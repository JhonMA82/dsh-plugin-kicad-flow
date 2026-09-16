import type { CircuitIR } from './ir.js';
import { normalizeNetName } from './reconciliation.js';

// ---------------------------------------------------------------------------
// PCB snapshot model — parsed from the .kicad_pcb file, which is the only
// deterministic, testable source of truth for footprint/nets/pads. MCP success
// responses are never treated as proof; the file (plus the live get_pads
// cross-check in the engine) is authoritative.
// ---------------------------------------------------------------------------

export interface PcbPad {
  /** Pad number exactly as stored in the footprint (e.g. "1", "A1", "11"). */
  pad: string;
  /** Pad position relative to the footprint origin (file coordinates). */
  x?: number;
  y?: number;
  /** Attached net name (already normalized, no leading '/'), or null. */
  net: string | null;
}

export interface PcbComponent {
  ref: string;
  /** Footprint library id as stored on the board ("Library:Footprint"). */
  lib: string;
  x: number;
  y: number;
  rotation: number;
  layer?: string;
  pads: PcbPad[];
}

export interface PcbSnapshot {
  components: PcbComponent[];
  nets: string[];
}

/** KiCad names pads that belong to no net "unconnected-(...)"; they are net
 * table entries, not IR nets, so both parsers and reconciliation skip them. */
export function isUnconnectedNetName(name: string): boolean {
  return !name || name.startsWith('unconnected-(');
}

/** Read one balanced `(...)` block starting at `start` (which must point at
 * the opening paren of the keyword). Returns the block text and the index
 * just past its closing paren. */
function readBalancedBlock(text: string, start: number): { block: string; next: number } {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++; // skip escaped quote
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { block: text.slice(start, i + 1), next: i + 1 };
    }
  }
  return { block: text.slice(start), next: text.length };
}

function* footprintBlocks(text: string): Generator<string> {
  const needle = '(footprint ';
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(needle, cursor);
    if (start < 0) return;
    const parenStart = start; // points at '(' of "(footprint ..."
    const { block, next } = readBalancedBlock(text, parenStart);
    yield block;
    cursor = next;
  }
}

/** Parse a .kicad_pcb (KiCad 7+ s-expression) into a PcbSnapshot. Nets come
 * from the file header (before the first footprint block); pads carry their
 * own `(net N "NAME")` entries. Unknown/absent values are honest: missing
 * positions become 0, pads without net become null. */
export function parseKicadPcb(text: string): PcbSnapshot {
  const firstFp = text.indexOf('(footprint ');
  const header = firstFp >= 0 ? text.slice(0, firstFp) : text;

  const nets: string[] = [];
  const seenNets = new Set<string>();
  for (const m of header.matchAll(/\(net\s+\d+\s+"([^"]*)"\)/g)) {
    const name = normalizeNetName(m[1]!);
    if (!name || isUnconnectedNetName(name) || seenNets.has(name)) continue;
    seenNets.add(name);
    nets.push(name);
  }

  const components: PcbComponent[] = [];
  for (const block of footprintBlocks(text)) {
    const lib = block.match(/^\(footprint\s+"([^"]*)"/)?.[1] ?? '';
    // The footprint's own (at ...) precedes any property/pad (at ...) in the
    // file layout KiCad emits.
    const at = block.match(/\(at\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)(?:\s+([-+0-9.eE]+))?\)/);
    const ref = block.match(/\(property\s+"Reference"\s+"([^"]*)"/)?.[1] ?? '';
    const layer = block.match(/\(layer\s+"([^"]*)"/)?.[1];
    const pads: PcbPad[] = [];
    for (const m of block.matchAll(/\(pad\s+"([^"]*)"/g)) {
      const { block: padBlock } = readBalancedBlock(block, m.index!);
      const pat = padBlock.match(/\(at\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)(?:\s+([-+0-9.eE]+))?\)/);
      // KiCad ≤9: (net N "NAME"); KiCad 10: (net "NAME") without netcode.
      const pnet = padBlock.match(/\(net\s+(?:\d+\s+)?"([^"]*)"\)/);
      const rawNet = pnet ? normalizeNetName(pnet[1]!) : '';
      pads.push({
        pad: m[1]!,
        x: pat ? +pat[1]! : undefined,
        y: pat ? +pat[2]! : undefined,
        net: rawNet && !isUnconnectedNetName(rawNet) ? rawNet : null,
      });
    }
    components.push({
      ref,
      lib,
      x: at ? +at[1]! : 0,
      y: at ? +at[2]! : 0,
      rotation: at && at[3] ? +at[3] : 0,
      layer,
      pads,
    });
  }
  // KiCad ≤9 declares nets in a numbered header section. KiCad 10 does not:
  // net names appear only on pads. Union of both sources, deterministic order
  // (header first, then pad-discovered nets in encounter order).
  for (const comp of components) {
    for (const pad of comp.pads) {
      const name = pad.net;
      if (!name || seenNets.has(name)) continue;
      seenNets.add(name);
      nets.push(name);
    }
  }
  return { components, nets };
}

