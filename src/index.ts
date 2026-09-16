import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { KiCadFlowEngine } from './engine.js';
import { validateAndNormalizeIR } from './ir.js';
import { schematicPlacements, pcbPlacements, connectionMaps } from './layout.js';
import { McpBridge } from './mcp-bridge.js';
import { buildManufacturingPack, evaluateManufacturingGate, type Level1GateState } from './manufacturing.js';
import { parseRoutingBoard } from './routing.js';
import { runErc } from './verification.js';

export const name = 'dsh-plugin-kicad-flow';
export const inject = ['tools'] as const;

export interface Config {
  kicadMcpCommand: string;
  kicadMcpArgs: string[];
  projectDir: string;
  freeroutingJar: string;
  exposeRawMcp: boolean;
}

const DEFAULT_MCP_ENTRY = process.env.KICAD_MCP_ENTRY ?? '/home/juan/dev/Kicad/tools/KiCAD-MCP-Server/dist/index.js';
const DEFAULT_FREEROUTING = process.env.FREEROUTING_JAR ?? '/home/juan/dev/Kicad/tools/freerouting/freerouting.jar';

export const Config: Schema<Config> = Schema.object({
  kicadMcpCommand: Schema.string().default(process.env.KICAD_MCP_COMMAND ?? 'node'),
  kicadMcpArgs: Schema.array(Schema.string()).default([DEFAULT_MCP_ENTRY]),
  projectDir: Schema.string().default(process.env.KICAD_FLOW_PROJECT_DIR ?? './kicad-projects'),
  freeroutingJar: Schema.string().default(DEFAULT_FREEROUTING),
  exposeRawMcp: Schema.boolean().default(false),
});

const SYSTEM_PROMPT = `KiCad Flow is a deterministic hardware compiler (Level 1 complete: schematic -> PCB -> routing -> zones -> DRC -> manufacturing). Express the circuit as Circuit IR and let the compiler materialize KiCad.

Normal workflow:
1. Save the Circuit IR to a JSON file and use that file as the source of truth.
2. Run kicad_flow_validate_ir.
3. Run kicad_flow_compile for the requested target. The compiler performs strict symbol preflight, chunked mutation, checkpoints, IR↔KiCad reconciliation, and ERC before a schematic is complete.
4. Level-1 targets extend the chain: 'routed' adds freerouting DSN/SES routing + explicitly declared copper zones + final DRC (unrouted = 0 and DRC errors = 0 required). 'manufacturing' adds Gerbers/drill/BOM/CPL + reproducible ZIP + manifest, only after every Level-1 gate passed (project.status = level1_complete).
5. The LLM never emits traces, vias or coordinates: routing is declared intent (board.routing, backend 'freerouting'); copper zones are declared intent (zones[]); the compiler does the rest.
6. On any error, timeout, reconciliation mismatch, routing incomplete (unrouted > 0), DRC error, or ambiguous state: STOP and report. Do not repair automatically.

Rules:
- Do not choose low-level MCP tools, wire coordinates, PCB coordinates, or CLI sequences during normal work.
- Do not inline large Circuit IR objects into tool calls.
- Never modify the IR, plugin, KiCAD-MCP-Server, timeouts, dependencies, or project files automatically after an error.
- Never retry a timed-out mutation automatically. A timeout means unknown_after_timeout until the real board is reconciled (kicad_flow_routing_reconcile for routing).
- Never use forceRebuild as automatic recovery. It requires an explicit user decision.
- A MCP success response is not proof of success; the reconciled board/netlist file is authoritative.
- Use global=true for power rails or nets that must span sheets.
- Put one electrical pin on exactly one net and declare intentionally unused pins with noConnectPins.
- Copper zones are never inferred: absent zones[] means no zone is created.
- kicad_mcp_call is disabled by default and is never the normal design path.`;

const IR_TEMPLATE = {
  version: 1,
  project: { name: 'example-controller', profile: 'generic', description: 'One sentence purpose' },
  blocks: ['input', 'controller', 'output'],
  components: [
    {
      ref: 'J1',
      symbol: 'Connector_Generic:Conn_01x02',
      value: 'INPUT',
      footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
      block: 'input',
    },
    {
      ref: 'R1',
      symbol: 'Device:R',
      value: '10k',
      footprint: 'Resistor_SMD:R_0603_1608Metric',
      block: 'controller',
      properties: { LCSC: '' },
    },
  ],
  nets: [{ name: 'SIGNAL', pins: [{ ref: 'J1', pin: '1' }, { ref: 'R1', pin: '1' }] }],
  board: {
    widthMm: 60,
    heightMm: 40,
    layers: 2,
    // Declared routing intent. Absent = no routing stage is ever run.
    routing: { backend: 'freerouting', maxPasses: 20, timeoutSeconds: 300 },
  },
  // Declared copper zones. Absent/empty = no zone is ever created.
  zones: [{ net: 'GND', layer: 'B.Cu', minWidthMm: 0.2, thermal: 'relief' }],
  manufacturing: { enabled: true, outputDir: 'manufacturing' },
};

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

