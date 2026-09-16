import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { run } from './process.js';

export interface CheckIssue {
  type: string;
  severity: string;
  description: string;
  posMm?: { x: number; y: number };
}

export interface ErcReport {
  errors: number;
  warnings: number;
  violations: CheckIssue[];
}

export interface DrcReport {
  errors: number;
  warnings: number;
  unconnected: number;
  parity: number;
  violations: CheckIssue[];
  /** 0.3.0: schematic-parity findings kept separately (parseDrcJson never
   * mixed them into `violations`; additive field, v0.2.x consumers intact). */
  parityViolations?: CheckIssue[];
}

const UNIT_TO_MM: Record<string, number> = { mm: 1, in: 25.4, inch: 25.4, inches: 25.4, mil: 0.0254, mils: 0.0254 };

function issueFrom(raw: any, scale: number): CheckIssue {
  const p = raw?.items?.[0]?.pos ?? raw?.pos;
  return {
    type: String(raw?.type ?? 'unknown'),
    severity: String(raw?.severity ?? 'error').toLowerCase(),
    description: String(raw?.description ?? ''),
    posMm: p && typeof p.x === 'number' && typeof p.y === 'number'
      ? { x: +(p.x * scale).toFixed(3), y: +(p.y * scale).toFixed(3) }
      : undefined,
  };
}

export function parseErcJson(raw: string | object): ErcReport {
  const d: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // KiCad 10 has historically emitted ERC positions with an inconsistent unit
  // declaration on some builds. Prefer declared units when usable, otherwise mm.
  const units = String(d?.coordinate_units ?? 'mm').toLowerCase();
  const declaredScale = UNIT_TO_MM[units] ?? 1;
  // KiCad 10.0.0-10.0.6 has been observed reporting ERC positions in inches
  // while declaring coordinate_units=mm. This only affects diagnostics, not
  // pass/fail counts, but keep the proven compatibility workaround.
  const kicadVersion = String(d?.kicad_version ?? '');
  const positionScale = units === 'mm' && /^10\.0\.[0-6](?:\D|$)/.test(kicadVersion) ? 25.4 : declaredScale;
  const violations: CheckIssue[] = [];
  for (const sheet of Array.isArray(d?.sheets) ? d.sheets : []) {
    for (const v of Array.isArray(sheet?.violations) ? sheet.violations : []) {
      violations.push(issueFrom(v, positionScale));
    }
  }
  return {
    errors: violations.filter((v) => v.severity === 'error').length,
    warnings: violations.filter((v) => v.severity === 'warning').length,
    violations,
  };
}

export function parseDrcJson(raw: string | object): DrcReport {
  const d: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const scale = UNIT_TO_MM[String(d?.coordinate_units ?? 'mm').toLowerCase()] ?? 1;
  const direct = (Array.isArray(d?.violations) ? d.violations : []).map((v: any) => issueFrom(v, scale));
  const unconnectedItems = Array.isArray(d?.unconnected_items) ? d.unconnected_items : [];
  const parityItems = Array.isArray(d?.schematic_parity) ? d.schematic_parity : [];
  return {
    errors: direct.filter((v: CheckIssue) => v.severity === 'error').length,
    warnings: direct.filter((v: CheckIssue) => v.severity === 'warning').length,
    unconnected: Math.max(unconnectedItems.length, typeof d?.unconnected_items_count === 'number' ? d.unconnected_items_count : 0),
    parity: parityItems.length,
    violations: direct,
    parityViolations: parityItems.map((v: any) => issueFrom(v, scale)),
  };
}

/** Run ERC and return the parsed report without throwing. Read-only callers
 * (kicad_flow_pcb_preflight) report the result; runErc adds the 0-error gate. */
export async function ercReport(projectDir: string, schematicPath: string): Promise<ErcReport> {
  const out = join(projectDir, '.kicad-flow', 'erc.json');
  await fs.mkdir(join(projectDir, '.kicad-flow'), { recursive: true });
  await run('kicad-cli', [
    'sch', 'erc', '--format', 'json', '--severity-error', '--severity-warning', '-o', out, schematicPath,
  ]);
  return parseErcJson(await fs.readFile(out, 'utf8'));
}