// ---------------------------------------------------------------------------
// Deterministic PCB placement
// ---------------------------------------------------------------------------

/** Minimum Euclidean separation between two footprint origins on the PCB
 * (mm). PCB packages are much smaller than schematic symbols; 10 mm keeps
 * 0603/TO-220/SOT-style courtyards apart on dense boards while remaining a
 * purely deterministic heuristic. Real courtyard overlap is verified against
 * KiCad after placement (check_courtyard_overlaps when the server exposes
 * it), and pad-level collisions are detected from the board file. */
export const MIN_FP_SEPARATION_MM = 10;

export interface PcbPlacement {
  ref: string;
  x: number;
  y: number;
  rotation: number;
  layer?: string;
}

export interface PcbPlacementPlan {
  placements: PcbPlacement[];
  board: { widthMm: number; heightMm: number; marginMm: number };
}

function pcbBlockOrder(design: CircuitIR): string[] {
  const explicit = design.blocks ?? [];
  const seen = new Set(explicit);
  const inferred: string[] = [];
  for (const c of design.components) {
    const b = c.block ?? 'main';
    if (!seen.has(b)) {
      seen.add(b);
      inferred.push(b);
    }
  }
  return [...explicit, ...inferred];
}

/** Deterministic block-based placement inside the board's usable area
 * (margin..width-margin × margin..height-margin). Blocks form a 2D grid
 * (like the schematic auto-layout), components inside a block form a 2D
 * grid. Explicit IR pcb coordinates are respected and act as immovable
 * obstacles. Throws — never silently overlaps — on: explicit/explicit
 * collisions, or when the board cannot hold every auto-placed origin with
 * MIN_FP_SEPARATION_MM spacing. */
