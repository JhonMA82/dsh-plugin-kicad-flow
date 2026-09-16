import type { CircuitComponent, CircuitIR } from './ir.js';
import type { PreflightPin } from './pin-data.js';

export interface Placement {
  ref: string;
  x: number;
  y: number;
  rotation: number;
  layer?: string;
}

/** Sheet working area shared by the auto-layout and the de-collision pass. */
export const SHEET_AREA = {
  left: 20,
  top: 20,
  width: 255,
  height: 165,
} as const;

/** Minimum Euclidean separation between two symbol origins on the
 * schematic (mm). 0.2.6: stacked parts such as the vcm-controller Q1/Q6
 * pair (10.16 mm apart, sharing the D/S pin-base coordinate 220.98,97.79)
 * can no longer be emitted. Symbols with longer pins remain covered by
 * the endpoint collision check in the engine, which stops the compile
 * instead of wiring silently. */
export const MIN_ORIGIN_SEPARATION_MM = 15.24;

/** Two pin endpoints closer than this are the same electrical point. */
export const ENDPOINT_EPSILON_MM = 0.01;

function blockOrder(design: CircuitIR): string[] {
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

export function schematicPlacements(design: CircuitIR): Placement[] {
  const blocks = blockOrder(design);
  const grouped = new Map<string, CircuitComponent[]>();
  for (const b of blocks) grouped.set(b, []);
  for (const c of design.components) (grouped.get(c.block ?? 'main') ?? grouped.get('main') ?? []).push(c);

  // Keep the auto-layout inside an A4-landscape-friendly working area rather
  // than placing every block in one infinitely wide row. Explicit coordinates
  // in the IR always win.
  const pageLeft = SHEET_AREA.left;
  const pageTop = SHEET_AREA.top;
  const usableW = SHEET_AREA.width;
  const usableH = SHEET_AREA.height;
  const blockCount = Math.max(1, blocks.length);
  const blockCols = Math.max(1, Math.ceil(Math.sqrt(blockCount)));
  const blockRows = Math.max(1, Math.ceil(blockCount / blockCols));
  const cellW = usableW / blockCols;
  const cellH = usableH / blockRows;

  const placements: Placement[] = [];
  blocks.forEach((block, bi) => {
    const list = grouped.get(block) ?? [];
    const bc = bi % blockCols;
    const br = Math.floor(bi / blockCols);
    const itemCols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, list.length))));
    const itemRows = Math.max(1, Math.ceil(Math.max(1, list.length) / itemCols));

    list.forEach((c, index) => {
      const ic = index % itemCols;
      const ir = Math.floor(index / itemCols);
      const autoX = pageLeft + bc * cellW + ((ic + 1) * cellW) / (itemCols + 1);
      const autoY = pageTop + br * cellH + ((ir + 1) * cellH) / (itemRows + 1);
      placements.push({
        ref: c.ref,
        x: c.schematic?.x ?? +autoX.toFixed(2),
        y: c.schematic?.y ?? +autoY.toFixed(2),
        rotation: c.schematic?.rotation ?? c.rotation ?? 0,
      });
    });
  });
  // 0.2.6: deterministic de-collision of auto-placed origins. Explicit IR
  // coordinates are obstacles but are never moved; if they collide, the
  // engine endpoint check stops the compile before any mutation.
  const explicit = new Set(
    design.components.filter((c) => c.schematic !== undefined).map((c) => c.ref),
  );
  return resolveOriginCollisions(placements, explicit);
}

