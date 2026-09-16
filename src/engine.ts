import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CircuitIR, CircuitNetPin, CompileTarget, ZoneSpec } from './ir.js';
import { validateAndNormalizeIR } from './ir.js';
import {
  parseFootprintPads,
  resolveFootprintLibs,
  resolveFootprintPath,
  type FootprintPreflightIssue,
} from './footprint-preflight.js';
import {
  PWR_FLAG_PIN,
  PWR_FLAG_SYMBOL,
  PWR_FLAG_VALUE,
  expectedPowerFlags,
  type ExpectedArtifact,
} from './artifacts.js';
import {
  artifactPlacements,
  computeEndpointCoordinates,
  detectEndpointCollisions,
  formatCollisions,
  schematicPlacements,
  type Placement,
} from './layout.js';
import type { McpBridge, McpCallResult } from './mcp-bridge.js';
import { explicitNetclasses } from './netclasses.js';
import {
  formatRoutingReconciliation,
  formatZoneIssues,
  parseRoutingBoard,
  reconcileRoutingDesign,
  reconcileZones,
  routingBackend,
  type RouteResult,
  type RoutingBackend,
  type RoutingBoardSnapshot,
  type RoutingReconciliationReport,
  type ZoneReconciliationReport,
} from './routing.js';
import { buildManufacturingPack, type BomRow, type ManufacturingResult } from './manufacturing.js';
import {
  formatUnknownPins,
  normalizePinId,
  parseSymbolPinPreflight,
  verifyDesignPins,
  type PreflightPin,
  type PreflightSymbol,
} from './pin-data.js';
import {
  computePcbPlacements,
  detectPadCollisions,
  formatPcbReconciliation,
  parseKicadPcb,
  pcbFootprintRequirements,
  reconcilePcbDesign,
  type PcbReconciliationReport,
  type PcbSnapshot,
} from './pcb.js';
import {
  inspectSchematicNetlist,
  reconcileDesignToSnapshot,
  type EndpointIssue,
  type ReconciliationReport,
  type SnapshotProvider,
} from './reconciliation.js';
import { runDrcClassified, runErc, ercReport, type DrcReport, type ErcReport } from './verification.js';

export interface EngineConfig {
  projectDir: string;
  freeroutingJar?: string;
  componentBatchSize?: number;
  connectionBatchSize?: number;
  inspectSchematic?: SnapshotProvider;
  /** Read-only provider for the PCB snapshot. Default: parse the .kicad_pcb
   * file from disk (parseKicadPcb). Tests inject a provider. */
  inspectPcb?: (pcbPath: string) => Promise<PcbSnapshot>;
  /** Read-only provider for the routing snapshot (tracks/vias/zones/outline).
   * Default: parseRoutingBoard over the .kicad_pcb file. Tests inject one. */
  inspectRouting?: (pcbPath: string) => Promise<RoutingBoardSnapshot>;
}

export interface CompileOptions {
  target?: CompileTarget;
  forceRebuild?: boolean;
  /** Deprecated in 0.3.0: the PCB foundation never autoroutes. Kept for
   * call compatibility; declared-but-unrouted boards are reported. */
  skipAutoroute?: boolean;
  skipVerification?: boolean;
}

export type SchematicStatus =
  | 'pending'
  | 'in_progress'
  | 'unknown_after_timeout'
  | 'failed'
  | 'reconciled'
  | 'complete';