export function computePcbPlacements(design: CircuitIR): PcbPlacementPlan {
  const width = design.board?.widthMm ?? 80;
  const height = design.board?.heightMm ?? 50;
  const margin = design.board?.marginMm ?? 5;
  const left = margin;
  const top = margin;
  const right = width - margin;
  const bottom = height - margin;
  if (right - left < 10 || bottom - top < 10) {
    throw new Error(
      `PCB placement refused: board ${width}×${height} mm with ${margin} mm margin leaves no usable area. ` +
        'Declare larger board.widthMm/heightMm in the IR.',
    );
  }

  const blocks = pcbBlockOrder(design);
  const grouped = new Map<string, string[]>();
  for (const b of blocks) grouped.set(b, []);
  const refOrder: string[] = [];
  const refBlock = new Map<string, string>();
  for (const c of design.components) {
    const b = c.block ?? 'main';
    const bucket = grouped.get(b) ?? grouped.get('main');
    if (bucket) bucket.push(c.ref);
    else grouped.set(b, [c.ref]);
    refOrder.push(c.ref);
    refBlock.set(c.ref, b);
  }

  const usableW = right - left;
  const usableH = bottom - top;
  const blockCount = Math.max(1, blocks.length);
  const blockCols = Math.max(1, Math.ceil(Math.sqrt(blockCount)));
  const blockRows = Math.max(1, Math.ceil(blockCount / blockCols));
  const cellW = usableW / blockCols;
  const cellH = usableH / blockRows;

  const explicitRefs = design.components.filter((c) => c.pcb !== undefined).map((c) => c.ref);
  const explicitSet = new Set(explicitRefs);

  // Deterministic seeds, then a shared de-collision pass.
  const seeds: PcbPlacement[] = [];
  blocks.forEach((block, bi) => {
    const list = grouped.get(block) ?? [];
    const bc = bi % blockCols;
    const br = Math.floor(bi / blockCols);
    const itemCols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, list.length))));
    const itemRows = Math.max(1, Math.ceil(Math.max(1, list.length) / itemCols));
    list.forEach((ref, index) => {
      const comp = design.components.find((c) => c.ref === ref)!;
      const ic = index % itemCols;
      const ir = Math.floor(index / itemCols);
      const autoX = left + bc * cellW + ((ic + 1) * cellW) / (itemCols + 1);
      const autoY = top + br * cellH + ((ir + 1) * cellH) / (itemRows + 1);
      seeds.push({
        ref,
        x: comp.pcb?.x ?? +autoX.toFixed(2),
        y: comp.pcb?.y ?? +autoY.toFixed(2),
        rotation: comp.pcb?.rotation ?? comp.rotation ?? 0,
        layer: comp.pcb?.layer,
      });
    });
  });

  // Explicit references are immovable: any two of them closer than the
  // minimum separation is an IR defect the compiler must stop on.
  const pitch = MIN_FP_SEPARATION_MM;
  const explicitPlacements = seeds.filter((p) => explicitSet.has(p.ref));
  for (let i = 0; i < explicitPlacements.length; i++) {
    for (let j = i + 1; j < explicitPlacements.length; j++) {
      const a = explicitPlacements[i]!;
      const b = explicitPlacements[j]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < pitch - 1e-9) {
        throw new Error(
          `PCB placement refused: explicit pcb coordinates collide — '${a.ref}' and '${b.ref}' are ` +
            `${d.toFixed(2)} mm apart (minimum ${pitch} mm). Fix the IR pcb coordinates.`,
        );
      }
    }
  }

  // De-collision: sorted by ref, nudge +x by one pitch, wrap inside the
  // usable area; if the board cannot hold the component it is an error.
  const out = seeds.map((p) => ({ ...p }));
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  out.forEach((current, index) => {
    if (explicitSet.has(current.ref)) return;
    let guard = 0;
    for (;;) {
      const clash = out.slice(0, index).some((other) => Math.hypot(current.x - other.x, current.y - other.y) < pitch - 1e-9);
      if (!clash) return;
      if (++guard > 500) {
        throw new Error(
          `PCB placement refused: cannot separate '${current.ref}' from its neighbours by ${pitch} mm ` +
            `inside the ${width}×${height} mm board. Enlarge board.widthMm/heightMm or reduce the component count.`,
        );
      }
      current.x = +(current.x + pitch).toFixed(2);
      if (current.x > right) {
        current.x = +left.toFixed(2);
        current.y = +(current.y + pitch).toFixed(2);
        if (current.y > bottom) {
          throw new Error(
            `PCB placement refused: board ${width}×${height} mm cannot hold ${design.components.length} ` +
              `components with ${pitch} mm separation and ${margin} mm margin. Enlarge the board in the IR.`,
          );
        }
      }
    }
  });

  // Origin bounds check for EVERY placement (explicit coordinates included):
  // an origin outside the usable area is a deterministic defect.
  for (const p of out) {
    if (p.x < left - 1e-9 || p.x > right + 1e-9 || p.y < top - 1e-9 || p.y > bottom + 1e-9) {
      throw new Error(
        `PCB placement refused: '${p.ref}' at (${p.x},${p.y}) lies outside the usable board area ` +
          `[${left}..${right}]×[${top}..${bottom}] mm.`,
      );
    }
  }

  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { placements: out, board: { widthMm: width, heightMm: height, marginMm: margin } };
}