export function pcbPlacements(design: CircuitIR): Placement[] {
  const width = design.board?.widthMm ?? 80;
  const height = design.board?.heightMm ?? 50;
  const margin = design.board?.marginMm ?? 5;
  const blocks = blockOrder(design);
  const usableW = Math.max(10, width - margin * 2);
  const usableH = Math.max(10, height - margin * 2);
  const blockW = usableW / Math.max(1, blocks.length);
  const grouped = new Map<string, CircuitComponent[]>();
  for (const b of blocks) grouped.set(b, []);
  for (const c of design.components) (grouped.get(c.block ?? 'main') ?? grouped.get('main') ?? []).push(c);

  const placements: Placement[] = [];
  blocks.forEach((block, bi) => {
    const list = grouped.get(block) ?? [];
    const rows = Math.max(1, Math.ceil(Math.sqrt(list.length || 1)));
    const cols = Math.max(1, Math.ceil((list.length || 1) / rows));
    list.forEach((c, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = margin + bi * blockW + ((col + 1) * blockW) / (cols + 1);
      const y = margin + ((row + 1) * usableH) / (rows + 1);
      placements.push({
        ref: c.ref,
        x: c.pcb?.x ?? +x.toFixed(2),
        y: c.pcb?.y ?? +y.toFixed(2),
        rotation: c.pcb?.rotation ?? c.rotation ?? 0,
        layer: c.pcb?.layer,
      });
    });
  });
  return placements;
}

export function connectionMaps(design: CircuitIR): {
  local: Record<string, Record<string, string>>;
  global: Record<string, Record<string, string>>;
} {
  const local: Record<string, Record<string, string>> = {};
  const global: Record<string, Record<string, string>> = {};
  for (const net of design.nets) {
    const target = net.global ? global : local;
    for (const p of net.pins) {
      (target[p.ref] ??= {})[p.pin] = net.name;
    }
  }
  return { local, global };
}

/** Deterministic row for compiler artifacts (PWR_FLAGs) below the working
 * area: `x = left + pitch*(i+1)`, `y = top + height + pitch`, then the
 * shared de-collision pass against every existing origin. Artifact refs
 * (`#…`) sort before functional refs, so functional placements from 0.2.6
 * are never displaced by artifacts. */
export function artifactPlacements(refs: string[], existing: Placement[]): Placement[] {
  const pitch = MIN_ORIGIN_SEPARATION_MM;
  const seeds: Placement[] = refs.map((ref, i) => ({
    ref,
    x: +(SHEET_AREA.left + pitch * (i + 1)).toFixed(2),
    y: +(SHEET_AREA.top + SHEET_AREA.height + pitch).toFixed(2),
    rotation: 0,
  }));
  const fixed = new Set(existing.map((p) => p.ref));
  const merged = [...existing.map((p) => ({ ...p })), ...seeds];
  const resolved = resolveOriginCollisions(merged, fixed);
  const byRef = new Map(resolved.map((p) => [p.ref, p]));
  return refs.map((ref) => byRef.get(ref)!);
}

function originDistance(a: Placement, b: Placement): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Deterministically separate symbol origins closer than
 * MIN_ORIGIN_SEPARATION_MM. Sorted by ref, nudged +x by one pitch with
 * row wrap inside SHEET_AREA. Refs in `fixed` are obstacles and are never
 * moved. Throws instead of emitting an overlapping layout. */
export function resolveOriginCollisions(placements: Placement[], fixed: Set<string> = new Set()): Placement[] {
  const out = placements.map((p) => ({ ...p }));
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const pitch = MIN_ORIGIN_SEPARATION_MM;
  const right = SHEET_AREA.left + SHEET_AREA.width;
  const bottom = SHEET_AREA.top + SHEET_AREA.height;
  out.forEach((current, index) => {
    if (fixed.has(current.ref)) return;
    let guard = 0;
    for (;;) {
      const clash = out.slice(0, index).some((other) => originDistance(current, other) < pitch - 1e-9);
      if (!clash) return;
      if (++guard > 500) {
        throw new Error(
          `Auto-layout cannot separate '${current.ref}' from its neighbours ` +
            `by ${pitch} mm inside the sheet area; specify explicit schematic coordinates or reduce the component count.`,
        );
      }
      current.x = +(current.x + pitch).toFixed(2);
      if (current.x > right) {
        current.x = +SHEET_AREA.left.toFixed(2);
        current.y = +(current.y + pitch).toFixed(2);
        if (current.y > bottom) current.y = +SHEET_AREA.top.toFixed(2);
      }
    }
  });
  return out;
}