export interface PipelineOperation {
  tool: string;
  kind: 'preflight' | 'components' | 'connections' | 'no_connects' | 'reconcile' | 'erc'
    | 'board_create' | 'board_size' | 'board_place' | 'pcb_reconcile' | 'drc'
    | 'routing_export' | 'routing_cli' | 'routing_import' | 'routing_reconcile'
    | 'zone_add' | 'zone_refill' | 'zone_reconcile' | 'final_drc' | 'manufacturing';
  chunk?: number;
  status: 'in_progress' | 'confirmed' | 'unknown_after_timeout' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface SchematicProgress {
  status: SchematicStatus;
  confirmedComponentRefs: string[];
  confirmedNetNames: string[];
  reconciliation?: ReconciliationReport;
  /** 0.4.0: ERC report persisted so the manufacturing gate can verify ERC
   * PASS on multi-call chains (schematic phase already complete). */
  erc?: ErcReport;
  lastOperation?: PipelineOperation;
}

/** 0.3.0 PCB foundation progress. Additive extension of state v2: older
 * states without this field keep loading (schematic phase untouched). */
export type PcbStatus =
  | 'pending'
  | 'preflight'
  | 'footprints_resolved'
  | 'board_created'
  | 'placed'
  | 'reconciled'
  | 'drc_checked'
  | 'complete'
  | 'unknown_after_timeout'
  | 'failed';

export interface PcbProgress {
  status: PcbStatus;
  confirmedFootprintRefs: string[];
  confirmedNetNames: string[];
  reconciliation?: PcbReconciliationReport;
  drc?: DrcReport;
  deferred?: string[];
  lastOperation?: PipelineOperation;
}

/** 0.4.0 Level-1 routing + zones progress. Independent from schematic/pcb:
 * a routing failure never invalidates a PASS on the earlier phases. */
export type RoutingStatus =
  | 'pending'
  | 'preflight'
  | 'exported'
  | 'in_progress'
  | 'imported'
  | 'zones_placed'
  | 'zones_filled'
  | 'reconciled'
  | 'complete'
  | 'incomplete'
  | 'unknown_after_timeout'
  | 'failed';

export interface RoutingProgress {
  status: RoutingStatus;
  backend?: string;
  /** DSN/SES artifacts kept as diagnostics. */
  dsnPath?: string;
  sesPath?: string;
  tracks?: number;
  vias?: number;
  reconciliation?: RoutingReconciliationReport;
  zones?: ZoneReconciliationReport;
  finalDrc?: DrcReport;
  lastOperation?: PipelineOperation;
}

/** 0.4.0 manufacturing phase. FAIL here must not invalidate a PASS on
 * schematic/pcb/routing (independent phases in state v3). */
export type ManufacturingStatus =
  | 'pending'
  | 'complete'
  | 'unknown_after_timeout'
  | 'failed';

export interface ManufacturingProgress {
  status: ManufacturingStatus;
  outputDir?: string;
  manifest?: Record<string, unknown>;
  /** Full pack result kept in state for reused=true responses. */
  result?: ManufacturingResult;
  lastOperation?: PipelineOperation;
}

export interface PipelineState {
  version: 3;
  projectName: string;
  designHash: string;
  /** Per-phase fingerprints: schematic = electrical IR, pcb = schematic +
   * footprints + board constraints, routing = PCB placement + routing rules
   * + router config, manufacturing = routed PCB + output profile. A phase
   * is only reused when its fingerprint is unchanged. */
  fingerprints?: Record<string, string>;
  completed: CompileTarget[];
  updatedAt: string;
  artifacts: Record<string, string>;
  schematic: SchematicProgress;
  pcb?: PcbProgress;
  routing?: RoutingProgress;
  manufacturing?: ManufacturingProgress;
}

export interface CompileResult {
  projectDir: string;
  projectFile: string;
  schematicFile: string;
  pcbFile: string;
  target: CompileTarget;
  designHash: string;
  reused: boolean;
  warnings: Array<{ path: string; message: string }>;
  mcpCalls: string[];
  reconciliation?: ReconciliationReport;
  erc?: ErcReport;
  drc?: DrcReport;
  pcbReconciliation?: PcbReconciliationReport;
  /** Board features intentionally NOT executed by the 0.3.0 foundation
   * (autoroute, copper pours, layer-stack changes...), reported instead of
   * silently applied. */
  deferred?: string[];
  routing?: RoutingReconciliationReport & { backend?: string; tracks?: number; vias?: number };
  zones?: ZoneReconciliationReport;
  routingFinalDrc?: DrcReport;
  manufacturing?: ManufacturingResult;
  /** Set on target manufacturing when every Level-1 gate passed. */
  level1Complete?: boolean;
}

interface ConnectionTask extends EndpointIssue {
  net: string;
  global: boolean;
}

/** 0.2.6: deterministic label transport for every net. See the
 * batch_connect call site for the field-failure rationale. */
const CONNECTION_LABEL_TYPE = 'label' as const;

function hashDesign(design: CircuitIR): string {
  return createHash('sha256').update(JSON.stringify(design)).digest('hex').slice(0, 16);
}

async function exists(path: string): Promise<boolean> {
  try { await fs.access(path); return true; } catch { return false; }
}

function targetRank(t: CompileTarget): number {
  // Legacy alias: 'board' keeps its historical meaning (placed board, no
  // routing). 'routed' extends the chain; 'manufacturing' completes it.
  return t === 'schematic' ? 1 : t === 'pcb' || t === 'board' ? 2 : t === 'routed' ? 3 : 4;
}

function chunks<T>(items: T[], size: number): T[][] {
  const actual = Math.max(1, Math.trunc(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += actual) out.push(items.slice(i, i + actual));
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown): boolean {
  return /timed?\s*out|timeout|request timed out/i.test(errorMessage(error));
}

function hasUnsafeReconciliation(report: ReconciliationReport): string | undefined {
  if (report.duplicateReferences.length) return `duplicate reference(s): ${report.duplicateReferences.join(', ')}`;
  if (report.unexpectedComponents.length) return `unexpected component(s): ${report.unexpectedComponents.join(', ')}`;
  const badNets = report.netIssues.filter((n) => n.unexpectedEndpoints.length > 0);
  if (badNets.length) return `unexpected endpoint(s) on net(s): ${badNets.map((n) => n.name).join(', ')}`;
  if (report.unexpectedUnconnected.length) {
    return `unexpected unconnected pin(s): ${report.unexpectedUnconnected.slice(0, 12).map((n) => `${n.ref}:${n.pinFunction ?? n.pin}`).join(', ')}`;
  }
  if (report.unexpectedArtifacts.length) {
    return `unexpected compiler artifact(s): ${report.unexpectedArtifacts.slice(0, 8).join(', ')}`;
  }
  return undefined;
}

/** Component-phase invariant subset (0.4.1). Before the connection phase
 * starts, IR nets cannot exist in the netlist yet, except for intrinsic
 * symbol shorts: some official symbols (e.g. Relay:G5V-1) place two pins at
 * the same position (duplicated COM), which KiCad auto-names as a real
 * 2-node net (`Net-(ref-PadN)`) the moment the symbol is placed. Those nets
 * are absorbed into the labeled net once batch_connect runs, so netIssues
 * at component checkpoints are pre-connection artifacts, not errors. */
function hasUnsafeComponentState(report: ReconciliationReport): string | undefined {
  if (report.duplicateReferences.length) return `duplicate reference(s): ${report.duplicateReferences.join(', ')}`;
  if (report.unexpectedComponents.length) return `unexpected component(s): ${report.unexpectedComponents.join(', ')}`;
  return undefined;
}

/** Routing idempotency fingerprint: PCB placement (footprint positions and
 * pad nets), the IR routing/zone/board rules and the resolved netclasses.
 * A change in any of them invalidates the previous routing result. */
function routingFingerprint(design: CircuitIR, snapshot: PcbSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    placement: snapshot.components
      .map((c) => ({
        ref: c.ref, x: c.x, y: c.y, rotation: c.rotation, layer: c.layer,
        pads: c.pads.map((p) => ({ pad: p.pad, net: p.net ?? null })),
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    routing: design.board?.routing ?? null,
    zones: design.zones ?? [],
    board: design.board
      ? {
          widthMm: design.board.widthMm,
          heightMm: design.board.heightMm,
          clearanceMm: design.board.clearanceMm,
          trackWidthMm: design.board.trackWidthMm,
          viaDiameterMm: design.board.viaDiameterMm,
          viaDrillMm: design.board.viaDrillMm,
        }
      : null,
    netclasses: explicitNetclasses(design),
  })).digest('hex').slice(0, 16);
}

function routingSummary(state: PipelineState | undefined): CompileResult['routing'] {
  const r = state?.routing;
  if (!r?.reconciliation) return undefined;
  return {
    ...r.reconciliation,
    backend: r.backend,
    tracks: r.tracks ?? r.reconciliation.tracks,
    vias: r.vias ?? r.reconciliation.vias,
  };
}

/** PCB phase fingerprint: IR identity + the footprint set actually confirmed
 * on the board. Drift means footprints or board constraints changed. */
function pcbFingerprint(design: CircuitIR, state: PipelineState): string {
  return createHash('sha256').update(JSON.stringify({
    designHash: state.designHash,
    confirmedFootprintRefs: state.pcb?.confirmedFootprintRefs ?? [],
  })).digest('hex').slice(0, 16);
}

/** Manufacturing phase fingerprint: the routed board identity + output
 * profile. Drift means the routing result or output settings changed. */
function manufacturingFingerprint(design: CircuitIR, state: PipelineState): string | undefined {
  const routing = state.fingerprints?.routing;
  if (!routing) return undefined;
  return createHash('sha256').update(JSON.stringify({
    routing,
    outputDir: design.manufacturing?.outputDir ?? null,
    gerberZip: design.manufacturing?.gerberZip ?? null,
    bom: design.manufacturing?.bom ?? null,
    cpl: design.manufacturing?.cpl ?? null,
  })).digest('hex').slice(0, 16);
}

function manufacturingResultFromState(state: PipelineState | undefined): ManufacturingResult | undefined {
  const m = state?.manufacturing;
  return m?.status === 'complete' ? m.result : undefined;
}

function reportProgress(
  design: CircuitIR,
  report: ReconciliationReport,
  artifacts: ExpectedArtifact[] = [],
): Pick<SchematicProgress, 'confirmedComponentRefs' | 'confirmedNetNames'> {
  const missing = new Set(report.missingComponents);
  const missingArtifacts = new Set(report.missingArtifacts);
  const brokenNets = new Set(report.netIssues.map((n) => n.name));
  return {
    confirmedComponentRefs: [
      ...design.components.map((c) => c.ref).filter((ref) => !missing.has(ref)),
      ...artifacts.map((a) => a.ref).filter((ref) => !missingArtifacts.has(ref)),
    ],
    confirmedNetNames: design.nets.map((n) => n.name).filter((name) => !brokenNets.has(name)),
  };
}

export class KiCadFlowEngine {
  private readonly inspectSchematic: SnapshotProvider;
  private readonly inspectPcb: (pcbPath: string) => Promise<PcbSnapshot>;
  private readonly inspectRouting: (pcbPath: string) => Promise<RoutingBoardSnapshot>;
  private readonly componentBatchSize: number;
  private readonly connectionBatchSize: number;

  constructor(private readonly bridge: McpBridge, private readonly config: EngineConfig) {
    this.inspectSchematic = config.inspectSchematic ?? inspectSchematicNetlist;
    this.inspectPcb = config.inspectPcb ?? (async (pcbPath) => parseKicadPcb(await fs.readFile(pcbPath, 'utf8')));
    this.inspectRouting = config.inspectRouting
      ?? (async (pcbPath) => parseRoutingBoard(await fs.readFile(pcbPath, 'utf8')));
    this.componentBatchSize = config.componentBatchSize ?? 12;
    this.connectionBatchSize = config.connectionBatchSize ?? 16;
  }

  private testRoutingBackend?: RoutingBackend;
  private manufacturingTestOptions?: { expectDrill?: boolean };

  /** Test seam ONLY (never used by production code): replace the freerouting
   * backend with a deterministic fake so unit tests drive the routing stage
   * without java. Mirrors the inspectPcb/inspectRouting injection pattern. */
  setRoutingBackendForTest(backend: RoutingBackend): void {
    this.testRoutingBackend = backend;
  }

  /** Test seam ONLY: manufacturing pack overrides (e.g. expectDrill=false for
   * boards the fake pipeline builds without holes). */
  enableManufacturingForTest(options: { expectDrill?: boolean }): void {
    this.manufacturingTestOptions = options;
  }

  private get routingBackendInstance(): RoutingBackend {
    return this.testRoutingBackend ?? routingBackend('freerouting', this.bridge, this.config.freeroutingJar);
  }

  async reconcile(input: unknown): Promise<{ design: CircuitIR; report: ReconciliationReport; schematicFile: string }> {
    const vr = validateAndNormalizeIR(input);
    if (!vr.ok || !vr.design) {
      const msg = vr.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
      throw new Error(`Circuit IR is invalid:\n${msg}`);
    }
    const design = vr.design;
    const schematicFile = join(resolve(this.config.projectDir), design.project.name, `${design.project.name}.kicad_sch`);
    if (!(await exists(schematicFile))) throw new Error(`Schematic does not exist: ${schematicFile}`);
    const artifacts = expectedPowerFlags(design);
    const report = reconcileDesignToSnapshot(design, await this.inspectSchematic(schematicFile), artifacts);
    return { design, report, schematicFile };
  }

  async compile(input: unknown, options: CompileOptions = {}): Promise<CompileResult> {
    const vr = validateAndNormalizeIR(input);
    if (!vr.ok || !vr.design) {
      const msg = vr.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
      throw new Error(`Circuit IR is invalid:\n${msg}`);
    }
    const design = vr.design;
    const target = options.target ?? 'board';
    const root = resolve(this.config.projectDir);
    const projectDir = join(root, design.project.name);
    const stateDir = join(projectDir, '.kicad-flow');
    const statePath = join(stateDir, 'state.json');
    const designPath = join(stateDir, 'design.json');
    const projectFile = join(projectDir, `${design.project.name}.kicad_pro`);
    const schematicFile = join(projectDir, `${design.project.name}.kicad_sch`);
    const pcbFile = join(projectDir, `${design.project.name}.kicad_pcb`);
    const designHash = hashDesign(design);
    const calls: string[] = [];

    await fs.mkdir(root, { recursive: true });
    let previous: any;
    if (await exists(statePath)) {
      try { previous = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch { previous = undefined; }
    }

    if (options.forceRebuild) {
      await this.backupGeneratedFiles(projectDir, design.project.name);
      previous = undefined;
    } else if (previous?.designHash && previous.designHash !== designHash && await exists(projectFile)) {
      throw new Error(
        `Existing project was generated from a different Circuit IR (${previous.designHash} != ${designHash}). ` +
        `Use forceRebuild=true only after explicitly deciding to replace the existing generated state.`,
      );
    }

    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(designPath, JSON.stringify(design, null, 2) + '\n', 'utf8');

    // 0.4.0: state v3 is loadable from v2 (v2 states simply have no
    // routing/manufacturing phases yet; both require the same designHash).
    const trustedPrevious = (previous?.version === 2 || previous?.version === 3) && previous?.designHash === designHash
      ? previous as PipelineState
      : undefined;
    const already = trustedPrevious?.completed ?? [];

    // Checkpoint guards: an unknown/failed phase must never trigger more
    // mutations. Reconcile read-only or decide forceRebuild explicitly.
    const pcbStatus = trustedPrevious?.pcb?.status;
    if (target !== 'schematic' && (pcbStatus === 'unknown_after_timeout' || pcbStatus === 'failed')) {
      throw new Error(
        `PCB pipeline is in '${pcbStatus}' state (last operation: ${trustedPrevious!.pcb!.lastOperation?.tool ?? 'n/a'}). ` +
          'Run kicad_flow_pcb_reconcile to inspect the real board, or decide an explicit forceRebuild. ' +
          'Refusing to continue automatically.',
      );
    }
    const routingStatus = trustedPrevious?.routing?.status;
    if (targetRank(target) >= 3 && (routingStatus === 'unknown_after_timeout' || routingStatus === 'failed' || routingStatus === 'incomplete')) {
      throw new Error(
        `Routing pipeline is in '${routingStatus}' state (last operation: ${trustedPrevious!.routing!.lastOperation?.tool ?? 'n/a'}). ` +
          'Run kicad_flow_routing_reconcile to inspect the real board, or decide an explicit forceRebuild. ' +
          'Refusing to continue automatically.',
      );
    }
    const manufacturingStatus = trustedPrevious?.manufacturing?.status;
    if (target === 'manufacturing' && (manufacturingStatus === 'unknown_after_timeout' || manufacturingStatus === 'failed')) {
      throw new Error(
        `Manufacturing pipeline is in '${manufacturingStatus}' state (last operation: ${trustedPrevious!.manufacturing!.lastOperation?.tool ?? 'n/a'}). ` +
          'Inspect the manufacturing output directory, or decide an explicit forceRebuild. Refusing to continue automatically.',
      );
    }

    const reusable = already.some((x) => targetRank(x) >= targetRank(target));
    if (reusable) {
      return {
        projectDir, projectFile, schematicFile, pcbFile, target, designHash, reused: true,
        warnings: vr.warnings, mcpCalls: [],
        reconciliation: trustedPrevious?.schematic?.reconciliation,
        pcbReconciliation: trustedPrevious?.pcb?.reconciliation,
        drc: trustedPrevious?.pcb?.drc,
        deferred: trustedPrevious?.pcb?.deferred,
        routing: routingSummary(trustedPrevious),
        zones: trustedPrevious?.routing?.zones,
        routingFinalDrc: trustedPrevious?.routing?.finalDrc,
        manufacturing: manufacturingResultFromState(trustedPrevious),
        level1Complete: trustedPrevious?.completed?.includes('manufacturing'),
      };
    }

    await this.bridge.start();
    if (options.forceRebuild && this.bridge.hasTool('close_project')) {
      await this.call('close_project', { save: false }, calls);
    }

    if (!(await exists(projectFile))) {
      await this.call('create_project', { path: projectDir, name: design.project.name }, calls);
    } else {
      await this.bridge.callIfAvailable('open_project', { filename: projectFile });
      if (this.bridge.hasTool('open_project')) calls.push('open_project');
    }

    let state: PipelineState = trustedPrevious ?? {
      version: 3,
      projectName: design.project.name,
      designHash,
      completed: [],
      updatedAt: new Date().toISOString(),
      artifacts: { design: designPath, schematic: schematicFile },
      schematic: { status: 'pending', confirmedComponentRefs: [], confirmedNetNames: [] },
      pcb: { status: 'pending', confirmedFootprintRefs: [], confirmedNetNames: [] },
      routing: { status: 'pending' },
      manufacturing: { status: 'pending' },
    };
    // v2 → v3 migration: the 0.3.0 phases carry no routing/manufacturing
    // progress; add them once, on load, so every write keeps state v3.
    if (!state.routing) state.routing = { status: 'pending' };
    if (!state.manufacturing) state.manufacturing = { status: 'pending' };
    state.version = 3;
    await this.writeState(statePath, state);

    let erc: ErcReport | undefined;
    let reconciliation = state.schematic.reconciliation;
    if (!state.completed.includes('schematic')) {
      reconciliation = await this.compileSchematic(design, schematicFile, statePath, state, calls);
      if (!options.skipVerification) {
        const op = this.beginOperation('kicad-cli sch erc', 'erc');
        state.schematic.status = 'in_progress';
        state.schematic.lastOperation = op;
        await this.writeState(statePath, state);
        try {
          erc = await runErc(projectDir, schematicFile);
          state.schematic.erc = erc;
          state.schematic.lastOperation = this.confirmOperation(op);
        } catch (error) {
          state.schematic.status = 'failed';
          state.schematic.lastOperation = this.failOperation(op, error, false);
          await this.writeState(statePath, state);
          throw error;
        }
      }
      state.schematic.status = 'complete';
      state.schematic.reconciliation = reconciliation;
      state.completed = ['schematic'];
      state.artifacts = { design: designPath, schematic: schematicFile };
      await this.writeState(statePath, state);
    }
    if (target === 'schematic') {
      return { projectDir, projectFile, schematicFile, pcbFile, target, designHash, reused: false, warnings: vr.warnings, mcpCalls: calls, reconciliation, erc };
    }

    // 0.3.0 PCB foundation: footprint resolution → board creation → net
    // transfer → deterministic placement → PCB reconciliation → classified
    // DRC → STOP. No autorouting, no copper pours, no placement optimization.
    let drc: DrcReport | undefined;
    let pcbReconciliation: PcbReconciliationReport | undefined;
    let deferred: string[] = [];
    if (!state.completed.includes('pcb') && !state.completed.includes('board')) {
      const pcb = await this.compilePcb(design, projectDir, projectFile, schematicFile, pcbFile, statePath, state, calls, options);
      pcbReconciliation = pcb.reconciliation;
      drc = pcb.drc;
      deferred = pcb.deferred;
      const priorCompleted = state.completed.filter((t) => t === 'board');
      state.completed = [...priorCompleted, 'schematic', 'pcb'];
      state.artifacts = { design: designPath, schematic: schematicFile, pcb: pcbFile };
      state.fingerprints = { ...state.fingerprints, pcb: pcbFingerprint(design, state) };
      await this.writeState(statePath, state);
    } else {
      pcbReconciliation = state.pcb?.reconciliation;
      drc = state.pcb?.drc;
      deferred = state.pcb?.deferred ?? [];
    }
    if (target === 'pcb' || target === 'board') {
      return { projectDir, projectFile, schematicFile, pcbFile, target, designHash, reused: false, warnings: vr.warnings, mcpCalls: calls, reconciliation, erc, drc, pcbReconciliation, deferred };
    }

    // 0.4.0 Level-1: routing (freerouting backend) + explicit copper zones +
    // final DRC gate. Unrouted = 0 and DRC errors = 0 to advance.
    const routed = await this.compileRouted(design, projectDir, projectFile, schematicFile, pcbFile, statePath, state, calls, options);
    state.completed = [...new Set([...state.completed, 'routed' as CompileTarget])];
    state.artifacts.routing = `${projectDir}/.kicad-flow/routing`;
    await this.writeState(statePath, state);
    if (target === 'routed') {
      return {
        projectDir, projectFile, schematicFile, pcbFile, target, designHash, reused: false,
        warnings: vr.warnings, mcpCalls: calls, reconciliation, erc, drc, pcbReconciliation, deferred,
        routing: routed.routing, zones: routed.zones, routingFinalDrc: routed.finalDrc,
      };
    }

    // Manufacturing gate: STOP unless every Level-1 gate passed.
    const routingRecon = state.routing?.reconciliation;
    const finalDrc = state.routing?.finalDrc;
    const ercReport = erc ?? state.schematic.erc;
    const gateFails: string[] = [];
    if (!state.schematic.reconciliation?.ok) gateFails.push('schematic reconciliation did not pass');
    if (!ercReport) gateFails.push('ERC did not run');
    else if (ercReport.errors > 0) gateFails.push(`ERC reports ${ercReport.errors} error(s)`);
    if (!state.pcb?.reconciliation?.ok) gateFails.push('PCB reconciliation did not pass');
    if (state.routing?.status !== 'complete') gateFails.push(`routing phase is '${state.routing?.status ?? 'pending'}', not complete`);
    if (routingRecon && routingRecon.unroutedCount !== 0) gateFails.push(`routing reconciliation reports ${routingRecon.unroutedCount} unrouted endpoint(s)`);
    if (!finalDrc) gateFails.push('final DRC did not run');
    else if (finalDrc.errors > 0) gateFails.push(`final DRC reports ${finalDrc.errors} error(s)`);
    if (gateFails.length) {
      throw new Error(
        'Manufacturing gate blocked: ' + gateFails.join('; ') +
          '. Gerbers/drill/BOM/CPL are only produced after a fully routed, DRC-clean Level-1 board.',
      );
    }

    const manufacturing = await this.manufacture(design, projectDir, pcbFile, statePath, state, calls);
    state.completed = [...new Set([...state.completed, 'manufacturing' as CompileTarget])];
    const manufacturingFp = manufacturingFingerprint(design, state);
    if (!manufacturingFp) {
      throw new Error('Manufacturing fingerprint unavailable: routing phase fingerprint is missing from state.');
    }
    state.fingerprints = { ...state.fingerprints, manufacturing: manufacturingFp };
    state.artifacts = {
      design: designPath,
      schematic: schematicFile,
      pcb: pcbFile,
      manufacturing: manufacturing.outputDir,
      gerbers: manufacturing.gerberZip ?? '',
    };
    await this.writeState(statePath, state);

    return {
      projectDir, projectFile, schematicFile, pcbFile, target, designHash, reused: false,
      warnings: vr.warnings, mcpCalls: calls, reconciliation, erc, drc, pcbReconciliation, deferred,
      routing: routed.routing, zones: routed.zones, routingFinalDrc: routed.finalDrc, manufacturing,
      level1Complete: true,
    };
  }

  private async compileSchematic(
    design: CircuitIR,
    schematicFile: string,
    statePath: string,
    state: PipelineState,
    calls: string[],
  ): Promise<ReconciliationReport> {
    const artifacts = expectedPowerFlags(design);
    const placement = new Map(schematicPlacements(design).map((p) => [p.ref, p]));
    const artifactPlacement = new Map(
      artifactPlacements(
        artifacts.map((a) => a.ref),
        [...placement.values()],
      ).map((p) => [p.ref, p]),
    );
    const fullPlacement = new Map([...placement, ...artifactPlacement]);
    const artifactComponents = artifacts.map((a) => {
      const p = artifactPlacement.get(a.ref)!;
      return {
        symbol: a.symbol,
        reference: a.ref,
        value: PWR_FLAG_VALUE,
        footprint: undefined as string | undefined,
        position: { x: p.x, y: p.y },
        rotation: p.rotation,
        unit: undefined as number | undefined,
      };
    });
    const allComponents = [
      ...design.components.map((c) => {
        const p = placement.get(c.ref)!;
        return {
          symbol: c.symbol,
          reference: c.ref,
          value: c.value,
          footprint: c.footprint,
          position: { x: p.x, y: p.y },
          rotation: p.rotation,
          unit: c.unit,
        };
      }),
      ...artifactComponents,
    ];

    const pinData = await this.preflightSymbols(design, schematicFile, statePath, state, calls, artifacts);
    this.assertNoEndpointCollisions(design, fullPlacement, pinData, artifacts);
    await this.preflightFootprints(design, pinData, artifacts, statePath, state);

    let report = await this.reconcileCheckpoint(design, schematicFile, statePath, state, artifacts);
    this.assertSafeToResume(report);

    const missingRefs = new Set([...report.missingComponents, ...report.missingArtifacts]);
    const missingComponents = allComponents.filter((c) => missingRefs.has(c.reference));
    let componentChunk = 0;
    for (const batch of chunks(missingComponents, this.componentBatchSize)) {
      componentChunk++;
      const op = this.beginOperation('batch_add_components', 'components', componentChunk);
      state.schematic.status = 'in_progress';
      state.schematic.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        if (this.bridge.hasTool('batch_add_components')) {
          await this.call('batch_add_components', {
            schematicPath: schematicFile,
            components: batch,
            auto_position_fields: true,
          }, calls);
        } else {
          for (const c of batch) await this.call('add_schematic_component', { schematicPath: schematicFile, ...c }, calls);
        }
      } catch (error) {
        await this.recordOperationFailure(statePath, state, op, error);
        throw error;
      }

      report = await this.reconcileCheckpoint(design, schematicFile, statePath, state, artifacts);
      this.assertSafeToResume(report, 'components');
      const stillMissing = new Set([...report.missingComponents, ...report.missingArtifacts]);
      const failedRefs = batch.map((c) => c.reference).filter((ref) => stillMissing.has(ref));
      if (failedRefs.length) {
        const error = new Error(`Component chunk ${componentChunk} returned but did not materialize: ${failedRefs.join(', ')}`);
        await this.recordOperationFailure(statePath, state, op, error);
        throw error;
      }
      state.schematic.lastOperation = this.confirmOperation(op);
      await this.updateProgressFromReport(design, report, statePath, state, artifacts);
    }

    report = await this.reconcileCheckpoint(design, schematicFile, statePath, state, artifacts);
    this.assertSafeToResume(report, 'components');
    if (report.missingComponents.length || report.missingArtifacts.length) {
      const details = [...report.missingComponents, ...report.missingArtifacts].join(', ');
      throw new Error(`Schematic component reconciliation incomplete: ${details}`);
    }

    const connectionTasks = this.connectionTasks(design, report, artifacts);
    let connectionChunk = 0;
    for (const batch of chunks(connectionTasks, this.connectionBatchSize)) {
      connectionChunk++;
      const byGlobal = [
        batch.filter((x) => !x.global),
        batch.filter((x) => x.global),
      ].filter((x) => x.length > 0);
      for (const typedBatch of byGlobal) {
        const tool = this.bridge.hasTool('batch_connect') ? 'batch_connect' : 'connect_to_net';
        const op = this.beginOperation(tool, 'connections', connectionChunk);
        state.schematic.status = 'in_progress';
        state.schematic.lastOperation = op;
        await this.writeState(statePath, state);
        try {
          if (this.bridge.hasTool('batch_connect')) {
            await this.call('batch_connect', {
              schematicPath: schematicFile,
              connections: this.connectionMap(typedBatch),
              // 0.2.6: every net — including `global: true` rails — is
              // materialized with deterministic sheet-local labels. A field
              // failure (vcm-controller: 0 labels for GND/VCC5, 39 endpoints
              // left unconnected) proved `global_label` transport cannot be
              // trusted as the only path for power rails, and `global: true`
              // must never mean "skip connection". Single-sheet designs join
              // identically by local label name; the `global` flag is kept
              // for batching determinism and future multi-sheet use.
              labelType: CONNECTION_LABEL_TYPE,
            }, calls);
          } else {
            for (const task of typedBatch) {
              await this.call('connect_to_net', {
                schematicPath: schematicFile,
                componentRef: task.ref,
                pin: task.pin,
                netName: task.net,
                labelType: CONNECTION_LABEL_TYPE,
              }, calls);
            }
          }
        } catch (error) {
          await this.recordOperationFailure(statePath, state, op, error);
          throw error;
        }

        report = await this.reconcileCheckpoint(design, schematicFile, statePath, state, artifacts);
        this.assertSafeToResume(report);
        const remaining = this.connectionTasks(design, report, artifacts);
        const remainingKeys = new Set(remaining.map((x) => this.connectionKey(x)));
        const notApplied = typedBatch.filter((x) => remainingKeys.has(this.connectionKey(x)));
        if (notApplied.length) {
          const error = new Error(`Connection chunk ${connectionChunk} returned but ${notApplied.length} endpoint(s) remain unconnected: ${notApplied.slice(0, 12).map((x) => `${x.net}:${x.ref}:${x.pin}`).join(', ')}`);
          await this.recordOperationFailure(statePath, state, op, error);
          throw error;
        }
        state.schematic.lastOperation = this.confirmOperation(op);
        await this.updateProgressFromReport(design, report, statePath, state, artifacts);
      }
    }

    const noConnect = design.components.flatMap((c) => (c.noConnectPins ?? []).map((pinName) => ({ componentRef: c.ref, pinName })));
    if (noConnect.length && this.bridge.hasTool('batch_add_no_connects')) {
      let ncChunk = 0;
      for (const batch of chunks(noConnect, this.connectionBatchSize)) {
        ncChunk++;
        const op = this.beginOperation('batch_add_no_connects', 'no_connects', ncChunk);
        state.schematic.lastOperation = op;
        state.schematic.status = 'in_progress';
        await this.writeState(statePath, state);
        try {
          await this.call('batch_add_no_connects', { schematicPath: schematicFile, pins: batch }, calls);
          state.schematic.lastOperation = this.confirmOperation(op);
          await this.writeState(statePath, state);
        } catch (error) {
          await this.recordOperationFailure(statePath, state, op, error);
          throw error;
        }
      }
    }

    const edits: Record<string, Record<string, unknown>> = {};
    for (const c of design.components) {
      if (c.properties && Object.keys(c.properties).length) edits[c.ref] = { properties: c.properties };
    }
    if (Object.keys(edits).length && this.bridge.hasTool('batch_edit_schematic_components')) {
      await this.call('batch_edit_schematic_components', { schematicPath: schematicFile, components: edits }, calls);
    }

    await this.callOptional('autoplace_schematic_fields', { schematicPath: schematicFile }, calls);
    await this.callOptional('lint_schematic_cosmetic', { schematicPath: schematicFile }, calls);
    await this.callOptional('validate_schematic', { schematicPath: schematicFile }, calls);

    report = await this.reconcileCheckpoint(design, schematicFile, statePath, state, artifacts);
    if (!report.ok) {
      state.schematic.status = 'failed';
      state.schematic.reconciliation = report;
      await this.writeState(statePath, state);
      throw new Error(this.reconciliationFailureMessage(report));
    }
    state.schematic.status = 'reconciled';
    state.schematic.reconciliation = report;
    await this.updateProgressFromReport(design, report, statePath, state, artifacts);
    return report;
  }

  /** Strict preflight: every unique symbol is listed AND every IR pin
   * selector must resolve against the returned pin data before any
   * mutation. 0.2.6: pin identifiers are opaque strings (`"11"`, `"A1"`),
   * so relays and other symbols with multi-digit or alphanumeric pins can
   * no longer be skipped per-endpoint in silence. Returns the parsed pin
   * database for the endpoint collision check. */
  private async preflightSymbols(
    design: CircuitIR,
    schematicFile: string,
    statePath: string,
    state: PipelineState,
    calls: string[],
    artifacts: ExpectedArtifact[] = [],
  ): Promise<Map<string, PreflightSymbol>> {
    // Compiler artifacts are mutation targets too: their symbol must pass
    // the same strict preflight as functional symbols.
    const symbols = [...new Set([
      ...design.components.map((c) => c.symbol),
      ...artifacts.map((a) => a.symbol),
    ])];
    const op = this.beginOperation(this.bridge.hasTool('batch_list_symbol_pins') ? 'batch_list_symbol_pins' : 'list_symbol_pins', 'preflight');
    state.schematic.status = 'in_progress';
    state.schematic.lastOperation = op;
    await this.writeState(statePath, state);
    try {
      let combined = '';
      if (this.bridge.hasTool('batch_list_symbol_pins')) {
        const result = await this.call('batch_list_symbol_pins', { symbols, schematicPath: schematicFile, compact: false }, calls);
        combined += result.text;
      } else if (this.bridge.hasTool('list_symbol_pins')) {
        for (const symbol of symbols) {
          const result = await this.call('list_symbol_pins', { symbol, schematicPath: schematicFile }, calls);
          combined += `\n${result.text}`;
        }
      } else {
        throw new Error('KiCAD-MCP-Server exposes neither batch_list_symbol_pins nor list_symbol_pins; strict symbol preflight is required before mutation.');
      }
      const pinData = parseSymbolPinPreflight(combined);
      const verification = verifyDesignPins(design.components, design.nets, pinData);
      if (!verification.ok) {
        throw new Error(
          `Strict symbol preflight rejected ${verification.unknownPins.length} IR endpoint(s) ` +
            `with no matching symbol pin: ${formatUnknownPins(verification.unknownPins)}. ` +
            `Pin selectors are matched verbatim (multi-digit and alphanumeric pins such as 11/12/14/A1/A2 are supported); ` +
            `no schematic mutation was performed.`,
        );
      }
      for (const artifact of artifacts) {
        if (pinData.get(artifact.symbol)?.pins.has(artifact.pin) !== true) {
          throw new Error(
            `Strict symbol preflight rejected compiler artifact '${artifact.ref}' ` +
              `(${artifact.symbol}): pin '${artifact.pin}' not present in the symbol pin list. ` +
              `No schematic mutation was performed.`,
          );
        }
      }
      state.schematic.lastOperation = this.confirmOperation(op);
      await this.writeState(statePath, state);
      return pinData;
    } catch (error) {
      await this.recordOperationFailure(statePath, state, op, error);
      throw error;
    }
  }

  /** Stop the compile when two endpoints of DIFFERENT nets would share one
   * schematic coordinate. 0.2.6: the vcm-controller Q1-D/DRAIN0 vs Q6-S/GND
   * overlap at (220.98,97.79) silently pulled Q1-3 into DRAIN5. Same-net
   * sharing is intentional and allowed. Runs before any mutation. */
  private assertNoEndpointCollisions(
    design: CircuitIR,
    placement: Map<string, Placement>,
    pinData: Map<string, PreflightSymbol>,
    artifacts: ExpectedArtifact[] = [],
  ): void {
    // Functional components + compiler artifacts share one coordinate space.
    const symbolByRef = new Map<string, string>([
      ...design.components.map((c) => [c.ref, c.symbol] as const),
      ...artifacts.map((a) => [a.ref, a.symbol] as const),
    ]);
    const endpoints = [
      ...design.nets.flatMap((net) =>
        net.pins.map((p) => ({ ref: p.ref, pin: normalizePinId(p.pin), net: net.name })),
      ),
      // Artifact pins are electrical endpoints on their driven net.
      ...artifacts.map((a) => ({ ref: a.ref, pin: a.pin, net: a.net })),
    ];
    const located = endpoints.filter((e) => {
      const symbol = symbolByRef.get(e.ref);
      return symbol !== undefined && placement.has(e.ref) && pinData.get(symbol)?.pins.has(e.pin) === true;
    });
    // computeEndpointCoordinates keys offsets by REFERENCE (not symbol),
    // so each located endpoint maps to its own symbol's pin offsets.
    // 0.2.7 hardening: 0.2.6 passed a symbol-keyed map here, which made
    // the detector resolve zero coordinates (silent no-op; origin
    // separation still prevented the field failure, but the gate itself
    // was vacuous). Keying by ref makes the check real.
    const pinOffsets = new Map<string, Map<string, PreflightPin>>();
    for (const endpoint of located) {
      if (pinOffsets.has(endpoint.ref)) continue;
      const symbol = symbolByRef.get(endpoint.ref)!;
      pinOffsets.set(endpoint.ref, pinData.get(symbol)!.pins);
    }
    const coordinates = computeEndpointCoordinates(located, placement, pinOffsets);
    const collisions = detectEndpointCollisions(coordinates);
    if (collisions.length) {
      throw new Error(
        `Refusing to wire because ${collisions.length} endpoint coordinate collision(s) across different nets were detected: ` +
          `${formatCollisions(collisions)}. Resolve the layout (explicit schematic coordinates or separated auto-placement) and recompile; no schematic mutation was performed.`,
      );
    }
  }

  /** 0.4.1 strict footprint preflight, run BEFORE any component/footprint
   * mutation: (a) every IR footprint must resolve through the KiCad
   * fp-lib-table chain to an existing .kicad_mod file; (b) every pin the
   * design actually uses (net endpoints + no-connect) must exist as a pad
   * in that footprint. Catches renamed libraries and symbol↔footprint
   * numbering mismatches while they are still cheap to report. */
  private async preflightFootprints(
    design: CircuitIR,
    pinData: Map<string, PreflightSymbol>,
    artifacts: ExpectedArtifact[],
    statePath: string,
    state: PipelineState,
  ): Promise<void> {
    const op = this.beginOperation('footprint preflight', 'preflight');
    state.schematic.lastOperation = op;
    await this.writeState(statePath, state);
    try {
      const artifactRefs = new Set(artifacts.map((a) => a.ref));
      const libs = await resolveFootprintLibs();
      const issues: FootprintPreflightIssue[] = [];
      const padsByFootprint = new Map<string, Set<string> | null>();

      // Pins the design actually uses per ref (net endpoints + no-connect).
      const usedPins = new Map<string, Set<string>>();
      for (const net of design.nets) {
        for (const p of net.pins) {
          if (!usedPins.has(p.ref)) usedPins.set(p.ref, new Set());
          usedPins.get(p.ref)!.add(p.pin);
        }
      }
      for (const c of design.components) {
        for (const pin of c.noConnectPins ?? []) {
          if (!usedPins.has(c.ref)) usedPins.set(c.ref, new Set());
          usedPins.get(c.ref)!.add(pin);
        }
      }

      for (const component of design.components) {
        if (artifactRefs.has(component.ref)) continue;
        const footprint = component.footprint;
        if (!footprint) continue; // no footprint declared: the PCB phase reports that, not this preflight
        let pads = padsByFootprint.get(footprint);
        if (pads === undefined) {
          const resolved = await resolveFootprintPath(footprint, libs);
          if (!resolved.path) {
            issues.push({ ref: component.ref, footprint, problem: 'lib_not_found', detail: `library nick not resolvable via fp-lib-table (${libs.tables.length} table(s) consulted: ${libs.tables.join(', ')})` });
            padsByFootprint.set(footprint, null);
            continue;
          }
          try {
            pads = await parseFootprintPads(resolved.path);
            padsByFootprint.set(footprint, pads);
          } catch (error) {
            issues.push({ ref: component.ref, footprint, problem: 'module_unreadable', detail: `${resolved.path}: ${errorMessage(error)}` });
            padsByFootprint.set(footprint, null);
            continue;
          }
        }
        if (!pads) continue; // already reported for this footprint
        const symbolPins = pinData.get(component.symbol)?.pins;
        for (const pin of usedPins.get(component.ref) ?? []) {
          if (pads.has(pin)) continue;
          // Tolerate pins the symbol does not have either: those are already
          // reported by the strict symbol preflight, keep its message author.
          if (symbolPins && !symbolPins.has(pin)) continue;
          const available = [...pads].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ');
          issues.push({ ref: component.ref, footprint, problem: 'pad_missing', detail: `design uses pin '${pin}' but footprint pads are: [${available}]` });
        }
      }

      if (issues.length) {
        const summary = issues.slice(0, 12).map((i) => `${i.ref} ${i.footprint}: ${i.problem} — ${i.detail}`);
        throw new Error(
          `Strict footprint preflight rejected ${issues.length} footprint issue(s) before any mutation: ${summary.join(' | ')}` +
            (issues.length > 12 ? ` (+${issues.length - 12} more)` : ''),
        );
      }
      state.schematic.lastOperation = this.confirmOperation(op);
      await this.writeState(statePath, state);
    } catch (error) {
      await this.recordOperationFailure(statePath, state, op, error);
      throw error;
    }
  }

  private connectionTasks(design: CircuitIR, report: ReconciliationReport, artifacts: ExpectedArtifact[] = []): ConnectionTask[] {
    const issues = new Map(report.netIssues.map((issue) => [issue.name, issue]));
    const tasks: ConnectionTask[] = [];
    for (const net of design.nets) {
      const issue = issues.get(net.name);
      if (!issue) continue;
      for (const endpoint of issue.missingEndpoints) tasks.push({ ...endpoint, net: net.name, global: net.global === true });
    }
    // Pending compiler artifacts: added but not yet attached to their net.
    // Only MISATTACHED artifacts become connection tasks — this is what
    // makes resume idempotent (an already-attached flag yields no task).
    for (const artifact of artifacts) {
      const misattached = report.misattachedArtifacts.some((m) => m.ref === artifact.ref);
      const missing = report.missingArtifacts.includes(artifact.ref);
      if (missing || misattached) tasks.push({ ref: artifact.ref, pin: artifact.pin, net: artifact.net, global: false });
    }
    return tasks;
  }

  private connectionMap(tasks: ConnectionTask[]): Record<string, Record<string, string>> {
    const map: Record<string, Record<string, string>> = {};
    // 0.2.6: pin selectors stay opaque strings ("11", "A1") verbatim.
    for (const task of tasks) (map[task.ref] ??= {})[normalizePinId(task.pin)] = task.net;
    return map;
  }

  private connectionKey(task: ConnectionTask): string {
    return `${task.net}\u0000${task.ref}\u0000${normalizePinId(task.pin)}`;
  }

  private async reconcileCheckpoint(
    design: CircuitIR,
    schematicFile: string,
    statePath: string,
    state: PipelineState,
    artifacts: ExpectedArtifact[] = [],
  ): Promise<ReconciliationReport> {
    const report = reconcileDesignToSnapshot(design, await this.inspectSchematic(schematicFile), artifacts);
    state.schematic.reconciliation = report;
    const progress = reportProgress(design, report, artifacts);
    state.schematic.confirmedComponentRefs = progress.confirmedComponentRefs;
    state.schematic.confirmedNetNames = progress.confirmedNetNames;
    await this.writeState(statePath, state);
    return report;
  }

  private assertSafeToResume(report: ReconciliationReport, phase: 'components' | 'full' = 'full'): void {
    const unsafe = phase === 'components'
      ? hasUnsafeComponentState(report)
      : hasUnsafeReconciliation(report);
    if (unsafe) throw new Error(`Refusing automatic resume because reconciliation found ${unsafe}. STOP and inspect the schematic; no repair was attempted.`);
  }

  private reconciliationFailureMessage(report: ReconciliationReport): string {
    const parts: string[] = [];
    if (report.missingComponents.length) parts.push(`missing components: ${report.missingComponents.join(', ')}`);
    if (report.duplicateReferences.length) parts.push(`duplicates: ${report.duplicateReferences.join(', ')}`);
    if (report.missingNets.length) parts.push(`missing nets: ${report.missingNets.join(', ')}`);
    if (report.netIssues.length) {
      parts.push(`net mismatch: ${report.netIssues.slice(0, 12).map((n) => `${n.name}[expected=${n.expectedCount},actual=${n.actualCount},missing=${n.missingEndpoints.length},extra=${n.unexpectedEndpoints.length}]`).join('; ')}`);
    }
    if (report.unexpectedUnconnected.length) parts.push(`unexpected unconnected pins: ${report.unexpectedUnconnected.length}`);
    if (report.missingArtifacts.length) parts.push(`missing compiler artifacts: ${report.missingArtifacts.join(', ')}`);
    if (report.misattachedArtifacts.length) parts.push(`misattached artifacts: ${report.misattachedArtifacts.map((m) => `${m.ref}->${m.net}`).join(', ')}`);
    if (report.unexpectedArtifacts.length) parts.push(`unexpected compiler artifacts: ${report.unexpectedArtifacts.slice(0, 8).join(', ')}`);
    return `Schematic reconciliation failed. ${parts.join(' | ')}`;
  }

  private beginOperation(tool: string, kind: PipelineOperation['kind'], chunk?: number): PipelineOperation {
    return { tool, kind, chunk, status: 'in_progress', startedAt: new Date().toISOString() };
  }

  private confirmOperation(op: PipelineOperation): PipelineOperation {
    return { ...op, status: 'confirmed', finishedAt: new Date().toISOString() };
  }

  private failOperation(op: PipelineOperation, error: unknown, timeout: boolean): PipelineOperation {
    return {
      ...op,
      status: timeout ? 'unknown_after_timeout' : 'failed',
      finishedAt: new Date().toISOString(),
      error: errorMessage(error),
    };
  }

  private async recordOperationFailure(
    statePath: string,
    state: PipelineState,
    op: PipelineOperation,
    error: unknown,
  ): Promise<void> {
    const timeout = isTimeout(error);
    state.schematic.status = timeout ? 'unknown_after_timeout' : 'failed';
    state.schematic.lastOperation = this.failOperation(op, error, timeout);
    await this.writeState(statePath, state);
  }

  private async updateProgressFromReport(
    design: CircuitIR,
    report: ReconciliationReport,
    statePath: string,
    state: PipelineState,
    artifacts: ExpectedArtifact[] = [],
  ): Promise<void> {
    const progress = reportProgress(design, report, artifacts);
    state.schematic.confirmedComponentRefs = progress.confirmedComponentRefs;
    state.schematic.confirmedNetNames = progress.confirmedNetNames;
    state.schematic.reconciliation = report;
    await this.writeState(statePath, state);
  }

  /**
   * 0.3.0 PCB foundation. Staged, checkpointed, deterministic:
   * preflight (footprints resolved, schematic already reconciled) →
   * board creation/net transfer → board size + explicit constraints →
   * deterministic placement (+ real courtyard check when the server exposes
   * it) → PCB reconciliation from the .kicad_pcb file (+ live get_pads
   * cross-check) → classified DRC (unrouted reported, structural blocks).
   * No autorouting, no copper pours, no placement optimization.
   */
  private async compilePcb(
    design: CircuitIR,
    projectDir: string,
    projectFile: string,
    schematicFile: string,
    pcbFile: string,
    statePath: string,
    state: PipelineState,
    calls: string[],
    options: CompileOptions,
  ): Promise<{ reconciliation: PcbReconciliationReport; drc?: DrcReport; deferred: string[] }> {
    const progress = (state.pcb ??= { status: 'pending', confirmedFootprintRefs: [], confirmedNetNames: [] });

    if (progress.status === 'unknown_after_timeout' || progress.status === 'failed') {
      throw new Error(
        `PCB pipeline is in '${progress.status}' state (last operation: ${progress.lastOperation?.tool ?? 'n/a'}). ` +
          'Run kicad_flow_pcb_reconcile to inspect the real board, or decide an explicit forceRebuild. ' +
          'Refusing to continue automatically.',
      );
    }

    // STAGE: preflight — footprints must be explicit in the IR.
    {
      const op = this.beginOperation('pcb preflight', 'preflight');
      progress.status = 'preflight';
      progress.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        const requirements = pcbFootprintRequirements(design);
        if (requirements.missing.length) {
          throw new Error(
            `PCB preflight blocked: ${requirements.missing.length} component(s) have no footprint declared in the IR.\n` +
              requirements.missing.map((m) => `  ${m.ref} (${m.symbol})`).join('\n') +
              '\nDeclare one explicit, real KiCad footprint per component; the compiler never invents packages.',
          );
        }
        progress.confirmedFootprintRefs = requirements.required.map((r) => r.ref);
      } catch (error) {
        await this.recordPcbFailure(statePath, state, op, error);
        throw error;
      }
      progress.lastOperation = this.confirmOperation(op);
      progress.status = 'footprints_resolved';
      await this.writeState(statePath, state);
    }

    // STAGE: board creation + net transfer (resume-safe checkpoint).
    if (progress.status === 'footprints_resolved') {
      const op = this.beginOperation('create_board_from_schematic', 'board_create');
      progress.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        if (this.bridge.hasTool('create_board_from_schematic')) {
          await this.call('create_board_from_schematic', { schematicPath: schematicFile, boardPath: pcbFile, overwrite: true }, calls);
        } else if (this.bridge.hasTool('sync_schematic_to_board')) {
          await this.call('sync_schematic_to_board', { schematicPath: schematicFile, boardPath: pcbFile }, calls);
        } else {
          throw new Error('PCB creation blocked: KiCAD-MCP-Server exposes neither create_board_from_schematic nor sync_schematic_to_board.');
        }
      } catch (error) {
        await this.recordPcbFailure(statePath, state, op, error);
        throw error;
      }
      progress.lastOperation = this.confirmOperation(op);
      progress.status = 'board_created';
      await this.writeState(statePath, state);
    }

    // STAGE: board size + explicit constraints from the IR board section.
    if (progress.status === 'board_created') {
      const op = this.beginOperation('set_board_size', 'board_size');
      progress.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        await this.call('set_board_size', {
          width: design.board?.widthMm ?? 80,
          height: design.board?.heightMm ?? 50,
          unit: 'mm',
        }, calls);
        if (this.bridge.hasTool('set_design_rules')) {
          await this.call('set_design_rules', {
            clearance: design.board?.clearanceMm ?? 0.2,
            trackWidth: design.board?.trackWidthMm ?? 0.25,
            viaDiameter: design.board?.viaDiameterMm ?? 0.6,
            viaDrill: design.board?.viaDrillMm ?? 0.3,
          }, calls);
        }
        // Explicit IR netclasses ONLY. Profile defaults and name-pattern
        // inference are deliberately not applied in the PCB foundation.
        for (const rule of explicitNetclasses(design)) {
          if (!this.bridge.hasTool('create_netclass')) continue;
          await this.call('create_netclass', {
            name: rule.name,
            traceWidth: rule.trackWidthMm,
            clearance: rule.clearanceMm,
            viaDiameter: rule.viaDiameterMm,
            viaDrill: rule.viaDrillMm,
            nets: rule.nets,
          }, calls);
        }
      } catch (error) {
        await this.recordPcbFailure(statePath, state, op, error);
        throw error;
      }
      progress.lastOperation = this.confirmOperation(op);
      await this.writeState(statePath, state);
    }