/** Convert tool results to canonical JSON values. DSH rejects values containing
 * undefined/functions/symbols as "not lossless JSON" before rendering. */
export function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resolveDesignPath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}

async function loadDesignFile(path: string): Promise<{ path: string; design: unknown }> {
  const absolute = resolveDesignPath(path);
  let text: string;
  try {
    text = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read Circuit IR file '${absolute}': ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { path: absolute, design: JSON.parse(text) as unknown };
  } catch (error) {
    throw new Error(`Circuit IR file '${absolute}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function compactValidation(sourcePath: string, result: ReturnType<typeof validateAndNormalizeIR>): Record<string, unknown> {
  if (!result.ok || !result.design) {
    return toJsonValue({
      ok: false,
      sourcePath,
      errors: result.errors,
      warnings: result.warnings,
    });
  }

  const schematic = schematicPlacements(result.design);
  const pcb = pcbPlacements(result.design);
  const maps = connectionMaps(result.design);
  return toJsonValue({
    ok: true,
    sourcePath,
    project: result.design.project,
    summary: {
      blocks: result.design.blocks?.length ?? 0,
      components: result.design.components.length,
      nets: result.design.nets.length,
      netclasses: result.design.netclasses?.length ?? 0,
      schematicPlacements: schematic.length,
      pcbPlacements: pcb.length,
      localConnectionRefs: Object.keys(maps.local).length,
      globalConnectionRefs: Object.keys(maps.global).length,
    },
    errors: [],
    warnings: result.warnings,
  });
}

export function apply(ctx: any, config: Config): void {
  const bridge = new McpBridge({
    command: config.kicadMcpCommand,
    args: config.kicadMcpArgs,
  });
  const engine = new KiCadFlowEngine(bridge, {
    projectDir: config.projectDir,
    freeroutingJar: config.freeroutingJar,
  });

  const systemPrompt = ctx.get?.('systemPrompt');
  systemPrompt?.section({
    name: 'tool:kicad-flow',
    order: 165,
    text: SYSTEM_PROMPT,
  });

  ctx.tools.register({
    name: 'kicad_flow_ir_template',
    description: 'Return the compact Circuit IR v1 shape. Use only when the IR schema needs to be recalled.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOutput,
    async execute() {
      return toJsonValue(IR_TEMPLATE);
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_validate_ir',
    description: 'Validate a Circuit IR JSON file without touching KiCad. Pass an absolute designPath. Returns a compact summary rather than echoing the full IR.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string }) {
      const loaded = await loadDesignFile(a.designPath);
      return compactValidation(loaded.path, validateAndNormalizeIR(loaded.design));
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_compile',
    description: 'Primary KiCad Flow tool. Deterministically compile Circuit IR with strict preflight, chunked checkpoints, safe resume, netlist reconciliation and verification. Pass the IR by absolute designPath.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
        target: { type: 'string', enum: ['schematic', 'pcb', 'board', 'routed', 'manufacturing'] },
        forceRebuild: { type: 'boolean' },
        skipAutoroute: { type: 'boolean' },
        skipVerification: { type: 'boolean' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: {
      designPath: string;
      target?: 'schematic' | 'pcb' | 'board' | 'routed' | 'manufacturing';
      forceRebuild?: boolean;
      skipAutoroute?: boolean;
      skipVerification?: boolean;
    }) {
      const loaded = await loadDesignFile(a.designPath);
      const result = await engine.compile(loaded.design, a);
      return toJsonValue({ sourcePath: loaded.path, ...result });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_reconcile',
    description: 'Read-only IR ↔ KiCad reconciliation. Compares components, nets and endpoints using the exported KiCad netlist. Never mutates the project.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string }) {
      const loaded = await loadDesignFile(a.designPath);
      const result = await engine.reconcile(loaded.design);
      return toJsonValue({ sourcePath: loaded.path, schematicFile: result.schematicFile, ...result.report });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_erc',
    description: 'Run ERC only after read-only IR ↔ KiCad reconciliation passes. Stops on reconciliation mismatch or ERC errors.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string }) {
      const loaded = await loadDesignFile(a.designPath);
      const reconciled = await engine.reconcile(loaded.design);
      if (!reconciled.report.ok) {
        throw new Error(`ERC refused because IR ↔ KiCad reconciliation failed: ${JSON.stringify(reconciled.report)}`);
      }
      const projectDir = resolve(config.projectDir, reconciled.design.project.name);
      const erc = await runErc(projectDir, reconciled.schematicFile);
      return toJsonValue({ sourcePath: loaded.path, schematicFile: reconciled.schematicFile, reconciliation: reconciled.report, erc });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_pcb_preflight',
    description: 'Read-only PCB foundation preflight. Validates the IR, checks schematic reconciliation + ERC state, footprint requirements, placement feasibility and board constraints. Mutates nothing.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string }) {
      const loaded = await loadDesignFile(a.designPath);
      const result = await engine.pcbPreflight(loaded.design);
      return toJsonValue({ sourcePath: loaded.path, ...result });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_pcb_reconcile',
    description: 'Read-only PCB reconciliation: compares the Circuit IR against the .kicad_pcb file (footprints, nets, pad nets, pad collisions). Never mutates the project.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string }) {
      const loaded = await loadDesignFile(a.designPath);
      const result = await engine.pcbReconcileOnly(loaded.design);
      return toJsonValue({ sourcePath: loaded.path, ...result });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_drc',
    description: 'Read-only classified DRC: separates unrouted connections (reported, expected before routing) from structural errors and schematic parity (blocking). Refuses to run if PCB reconciliation fails.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string }) {
      const loaded = await loadDesignFile(a.designPath);
      const result = await engine.drcOnly(loaded.design);
      return toJsonValue({ sourcePath: loaded.path, ...result });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_route',
    description: 'Run the routing phase (freerouting DSN/SES backend) plus explicitly declared copper zones and the final DRC gate, over a previously placed board. Requires target pcb completed first. On unrouted > 0 or DRC errors the pipeline reports incomplete and stops.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
        skipVerification: { type: 'boolean' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string; skipVerification?: boolean }) {
      const loaded = await loadDesignFile(a.designPath);
      const result = await engine.compile(loaded.design, {
        target: 'routed',
        skipVerification: a.skipVerification,
      });
      return toJsonValue({ sourcePath: loaded.path, ...result });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_routing_reconcile',
    description: 'Read-only routing reconciliation: verifies every IR net endpoint is attached to a track/via/zone on the routed board and declared zones exist. Use after a routing timeout (unknown_after_timeout) or before trusting a routing result. Never mutates the project.',
    parameters: {
      type: 'object',
      properties: {
        designPath: { type: 'string', description: 'Absolute path to the Circuit IR JSON file.' },
      },
      required: ['designPath'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { designPath: string }) {
      const loaded = await loadDesignFile(a.designPath);
      const result = await engine.routingReconcileOnly(loaded.design);
      return toJsonValue({ sourcePath: loaded.path, ...result });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_status',
    description: 'Show KiCad Flow architecture and optionally probe the small KiCAD-MCP-Server capability set used by the compiler.',
    parameters: {
      type: 'object',
      properties: { connect: { type: 'boolean' } },
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { connect?: boolean }) {
      let capabilities: string[] = [];
      if (a.connect) capabilities = (await bridge.start()).map((t) => t.name);
      const important = [
        'create_project', 'batch_list_symbol_pins', 'list_symbol_pins', 'batch_add_components', 'batch_connect', 'validate_schematic',
        'create_board_from_schematic', 'sync_schematic_to_board', 'set_board_size', 'set_design_rules', 'batch_move_components',
        'check_courtyard_overlaps', 'get_pads', 'save_board', 'reload_board',
        'check_freerouting', 'export_dsn', 'import_ses', 'add_copper_pour', 'refill_zones',
        'export_gerbers', 'export_drill',
      ];
      return toJsonValue({
        version: '0.4.0',
        architecture: 'Circuit IR file -> deterministic compiler -> KiCAD-MCP-Server/kicad-cli/freerouting -> KiCad/JLCPCB (Level 1 complete)',
        projectDir: resolve(config.projectDir),
        rawMcpExposed: config.exposeRawMcp,
        transport: 'file-first',
        importantCapabilities: a.connect
          ? Object.fromEntries(important.map((n) => [n, capabilities.includes(n)]))
          : important,
      });
    },
  });

  ctx.tools.register({
    name: 'kicad_mcp_status',
    description: 'Diagnostic only. Connect to KiCAD-MCP-Server and report the subset of remote tools used by KiCad Flow.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOutput,
    async execute() {
      const remote = await bridge.start();
      const wanted = new Set([
        'create_project', 'open_project', 'batch_list_symbol_pins', 'batch_add_components', 'batch_connect', 'batch_add_no_connects',
        'batch_edit_schematic_components', 'validate_schematic', 'autoplace_schematic_fields', 'lint_schematic_cosmetic',
        'create_board_from_schematic', 'sync_schematic_to_board', 'set_board_size', 'set_design_rules', 'batch_move_components',
        'check_courtyard_overlaps', 'get_pads', 'save_board', 'reload_board',
        'autoroute', 'add_copper_pour', 'refill_zones',
      ]);
      return toJsonValue({
        connected: true,
        toolCount: remote.length,
        usedTools: remote.filter((x) => wanted.has(x.name)).map((x) => x.name),
      });
    },
  });

  ctx.tools.register({
    name: 'kicad_flow_manufacturing_pack',
    description: 'Build Gerbers, drill, BOM and JLCPCB CPL for a project previously compiled by KiCad Flow. Level-1 gate: refuses to run unless state.json shows schematic + PCB reconciliation PASS, routing complete with unrouted = 0 and final DRC errors = 0.',
    parameters: {
      type: 'object',
      properties: {
        projectName: { type: 'string' },
        projectDir: { type: 'string' },
      },
      required: ['projectName'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(a: { projectName: string; projectDir?: string }) {
      const projectDir = resolve(a.projectDir ?? join(config.projectDir, a.projectName));
      const designPath = join(projectDir, '.kicad-flow', 'design.json');
      const design = validateAndNormalizeIR(JSON.parse(await fs.readFile(designPath, 'utf8')));
      if (!design.ok || !design.design) {
        throw new Error(`Stored design is invalid: ${design.errors.map((e) => e.message).join('; ')}`);
      }
      const d = design.design;
      // Level-1 gate: the standalone pack is only produced for a fully routed,
      // DRC-clean board. Mirrors the engine manufacturing gate (compile target
      // 'manufacturing'); blocks packing of placed-but-unrouted boards.
      const statePath = join(projectDir, '.kicad-flow', 'state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as Level1GateState;
      const gateFails = evaluateManufacturingGate(state);
      if (gateFails.length) {
        throw new Error(
          'Manufacturing gate blocked: ' + gateFails.join('; ') +
            '. Gerbers/drill/BOM/CPL are only produced after a fully routed, DRC-clean Level-1 board (kicad_flow_compile target=manufacturing).',
        );
      }
      const pcbPath = join(projectDir, `${d.project.name}.kicad_pcb`);
      // Copper layers, board size and DRC status come from the board/state
      // itself, never from a hardcoded vendor list. The gate guarantees the
      // final DRC exists and is clean before this point.
      const routingSnapshot = parseRoutingBoard(await fs.readFile(pcbPath, 'utf8'));
      const outline = routingSnapshot.geometry.outline;
      const finalDrc = state.routing?.finalDrc;
      return toJsonValue(await buildManufacturingPack({
        projectName: d.project.name,
        projectDir,
        pcbPath,
        outputDir: d.manufacturing?.outputDir,
        design: d,
        copperLayers: routingSnapshot.geometry.copperLayers,
        boardWidthMm: outline ? Number((outline.x2 - outline.x1).toFixed(3)) : undefined,
        boardHeightMm: outline ? Number((outline.y2 - outline.y1).toFixed(3)) : undefined,
        drcStatus: `errors=${finalDrc?.errors ?? 0}, warnings=${finalDrc?.warnings ?? 0}, unconnected=${finalDrc?.unconnected ?? 0}`,
        excludeCplRefs: d.components.filter((c) => c.excludeFromCpl || c.excludeFromBom).map((c) => c.ref),
      }));
    },
  });

  if (config.exposeRawMcp) {
    ctx.tools.register({
      name: 'kicad_mcp_call',
      description: 'DEBUG ONLY. Raw KiCAD-MCP-Server passthrough. Normal design work must use kicad_flow_compile.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          args: { type: 'object', additionalProperties: true },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      output: jsonOutput,
      async execute(a: { tool: string; args?: Record<string, unknown> }) {
        const result = await bridge.call(a.tool, a.args ?? {});
        return toJsonValue({ text: result.text, json: result.json, isError: result.isError });
      },
    });
  }

  ctx.effect(() => () => {
    void bridge.stop();
  });
}