export interface EndpointInput {
  ref: string;
  pin: string;
  net: string;
}

export interface EndpointCoordinate extends EndpointInput {
  x: number;
  y: number;
}

/** Rotate a symbol-local offset into schematic file coordinates.
 * Verified empirically against KiCad 10 `.kicad_sch` output: at rotation 0
 * the schematic pin base equals placement + lib offset with no axis flip
 * (Q_NMOS_GDS D at lib (2.54,5.08) + origin (218.44,92.71) = (220.98,97.79)
 * in the file). Rotations are clockwise-positive in file coordinates. */
export function pinOffsetToSchematic(
  placement: Placement,
  offset: { x: number; y: number },
): { x: number; y: number } {
  const rot = ((placement.rotation % 360) + 360) % 360;
  let dx = offset.x;
  let dy = offset.y;
  if (rot === 90) {
    dx = -offset.y;
    dy = offset.x;
  } else if (rot === 180) {
    dx = -offset.x;
    dy = -offset.y;
  } else if (rot === 270) {
    dx = offset.y;
    dy = -offset.x;
  } else if (rot !== 0) {
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    dx = offset.x * cos - offset.y * sin;
    dy = offset.x * sin + offset.y * cos;
  }
  return { x: placement.x + dx, y: placement.y + dy };
}

/** Absolute pin-base coordinates for every IR endpoint that has known
 * preflight offsets. Endpoints without offset data are skipped (the pin
 * verification step already rejects truly unknown pins). */
export function computeEndpointCoordinates(
  endpoints: EndpointInput[],
  placements: Map<string, Placement>,
  pinOffsets: Map<string, Map<string, PreflightPin>>,
): EndpointCoordinate[] {
  const out: EndpointCoordinate[] = [];
  for (const endpoint of endpoints) {
    const placement = placements.get(endpoint.ref);
    const offset = pinOffsets.get(endpoint.ref)?.get(endpoint.pin);
    if (!placement || !offset || offset.x === undefined || offset.y === undefined) continue;
    const absolute = pinOffsetToSchematic(placement, { x: offset.x, y: offset.y });
    out.push({ ...endpoint, x: +absolute.x.toFixed(2), y: +absolute.y.toFixed(2) });
  }
  return out;
}

export interface EndpointCollision {
  x: number;
  y: number;
  nets: string[];
  endpoints: EndpointInput[];
}

/** Group endpoints sharing one coordinate across DIFFERENT nets. Same-net
 * sharing is intentional (labels join by name); cross-net sharing is a
 * placement defect that would short the nets in KiCad. */
export function detectEndpointCollisions(coordinates: EndpointCoordinate[]): EndpointCollision[] {
  const groups = new Map<string, EndpointCoordinate[]>();
  for (const endpoint of coordinates) {
    const key = `${Math.round(endpoint.x / ENDPOINT_EPSILON_MM)}:${Math.round(endpoint.y / ENDPOINT_EPSILON_MM)}`;
    const group = groups.get(key);
    if (group) group.push(endpoint);
    else groups.set(key, [endpoint]);
  }
  const collisions: EndpointCollision[] = [];
  for (const group of groups.values()) {
    const nets = [...new Set(group.map((g) => g.net))].sort();
    if (nets.length < 2) continue;
    const xs = group.map((g) => g.x);
    const ys = group.map((g) => g.y);
    collisions.push({
      x: +((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(2),
      y: +((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(2),
      nets,
      endpoints: group.map((g) => ({ ref: g.ref, pin: g.pin, net: g.net })),
    });
  }
  collisions.sort((a, b) => a.x - b.x || a.y - b.y);
  return collisions;
}

export function formatCollisions(collisions: EndpointCollision[]): string {
  return collisions
    .slice(0, 8)
    .map(
      (c) =>
        `(${c.x},${c.y}) nets ${c.nets.join('+')}: ` +
        c.endpoints.map((e) => `${e.ref}:${e.pin}(${e.net})`).join(', '),
    )
    .join('; ');
}