    // STAGE: deterministic placement (collisions checked BEFORE mutation).
    if (progress.status === 'board_created') {
      const op = this.beginOperation('batch_move_components', 'board_place');
      progress.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        const plan = computePcbPlacements(design);
        const moves: Record<string, Record<string, unknown>> = {};
        for (const p of plan.placements) {
          moves[p.ref] = { x: p.x, y: p.y, rotation: p.rotation, layer: p.layer, unit: 'mm' };
        }
        if (Object.keys(moves).length) {
          if (this.bridge.hasTool('batch_move_components')) {
            await this.call('batch_move_components', { moves, save: true }, calls);
          } else {
            for (const [reference, spec] of Object.entries(moves)) {
              await this.call('move_component', { reference, ...spec }, calls);
            }
          }
        }
        if (this.bridge.hasTool('check_courtyard_overlaps')) {
          const check = await this.call('check_courtyard_overlaps', {}, calls);
          const payload = check.json as { overlaps?: Array<{ a?: string; b?: string }>; boundary_violations?: Array<{ ref?: string }> } | undefined;
          const overlaps = payload?.overlaps ?? [];
          const boundary = payload?.boundary_violations ?? [];
          if (overlaps.length || boundary.length) {
            throw new Error(
              'PCB placement blocked: courtyard overlaps [' +
                overlaps.slice(0, 8).map((o) => `${o.a ?? '?'}~${o.b ?? '?'}`).join(', ') +
                '] and/or board-edge violations [' +
                boundary.slice(0, 8).map((b) => b.ref ?? '?').join(', ') +
                ']. Move components explicitly in the IR or enlarge the board.',
            );
          }
        }
      } catch (error) {
        await this.recordPcbFailure(statePath, state, op, error);
        throw error;
      }
      progress.lastOperation = this.confirmOperation(op);
      progress.status = 'placed';
      await this.writeState(statePath, state);
    }

    // STAGE: PCB reconciliation against the authoritative board file.
    {
      const op = this.beginOperation('pcb reconciliation', 'pcb_reconcile');
      progress.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        await this.callOptional('save_board', {}, calls);
        const snapshot = await this.inspectPcb(pcbFile);
        if (!snapshot.components.length) {
          throw new Error('PCB reconciliation blocked: the .kicad_pcb snapshot contains no footprints. The board was not created or was written elsewhere.');
        }
        if (this.bridge.hasTool('get_pads')) {
          const live = await this.call('get_pads', {}, calls);
          this.assertPadsAgree(snapshot, live.json);
        }
        const padCollisions = detectPadCollisions(snapshot);
        if (padCollisions.length) {
          throw new Error(
            'PCB reconciliation blocked: pads from different nets share the same coordinates: ' +
              padCollisions.slice(0, 6).map((c) => `(${c.x},${c.y}) ${c.nets.join('+')}`).join('; '),
          );
        }
        const report = reconcilePcbDesign(design, snapshot);
        if (!report.ok) {
          throw new Error('PCB reconciliation failed:\n' + formatPcbReconciliation(report));
        }
        progress.reconciliation = report;
        progress.confirmedFootprintRefs = snapshot.components.map((c) => c.ref).sort();
        progress.confirmedNetNames = snapshot.nets;
      } catch (error) {
        await this.recordPcbFailure(statePath, state, op, error);
        throw error;
      }
      progress.lastOperation = this.confirmOperation(op);
      progress.status = 'reconciled';
      await this.writeState(statePath, state);
    }

    // STAGE: classified DRC — unrouted is REPORTED, structural errors block.
    let drc: DrcReport | undefined;
    if (!options.skipVerification) {
      const op = this.beginOperation('kicad-cli pcb drc', 'drc');
      progress.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        const result = await runDrcClassified(projectDir, pcbFile);
        drc = result.report;
      } catch (error) {
        await this.recordPcbFailure(statePath, state, op, error);
        throw error;
      }
      progress.lastOperation = this.confirmOperation(op);
      progress.status = 'drc_checked';
      await this.writeState(statePath, state);
    }

    // Deferred features are reported, never silently applied.
    const deferred: string[] = ['layerStack (copper layer count is reported, not changed, by the 0.3.0 foundation)'];
    if (design.board?.autoroute !== false) {
      deferred.push('autoroute (the PCB foundation never routes; unrouted connections are reported by the classified DRC)');
    }
    if (design.board?.gndPours) {
      deferred.push('copperPours (zones are out of scope for the 0.3.0 foundation)');
    }
    // Non-blocking parity warnings are reported, never silently dropped
    // (KiCad 10 emits cosmetic parity warnings: sheet-prefix net notation,
    // Description field differences).
    const parityWarnings = (drc?.parityViolations ?? []).filter((v) => v.severity !== 'error');
    for (const v of parityWarnings.slice(0, 20)) {
      deferred.push(`drcParityWarning (${v.type}): ${v.description}`);
    }
    if (parityWarnings.length > 20) {
      deferred.push(`drcParityWarning: ...and ${parityWarnings.length - 20} more`);
    }
    progress.drc = drc;
    progress.deferred = deferred;
    progress.status = 'complete';
    await this.writeState(statePath, state);
    return { reconciliation: progress.reconciliation!, drc, deferred };
  }

  // ---------------------------------------------------------------------
  // 0.4.0 Level-1: routing backend pipeline (freerouting) + copper zones +
  // final DRC gate.
  // ---------------------------------------------------------------------

  /**
   * Staged, checkpointed routing pipeline:
   * gates (schematic PASS, ERC errors=0, PCB reconciliation PASS, footprints,
   * board outline, netclasses, router available, no unknown_after_timeout)
   * → idempotency fingerprint → PCB backup → export DSN → freerouting CLI →
   * import SES → routing reconciliation (unrouted = 0 gate) → explicit copper
   * zones (one entity per IR declaration) → zone reconciliation → final
   * classified DRC (errors = 0 AND unconnected = 0) → routing complete.
   * A failed gate or reconciliation sets routing failed/incomplete and STOPS;
   * the board file is the only authoritative judge.
   */
  private async compileRouted(
    design: CircuitIR,
    projectDir: string,
    projectFile: string,
    schematicFile: string,
    pcbFile: string,
    statePath: string,
    state: PipelineState,
    calls: string[],
    options: CompileOptions,
  ): Promise<{ routing: CompileResult['routing']; zones?: ZoneReconciliationReport; finalDrc?: DrcReport }> {
    const routing = (state.routing ??= { status: 'pending' });
    if (routing.status === 'unknown_after_timeout' || routing.status === 'failed' || routing.status === 'incomplete') {
      throw new Error(
        `Routing pipeline is in '${routing.status}' state (last operation: ${routing.lastOperation?.tool ?? 'n/a'}). ` +
          'Run kicad_flow_routing_reconcile to inspect the real board, or decide an explicit forceRebuild. ' +
          'Refusing to continue automatically.',
      );
    }

    // STAGE: gates — every precondition is verified read-only before any
    // routing mutation. A failed gate STOPS the pipeline.
    {
      const op = this.beginOperation('routing preflight', 'preflight');
      routing.status = 'preflight';
      routing.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        // (1) schematic reconciliation PASS.
        if (!state.schematic.reconciliation?.ok) {
          throw new Error('Routing preflight blocked: schematic reconciliation has not passed. Compile target pcb first.');
        }
        // (2) ERC PASS — re-run read-only; deterministic for a frozen schematic.
        if (!options.skipVerification) {
          const erc = await runErc(projectDir, schematicFile);
          // Persist so the manufacturing gate can verify ERC PASS even when
          // the schematic phase was completed in an earlier call.
          state.schematic.erc = erc;
          if (erc.errors > 0) {
            throw new Error(`Routing preflight blocked: ERC reports ${erc.errors} error(s).`);
          }
        }
        // (3) PCB reconciliation PASS against the authoritative board file.
        const pcbSnapshot = await this.inspectPcb(pcbFile);
        if (!pcbSnapshot.components.length) {
          throw new Error('Routing preflight blocked: the .kicad_pcb snapshot contains no footprints.');
        }
        const pcbReport = reconcilePcbDesign(design, pcbSnapshot);
        if (!pcbReport.ok) {
          throw new Error('Routing preflight blocked: PCB reconciliation failed:\n' + formatPcbReconciliation(pcbReport));
        }
        // (4) footprints resolved (redundant with PCB reconciliation, kept as
        // an explicit gate per the 0.4.0 contract).
        const requirements = pcbFootprintRequirements(design);
        if (requirements.missing.length) {
          throw new Error(`Routing preflight blocked: ${requirements.missing.length} component(s) have no footprint.`);
        }
        // (5) netclasses: every explicitly declared IR netclass must be present
        // in the .kicad_pro the DSN exporter reads (server #302 path).
        const declaredNetclasses = explicitNetclasses(design);
        if (declaredNetclasses.length) {
          let projectJson: any;
          try {
            projectJson = JSON.parse(await fs.readFile(join(projectDir, `${design.project.name}.kicad_pro`), 'utf8'));
          } catch {
            throw new Error('Routing preflight blocked: .kicad_pro file is missing or unreadable; netclass rules cannot be verified.');
          }
          const classNames = new Set(
            ((projectJson?.net_settings?.classes ?? []) as Array<Record<string, unknown>>).map((c) => String(c.name ?? '')),
          );
          const missing = declaredNetclasses.filter((r) => !classNames.has(r.name));
          if (missing.length) {
            throw new Error(
              `Routing preflight blocked: declared netclass(es) not applied to the project: ` +
                `${missing.map((m) => m.name).join(', ')}. Recompile target pcb.`,
            );
          }
        }
        // (6) board outline exists (containment checks and zone fallback need it).
        const routingSnapshot = await this.inspectRouting(pcbFile);
        this.lastRoutingSnapshot = routingSnapshot;
        if (!routingSnapshot.geometry.outline) {
          throw new Error('Routing preflight blocked: no board outline found on Edge.Cuts.');
        }
        // (7) router available (MCP tools + jar + java).
        await this.routingBackendInstance.preflight();
      } catch (error) {
        routing.status = 'failed';
        routing.lastOperation = this.failOperation(op, error, false);
        await this.writeState(statePath, state);
        throw error;
      }
      routing.lastOperation = this.confirmOperation(op);
      await this.writeState(statePath, state);
    }

    // STAGE: idempotency. Same placement + same routing rules + same router
    // config + previous complete result → reuse. No new tracks, vias or zones.
    const routingProgress = routing;
    {
      const pcbSnapshotNow = await this.inspectPcb(pcbFile);
      const fingerprint = routingFingerprint(design, pcbSnapshotNow);
      state.fingerprints ??= {};
      const doneStatus: RoutingStatus = 'complete';
      if (!options.forceRebuild && state.fingerprints.routing === fingerprint && routingProgress.status === doneStatus) {
        // Idempotency is verified against the real board file: the recorded
        // track/via counts must still match what is on disk.
        const snapshot = await this.inspectRouting(pcbFile);
        if (snapshot.tracks.length === (routing.tracks ?? 0) && snapshot.vias.length === (routing.vias ?? 0)) {
          routing.lastOperation = this.confirmOperation({
            tool: 'routing reuse', kind: 'routing_reconcile', status: 'confirmed', startedAt: new Date().toISOString(),
          });
          await this.writeState(statePath, state);
          return {
            routing: {
              ...(routing.reconciliation ?? {
                ok: true, unroutedCount: 0, unrouted: [], floatingPads: [], tracks: snapshot.tracks.length,
                vias: snapshot.vias.length, unknownNetTraces: [], outsideBoard: [], viaShorts: [],
                zoneExemptNets: [], issues: [],
              }),
              backend: routing.backend,
              tracks: routing.tracks ?? routing.reconciliation?.tracks ?? snapshot.tracks.length,
              vias: routing.vias ?? routing.reconciliation?.vias ?? snapshot.vias.length,
            },
            zones: routing.zones,
            finalDrc: routing.finalDrc,
          };
        }
        // Board drifted from the recorded state: re-route below.
        routing.status = 'pending';
      }
    }

    // STAGE: preserve the last valid PCB before the router may modify it.
    await this.backupRoutedBoard(pcbFile, 'pre-routing');

    // STAGE: export DSN → freerouting CLI → import SES (backend unit).
    const backend = this.routingBackendInstance;
    const spec = design.board?.routing ?? {};
    const stagingDir = join(projectDir, '.kicad-flow', 'routing');
    // The board must be open in the server: export_dsn falls back to the
    // loaded board object and import_ses mutates it in memory before saving.
    await this.bridge.callIfAvailable('open_project', { filename: projectFile });
    if (this.bridge.hasTool('open_project')) calls.push('open_project');

    const routeOp = this.beginOperation(`routing (${backend.name}: export_dsn → CLI → import_ses)`, 'routing_export');
    routing.status = 'in_progress';
    routing.lastOperation = routeOp;
    await this.writeState(statePath, state);
    let routeResult: RouteResult;
    try {
      routeResult = await backend.route(
        {
          projectDir,
          projectName: design.project.name,
          pcbPath: pcbFile,
          stagingDir,
          maxPasses: spec.maxPasses ?? 20,
          timeoutSeconds: spec.timeoutSeconds ?? 300,
          freeroutingJar: this.config.freeroutingJar,
        },
        calls,
      );
    } catch (error) {
      // Timeout semantics: the SES import is the only board-mutating step and
      // the backend validates the SES before it, but the conservative contract
      // is kept: any timeout inside route() leaves the real result unknown
      // until reconciliation.
      const timeout = isTimeout(error);
      routing.status = timeout ? 'unknown_after_timeout' : 'failed';
      routing.lastOperation = this.failOperation(routeOp, error, timeout);
      await this.writeState(statePath, state);
      throw error;
    }
    routing.dsnPath = routeResult.dsnPath;
    routing.sesPath = routeResult.sesPath;
    routing.backend = routeResult.backend;
    routing.lastOperation = this.confirmOperation(routeOp);
    routing.status = 'imported';
    await this.writeState(statePath, state);

    // STAGE: routing reconciliation — the parsed board file is authoritative.
    let recon: RoutingReconciliationReport;
    {
      const op = this.beginOperation('routing reconciliation', 'routing_reconcile');
      routing.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        const snapshot = await this.inspectRouting(pcbFile);
        this.lastRoutingSnapshot = snapshot;
        const pcbSnapshot = await this.inspectPcb(pcbFile);
        recon = reconcileRoutingDesign(design, snapshot, { components: pcbSnapshot.components });
        routing.tracks = snapshot.tracks.length;
        routing.vias = snapshot.vias.length;
        routing.reconciliation = recon;
        routing.lastOperation = this.confirmOperation(op);
        await this.writeState(statePath, state);
      } catch (error) {
        routing.status = 'failed';
        routing.lastOperation = this.failOperation(op, error, false);
        await this.writeState(statePath, state);
        throw error;
      }
    }
    if (!recon.ok) {
      routing.status = 'incomplete';
      await this.writeState(statePath, state);
      throw new Error(
        `Routing reconciliation reported ${recon.unroutedCount} unrouted endpoint(s); routing.status=incomplete. ` +
          formatRoutingReconciliation(recon),
      );
    }

    // STAGE: explicit copper zones (one entity per IR declaration) + refill +
    // zone reconciliation. Skipped when the IR declares none (reconciled to
    // zero so a stale zone still stops the pipeline).
    let zones: ZoneReconciliationReport | undefined;
    if (design.zones?.length) {
      zones = await this.compileZones(design, projectDir, projectFile, pcbFile, statePath, state, routing, calls);
    } else {
      const snapshot = await this.inspectRouting(pcbFile);
      zones = reconcileZones(design, snapshot);
      routing.zones = zones;
      if (!zones.ok) {
        routing.status = 'failed';
        await this.writeState(statePath, state);
        throw new Error('Zone reconciliation failed with no IR zones declared: ' + formatZoneIssues(zones));
      }
      await this.writeState(statePath, state);
    }

    // STAGE: final classified DRC. Level-1 PASS requires errors = 0 AND
    // unconnected = 0 (warnings are visible, never blocking by themselves).
    const finalDrc = await this.runFinalDrc(projectDir, pcbFile, statePath, state, routing);

    routing.status = 'complete';
    state.fingerprints.routing = routingFingerprint(design, await this.inspectPcb(pcbFile));
    await this.writeState(statePath, state);
    return {
      // Track/via counts come from the reconciled board snapshot (authoritative),
      // not from routeResult: the freerouting backend does not count them.
      routing: { ...recon, backend: routeResult.backend, tracks: recon.tracks, vias: recon.vias },
      zones,
      finalDrc,
    };
  }

  /** Explicit copper zones only: one add_copper_pour per IR declaration
   * (exact board net name from get_nets_list), then refill_zones (server-side
   * isolated subprocess), then zone reconciliation + live query_zones check. */
  private async compileZones(
    design: CircuitIR,
    projectDir: string,
    projectFile: string,
    pcbFile: string,
    statePath: string,
    state: PipelineState,
    routing: RoutingProgress,
    calls: string[],
  ): Promise<ZoneReconciliationReport> {
    const declared = design.zones ?? [];

    // Exact board net names: pcbnew GetNetname() may carry a '/' prefix that
    // the server-side NetsByName().has_key() requires verbatim. Query first,
    // then use the returned name verbatim; fall back to the bare IR name.
    let netNames: string[] = [];
    if (this.bridge.hasTool('get_nets_list')) {
      const live = await this.call('get_nets_list', {}, calls);
      const payload = live.json as { nets?: Array<{ name?: string }> } | undefined;
      netNames = (payload?.nets ?? []).map((n) => n.name ?? '').filter(Boolean);
    }
    const boardNetName = (net: string): string =>
      netNames.find((n) => n.replace(/^\//, '') === net) ?? net;

    // One entity per declaration, deterministic IR order.
    let zoneChunk = 0;
    for (const zone of declared) {
      zoneChunk++;
      const op = this.beginOperation('add_copper_pour', 'zone_add', zoneChunk);
      routing.status = 'zones_placed';
      routing.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        const outline = this.zoneOutlineFor(design, zone);
        await this.call('add_copper_pour', {
          // Server zod schema only accepts { layer, net, clearance?, outline? }
          // and strips unknown keys, so priority/minWidth/fillType are handled
          // by the python handler defaults (0 / 0.25 mm / solid).
          net: boardNetName(zone.net),
          layer: zone.layer,
          clearance: zone.clearanceMm ?? 0.5,
          outline: outline.map((p) => ({ x: p.x, y: p.y })),
        }, calls);
      } catch (error) {
        routing.status = 'failed';
        routing.lastOperation = this.failOperation(op, error, isTimeout(error));
        await this.writeState(statePath, state);
        throw error;
      }
      routing.lastOperation = this.confirmOperation(op);
    }

    // Fill: refill_zones saves the board, runs ZONE_FILLER in an isolated
    // subprocess and reloads. A failure here is fatal for Level-1 because
    // zone reconciliation requires filled zones.
    {
      const op = this.beginOperation('refill_zones', 'zone_refill');
      routing.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        await this.call('refill_zones', {}, calls);
      } catch (error) {
        routing.status = 'failed';
        routing.lastOperation = this.failOperation(op, error, isTimeout(error));
        await this.writeState(statePath, state);
        throw error;
      }
      routing.lastOperation = this.confirmOperation(op);
      routing.status = 'zones_filled';
      await this.writeState(statePath, state);
    }

    // Zone reconciliation from the authoritative board file + live cross-check.
    {
      const op = this.beginOperation('zone reconciliation', 'zone_reconcile');
      routing.lastOperation = op;
      await this.writeState(statePath, state);
      try {
        const snapshot = await this.inspectRouting(pcbFile);
        this.lastRoutingSnapshot = snapshot;
        const report = reconcileZones(design, snapshot);
        routing.zones = report;
        if (!report.ok) {
          routing.status = 'failed';
          routing.lastOperation = this.failOperation(op, new Error(formatZoneIssues(report)), false);
          await this.writeState(statePath, state);
          throw new Error('Zone reconciliation failed: ' + formatZoneIssues(report));
        }
        if (this.bridge.hasTool('query_zones')) {
          const live = await this.call('query_zones', {}, calls);
          const payload = live.json as
            | { zones?: Array<{ net?: string; layers?: string[]; isFilled?: boolean }> }
            | undefined;
          for (const zone of declared) {
            const match = (payload?.zones ?? []).find(
              (z) => (z.net ?? '').replace(/^\//, '') === zone.net && (z.layers ?? []).includes(zone.layer),
            );
            if (!match) {
              throw new Error(`Zone live check: server query_zones reports no zone for '${zone.net}' on '${zone.layer}'.`);
            }
            if (match.isFilled === false) {
              throw new Error(`Zone live check: zone '${zone.net}' on '${zone.layer}' is reported unfilled by query_zones.`);
            }
          }
        }
        routing.lastOperation = this.confirmOperation(op);
        await this.writeState(statePath, state);
        return report;
      } catch (error) {
        if (routing.status !== 'failed') {
          routing.status = 'failed';
          routing.lastOperation = this.failOperation(op, error, isTimeout(error));
        }
        await this.writeState(statePath, state);
        throw error;
      }
    }
  }

  /** Zone outline: board-outline bbox from the last routing snapshot, inset
   * 0.5 mm so the pour stays inside Edge.Cuts. Falls back to the IR board
   * box (minus the same inset) when no outline was parsed. The server-side
   * fallback (board edges + corner-radius inset) is only used when no
   * outline is provided; sending an explicit outline keeps Level-1
   * deterministic. */
  private zoneOutlineFor(design: CircuitIR, _zone: ZoneSpec): Array<{ x: number; y: number }> {
    const outline = this.lastRoutingSnapshot?.geometry.outline;
    const inset = 0.5;
    if (outline) {
      return [
        { x: outline.x1 + inset, y: outline.y1 + inset },
        { x: outline.x2 - inset, y: outline.y1 + inset },
        { x: outline.x2 - inset, y: outline.y2 - inset },
        { x: outline.x1 + inset, y: outline.y2 - inset },
      ];
    }
    const w = design.board?.widthMm ?? 80;
    const h = design.board?.heightMm ?? 50;
    return [
      { x: inset, y: inset },
      { x: w - inset, y: inset },
      { x: w - inset, y: h - inset },
      { x: inset, y: h - inset },
    ];
  }

  private lastRoutingSnapshot?: RoutingBoardSnapshot;

  /** Final classified DRC before declaring routing complete. */
  private async runFinalDrc(
    projectDir: string,
    pcbFile: string,
    statePath: string,
    state: PipelineState,
    routing: RoutingProgress,
  ): Promise<DrcReport> {
    const op = this.beginOperation('kicad-cli pcb drc (final)', 'final_drc');
    routing.lastOperation = op;
    await this.writeState(statePath, state);
    try {
      const { report, classification } = await runDrcClassified(projectDir, pcbFile);
      // 0.3.0 classified DRC treats unconnected as reported-only; Level-1
      // routing completion additionally requires unconnected = 0.
      if (classification.blocking) {
        throw new Error(
          `Final DRC blocked: ${classification.blockingReason}. Unrouted connections: ${classification.unroutedCount}.`,
        );
      }
      if (report.unconnected > 0) {
        throw new Error(
          `Final DRC blocked: ${report.unconnected} unrouted connection(s) remain. Level-1 completion requires unrouted = 0.`,
        );
      }
      routing.finalDrc = report;
      routing.lastOperation = this.confirmOperation(op);
      await this.writeState(statePath, state);
      return report;
    } catch (error) {
      const timeout = isTimeout(error);
      routing.status = timeout ? 'unknown_after_timeout' : 'failed';
      routing.lastOperation = this.failOperation(op, error, timeout);
      await this.writeState(statePath, state);
      throw error;
    }
  }

  /** Preserve the current board file as a diagnostic before a mutation that
   * may rewrite it (routing import, zone fill). Never auto-restored. */
  private async backupRoutedBoard(pcbFile: string, tag: string): Promise<void> {
    if (!(await exists(pcbFile))) return;
    const dir = join(dirname(pcbFile), '.kicad-flow', 'routing-backups');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(pcbFile, join(dir, `${tag}-${stamp}.kicad_pcb`));
  }

  /** Read-only routing reconciliation tool entry (kicad_flow_routing_reconcile). */
  async routingReconcileOnly(input: unknown): Promise<Record<string, unknown>> {
    const design = this.designFromInput(input);
    const projectDir = join(resolve(this.config.projectDir), design.project.name);
    const pcbFile = join(projectDir, `${design.project.name}.kicad_pcb`);
    if (!(await exists(pcbFile))) {
      throw new Error(`PCB not found at ${pcbFile}. Compile target pcb first (kicad_flow_compile target=pcb).`);
    }
    const snapshot = await this.inspectRouting(pcbFile);
    const pcbSnapshot = await this.inspectPcb(pcbFile);
    const report = reconcileRoutingDesign(design, snapshot, { components: pcbSnapshot.components });
    const zones = reconcileZones(design, snapshot);
    return {
      ok: report.ok && zones.ok,
      routing: report,
      zones,
      tracks: snapshot.tracks.length,
      vias: snapshot.vias.length,
      outline: snapshot.geometry.outline,
    };
  }

  /** Live cross-check: the open board object (MCP get_pads) and the parsed
   * board file must agree on every pad's net. Disagreement is an ambiguous
   * state and stops the pipeline. */
  private assertPadsAgree(snapshot: PcbSnapshot, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const pads = (payload as { pads?: unknown }).pads;
    if (!Array.isArray(pads)) return;
    const live = new Map<string, Map<string, string | null>>();
    for (const raw of pads as Array<Record<string, unknown>>) {
      const ref = typeof raw.reference === 'string' ? raw.reference : undefined;
      const number = typeof raw.number === 'string' ? raw.number : undefined;
      if (!ref || number === undefined) continue;
      const netRaw = typeof raw.net === 'string' ? raw.net : '';
      const net = netRaw && !netRaw.startsWith('unconnected-(') ? netRaw.replace(/^\//, '') : null;
      if (!live.has(ref)) live.set(ref, new Map());
      live.get(ref)!.set(number, net);
    }
    for (const comp of snapshot.components) {
      const livePads = live.get(comp.ref);
      if (!livePads) continue; // ref not reported live: file snapshot stays authoritative
      for (const pad of comp.pads) {
        if (!livePads.has(pad.pad)) continue;
        const liveNet = livePads.get(pad.pad) ?? null;
        if ((pad.net ?? null) !== liveNet) {
          throw new Error(
            `PCB pad disagreement between the board file and the live board: ${comp.ref} pad '${pad.pad}' ` +
              `file=${pad.net ?? '<none>'} live=${liveNet ?? '<none>'}. This is an ambiguous state; resolve it manually before continuing.`,
          );
        }
      }
    }
  }

  private async recordPcbFailure(statePath: string, state: PipelineState, op: PipelineOperation, error: unknown): Promise<void> {
    const timeout = isTimeout(error);
    const progress = (state.pcb ??= { status: 'pending', confirmedFootprintRefs: [], confirmedNetNames: [] });
    progress.status = timeout ? 'unknown_after_timeout' : 'failed';
    progress.lastOperation = this.failOperation(op, error, timeout);
    await this.writeState(statePath, state);
  }

  // ---------------------------------------------------------------------
  // 0.3.0 read-only PCB tools
  // ---------------------------------------------------------------------

  /** Read-only PCB preflight: validates the IR, checks the existing
   * schematic reconciliation and ERC, reports footprint requirements,
   * placement feasibility and board constraints. Mutates nothing. */
  async pcbPreflight(input: unknown): Promise<Record<string, unknown>> {
    const vr = validateAndNormalizeIR(input);
    if (!vr.ok || !vr.design) {
      throw new Error(`Circuit IR is invalid:\n${vr.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
    }
    const design = vr.design;
    const projectDir = join(resolve(this.config.projectDir), design.project.name);
    const schematicFile = join(projectDir, `${design.project.name}.kicad_sch`);
    const requirements = pcbFootprintRequirements(design);

    let placement: { ok: boolean; error?: string; componentCount: number; board: { widthMm: number; heightMm: number; marginMm: number } };
    try {
      const plan = computePcbPlacements(design);
      placement = { ok: true, componentCount: plan.placements.length, board: plan.board };
    } catch (error) {
      placement = {
        ok: false,
        error: errorMessage(error),
        componentCount: design.components.length,
        board: {
          widthMm: design.board?.widthMm ?? 80,
          heightMm: design.board?.heightMm ?? 50,
          marginMm: design.board?.marginMm ?? 5,
        },
      };
    }

    let schematic: { exists: boolean; reconciled: boolean; report?: ReconciliationReport } = { exists: false, reconciled: false };
    if (await exists(schematicFile)) {
      try {
        const snapshot = await this.inspectSchematic(schematicFile);
        const report = reconcileDesignToSnapshot(design, snapshot, expectedPowerFlags(design));
        schematic = { exists: true, reconciled: report.ok, report };
      } catch (error) {
        schematic = { exists: true, reconciled: false, report: undefined };
        return {
          ok: false,
          project: design.project.name,
          error: `Schematic snapshot failed: ${errorMessage(error)}`,
          schematic,
          footprints: { required: requirements.required, missing: requirements.missing, artifactsExcluded: requirements.artifactsExcluded },
        };
      }
    }

    let erc: { errors: number; warnings: number } | 'not_run' | { error: string } = 'not_run';
    if (schematic.exists) {
      try {
        const report = await ercReport(projectDir, schematicFile);
        erc = { errors: report.errors, warnings: report.warnings };
      } catch (error) {
        erc = { error: errorMessage(error) };
      }
    }

    const ercErrors = typeof erc === 'object' && 'errors' in erc ? erc.errors : undefined;
    const ok = schematic.reconciled && ercErrors === 0 && requirements.missing.length === 0 && placement.ok;
    return {
      ok,
      project: design.project.name,
      schematic,
      erc,
      footprints: {
        required: requirements.required,
        missing: requirements.missing,
        artifactsExcluded: requirements.artifactsExcluded,
        policy: 'every functional component requires an explicit IR footprint; #PWR/PWR_FLAG artifacts never become footprints',
      },
      placement,
      board: {
        widthMm: design.board?.widthMm ?? 80,
        heightMm: design.board?.heightMm ?? 50,
        marginMm: design.board?.marginMm ?? 5,
        layers: design.board?.layers ?? 2,
        clearanceMm: design.board?.clearanceMm ?? 0.2,
        trackWidthMm: design.board?.trackWidthMm ?? 0.25,
        viaDiameterMm: design.board?.viaDiameterMm ?? 0.6,
        viaDrillMm: design.board?.viaDrillMm ?? 0.3,
      },
      netclasses: {
        declared: (design.netclasses ?? []).map((r) => r.name),
        profileDefaultsInjected: false,
        policy: 'only IR-declared netclasses are applied; missing special rules are reported, never inferred',
      },
    };
  }

  /** Read-only PCB reconciliation against the .kicad_pcb file. */
  async pcbReconcileOnly(input: unknown): Promise<Record<string, unknown>> {
    const design = this.designFromInput(input);
    const projectDir = join(resolve(this.config.projectDir), design.project.name);
    const pcbFile = join(projectDir, `${design.project.name}.kicad_pcb`);
    if (!(await exists(pcbFile))) {
      throw new Error(`PCB not found at ${pcbFile}. Compile target pcb first (kicad_flow_compile target=pcb).`);
    }
    const snapshot = await this.inspectPcb(pcbFile);
    const report = reconcilePcbDesign(design, snapshot);
    const padCollisions = detectPadCollisions(snapshot);
    return {
      ok: report.ok && padCollisions.length === 0,
      report,
      padCollisions,
      snapshotFootprints: snapshot.components.length,
      snapshotNets: snapshot.nets.length,
    };
  }

  /** Read-only classified DRC. Refuses to run while PCB reconciliation
   * fails; unrouted connections are reported, structural errors surface as
   * a thrown error (they block the foundation). */
  async drcOnly(input: unknown): Promise<Record<string, unknown>> {
    const design = this.designFromInput(input);
    const projectDir = join(resolve(this.config.projectDir), design.project.name);
    const pcbFile = join(projectDir, `${design.project.name}.kicad_pcb`);
    if (!(await exists(pcbFile))) {
      throw new Error(`PCB not found at ${pcbFile}. Compile target pcb first (kicad_flow_compile target=pcb).`);
    }
    const snapshot = await this.inspectPcb(pcbFile);
    const reconciliation = reconcilePcbDesign(design, snapshot);
    if (!reconciliation.ok) {
      throw new Error('DRC refused: PCB reconciliation failed first:\n' + formatPcbReconciliation(reconciliation));
    }
    const { report, classification } = await runDrcClassified(projectDir, pcbFile);
    return { ok: !classification.blocking, drc: report, classification };
  }

  private designFromInput(input: unknown): CircuitIR {
    const vr = validateAndNormalizeIR(input);
    if (!vr.ok || !vr.design) {
      throw new Error(`Circuit IR is invalid:\n${vr.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
    }
    return vr.design;
  }

  private async manufacture(
    design: CircuitIR,
    projectDir: string,
    pcbFile: string,
    statePath: string,
    state: PipelineState,
    calls: string[],
  ): Promise<ManufacturingResult> {
    calls.push('kicad-cli manufacturing pack');
    const mfg = state.manufacturing ?? { status: 'pending' as const };
    state.manufacturing = mfg;
    mfg.status = 'pending';
    mfg.lastOperation = this.beginOperation('kicad-cli gerbers/drill/bom/cpl', 'manufacturing');
    await this.writeState(statePath, state);
    try {
      // Copper layer list comes from the parsed board (authoritative source),
      // with a fresh parse as fallback.
      let copperLayers = this.lastRoutingSnapshot?.geometry.copperLayers ?? [];
      if (!copperLayers.length) {
        copperLayers = await this.inspectRouting(pcbFile).then(
          (s) => s.geometry.copperLayers,
          () => [],
        );
      }
      const mfgResult = await buildManufacturingPack({
        projectName: design.project.name,
        projectDir,
        pcbPath: pcbFile,
        outputDir: design.manufacturing?.outputDir,
        design,
        copperLayers,
        boardWidthMm: design.board?.widthMm,
        boardHeightMm: design.board?.heightMm,
        expectDrill: this.manufacturingTestOptions?.expectDrill,
        drcStatus: state.routing?.finalDrc ? `errors=${state.routing.finalDrc.errors}, warnings=${state.routing.finalDrc.warnings}, unconnected=${state.routing.finalDrc.unconnected}` : undefined,
        excludeCplRefs: design.components
          .filter((c) => c.excludeFromCpl || c.excludeFromBom)
          .map((c) => c.ref),
      });
      mfg.status = 'complete';
      mfg.result = mfgResult;
      mfg.lastOperation = this.confirmOperation(mfg.lastOperation);
      await this.writeState(statePath, state);
      return mfgResult;
    } catch (error) {
      const timeout = isTimeout(error);
      mfg.status = timeout ? 'unknown_after_timeout' : 'failed';
      mfg.lastOperation = this.failOperation(mfg.lastOperation, error, timeout);
      await this.writeState(statePath, state);
      throw error;
    }
  }

  private async call(name: string, args: Record<string, unknown>, calls: string[]): Promise<McpCallResult> {
    const result = await this.bridge.call(name, stripUndefined(args));
    calls.push(name);
    // 0.4.1: an MCP success response with a JSON body carrying success=false is
    // a tool-level refusal (e.g. batch_move_components all-or-nothing: "Component
    // not found: F1, K1" while 50 footprints stayed stacked at (0,0)). The bridge
    // only throws on isError/semantic text matches; success=false must also fail
    // loudly or the pipeline continues into misleading downstream errors.
    const payload = result.json as { success?: unknown; message?: unknown; errorDetails?: unknown } | undefined;
    if (payload && payload.success === false) {
      const message = typeof payload.message === 'string' ? payload.message : 'tool reported success=false';
      const details = typeof payload.errorDetails === 'string' ? ` — ${payload.errorDetails}` : '';
      throw new Error(`KiCad MCP ${name} failed: ${message}${details}`);
    }
    return result;
  }

  private async callOptional(name: string, args: Record<string, unknown>, calls: string[]): Promise<void> {
    if (!this.bridge.hasTool(name)) return;
    try {
      await this.bridge.call(name, stripUndefined(args));
      calls.push(name);
    } catch (error) {
      // Cosmetic/compatibility helpers must never corrupt the core pipeline.
      if (!['autoplace_schematic_fields', 'lint_schematic_cosmetic'].includes(name)) throw error;
    }
  }

  private async writeState(statePath: string, state: PipelineState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await fs.mkdir(dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  private async backupGeneratedFiles(projectDir: string, name: string): Promise<void> {
    if (!(await exists(projectDir))) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(projectDir, '.kicad-flow', 'backups', stamp);
    const candidates = [
      `${name}.kicad_pro`, `${name}.kicad_sch`, `${name}.kicad_pcb`, `${name}.kicad_prl`, `${name}.kicad_pro-bak`,
    ];
    let copied = false;
    for (const file of candidates) {
      const src = join(projectDir, file);
      if (!(await exists(src))) continue;
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(src, join(backupDir, file));
      await fs.rm(src, { force: true });
      copied = true;
    }
    if (copied) {
      await fs.writeFile(join(backupDir, 'README.txt'), 'Automatic backup created by dsh-plugin-kicad-flow before forceRebuild.\n');
    }
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) out[k] = v.map((x) => typeof x === 'object' && x !== null ? stripUndefined(x as Record<string, unknown>) : x);
    else if (typeof v === 'object' && v !== null) out[k] = stripUndefined(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out as T;
}