export async function runErc(projectDir: string, schematicPath: string): Promise<ErcReport> {
  const report = await ercReport(projectDir, schematicPath);
  if (report.errors > 0) {
    const details = report.violations
      .filter((x) => x.severity === 'error')
      .slice(0, 20)
      .map((x) => `${x.type}: ${x.description}`)
      .join('\n');
    throw new Error(`ERC blocked the pipeline: ${report.errors} error(s).\n${details}`);
  }
  return report;
}

export async function runDrc(projectDir: string, pcbPath: string): Promise<DrcReport> {
  const out = join(projectDir, '.kicad-flow', 'drc.json');
  await fs.mkdir(join(projectDir, '.kicad-flow'), { recursive: true });
  await run('kicad-cli', [
    'pcb', 'drc', '--format', 'json', '--schematic-parity', '--refill-zones',
    '--severity-error', '--severity-warning', '-o', out, pcbPath,
  ]);
  const report = parseDrcJson(await fs.readFile(out, 'utf8'));
  const blocking = report.errors + report.unconnected + report.parity;
  if (blocking > 0) {
    throw new Error(
      `DRC blocked the pipeline: ${report.errors} error(s), ${report.unconnected} unconnected, ${report.parity} parity issue(s).`,
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// 0.3.0: classified DRC for the PCB foundation target
// ---------------------------------------------------------------------------

export interface DrcClassification {
  /** Structural violations (severity error): copper/clearance/geometry. */
  structuralErrors: CheckIssue[];
  /** Schematic-parity findings: board differs from the schematic. */
  parityIssues: CheckIssue[];
  /** Unrouted connections. Reported, never auto-routed (0.3.0 has no
   * routing step); they do not block the foundation. */
  unroutedCount: number;
  /** True when the PCB foundation must stop (structural/parity). */
  blocking: boolean;
  blockingReason?: string;
}

/** Separate unrouted connections from structural DRC errors. `unrouted` is
 * the expected state right after deterministic placement (0.3.0 places but
 * does not route); structural errors and parity *errors* block. Parity
 * warnings are reported (never silently dropped): KiCad 10 emits cosmetic
 * parity warnings here (sheet-prefix notation `X` vs `/X` on pad nets,
 * `Description` field differences) that are not electrical conflicts. */
export function classifyDrc(report: DrcReport): DrcClassification {
  const structuralErrors = report.violations.filter((v) => v.severity === 'error');
  const parityIssues = report.parityViolations ?? [];
  const parityErrors = parityIssues.filter((v) => v.severity === 'error');
  const blocking = structuralErrors.length > 0 || parityErrors.length > 0;
  const reason = blocking
    ? [
        structuralErrors.length
          ? `${structuralErrors.length} structural DRC error(s): ${structuralErrors.slice(0, 10).map((v) => v.type).join(', ')}`
          : '',
        parityErrors.length ? `${parityErrors.length} schematic-parity error(s)` : '',
      ]
        .filter(Boolean)
        .join('; ')
    : undefined;
  return {
    structuralErrors,
    parityIssues,
    unroutedCount: report.unconnected,
    blocking,
    blockingReason: reason,
  };
}

export async function runDrcClassified(projectDir: string, pcbPath: string): Promise<{ report: DrcReport; classification: DrcClassification }> {
  const out = join(projectDir, '.kicad-flow', 'drc.json');
  await fs.mkdir(join(projectDir, '.kicad-flow'), { recursive: true });
  await run('kicad-cli', [
    'pcb', 'drc', '--format', 'json', '--schematic-parity', '--refill-zones',
    '--severity-error', '--severity-warning', '-o', out, pcbPath,
  ]);
  const report = parseDrcJson(await fs.readFile(out, 'utf8'));
  const classification = classifyDrc(report);
  if (classification.blocking) {
    throw new Error(
      `DRC blocked the PCB pipeline: ${classification.blockingReason}. ` +
        `Unrouted connections (reported, not blocking): ${classification.unroutedCount}.`,
    );
  }
  return { report, classification };
}
