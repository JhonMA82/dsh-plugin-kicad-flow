// Level-1 manufacturing pack: Gerbers, Excellon drill, BOM, JLCPCB CPL,
// reproducible ZIP and a manifest with sha256 hashes.
//
// Policy notes:
// - Gerber layers are derived from the board itself (parsed copper layers),
//   never from a hardcoded per-vendor list.
// - KiCad 10 `kicad-cli pcb export pos` reports PosY = -boardY (Y inverted).
//   CPL transform is therefore a plain Y negation; rotation is passed through
//   verbatim (kicad-native convention, flagged in the manifest).
// - BOM grouping uses only declared IR properties (LCSC / JLCPCB_PN); part
//   numbers are never invented. Artifacts (#PWR / power:PWR_FLAG) and
//   excludeFromBom components are always excluded.
// - The ZIP is produced with python3 zipfile (no `zip` CLI on the host):
//   sorted entries, fixed 1980-01-01 timestamps => byte-reproducible.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { run } from './process.js';
import { PWR_FLAG_SYMBOL } from './artifacts.js';
import type { CircuitIR } from './ir.js';

export const PLUGIN_VERSION = '0.4.2';

/** Fallback copper set when the board could not be parsed (2-layer default). */
export const FALLBACK_COPPER_LAYERS = ['F.Cu', 'B.Cu'] as const;

/** Gerber layer derivation from the parsed board copper layers.
 * Front layers only when F.Cu exists; back layers only when B.Cu exists;
 * inner copper layers pass through; Edge.Cuts always included. */
export function deriveGerberLayers(copperLayers: string[]): string[] {
  const layers: string[] = [];
  const hasFront = copperLayers.includes('F.Cu');
  const hasBack = copperLayers.includes('B.Cu');
  if (hasFront) layers.push('F.Cu', 'F.Mask', 'F.SilkS', 'F.Paste');
  if (hasBack) layers.push('B.Cu', 'B.Mask', 'B.SilkS');
  for (const l of copperLayers) {
    if (l !== 'F.Cu' && l !== 'B.Cu' && !layers.includes(l)) layers.push(l);
  }
  layers.push('Edge.Cuts');
  return layers;
}

/** A component that exists only for electrical bookkeeping (KiCad power
 * artifacts use refs starting with '#' and the PWR_FLAG symbol). */
export function isArtifactComponent(c: { ref: string; symbol?: string }): boolean {
  return c.ref.startsWith('#') || c.symbol === PWR_FLAG_SYMBOL;
}

export interface BomRow {
  /** Grouped designators, comma-joined (e.g. "R1,R2"). */
  Designator: string;
  Comment: string;
  Footprint: string;
  Qty: number;
  /** Declared LCSC / JLCPCB_PN property only — never invented. */
  LCSC: string;
}

/** Build grouped BOM rows from the IR: functional components only (artifacts
 * and excludeFromBom excluded), grouped by Comment+Footprint+LCSC. */