// ---------------------------------------------------------------------------
// Pad-level collision detection (real board data)
// ---------------------------------------------------------------------------

export interface PadCollision {
  x: number;
  y: number;
  nets: string[];
  pads: Array<{ ref: string; pad: string; net: string | null }>;
}

/** Rotate a footprint-local offset like KiCad does for footprint rotation in
 * board coordinates (Y-down, file rotation positive = clockwise on screen —
 * same convention verified for schematic pin offsets in 0.2.6). Used only as
 * a collision-detection heuristic from board-file data. */
function rotateOffset(dx: number, dy: number, rotDeg: number): { x: number; y: number } {
  const rot = ((rotDeg % 360) + 360) % 360;
  if (rot === 0) return { x: dx, y: dy };
  if (rot === 90) return { x: -dy, y: dx };
  if (rot === 180) return { x: -dx, y: -dy };
  if (rot === 270) return { x: dy, y: -dx };
  const rad = (rot * Math.PI) / 180;
  return { x: dx * Math.cos(rad) - dy * Math.sin(rad), y: dx * Math.sin(rad) + dy * Math.cos(rad) };
}

const PAD_EPSILON_MM = 0.01;

/** Detect pads from DIFFERENT nets sharing (approximately) the same absolute
 * coordinate — a real short on the manufactured board. Same-net pad sharing
 * is legal (touches/jumpers) and never reported. */
