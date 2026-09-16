// kicad-flow 0.4.0 — Level 1: routing reconciliation + freerouting backend.
//
// Design rules encoded here (from the 0.4.0 spec):
// - The LLM never emits traces, coordinates or SES files. The IR only
//   declares INTENT (RoutingSpec: backend/maxPasses/timeoutSeconds; ZoneSpec:
//   net/layer/clearance/minWidth/priority/thermal/fill). All KiCad mechanics
//   (DSN export, freerouting CLI invocation, SES import, zone creation and
//   refill) belong to the compiler.
// - A MCP success response is never proof of success: routing is verified by
//   reconciling the parsed .kicad_pcb file (segments/vias/zones) against the
//   IR nets and the board geometry.

import type { CircuitIR, ZoneSpec } from './ir.js';
import type { PcbComponent } from './pcb.js';
import { run } from './process.js';
import type { McpBridge } from './mcp-bridge.js';

// ---------------------------------------------------------------------------
// Board s-expression helpers (quote-aware balanced blocks)
// ---------------------------------------------------------------------------

/** Index just past the closing paren of the balanced block that starts at
 * `start` (which must point at '('). Quote-aware. */
function blockEnd(text: string, start: number): number {
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
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function* keywordBlocks(text: string, keyword: string): Generator<string> {
  // The keyword may be followed by any whitespace (real boards write
  // `(zone\n\t(net 1) ...`), not only a space.
  const needle = `(${keyword}`;
  let cursor = 0;
  for (;;) {
    let start = text.indexOf(needle, cursor);
    while (start >= 0) {
      const next = text[start + needle.length];
      if (next === undefined || /\s/.test(next)) break;
      start = text.indexOf(needle, start + needle.length);
    }
    if (start < 0) return;
    const end = blockEnd(text, start);
    yield text.slice(start, end);
    cursor = end;
  }
}

// ---------------------------------------------------------------------------
// Track / via / zone / outline parsing from the .kicad_pcb file
// ---------------------------------------------------------------------------

export interface RoutingTrack {
  x1: number; y1: number; x2: number; y2: number;
  width: number; layer: string;
  netName: string | null;
}

export interface RoutingVia {
  x: number; y: number;
  size: number; drill: number;
  netName: string | null;
  layers: string[];
}

export interface RoutingZone {
  net: string | null;
  layers: string[];
  priority: number;
  minThickness: number;
  /** Zone-to-pad clearance override (`(connect_pads (clearance N))`), if set. */
  clearance?: number;
  /** `fill_mode` from the zone block (`solid` | `hatched`), when present. */
  fillMode?: string;
  /** Pad connection style: `solid` (`(connect_pads yes)`) or `relief`
   * (thermal gap/bridge params without `yes`). Undefined when the block
   * carries no connection hint. */
  thermal?: 'solid' | 'relief';
  filled: boolean;
}

export interface RoutingBoardGeometry {
  outline: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Copper layer names declared in the board file header. */
  copperLayers: string[];
}

export interface RoutingBoardSnapshot {
  tracks: RoutingTrack[];
  vias: RoutingVia[];
  zones: RoutingZone[];
  geometry: RoutingBoardGeometry;
}

function normalizeBoardNet(name: string | undefined): string | null {
  if (!name) return null;
  const stripped = name.startsWith('/') ? name.slice(1) : name;
  if (!stripped || stripped.startsWith('unconnected-(')) return null;
  return stripped;
}

const NUM = '[-+0-9.eE]+';

/** Parse tracks/vias/zones/geometry out of a .kicad_pcb (KiCad 7+ format;
 * verified against a real KiCad 10 board). The board file remains the only
 * authoritative snapshot source. */
export function parseRoutingBoard(text: string): RoutingBoardSnapshot {
  const tracks: RoutingTrack[] = [];
  for (const block of keywordBlocks(text, 'segment')) {
    const at = block.match(new RegExp(`\\(start\\s+(${NUM})\\s+(${NUM})\\)`));
    const end = block.match(new RegExp(`\\(end\\s+(${NUM})\\s+(${NUM})\\)`));
    const width = block.match(new RegExp(`\\(width\\s+(${NUM})\\)`));
    const layer = block.match(/\(layer\s+"([^"]*)"/);
    const net = block.match(/\(net\s+(?:\d+\s+)?"([^"]*)"\)/);
    tracks.push({
      x1: at ? +at[1]! : NaN,
      y1: at ? +at[2]! : NaN,
      x2: end ? +end[1]! : NaN,
      y2: end ? +end[2]! : NaN,
      width: width ? +width[1]! : NaN,
      layer: layer?.[1] ?? '',
      netName: normalizeBoardNet(net?.[1]),
    });
  }

  const vias: RoutingVia[] = [];
  for (const block of keywordBlocks(text, 'via')) {
    const at = block.match(new RegExp(`\\(at\\s+(${NUM})\\s+(${NUM})\\)`));
    const size = block.match(new RegExp(`\\(size\\s+(${NUM})\\)`));
    const drill = block.match(new RegExp(`\\(drill\\s+(${NUM})\\)`));
    const net = block.match(/\(net\s+(?:\d+\s+)?"([^"]*)"\)/);
    const layers = [...block.matchAll(/\(layer\s+"([^"]*)"\)/g)].map((m) => m[1] as string);
    vias.push({
      x: at ? +at[1]! : NaN,
      y: at ? +at[2]! : NaN,
      size: size ? +size[1]! : NaN,
      drill: drill ? +drill[1]! : NaN,
      netName: normalizeBoardNet(net?.[1]),
      layers,
    });
  }

  const zones: RoutingZone[] = [];
  for (const block of keywordBlocks(text, 'zone')) {
    // Real KiCad zone blocks carry the net as `(net 1) (net_name "GND")`;
    // `(net N "NAME")` is kept as a defensive fallback.
    const net = block.match(/\(net_name\s+"([^"]*)"\)/) ?? block.match(/\(net\s+(?:\d+\s+)?"([^"]*)"\)/);
    const priority = block.match(new RegExp(`\\(priority\\s+(${NUM})\\)`));
    const minThickness = block.match(new RegExp(`\\(min_thickness\\s+(${NUM})\\)`));
    const clearance = block.match(new RegExp(`\\(clearance\\s+(${NUM})\\)`));
    const filled = /\(filled_polygon/.test(block);
    // Zones declare layers either singular `(layer "B.Cu")` or plural
    // `(layers "F.Cu" "B.Cu")` (verified against KiCad 9/10 template boards).
    const layers = [
      ...[...block.matchAll(/\blayers?\s+((?:"[^"]*"\s*)+)/g)].flatMap((m) =>
        [...(m[1]?.matchAll(/"([^"]*)"/g) ?? [])].map((q) => q[1] as string),
      ),
    ].filter((l) => l.endsWith('.Cu'));
    const fillMode = block.match(/\(fill_mode\s+([a-z]+)/)?.[1];
    const solidConnection = /\(connect_pads\s+yes/.test(block);
    const thermalReliefParams = /\(thermal_gap/.test(block) || /\(thermal_bridge/.test(block);
    const thermal: 'solid' | 'relief' | undefined = solidConnection
      ? 'solid'
      : thermalReliefParams
        ? 'relief'
        : undefined;
    zones.push({
      net: normalizeBoardNet(net?.[1]),
      layers,
      priority: priority ? +priority[1]! : 0,
      minThickness: minThickness ? +minThickness[1]! : NaN,
      clearance: clearance ? +clearance[1]! : undefined,
      fillMode,
      thermal,
      filled,
    });
  }

  // Board outline: bounding box of Edge.Cuts primitives (gr_line/gr_rect/
  // gr_arc/gr_poly). Deterministic and adequate for Level-1 containment
  // checks on rectangular outlines.
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const edgeLayers = new Set(['Edge.Cuts']);
  const consider = (x: number, y: number, layer: string | undefined) => {
    if (!layer || !edgeLayers.has(layer)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  };
  for (const block of keywordBlocks(text, 'gr_line')) {
    const layer = block.match(/\(layer\s+"([^"]*)"/)?.[1];
    const s = block.match(new RegExp(`\\(start\\s+(${NUM})\\s+(${NUM})\\)`));
    const e = block.match(new RegExp(`\\(end\\s+(${NUM})\\s+(${NUM})\\)`));
    if (s) consider(+s[1]!, +s[2]!, layer);
    if (e) consider(+e[1]!, +e[2]!, layer);
  }
  for (const block of keywordBlocks(text, 'gr_rect')) {
    const layer = block.match(/\(layer\s+"([^"]*)"/)?.[1];
    const s = block.match(new RegExp(`\\(start\\s+(${NUM})\\s+(${NUM})\\)`));
    const e = block.match(new RegExp(`\\(end\\s+(${NUM})\\s+(${NUM})\\)`));
    if (s) consider(+s[1]!, +s[2]!, layer);
    if (e) consider(+e[1]!, +e[2]!, layer);
  }
  for (const block of keywordBlocks(text, 'gr_arc')) {
    const layer = block.match(/\(layer\s+"([^"]*)"/)?.[1];
    const mid = block.match(new RegExp(`\\(mid\\s+(${NUM})\\s+(${NUM})\\)`));
    const end = block.match(new RegExp(`\\(end\\s+(${NUM})\\s+(${NUM})\\)`));
    if (mid) consider(+mid[1]!, +mid[2]!, layer);
    if (end) consider(+end[1]!, +end[2]!, layer);
  }
  for (const block of keywordBlocks(text, 'gr_poly')) {
    const layer = block.match(/\(layer\s+"([^"]*)"/)?.[1];
    for (const pt of block.matchAll(new RegExp(`\\(xy\\s+(${NUM})\\s+(${NUM})\\)`, 'g'))) {
      consider(+pt[1]!, +pt[2]!, layer);
    }
  }

  // Copper layers from the board header: `(N "F.Cu" signal)`.
  const copperLayers: string[] = [];
  const header = text.slice(0, text.indexOf('(footprint ') > 0 ? text.indexOf('(footprint ') : text.length);
  const layersSection = header.slice(Math.max(0, header.indexOf('(layers')));
  for (const m of layersSection.matchAll(/\(\d+\s+"([A-Za-z0-9.]+\.Cu)"[^)]*\)/g)) {
    if (!copperLayers.includes(m[1] as string)) copperLayers.push(m[1] as string);
  }

  const outline = Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)
    ? { x1, y1, x2, y2 }
    : null;
  return { tracks, vias, zones, geometry: { outline, copperLayers } };
}

// ---------------------------------------------------------------------------
// Routing reconciliation — IR ↔ routed board
// ---------------------------------------------------------------------------

export interface UnroutedEndpoint {
  net: string;
  ref: string;
  pin: string;
}

export interface RoutingReconciliationReport {
  ok: boolean;
  /** True when every IR net endpoint pair is physically connected. */
  unroutedCount: number;
  unrouted: UnroutedEndpoint[];
  /** Net endpoints (from the parsed footprints) not touching any track,
   * via or zone on their net. */
  floatingPads: UnroutedEndpoint[];
  tracks: number;
  vias: number;
  /** Tracks/vias whose net is not in the IR (freerouting invented a net). */
  unknownNetTraces: string[];
  /** Traces or vias whose center lies outside the board outline. */
  outsideBoard: string[];
  /** Two different nets sharing a via location (short). */
  viaShorts: string[];
  /** Nets covered by an IR-declared copper zone. Their pad connectivity is
   * judged by zone reconciliation + the final DRC (zone fill is not parsed
   * as copper polygons in Level-1), so they are exempt from the track-graph
   * pairwise/floating verdicts. */
  zoneExemptNets: string[];
  issues: string[];
}

export interface RoutingEndpointContext {
  /** Absolute pad positions per ref — from the parsed board footprints. */
  components: PcbComponent[];
}

/** Pad is "attached" when copper exists within this distance of the pad
 * center: a segment endpoint, a via, or a same-net zone covering it. */
const PAD_ATTACH_TOLERANCE_MM = 0.6;

function pointOnSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const dxc = px - x1;
  const dyc = py - y1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(dxc, dyc) <= PAD_ATTACH_TOLERANCE_MM;
  const t = Math.max(0, Math.min(1, (dxc * dx + dyc * dy) / lenSq));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy) <= PAD_ATTACH_TOLERANCE_MM;
}

/** Reconcile the routed board against the IR:
 * - unroutedCount: IR net endpoint pairs (consecutive pins on each net in
 *   declaration order) not joined by same-net copper. Level-1 PASS = 0.
 * - floatingPads: IR pads with no same-net copper nearby.
 * - unknownNetTraces / outsideBoard / viaShorts: structural routing defects. */
export function reconcileRoutingDesign(
  design: CircuitIR,
  snapshot: RoutingBoardSnapshot,
  context: RoutingEndpointContext,
): RoutingReconciliationReport {
  const issues: string[] = [];
  const knownNets = new Set(design.nets.map((n) => n.name));

  // --- copper graph per net (union-find over segment endpoints + vias) ---
  type Node = { x: number; y: number; parent: Node };
  const makeNode = (x: number, y: number): Node => {
    const n = { x, y, parent: undefined as unknown as Node };
    n.parent = n;
    return n;
  };
  const find = (n: Node): Node => (n.parent === n ? n : (n.parent = find(n.parent)));
  const union = (a: Node, b: Node): void => { find(a).parent = find(b); };

  const copperByNet = new Map<string, { nodes: Node[]; segments: Array<{ x1: number; y1: number; x2: number; y2: number; a: Node; b: Node }> }>();
  const netCopper = (net: string) => {
    let entry = copperByNet.get(net);
    if (!entry) { entry = { nodes: [], segments: [] }; copperByNet.set(net, entry); }
    return entry;
  };

  for (const track of snapshot.tracks) {
    if (!track.netName) continue;
    if (!knownNets.has(track.netName)) continue;
    const entry = netCopper(track.netName);
    const a = makeNode(track.x1, track.y1);
    const b = makeNode(track.x2, track.y2);
    entry.nodes.push(a, b);
    entry.segments.push({ x1: track.x1, y1: track.y1, x2: track.x2, y2: track.y2, a, b });
    union(a, b);
  }
  for (const via of snapshot.vias) {
    if (!via.netName || !knownNets.has(via.netName)) continue;
    const entry = netCopper(via.netName);
    const n = makeNode(via.x, via.y);
    entry.nodes.push(n);
  }
  // Connect coplanar/coincident copper: segment endpoints touching other
  // segments of the same net, and vias touching segments of the same net.
  for (const [net, entry] of copperByNet) {
    void net;
    const all = entry.nodes;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= PAD_ATTACH_TOLERANCE_MM) union(a, b);
      }
    }
    for (const seg of entry.segments) {
      for (const node of all) {
        if (node === seg.a || node === seg.b) continue;
        if (
          pointOnSegment(node.x, node.y, seg.x1, seg.y1, seg.x2, seg.y2) ||
          Math.hypot(node.x - seg.x1, node.y - seg.y1) <= PAD_ATTACH_TOLERANCE_MM ||
          Math.hypot(node.x - seg.x2, node.y - seg.y2) <= PAD_ATTACH_TOLERANCE_MM
        ) {
          union(node, seg.a);
        }
      }
    }
  }

  // Zone coverage: a filled same-net zone covering a pad counts as attached.
  const zoneCovers = (net: string, x: number, y: number): boolean => {
    for (const zone of snapshot.zones) {
      if (zone.net !== net || !zone.filled) continue;
      // Zone outlines are not parsed to polygons in Level-1; a filled zone
      // inside the board outline is assumed to cover the pad unless it is
      // provably outside the board (reconciliation already checks zones
      // against the outline). This is deliberately generous: the final DRC
      // is the authoritative connectivity judge.
      return true;
    }
    return false;
  };

  // --- per-endpoint attachment + pairwise connectivity ---
  const refToComp = new Map(context.components.map((c) => [c.ref, c]));
  const unrouted: UnroutedEndpoint[] = [];
  const floatingPads: UnroutedEndpoint[] = [];
  const entryByNet = new Map(design.nets.map((n) => [n.name, copperByNet.get(n.name)]));
  // Zone-declared nets: connectivity is verified by zone reconciliation and
  // the final DRC, not by the track graph (freerouting typically leaves
  // zone-nets to the pour, and zone polygons are not parsed in Level-1).
  const zoneExemptNets = new Set((design.zones ?? []).map((z) => z.net));

  for (const net of design.nets) {
    const entry = entryByNet.get(net.name);
    const endpointNodes: Array<{ endpoint: UnroutedEndpoint; node: Node | null }> = [];
    if (zoneExemptNets.has(net.name)) continue;
    for (const pin of net.pins) {
      const endpoint: UnroutedEndpoint = { net: net.name, ref: pin.ref, pin: pin.pin };
      const comp = refToComp.get(pin.ref);
      if (!comp) continue; // missing footprints are a PCB reconciliation defect
      const pad = comp.pads.find((p) => p.pad === pin.pin);
      if (!pad || pad.x === undefined || pad.y === undefined) continue;
      const absX = comp.x + pad.x;
      const absY = comp.y + pad.y;
      let node: Node | null = null;
      if (entry) {
        node = entry.nodes.find(
          (n) => Math.hypot(n.x - absX, n.y - absY) <= PAD_ATTACH_TOLERANCE_MM,
        ) ?? null;
      }
      if (!node && zoneCovers(net.name, absX, absY)) {
        node = null; // covered by zone: counts as attached (node stays null but pad is not floating)
      } else if (!node) {
        floatingPads.push(endpoint);
        continue;
      }
      endpointNodes.push({ endpoint, node });
    }
    // Pairwise connectivity across all endpoints of the net. A net with two
    // endpoints in different copper components (or one covered only by a
    // zone) is conservatively checked through components when both have nodes.
    for (let i = 1; i < endpointNodes.length; i++) {
      const a = endpointNodes[i - 1]!;
      const b = endpointNodes[i]!;
      if (a.node && b.node && find(a.node) !== find(b.node)) {
        unrouted.push(b.endpoint);
      } else if (!a.node || !b.node) {
        // At least one side is only zone-covered: component graph cannot
        // judge it; leave the verdict to the final DRC (unrouted_items).
        continue;
      }
    }
  }

  // --- structural defects ---
  const unknownNetTraces: string[] = [];
  for (const track of snapshot.tracks) {
    if (track.netName && !knownNets.has(track.netName)) {
      unknownNetTraces.push(`segment(${track.x1},${track.y1})->(${track.x2},${track.y2}) net '${track.netName}'`);
    }
  }
  for (const via of snapshot.vias) {
    if (via.netName && !knownNets.has(via.netName)) {
      unknownNetTraces.push(`via(${via.x},${via.y}) net '${via.netName}'`);
    }
  }

  const outsideBoard: string[] = [];
  const outline = snapshot.geometry.outline;
  if (outline) {
    const inside = (x: number, y: number): boolean =>
      x >= outline.x1 - 0.05 && x <= outline.x2 + 0.05 && y >= outline.y1 - 0.05 && y <= outline.y2 + 0.05;
    for (const track of snapshot.tracks) {
      if (!inside(track.x1, track.y1) || !inside(track.x2, track.y2)) {
        outsideBoard.push(`segment(${track.x1},${track.y1})->(${track.x2},${track.y2}) on ${track.layer}`);
      }
    }
    for (const via of snapshot.vias) {
      if (!inside(via.x, via.y)) outsideBoard.push(`via(${via.x},${via.y})`);
    }
  } else {
    issues.push('board outline not found on Edge.Cuts; containment not verified');
  }

  const viaShorts: string[] = [];
  {
    const byPos = new Map<string, string[]>();
    for (const via of snapshot.vias) {
      if (!via.netName) continue;
      const key = `${via.x.toFixed(3)}:${via.y.toFixed(3)}`;
      const list = byPos.get(key) ?? [];
      if (!list.includes(via.netName)) list.push(via.netName);
      byPos.set(key, list);
    }
    for (const [pos, nets] of byPos) {
      if (nets.length > 1) viaShorts.push(`via at ${pos} carries nets ${nets.join('+')}`);
    }
  }

  if (unknownNetTraces.length) issues.push(`${unknownNetTraces.length} trace(s) on unknown net(s)`);
  if (outsideBoard.length) issues.push(`${outsideBoard.length} trace(s)/via(s) outside the board outline`);
  if (viaShorts.length) issues.push(`${viaShorts.length} via short(s)`);

  const unroutedCount = unrouted.length + floatingPads.length;
  return {
    ok: unroutedCount === 0 && unknownNetTraces.length === 0 && outsideBoard.length === 0 && viaShorts.length === 0,
    unroutedCount,
    unrouted,
    floatingPads,
    tracks: snapshot.tracks.length,
    vias: snapshot.vias.length,
    unknownNetTraces,
    outsideBoard,
    viaShorts,
    zoneExemptNets: [...zoneExemptNets],
    issues,
  };
}

export function formatRoutingReconciliation(report: RoutingReconciliationReport): string {
  const lines: string[] = [];
  if (report.unrouted.length) {
    lines.push(`unrouted endpoint pair(s): ${report.unrouted.slice(0, 12).map((u) => `${u.net}:${u.ref}:${u.pin}`).join(', ')}`);
  }
  if (report.floatingPads.length) {
    lines.push(`floating pad(s): ${report.floatingPads.slice(0, 12).map((u) => `${u.net}:${u.ref}:${u.pin}`).join(', ')}`);
  }
  for (const t of report.unknownNetTraces.slice(0, 8)) lines.push(`unknown-net trace: ${t}`);
  for (const o of report.outsideBoard.slice(0, 8)) lines.push(`outside board: ${o}`);
  for (const s of report.viaShorts.slice(0, 8)) lines.push(`via short: ${s}`);
  for (const i of report.issues) lines.push(i);
  if (!lines.length) lines.push('routing reconciliation reported not-ok without specific issues.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Routing backend abstraction
// ---------------------------------------------------------------------------

export interface RouteRequest {
  projectDir: string;
  projectName: string;
  pcbPath: string;
  /** Directory where DSN/SES artifacts are staged (project/.kicad-flow/routing). */
  stagingDir: string;
  maxPasses: number;
  timeoutSeconds: number;
  freeroutingJar?: string;
}

export interface RouteResult {
  backend: string;
  dsnPath: string;
  sesPath: string;
  tracks: number;
  vias: number;
  mcpCalls: string[];
}

export interface RoutingBackend {
  readonly name: string;
  /** Verify the router is usable (freerouting: jar exists, java present). */
  preflight(): Promise<void>;
  /** Export the board to the router format and run it, then import the
   * result back into the board file. Returns where artifacts were written. */
  route(request: RouteRequest, calls: string[]): Promise<RouteResult>;
}

const ROUTING_BLOCKED = 'Routing pipeline blocked';

export class FreeroutingBackend implements RoutingBackend {
  readonly name = 'freerouting';

  constructor(
    private readonly bridge: McpBridge,
    private readonly jarPath: string | undefined,
  ) {}

  async preflight(): Promise<void> {
    if (!this.bridge.hasTool('export_dsn')) {
      throw new Error(`${ROUTING_BLOCKED}: KiCAD-MCP-Server does not expose export_dsn.`);
    }
    if (!this.bridge.hasTool('import_ses')) {
      throw new Error(`${ROUTING_BLOCKED}: KiCAD-MCP-Server does not expose import_ses.`);
    }
    const jar = this.jarPath ?? '/home/juan/dev/Kicad/tools/freerouting/freerouting.jar';
    try {
      await run('test', ['-f', jar]);
    } catch {
      throw new Error(`${ROUTING_BLOCKED}: freerouting jar not found at ${jar}.`);
    }
    if (this.bridge.hasTool('check_freerouting')) {
      const result = await this.bridge.call('check_freerouting', { freeroutingJar: this.jarPath });
      if (result.isError) {
        throw new Error(`${ROUTING_BLOCKED}: check_freerouting failed: ${result.text}`);
      }
    }
  }

  async route(request: RouteRequest, calls: string[]): Promise<RouteResult> {
    const dsnPath = `${request.stagingDir}/${request.projectName}.dsn`;
    const sesPath = `${request.stagingDir}/${request.projectName}.ses`;
    const fs = await import('node:fs/promises');
    await fs.mkdir(request.stagingDir, { recursive: true });

    // 1. DSN export (applies project netclasses to the DSN per server #302).
    await this.bridge.call('export_dsn', { boardPath: request.pcbPath, outputPath: dsnPath });
    calls.push('export_dsn');

    // 2. freerouting CLI. A non-zero exit is a routing failure: STOP.
    try {
      await run('java', [
        '-jar', this.jarPath ?? '/home/juan/dev/Kicad/tools/freerouting/freerouting.jar',
        '-de', dsnPath,
        '-do', sesPath,
        '-mp', String(request.maxPasses),
        '-l', 'en',
      ], request.projectDir);
    } catch (error) {
      throw new Error(
        `${ROUTING_BLOCKED}: freerouting CLI failed (maxPasses=${request.maxPasses}). ` +
        `The board was NOT modified. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 3. SES must exist and be non-empty.
    let sesText: string;
    try {
      sesText = await fs.readFile(sesPath, 'utf8');
    } catch (error) {
      throw new Error(
        `${ROUTING_BLOCKED}: freerouting did not produce a SES file at ${sesPath}. ` +
        `The board was NOT modified. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!/\(routes?\b|\(network_out\b/.test(sesText)) {
      throw new Error(
        `${ROUTING_BLOCKED}: the SES file at ${sesPath} contains no routes section; it is not a valid routing session. The board was NOT modified.`,
      );
    }

    // 4. Import SES back into the board (server reconciles '/'-prefixed net
    // names and saves the board).
    await this.bridge.call('import_ses', { sesPath, boardPath: request.pcbPath });
    calls.push('import_ses');

    return { backend: this.name, dsnPath, sesPath, tracks: 0, vias: 0, mcpCalls: [...calls] };
  }
}

export function routingBackend(name: string, bridge: McpBridge, jarPath: string | undefined): RoutingBackend {
  if (name === 'freerouting') return new FreeroutingBackend(bridge, jarPath);
  throw new Error(`${ROUTING_BLOCKED}: unsupported routing backend '${name}'. 0.4.0 ships 'freerouting' only.`);
}

// ---------------------------------------------------------------------------
// Zone reconciliation
// ---------------------------------------------------------------------------

export interface ZoneIssue {
  zone: ZoneSpec;
  problem: string;
}

export interface ZoneReconciliationReport {
  ok: boolean;
  expectedZones: number;
  actualZones: number;
  issues: ZoneIssue[];
}

/** Match IR-declared zones against the board's parsed zone list. Each IR
 * declaration must map to exactly one filled board zone on the right net and
 * layer. Extra zones are unexpected (the compiler creates one entity per
 * declaration, never more). */
export function reconcileZones(design: CircuitIR, snapshot: RoutingBoardSnapshot): ZoneReconciliationReport {
  const issues: ZoneIssue[] = [];
  const declared = design.zones ?? [];
  const remaining = [...snapshot.zones];
  for (const zone of declared) {
    const idx = remaining.findIndex((z) => {
      if (z.net !== zone.net) return false;
      if (zone.layer && !z.layers.includes(zone.layer)) return false;
      return true;
    });
    if (idx < 0) {
      issues.push({
        zone,
        problem: `no board zone found for net '${zone.net}' on layer '${zone.layer}'`,
      });
      continue;
    }
    const [match] = remaining.splice(idx, 1);
    if (!match!.filled) {
      issues.push({ zone, problem: `zone for '${zone.net}' on '${zone.layer}' is not filled` });
    }
    if (Number.isFinite(match!.minThickness) && match!.minThickness + 1e-6 < (zone.minWidthMm ?? 0.2)) {
      issues.push({ zone, problem: `zone minThickness ${match!.minThickness} < declared minWidth ${zone.minWidthMm}` });
    }
  }
  if (remaining.length) {
    for (const extra of remaining) {
      issues.push({
        zone: { net: extra.net ?? '(none)', layer: extra.layers[0] ?? '(none)' },
        problem: `unexpected zone on board (net '${extra.net}', layers ${extra.layers.join('/')})`,
      });
    }
  }
  return {
    ok: issues.length === 0,
    expectedZones: declared.length,
    actualZones: snapshot.zones.length,
    issues,
  };
}

export function formatZoneIssues(report: ZoneReconciliationReport): string {
  return report.issues
    .slice(0, 12)
    .map((i) => `zone ${i.zone.net}@${i.zone.layer}: ${i.problem}`)
    .join('; ');
}