export function bomRowsFromDesign(design: CircuitIR): BomRow[] {
  interface Group {
    refs: string[];
    comment: string;
    footprint: string;
    lcsc: string;
  }
  const groups = new Map<string, Group>();
  for (const c of design.components) {
    if (c.excludeFromBom || isArtifactComponent(c)) continue;
    const comment = c.value ?? c.symbol;
    const footprint = c.footprint ?? '';
    const lcsc = c.properties?.LCSC ?? c.properties?.JLCPCB_PN ?? '';
    const key = `${comment}\u0000${footprint}\u0000${lcsc}`;
    const g = groups.get(key);
    if (g) g.refs.push(c.ref);
    else groups.set(key, { refs: [c.ref], comment, footprint, lcsc });
  }
  return [...groups.values()].map((g) => ({
    Designator: g.refs.join(','),
    Comment: g.comment,
    Footprint: g.footprint,
    Qty: g.refs.length,
    LCSC: g.lcsc,
  }));
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toBomCsv(rows: BomRow[]): string {
  const header = 'Comment,Designator,Footprint,Qty,LCSC';
  return [
    header,
    ...rows.map((r) => [r.Comment, r.Designator, r.Footprint, r.Qty, r.LCSC].map(csvCell).join(',')),
  ].join('\n') + '\n';
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export interface CplRow {
  Designator: string;
  Val: string;
  Package: string;
  'Mid X': number;
  'Mid Y': number;
  Rotation: number;
  Layer: string;
}

/** Map KiCad pos CSV (KiCad 10: PosY = -boardY) to CPL rows. Y is negated
 * back to board coordinates; rotation is kept verbatim (kicad-native). */
export function parsePosCsv(csv: string, opts?: { excludeRefs?: string[] }): CplRow[] {
  const exclude = new Set(opts?.excludeRefs ?? []);
  const lines = csv.split(/\r?\n/).filter((x) => x.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]!).map((x) => x.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name.toLowerCase());
  const iRef = idx('Ref');
  const iVal = idx('Val');
  const iPackage = idx('Package');
  const iX = idx('PosX');
  const iY = idx('PosY');
  const iRot = idx('Rot');
  const iSide = idx('Side');
  if (iRef < 0 || iX < 0 || iY < 0) return [];
  return lines.slice(1).flatMap((line) => {
    const c = parseCsvLine(line);
    const ref = c[iRef] ?? '';
    if (!ref || ref.startsWith('#') || exclude.has(ref)) return [];
    return [{
      Designator: ref,
      Val: iVal >= 0 ? c[iVal] ?? '' : '',
      Package: iPackage >= 0 ? c[iPackage] ?? '' : '',
      'Mid X': Number(c[iX] ?? 0),
      'Mid Y': -Number(c[iY] ?? 0),
      Rotation: iRot >= 0 ? Number(c[iRot] ?? 0) : 0,
      Layer: (iSide >= 0 ? c[iSide] ?? '' : '').toLowerCase() === 'back' ? 'bottom' : 'top',
    }];
  });
}

export function toCplCsv(rows: CplRow[]): string {
  const header = 'Designator,Val,Package,Mid X,Mid Y,Rotation,Layer';
  return [
    header,
    ...rows.map((r) => [r.Designator, r.Val, r.Package, r['Mid X'], r['Mid Y'], r.Rotation, r.Layer].map(csvCell).join(',')),
  ].join('\n') + '\n';
}

export interface ManufacturingResult {
  outputDir: string;
  gerberZip?: string;
  bom?: string;
  cpl?: string;
  manifest?: string;
  drillFiles: string[];
  gerberFiles: string[];
}

/** Shape of the persisted pipeline state (.kicad-flow/state.json) needed by
 * the standalone Level-1 manufacturing gate. Kept structural so old states
 * simply fail the gate instead of crashing. */
export interface Level1GateState {
  schematic?: { reconciliation?: { ok?: boolean }; erc?: { errors?: number } };
  pcb?: { reconciliation?: { ok?: boolean } };
  routing?: {
    status?: string;
    reconciliation?: { unroutedCount?: number };
    finalDrc?: { errors?: number; warnings?: number; unconnected?: number };
  };
}
/** Level-1 manufacturing gate: returns every unmet condition (empty list =
 * gate passed). Mirrors the engine's compile-time manufacturing gate for
 * target 'manufacturing': the standalone pack only runs on a fully routed,
 * DRC-clean board. */
export function evaluateManufacturingGate(state: Level1GateState | undefined): string[] {
  const gateFails: string[] = [];
  if (!state?.schematic?.reconciliation?.ok) gateFails.push('schematic reconciliation did not pass');
  if (!state?.schematic?.erc) gateFails.push('ERC did not run');
  else if ((state.schematic.erc.errors ?? 0) > 0) gateFails.push(`ERC reports ${state.schematic.erc.errors} error(s)`);
  if (!state?.pcb?.reconciliation?.ok) gateFails.push('PCB reconciliation did not pass');
  if (state?.routing?.status !== 'complete') {
    gateFails.push(`routing phase is '${state?.routing?.status ?? 'pending'}', not complete`);
  }
  const routingRecon = state?.routing?.reconciliation;
  if (routingRecon && (routingRecon.unroutedCount ?? 0) !== 0) {
    gateFails.push(`routing reconciliation reports ${routingRecon.unroutedCount} unrouted endpoint(s)`);
  }
  const finalDrc = state?.routing?.finalDrc;
  if (!finalDrc) gateFails.push('final DRC did not run');
  else if ((finalDrc.errors ?? 0) > 0) gateFails.push(`final DRC reports ${finalDrc.errors} error(s)`);
  return gateFails;
}

export interface ManufacturingManifest {
  plugin: string;
  pluginVersion: string;
  project: string;
  createdAt: string;
  kicadVersion?: string;
  board: {
    widthMm?: number;
    heightMm?: number;
    copperLayers: string[];
    gerberLayers: string[];
  };
  drc?: string;
  cpl: {
    yTransform: string;
    rotationConvention: string;
  };
  files: Array<{ file: string; role: string; bytes: number; sha256: string }>;
}

/** Reproducible ZIP via python3 zipfile: sorted entries, fixed timestamps. */
async function writeReproducibleZip(outZip: string, files: Array<{ path: string; name: string }>): Promise<void> {
  const script = [
    'import sys, zipfile, os',
    'out = sys.argv[1]',
    'entries = sorted((a.split("=", 1) for a in sys.argv[2:]), key=lambda e: e[1])',
    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:',
    '    for path, name in entries:',
    '        zi = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))',
    '        zi.compress_type = zipfile.ZIP_DEFLATED',
    '        zi.external_attr = 0o644 << 16',
    '        with open(path, "rb") as f:',
    '            z.writestr(zi, f.read())',
  ].join('\n');
  await run('python3', ['-c', script, outZip, ...files.map((f) => `${f.path}=${f.name}`)]);
}

async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  const buf = await fs.readFile(path);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function kicadCliVersion(): Promise<string | undefined> {
  try {
    const out = await run('kicad-cli', ['--version']);
    return out.stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

async function assertNonEmpty(path: string, what: string): Promise<void> {
  const buf = await fs.readFile(path).catch(() => null);
  if (!buf || buf.length === 0) {
    throw new Error(`Manufacturing pack blocked: ${what} is empty or missing (${basename(path)}).`);
  }
}

export async function buildManufacturingPack(args: {
  projectName: string;
  projectDir: string;
  pcbPath: string;
  outputDir?: string;
  design?: CircuitIR;
  bomRows?: BomRow[];
  copperLayers?: string[];
  boardWidthMm?: number;
  boardHeightMm?: number;
  drcStatus?: string;
  excludeCplRefs?: string[];
  /** A board normally always drills holes (vias/THT); default true. */
  expectDrill?: boolean;
}): Promise<ManufacturingResult> {
  const outputDir = join(args.projectDir, args.outputDir ?? 'manufacturing');
  const gerberDir = join(outputDir, 'gerbers');
  await fs.mkdir(gerberDir, { recursive: true });

  const copperLayers = args.copperLayers?.length ? args.copperLayers : [...FALLBACK_COPPER_LAYERS];
  const layers = deriveGerberLayers(copperLayers);

  // Gerbers: plotted from the board's own layer set. --check-zones refuses to
  // plot when zone fills are stale (Level-1 DRC-consistency gate).
  await run('kicad-cli', [
    'pcb', 'export', 'gerbers', '--layers', layers.join(','), '--check-zones', '--output', gerberDir, args.pcbPath,
  ]);
  // KiCad emits Protel-named gerbers (gtl/gbl/gts/gbs/gto/gbo/gtp/gm1/gko);
  // accept .gbr too (generic extension used by some setups/tests).
  const gerberFiles = (await fs.readdir(gerberDir))
    .filter((f) => /\.(gbr|gtl|gbl|gts|gbs|gto|gbo|gtp|gm1|gko)$/i.test(f))
    .sort();
  for (const f of gerberFiles) await assertNonEmpty(join(gerberDir, f), `gerber ${f}`);

  // Drill: Excellon mm; every produced file must be non-empty and, when the
  // board is expected to have holes, at least one file must exist.
  await run('kicad-cli', [
    'pcb', 'export', 'drill', '--format', 'excellon', '--excellon-units', 'mm', '--output', gerberDir, args.pcbPath,
  ]);
  const drillFiles = (await fs.readdir(gerberDir)).filter((f) => f.endsWith('.drl')).sort();
  if (args.expectDrill !== false && drillFiles.length === 0) {
    throw new Error('Manufacturing pack blocked: drill export produced no Excellon files.');
  }
  for (const f of drillFiles) await assertNonEmpty(join(gerberDir, f), `drill ${f}`);

  // Component positions -> JLCPCB CPL (KiCad 10 pos Y is inverted: negate).
  const posPath = join(outputDir, 'positions.csv');
  await run('kicad-cli', [
    'pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', '--side', 'both',
    '--use-drill-file-origin', '--output', posPath, args.pcbPath,
  ]);
  const posCsv = await fs.readFile(posPath, 'utf8');
  const cplRows = parsePosCsv(posCsv, { excludeRefs: args.excludeCplRefs });
  const cplPath = join(outputDir, 'CPL.csv');
  await fs.writeFile(cplPath, toCplCsv(cplRows), 'utf8');

  // BOM: grouped functional components (rows prepared by the engine from the
  // IR; part numbers come from declared properties only).
  const bomRows = args.bomRows ?? (args.design ? bomRowsFromDesign(args.design) : undefined);
  let bomPath: string | undefined;
  if (bomRows?.length) {
    bomPath = join(outputDir, 'BOM.csv');
    await fs.writeFile(bomPath, toBomCsv(bomRows), 'utf8');
  }

  // Reproducible ZIP: gerbers + drill, sorted, fixed timestamps.
  const zipPath = join(outputDir, `${args.projectName}_Gerbers.zip`);
  const zipEntries = [
    ...gerberFiles.map((f) => ({ path: join(gerberDir, f), name: f })),
    ...drillFiles.map((f) => ({ path: join(gerberDir, f), name: f })),
  ];
  if (zipEntries.length) await writeReproducibleZip(zipPath, zipEntries);

  // Manifest: hashes over every produced artifact (relative to outputDir).
  const manifestFiles: ManufacturingManifest['files'] = [];
  const addFile = async (path: string, role: string): Promise<void> => {
    const { bytes, sha256 } = await sha256File(path);
    manifestFiles.push({ file: path.slice(outputDir.length + 1), role, bytes, sha256 });
  };
  for (const f of gerberFiles) await addFile(join(gerberDir, f), 'gerber');
  for (const f of drillFiles) await addFile(join(gerberDir, f), 'drill');
  await addFile(posPath, 'positions');
  await addFile(cplPath, 'cpl');
  if (bomPath) await addFile(bomPath, 'bom');
  if (zipEntries.length) await addFile(zipPath, 'gerber-zip');

  const manifest: ManufacturingManifest = {
    plugin: 'dsh-plugin-kicad-flow',
    pluginVersion: PLUGIN_VERSION,
    project: args.projectName,
    createdAt: new Date().toISOString(),
    kicadVersion: await kicadCliVersion(),
    board: {
      widthMm: args.boardWidthMm,
      heightMm: args.boardHeightMm,
      copperLayers: [...copperLayers],
      gerberLayers: layers,
    },
    drc: args.drcStatus,
    cpl: {
      yTransform: 'negate (KiCad 10 pos export reports PosY = -boardY)',
      rotationConvention: 'kicad-native (bottom-side rotation may need manual review)',
    },
    files: manifestFiles,
  };
  const manifestPath = join(outputDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return {
    outputDir,
    gerberZip: zipEntries.length ? zipPath : undefined,
    bom: bomPath,
    cpl: cplPath,
    manifest: manifestPath,
    drillFiles,
    gerberFiles,
  };
}