export function detectPadCollisions(snapshot: PcbSnapshot): PadCollision[] {
  const points: Array<{ ref: string; pad: string; net: string | null; x: number; y: number }> = [];
  for (const comp of snapshot.components) {
    for (const pad of comp.pads) {
      if (pad.net === null || pad.x === undefined || pad.y === undefined) continue;
      const abs = rotateOffset(pad.x, pad.y, comp.rotation);
      points.push({ ref: comp.ref, pad: pad.pad, net: pad.net, x: +(comp.x + abs.x).toFixed(4), y: +(comp.y + abs.y).toFixed(4) });
    }
  }
  const groups = new Map<string, typeof points>();
  for (const p of points) {
    const key = `${Math.round(p.x / PAD_EPSILON_MM)}:${Math.round(p.y / PAD_EPSILON_MM)}`;
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  const collisions: PadCollision[] = [];
  for (const group of groups.values()) {
    const nets = [...new Set(group.map((g) => g.net))].filter((n): n is string => Boolean(n)).sort();
    if (nets.length < 2) continue;
    collisions.push({
      x: +(group.reduce((s, g) => s + g.x, 0) / group.length).toFixed(2),
      y: +(group.reduce((s, g) => s + g.y, 0) / group.length).toFixed(2),
      nets,
      pads: group.map((g) => ({ ref: g.ref, pad: g.pad, net: g.net })),
    });
  }
  collisions.sort((a, b) => a.x - b.x || a.y - b.y);
  return collisions;
}

// ---------------------------------------------------------------------------
// PCB reconciliation — IR ↔ .kicad_pcb
// ---------------------------------------------------------------------------

export interface PcbPadIssue {
  ref: string;
  symbol: string;
  footprint: string;
  /** IR pin that was expected to exist as a pad (verbatim opaque string). */
  expectedPin: string;
  expectedNet: string;
  actualNet: string | null;
  kind: 'missing_pad' | 'wrong_net' | 'unconnected_pad';
  availablePads: string[];
}

export interface PcbFootprintMismatch {
  ref: string;
  expected: string;
  actual: string;
}

export interface PcbReconciliationReport {
  ok: boolean;
  expectedComponents: number;
  actualFootprints: number;
  missingFootprints: string[];
  unexpectedFootprints: string[];
  duplicateReferences: string[];
  wrongFootprints: PcbFootprintMismatch[];
  /** Compiler artifacts (#PWR*) must NEVER become PCB footprints. */
  artifactsOnBoard: string[];
  expectedNets: number;
  matchedNets: number;
  missingNets: string[];
  unexpectedNets: string[];
  padIssues: PcbPadIssue[];
}

/** Reconcile the IR against the parsed .kicad_pcb snapshot:
 * - every functional component exactly once, with the declared footprint;
 * - zero compiler artifacts (#PWR*) on the board;
 * - every IR net present, no unexpected nets (unconnected-* ignored);
 * - every IR endpoint present as a pad with the expected number and net
 *   (pin↔pad verification: ref/symbol/footprint/expected pin/available pads
 *   are reported on mismatch). */
export function reconcilePcbDesign(design: CircuitIR, snapshot: PcbSnapshot): PcbReconciliationReport {
  const byRef = new Map<string, PcbComponent[]>();
  for (const comp of snapshot.components) {
    const list = byRef.get(comp.ref);
    if (list) list.push(comp);
    else byRef.set(comp.ref, [comp]);
  }

  const expectedRefs = design.components.map((c) => c.ref);
  const expectedSet = new Set(expectedRefs);
  const missingFootprints = expectedRefs.filter((ref) => !byRef.has(ref));
  const duplicateReferences = [...byRef.entries()].filter(([, list]) => list.length > 1).map(([ref]) => ref).sort();
  const unexpectedFootprints = [...byRef.keys()].filter((ref) => !expectedSet.has(ref)).sort();
  const artifactsOnBoard = unexpectedFootprints.filter((ref) => (ref ?? '').startsWith('#'));
  const wrongFootprints: PcbFootprintMismatch[] = [];
  for (const c of design.components) {
    const actual = byRef.get(c.ref)?.[0];
    if (actual && actual.lib !== c.footprint) {
      wrongFootprints.push({ ref: c.ref, expected: c.footprint ?? '', actual: actual.lib });
    }
  }

  const snapshotNets = new Set(snapshot.nets);
  const expectedNets = design.nets.map((n) => n.name);
  const missingNets = expectedNets.filter((n) => !snapshotNets.has(n));
  const unexpectedNets = [...snapshotNets].filter((n) => !new Set(expectedNets).has(n)).sort();
  const matchedNets = expectedNets.filter((n) => snapshotNets.has(n)).length;

  const padIssues: PcbPadIssue[] = [];
  const refToComponent = new Map(design.components.map((c) => [c.ref, c]));
  for (const net of design.nets) {
    for (const endpoint of net.pins) {
      const comp = refToComponent.get(endpoint.ref)!;
      const actual = byRef.get(endpoint.ref)?.[0];
      if (!actual) continue; // already reported as missingFootprints
      const availablePads = actual.pads.map((p) => p.pad);
      const pad = actual.pads.find((p) => p.pad === endpoint.pin);
      if (!pad) {
        padIssues.push({
          ref: endpoint.ref,
          symbol: comp.symbol,
          footprint: comp.footprint ?? '',
          expectedPin: endpoint.pin,
          expectedNet: net.name,
          actualNet: null,
          kind: 'missing_pad',
          availablePads,
        });
        continue;
      }
      if (pad.net === null) {
        padIssues.push({
          ref: endpoint.ref,
          symbol: comp.symbol,
          footprint: comp.footprint ?? '',
          expectedPin: endpoint.pin,
          expectedNet: net.name,
          actualNet: null,
          kind: 'unconnected_pad',
          availablePads,
        });
      } else if (pad.net !== net.name) {
        padIssues.push({
          ref: endpoint.ref,
          symbol: comp.symbol,
          footprint: comp.footprint ?? '',
          expectedPin: endpoint.pin,
          expectedNet: net.name,
          actualNet: pad.net,
          kind: 'wrong_net',
          availablePads,
        });
      }
    }
  }

  const ok =
    missingFootprints.length === 0 &&
    unexpectedFootprints.length === 0 &&
    duplicateReferences.length === 0 &&
    wrongFootprints.length === 0 &&
    artifactsOnBoard.length === 0 &&
    missingNets.length === 0 &&
    unexpectedNets.length === 0 &&
    padIssues.length === 0;

  return {
    ok,
    expectedComponents: expectedRefs.length,
    actualFootprints: snapshot.components.length,
    missingFootprints,
    unexpectedFootprints,
    duplicateReferences,
    wrongFootprints,
    artifactsOnBoard,
    expectedNets: expectedNets.length,
    matchedNets,
    missingNets,
    unexpectedNets,
    padIssues,
  };
}

/** Components that must exist as PCB footprints. Compiler artifacts
 * (power:PWR_FLAG and any '#' reference) are schematic-only by design and
 * are always excluded from the PCB stage. */
export function pcbFootprintRequirements(design: CircuitIR): {
  required: Array<{ ref: string; symbol: string; footprint: string }>;
  missing: Array<{ ref: string; symbol: string }>;
  artifactsExcluded: string[];
} {
  const required: Array<{ ref: string; symbol: string; footprint: string }> = [];
  const missing: Array<{ ref: string; symbol: string }> = [];
  const artifactsExcluded: string[] = [];
  for (const c of design.components) {
    if (c.ref.startsWith('#') || c.symbol === 'power:PWR_FLAG') {
      artifactsExcluded.push(c.ref);
      continue;
    }
    if (c.footprint) required.push({ ref: c.ref, symbol: c.symbol, footprint: c.footprint });
    else missing.push({ ref: c.ref, symbol: c.symbol });
  }
  return { required, missing, artifactsExcluded };
}

/** Human-readable, bounded reconciliation report used in thrown errors:
 * ref/symbol/footprint/expected pin/available pads are always included for
 * pad issues. */
export function formatPcbReconciliation(report: PcbReconciliationReport): string {
  const lines: string[] = [];
  if (report.missingFootprints.length) lines.push(`missing footprints: ${report.missingFootprints.join(', ')}`);
  if (report.unexpectedFootprints.length) lines.push(`unexpected footprints: ${report.unexpectedFootprints.join(', ')}`);
  if (report.duplicateReferences.length) lines.push(`duplicate reference(s): ${report.duplicateReferences.join(', ')}`);
  for (const w of report.wrongFootprints.slice(0, 12)) {
    lines.push(`wrong footprint ${w.ref}: expected ${w.expected}, board has ${w.actual}`);
  }
  if (report.artifactsOnBoard.length) lines.push(`compiler artifacts on board (forbidden): ${report.artifactsOnBoard.join(', ')}`);
  if (report.missingNets.length) lines.push(`missing net(s): ${report.missingNets.join(', ')}`);
  if (report.unexpectedNets.length) lines.push(`unexpected net(s): ${report.unexpectedNets.join(', ')}`);
  for (const issue of report.padIssues.slice(0, 20)) {
    lines.push(
      `pad ${issue.kind} ${issue.ref} (${issue.symbol}, ${issue.footprint}): expected pin '${issue.expectedPin}' on net ` +
        `'${issue.expectedNet}'` +
        (issue.kind === 'missing_pad'
          ? ` — no such pad; available pads: [${issue.availablePads.join(', ')}]`
          : `; pad is on net '${issue.actualNet ?? '<unconnected>'}'; available pads: [${issue.availablePads.join(', ')}]`),
    );
  }
  if (report.padIssues.length > 20) lines.push(`... and ${report.padIssues.length - 20} more pad issue(s)`);
  if (!lines.length) lines.push('PCB reconciliation reported not-ok without specific issues.');
  return lines.join('\n');
}
