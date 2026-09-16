import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { KiCadFlowEngine } from '../dist/engine.js';
import { validateAndNormalizeIR } from '../dist/ir.js';
import { parseRoutingBoard, reconcileRoutingDesign, reconcileZones } from '../dist/routing.js';
import { buildManufacturingPack, evaluateManufacturingGate, PLUGIN_VERSION } from '../dist/manufacturing.js';

// ---------------------------------------------------------------------------
// 0.4.0 Level-1 regression: routing + zones + manufacturing over the same
// FakeBridge family as regression-0.3.0.
//
// The routing stage is driven through an injected RoutingBackend (no java):
// the fake draws a routed .kicad_pcb (tracks chaining each net's pads, zones
// from the IR) into the project board file, which the engine then parses with
// the production parseRoutingBoard — exactly like the real flow.
//
// kicad-cli (ERC / classified DRC / manufacturing exports) is shimmed through
// PATH so the whole Level-1 chain runs offline and deterministically.
// ---------------------------------------------------------------------------

const PIN_DB = {
  'Connector_Generic:Conn_01x02': [
    ['1', '', 'passive', -2.54, 0, 0],
    ['2', '', 'passive', 2.54, 0, 0],
  ],
  'Device:R': [
    ['1', '', 'passive', 0, 2.54, 0],
    ['2', '', 'passive', 0, -2.54, 0],
  ],
  'Device:C': [
    ['1', '', 'passive', 0, 2.54, 0],
    ['2', '', 'passive', 0, -2.54, 0],
  ],
  'power:PWR_FLAG': [
    ['1', '', 'power_out', 0, 0, 0],
  ],
};

const FOOTPRINT_DB = {
  'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical': ['1', '2'],
  'Resistor_SMD:R_0603_1608Metric': ['1', '2'],
  'Capacitor_SMD:C_0603_1608Metric': ['1', '2'],
};

function preflightText(symbols) {
  const lines = [];
  const errors = [];
  for (const symbol of symbols) {
    const pins = PIN_DB[symbol];
    if (!pins) {
      errors.push(`  ${symbol}: symbol not found`);
      continue;
    }
    lines.push(`${symbol} — ${pins.length} pin(s):`);
    for (const [number, name, type, x, y, angle] of pins) {
      lines.push(`    Pin ${number} (${name}) — type: ${type} at (${x},${y}) angle=${angle}`);
    }
  }
  if (errors.length) {
    lines.push('');
    lines.push('Errors:');
    lines.push(...errors);
  }
  return lines.join('\n');
}

class FakeBridge {
  tools = new Set([
    'create_project', 'batch_list_symbol_pins', 'batch_add_components', 'batch_connect',
    'batch_add_no_connects', 'validate_schematic',
    'create_board_from_schematic', 'set_board_size', 'set_design_rules',
    'batch_move_components', 'get_pads',
    'open_project', 'get_nets_list', 'query_zones',
    'export_dsn', 'import_ses', 'add_copper_pour', 'refill_zones',
  ]);
  calls = [];
  refs = [];
  refSymbols = new Map();
  refFootprints = new Map();
  nets = new Map();
  boardSize = null;
  pcbFootprints = new Map();
  failOn = null;
  projectPath = null;
  projectName = null;
  /** Zones the server would report through query_zones. */
  reportedZones = [];
  /** Raw add_copper_pour args, in arrival order. */
  pourCalls = [];
  /** When true, refill_zones fails (server-side subprocess error). */
  refillFails = false;

  async start() { return [...this.tools].map((name) => ({ name })); }
  hasTool(name) { return this.tools.has(name); }
  async callIfAvailable(name, args = {}) {
    return this.hasTool(name) ? this.call(name, args) : undefined;
  }

  snapshot = async () => {
    const nets = [...this.nets.entries()].map(([name, nodes]) => ({
      rawName: name,
      name: name.startsWith('/') ? name.slice(1) : name,
      nodes: nodes.map((n) => ({ ...n })),
    }));
    const schematicArtifacts = this.refs
      .filter((r) => r.startsWith('#PWR'))
      .map((ref) => {
        let net = null;
        for (const [name, nodes] of this.nets) {
          if (nodes.some((n) => n.ref === ref)) {
            net = name.startsWith('/') ? name.slice(1) : name;
            break;
          }
        }
        return { ref, net };
      });
    const covered = new Set();
    for (const nodes of this.nets.values()) {
      for (const n of nodes) covered.add(`${n.ref}/${n.pin}`);
    }
    for (const ref of this.refs) {
      for (const [number] of PIN_DB[this.refSymbols.get(ref)] ?? []) {
        if (covered.has(`${ref}/${number}`)) continue;
        nets.push({
          rawName: `unconnected-(${ref}-Pad${number})`,
          name: `unconnected-(${ref}-Pad${number})`,
          nodes: [{ ref, pin: number }],
        });
      }
    }
    return { componentRefs: [...this.refs], nets, schematicArtifacts };
  };

  pcbSnapshot = async () => {
    const components = [...this.pcbFootprints.entries()].map(([ref, fp]) => ({
      ref,
      lib: fp.lib,
      x: fp.x,
      y: fp.y,
      rotation: fp.rotation,
      layer: 'F.Cu',
      pads: fp.pads.map((p) => ({ pad: p.pad, net: p.net, x: p.dx, y: p.dy })),
    }));
    return { components, nets: [...this.netNames()].sort() };
  };

  netNames() {
    const names = new Set();
    for (const [raw, nodes] of this.nets) {
      const name = raw.startsWith('/') ? raw.slice(1) : raw;
      if (!name || name.startsWith('unconnected-(')) continue;
      names.add(name);
    }
    return [...names];
  }

  padNetFor(ref, pad) {
    for (const [raw, nodes] of this.nets) {
      if (nodes.some((n) => n.ref === ref && n.pin === pad)) {
        const name = raw.startsWith('/') ? raw.slice(1) : raw;
        return name && !name.startsWith('unconnected-(') ? name : null;
      }
    }
    return null;
  }

  padLocal(lib, pad) {
    if (lib === 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical') {
      return { dx: pad === '1' ? -2.54 : 2.54, dy: 0 };
    }
    return pad === '1' ? { dx: 0, dy: 2.54 } : { dx: 0, dy: -2.54 };
  }

  boardFilePath() {
    return this.projectPath && this.projectName
      ? join(this.projectPath, `${this.projectName}.kicad_pcb`)
      : null;
  }

  /** Materialize the (placed, unrouted) board file the compiler parses. */
  async writeBoard(zones = [], extra = {}) {
    const path = this.boardFilePath();
    if (!path) return;
    const snapshot = await this.pcbSnapshot();
    await writeFile(path, routedPcbText(snapshot, [], { zones, ...extra }), 'utf8');
  }

  async call(name, args = {}) {
    if (this.failOn && this.failOn.tool === name) {
      throw new Error(this.failOn.message ?? 'request timed out');
    }
    if (!this.hasTool(name)) throw new Error(`missing ${name}`);
    this.calls.push({ name, args });
    const fs = await import('node:fs/promises');
    if (name === 'create_project') {
      await fs.mkdir(args.path, { recursive: true });
      this.projectPath = args.path;
      this.projectName = args.name;
      await writeFile(join(args.path, `${args.name}.kicad_pro`), '{}');
      await writeFile(join(args.path, `${args.name}.kicad_sch`), '(kicad_sch)');
    }
    if (name === 'batch_list_symbol_pins') {
      return { raw: {}, text: preflightText(args.symbols), isError: false };
    }
    if (name === 'batch_add_components') {
      for (const c of args.components) {
        this.refs.push(c.reference);
        this.refSymbols.set(c.reference, c.symbol);
        if (c.footprint) this.refFootprints.set(c.reference, c.footprint);
      }
    }
    if (name === 'batch_connect') {
      for (const [ref, pins] of Object.entries(args.connections)) {
        for (const [pin, net] of Object.entries(pins)) {
          const key = `/${net}`;
          const nodes = this.nets.get(key) ?? [];
          if (!nodes.some((n) => n.ref === ref && n.pin === pin)) nodes.push({ ref, pin, pinFunction: pin });
          this.nets.set(key, nodes);
        }
      }
    }
    if (name === 'create_board_from_schematic') {
      for (const ref of this.refs) {
        const lib = this.refFootprints.get(ref);
        if (!lib) continue;
        const pads = (FOOTPRINT_DB[lib] ?? []).map((pad) => {
          const local = this.padLocal(lib, pad);
          return { pad, dx: local.dx, dy: local.dy, net: this.padNetFor(ref, pad) };
        });
        this.pcbFootprints.set(ref, { lib, x: 0, y: 0, rotation: 0, pads });
      }
    }
    if (name === 'set_board_size') this.boardSize = { width: args.width, height: args.height, unit: args.unit };
    if (name === 'batch_move_components') {
      for (const [ref, spec] of Object.entries(args.moves)) {
        const fp = this.pcbFootprints.get(ref);
        if (!fp) continue;
        fp.x = spec.x;
        fp.y = spec.y;
        fp.rotation = spec.rotation ?? 0;
      }
      await this.writeBoard();
    }
    if (name === 'get_pads') {
      const pads = [];
      for (const [ref, fp] of this.pcbFootprints) {
        for (const p of fp.pads) {
          pads.push({ reference: ref, number: p.pad, net: p.net ? `/${p.net}` : '' });
        }
      }
      const text = JSON.stringify({ success: true, padCount: pads.length, pads });
      return { raw: {}, text, json: JSON.parse(text), isError: false };
    }
    if (name === 'get_nets_list') {
      const nets = [...this.netNames()].map((n) => ({ name: `/${n}` }));
      const text = JSON.stringify({ success: true, nets });
      return { raw: {}, text, json: JSON.parse(text), isError: false };
    }
    if (name === 'export_dsn') {
      await writeFile(args.outputPath, '(dsn)', 'utf8');
      return { raw: {}, text: 'ok', isError: false };
    }
    if (name === 'import_ses') {
      return { raw: {}, text: 'ok', isError: false };
    }
    if (name === 'add_copper_pour') {
      this.pourCalls.push({ ...args });
      this.reportedZones.push({ net: args.net, layers: [args.layer], isFilled: false });
      return { raw: {}, text: 'ok', isError: false };
    }
    if (name === 'refill_zones') {
      if (this.refillFails) throw new Error('zone filler subprocess failed');
      for (const z of this.reportedZones) z.isFilled = true;
      return { raw: {}, text: 'ok', isError: false };
    }
    if (name === 'query_zones') {
      const text = JSON.stringify({ success: true, zones: this.reportedZones });
      return { raw: {}, text, json: JSON.parse(text), isError: false };
    }
    return { raw: {}, text: 'ok', isError: false };
  }
}

function padLocal(lib, pad) {
  if (lib === 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical') {
    return { x: pad === '1' ? -2.54 : 2.54, y: 0 };
  }
  return pad === '1' ? { x: 0, y: 2.54 } : { x: 0, y: -2.54 };
}

/** Simulated .kicad_pcb: Edge.Cuts rectangle, footprints with pad nets,
 * straight F.Cu tracks chaining each net's pads in IR order, vias and
 * filled zones. `nets` entries are IR nets ({name, pins} or plain names). */
function routedPcbText(pcbSnapshot, nets, { vias = [], zones = [], extraTracks = [], skipNets = [] } = {}) {
  const lines = [
    '(kicad_pcb (version 20241229) (generator "pcbnew")',
    '  (general (thickness 1.6))',
    '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
    '  (net 0 "")',
  ];
  let netIdx = 1;
  const netNumbers = new Map();
  for (const n of nets) {
    const name = typeof n === 'string' ? n : n.name;
    lines.push(`  (net ${netIdx} "${name}")`);
    netNumbers.set(name, netIdx);
    netIdx++;
  }
  lines.push(
    '  (gr_line (start 0 0) (end 60 0) (layer "Edge.Cuts") (width 0.1))',
    '  (gr_line (start 60 0) (end 60 40) (layer "Edge.Cuts") (width 0.1))',
    '  (gr_line (start 60 40) (end 0 40) (layer "Edge.Cuts") (width 0.1))',
    '  (gr_line (start 0 40) (end 0 0) (layer "Edge.Cuts") (width 0.1))',
  );
  const padAbs = new Map();
  for (const comp of pcbSnapshot.components) {
    lines.push(
      `  (footprint "${comp.lib}" (layer "F.Cu") (at ${comp.x} ${comp.y} ${comp.rotation ?? 0})`,
      `    (property "Reference" "${comp.ref}" (at 0 0 0) (layer "F.SilkS"))`,
    );
    for (const pad of comp.pads) {
      const local = padLocal(comp.lib, pad.pad);
      const absX = +(comp.x + local.x).toFixed(3);
      const absY = +(comp.y + local.y).toFixed(3);
      padAbs.set(`${comp.ref}/${pad.pad}`, { x: absX, y: absY });
      const netPart = pad.net ? ` (net ${netNumbers.get(pad.net) ?? 0} "/${pad.net}")` : '';
      lines.push(`    (pad "${pad.pad}" smd rect (at ${local.x} ${local.y}) (size 0.9 0.9) (layers "F.Cu")${netPart})`);
    }
    lines.push('  )');
  }
  for (const n of nets) {
    const name = typeof n === 'string' ? n : n.name;
    if (skipNets.includes(name)) continue;
    const pins = typeof n === 'string' ? [] : n.pins;
    const pts = pins.map((p) => padAbs.get(`${p.ref}/${p.pin}`)).filter(Boolean);
    for (let i = 1; i < pts.length; i++) {
      lines.push(
        `  (segment (start ${pts[i - 1].x} ${pts[i - 1].y}) (end ${pts[i].x} ${pts[i].y}) (width 0.25) (layer "F.Cu") (net ${netNumbers.get(name)} "/${name}"))`,
      );
    }
  }
  for (const t of extraTracks) {
    lines.push(
      `  (segment (start ${t.x1} ${t.y1}) (end ${t.x2} ${t.y2}) (width ${t.width ?? 0.25}) (layer "${t.layer ?? 'F.Cu'}") (net ${t.netNumber ?? 0} "/${t.netName ?? ''}"))`,
    );
  }
  for (const v of vias) {
    lines.push(
      `  (via (at ${v.x} ${v.y}) (size ${v.size ?? 0.6}) (drill ${v.drill ?? 0.3}) (layers "F.Cu" "B.Cu") (net ${netNumbers.get(v.net) ?? 0} "/${v.net}"))`,
    );
  }
  for (const z of zones) {
    lines.push(
      `  (zone (net ${netNumbers.get(z.net) ?? 0}) (net_name "${z.net}") (layers "${z.layer}") (hatch edge 0.5) (priority ${z.priority ?? 0})`,
      '    (connect_pads (clearance 0.2))',
      `    (min_thickness ${z.minThickness ?? 0.2}) (filled_areas_thickness no)`,
      '    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))',
    );
    if (z.filled !== false) {
      lines.push(`    (filled_polygon (layer "${z.layer}") (pts (xy 1 1) (xy 59 1) (xy 59 39) (xy 1 39)))`);
    }
    lines.push('  )');
  }
  lines.push(')');
  return lines.join('\n') + '\n';
}

const LEVEL1 = {
  version: 1,
  project: { name: 'level1-generic', profile: 'generic' },
  blocks: ['power', 'controller'],
  components: [
    { ref: 'J1', symbol: 'Connector_Generic:Conn_01x02', value: 'PWR', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', block: 'power' },
    { ref: 'R1', symbol: 'Device:R', value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', block: 'controller' },
    { ref: 'R2', symbol: 'Device:R', value: '1k', footprint: 'Resistor_SMD:R_0603_1608Metric', block: 'controller' },
    { ref: 'C1', symbol: 'Device:C', value: '100n', footprint: 'Capacitor_SMD:C_0603_1608Metric', block: 'power' },
  ],
  nets: [
    { name: 'GND', global: true, erc: { powerDriven: true }, pins: [{ ref: 'J1', pin: '2' }, { ref: 'R2', pin: '2' }, { ref: 'C1', pin: '2' }] },
    { name: 'VCC', global: true, pins: [{ ref: 'J1', pin: '1' }, { ref: 'R1', pin: '1' }, { ref: 'C1', pin: '1' }] },
    { name: 'SIG', pins: [{ ref: 'R1', pin: '2' }, { ref: 'R2', pin: '1' }] },
  ],
  board: { widthMm: 60, heightMm: 40, marginMm: 5, layers: 2, routing: { backend: 'freerouting', maxPasses: 20, timeoutSeconds: 300 } },
  zones: [{ net: 'GND', layer: 'B.Cu', minWidthMm: 0.2, thermal: 'relief' }],
};

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-040-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const KICAD_CLI_SHIM = `#!/bin/sh
# Test shim for kicad-cli (dsh-plugin-kicad-flow 0.4.0 unit tests).
set -u
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ] || [ "$prev" = "--output" ]; then out="$a"; fi
  prev="$a"
done
case " $* " in
  *" sch "*)
    if [ -n "\${ERC_OVERRIDE:-}" ] && [ -f "$ERC_OVERRIDE" ]; then cp "$ERC_OVERRIDE" "$out";
    else printf '%s\\n' '{"coordinate_units":"mm","kicad_version":"10.0.6","sheets":[]}' > "$out"; fi ;;
  *" pcb drc "*)
    n=0
    if [ -n "\${DRC_COUNT_FILE:-}" ]; then n=$(cat "$DRC_COUNT_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$DRC_COUNT_FILE"; fi
    if [ -n "\${DRC_FAIL_ON_CALL:-}" ] && [ "$n" = "\${DRC_FAIL_ON_CALL}" ]; then
      echo "kicad-cli pcb drc: request timed out" >&2; exit 1
    fi
    if [ -n "\${DRC_OVERRIDE:-}" ] && [ -f "$DRC_OVERRIDE" ]; then cp "$DRC_OVERRIDE" "$out";
    else printf '%s\\n' '{"coordinate_units":"mm","violations":[],"unconnected_items":[],"schematic_parity":[]}' > "$out"; fi ;;
  *" pcb export gerbers "*)
    mkdir -p "$out"
    if [ -n "\${EMPTY_GERBER:-}" ]; then : > "$out/x-F_Cu.gbr";
    else
      # Real KiCad 10 emits Protel extensions; keep one .gbr to exercise generic acceptance.
      for l in F_Cu B_Cu F_Mask F_Silkscreen F_Paste B_Mask B_Silkscreen; do
        printf 'G04 test gerber\\n' > "$out/x-$l.\${GT:-gbr}"
      done
      printf 'G04 test gerber\\n' > "$out/x-Edge_Cuts.gm1"
    fi ;;
  *" pcb export drill "*)
    if [ -z "\${NO_DRILL:-}" ]; then
      printf 'M48\\nT1 C0.300\\n%%\\nT1\\nX0Y0\\nM30\\n' > "$out/x-PTH.drl"
      printf 'M48\\n%%\\nM30\\n' > "$out/x-NPTH.drl"
    fi ;;
  *" pcb export pos "*)
    {
      printf '%s\\n' 'Ref,Val,Package,PosX,PosY,Rot,Side'
      printf '%s\\n' 'J1,PWR,PinHeader,30.0,-20.0,0,top'
      printf '%s\\n' 'R1,10k,R_0603,20.0,-10.0,90,top'
      printf '%s\\n' 'R2,1k,R_0603,40.0,-10.0,0,top'
      printf '%s\\n' 'C1,100n,C_0603,20.0,-16.0,0,top'
    } > "$out" ;;
  *)
    if [ "\${1:-}" = "--version" ]; then echo "10.0.6"; fi ;;
esac
`;

/** Run fn with a shimmed kicad-cli on PATH (ERC/DRC/manufacturing offline). */
async function withShims(fn) {
  const binDir = await mkdtemp(join(tmpdir(), 'kicad-flow-bin-'));
  const shim = join(binDir, 'kicad-cli');
  await writeFile(shim, KICAD_CLI_SHIM);
  await chmod(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
    await rm(binDir, { recursive: true, force: true });
  }
}

/** Temporarily set/restore environment variables. */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeEngine(bridge, root) {
  // inspectRouting is intentionally NOT injected: the engine parses the board
  // file the FakeBridge materializes, exactly like production.
  return new KiCadFlowEngine(bridge, {
    projectDir: root,
    inspectSchematic: bridge.snapshot,
    inspectPcb: bridge.pcbSnapshot,
  });
}

/** Deterministic fake RoutingBackend: draws a routed board into the project
 * board file (optionally skipping nets, adding vias or extra tracks) and
 * records how many times the router actually ran. */
function fakeRoutingBackend(bridge, design, { skipNets = [], failWith = null, vias = [], extraZones = [], omitZones = false } = {}) {
  let runs = 0;
  return {
    get runs() { return runs; },
    name: 'freerouting',
    async preflight() {},
    async route(request, calls) {
      runs++;
      if (failWith) throw failWith;
      calls.push('export_dsn');
      const pcbSnap = await bridge.pcbSnapshot();
      const boardText = routedPcbText(pcbSnap, design.nets, {
        skipNets,
        vias,
        zones: omitZones ? [] : [
          ...(design.zones ?? []).map((z) => ({ net: z.net, layer: z.layer, minThickness: z.minWidthMm ?? 0.2 })),
          ...extraZones,
        ],
      });
      const dsnPath = join(request.stagingDir, 'route.dsn');
      const sesPath = join(request.stagingDir, 'route.ses');
      await mkdir(request.stagingDir, { recursive: true });
      await writeFile(request.pcbPath, boardText, 'utf8');
      await writeFile(dsnPath, '(dsn)', 'utf8');
      await writeFile(sesPath, '(routes (network_out))', 'utf8');
      calls.push('import_ses');
      return {
        backend: 'freerouting', dsnPath, sesPath,
        tracks: 9, vias: 0, mcpCalls: ['export_dsn', 'import_ses'],
      };
    },
  };
}

// --- IR 0.4.0 validation -------------------------------------------------------

test('0.4.0: routing spec validation (backend allow-list, maxPasses, timeout)', () => {
  const ok = validateAndNormalizeIR({ ...LEVEL1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.design.board.routing, { backend: 'freerouting', maxPasses: 20, timeoutSeconds: 300 });

  const badBackend = validateAndNormalizeIR({
    ...LEVEL1, board: { ...LEVEL1.board, routing: { backend: 'kicad-auto' } },
  });
  assert.equal(badBackend.ok, false);
  assert.ok(badBackend.errors.some((e) => e.path === 'board.routing.backend'));

  const badPasses = validateAndNormalizeIR({
    ...LEVEL1, board: { ...LEVEL1.board, routing: { maxPasses: 0 } },
  });
  assert.equal(badPasses.ok, false);
  assert.ok(badPasses.errors.some((e) => e.path === 'board.routing.maxPasses'));

  const badTimeout = validateAndNormalizeIR({
    ...LEVEL1, board: { ...LEVEL1.board, routing: { timeoutSeconds: -5 } },
  });
  assert.equal(badTimeout.ok, false);
  assert.ok(badTimeout.errors.some((e) => e.path === 'board.routing.timeoutSeconds'));
});

test('0.4.0: zone specs require existing nets and non-empty layers', () => {
  const ok = validateAndNormalizeIR({ ...LEVEL1 });
  assert.equal(ok.design.zones.length, 1);
  assert.deepEqual(ok.design.zones[0], {
    net: 'GND', layer: 'B.Cu', clearanceMm: 0.2, minWidthMm: 0.2, fill: 'solid', priority: 0, thermal: 'relief',
  });

  const badNet = validateAndNormalizeIR({ ...LEVEL1, zones: [{ net: 'NOPE', layer: 'B.Cu' }] });
  assert.equal(badNet.ok, false);
  assert.ok(badNet.errors.some((e) => e.message.includes('does not exist in nets')));

  const badLayer = validateAndNormalizeIR({ ...LEVEL1, zones: [{ net: 'GND', layer: '' }] });
  assert.equal(badLayer.ok, false);
  assert.ok(badLayer.errors.some((e) => e.path === 'zones[0].layer'));
});

test('0.4.0: excludeFromBom / excludeFromCpl normalize to booleans', () => {
  const design = validateAndNormalizeIR({
    ...LEVEL1,
    components: [...LEVEL1.components, { ref: 'TP1', symbol: 'Device:R', value: 'testpad', excludeFromBom: true, excludeFromCpl: true }],
  }).design;
  const tp1 = design.components.find((c) => c.ref === 'TP1');
  assert.equal(tp1.excludeFromBom, true);
  assert.equal(tp1.excludeFromCpl, true);
  assert.equal(design.components.find((c) => c.ref === 'R1').excludeFromBom, false);
});

// --- routing pipeline ----------------------------------------------------------

test('0.4.0: routed target routes, fills the GND zone, passes final DRC and writes v3 state', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    const backend = fakeRoutingBackend(bridge, LEVEL1);
    engine.setRoutingBackendForTest(backend);
    const result = await engine.compile(LEVEL1, { target: 'routed' });
    assert.equal(result.target, 'routed');
    assert.equal(result.reused, false);
    assert.equal(result.routing.ok, true);
    assert.equal(result.routing.unroutedCount, 0);
    assert.equal(result.routing.backend, 'freerouting');
    assert.ok(result.routing.tracks > 0);
    assert.equal(result.zones.ok, true);
    assert.equal(result.zones.expectedZones, 1);
    assert.equal(result.zones.actualZones, 1);
    assert.equal(result.routingFinalDrc.errors, 0);
    assert.equal(result.routingFinalDrc.unconnected, 0);
    assert.ok(result.mcpCalls.includes('export_dsn'));
    assert.ok(result.mcpCalls.includes('import_ses'));
    assert.ok(result.mcpCalls.includes('add_copper_pour'));
    assert.ok(result.mcpCalls.includes('refill_zones'));
    assert.ok(!result.mcpCalls.includes('autoroute'));
    // Zone net name passes through get_nets_list verbatim ('/'-prefixed).
    assert.equal(bridge.pourCalls.length, 1);
    assert.equal(bridge.pourCalls[0].net, '/GND');
    assert.equal(bridge.pourCalls[0].layer, 'B.Cu');
    assert.equal(bridge.pourCalls[0].outline.length, 4);
    for (const p of bridge.pourCalls[0].outline) {
      assert.ok(!('unit' in p) && p.x >= 0 && p.x <= 60 && p.y >= 0 && p.y <= 40, `outline point ${JSON.stringify(p)} outside board or unit-tagged`);
    }
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.version, 3);
    assert.equal(state.routing.status, 'complete');
    assert.equal(state.routing.reconciliation.unroutedCount, 0);
    assert.equal(state.routing.zones.actualZones, 1);
    assert.equal(state.routing.finalDrc.unconnected, 0);
    assert.equal(state.manufacturing.status, 'pending');
    assert.ok(state.fingerprints.routing);
    assert.deepEqual(state.completed, ['schematic', 'pcb', 'routed']);
  }));
});

test('0.4.0: routing idempotency — reuse with zero new mutations, then manufacturing completes Level-1', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    const backend = fakeRoutingBackend(bridge, LEVEL1);
    engine.setRoutingBackendForTest(backend);
    const first = await engine.compile(LEVEL1, { target: 'routed' });
    assert.equal(first.reused, false);
    const boardPath = join(root, 'level1-generic', 'level1-generic.kicad_pcb');
    const boardAfterFirst = await readFile(boardPath, 'utf8');
    const segmentCount = (boardAfterFirst.match(/\(segment/g) ?? []).length;
    const callsAfterFirst = bridge.calls.length;

    const second = await engine.compile(LEVEL1, { target: 'routed' });
    assert.equal(second.reused, true);
    assert.equal(second.mcpCalls.length, 0);
    assert.equal(bridge.calls.length, callsAfterFirst, 'no new bridge calls on reuse');
    assert.equal(backend.runs, 1, 'router ran exactly once');
    assert.equal(second.routing.unroutedCount, 0);
    // The engine reports the reconciled track count (parsed board), not the
    // backend's self-reported count.
    assert.equal(second.routing.tracks, segmentCount);
    const boardAfterSecond = await readFile(boardPath, 'utf8');
    assert.equal(boardAfterSecond, boardAfterFirst, 'board file untouched on reuse');
    assert.equal((boardAfterSecond.match(/\(segment/g) ?? []).length, segmentCount, 'no duplicated tracks');
    assert.equal(second.zones.actualZones, 1, 'no duplicated zones');

    // Manufacturing on top: every Level-1 gate passes and the pack executes.
    const mfg = await engine.compile(LEVEL1, { target: 'manufacturing' });
    assert.equal(mfg.level1Complete, true);
    assert.ok(mfg.manufacturing.gerberZip);
    assert.ok(mfg.manufacturing.bom);
    assert.ok(mfg.manufacturing.cpl);
    assert.ok(mfg.manufacturing.drillFiles.length >= 1);
  }));
});

test('0.4.0: routing timeout leaves unknown_after_timeout and refuses to continue', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1, {
      failWith: new Error('java -jar freerouting.jar failed: Command timed out after 300000ms'),
    }));
    await assert.rejects(() => engine.compile(LEVEL1, { target: 'routed' }), /timed?\s*out/i);
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'unknown_after_timeout');
    assert.equal(state.routing.lastOperation.status, 'unknown_after_timeout');
    assert.equal(state.manufacturing.status, 'pending');
    // Independent phases stay confirmed.
    assert.equal(state.schematic.status, 'complete');
    assert.equal(state.pcb.status, 'complete');
    assert.deepEqual(state.completed, ['schematic', 'pcb']);
    // Retry refused without any new bridge call.
    const callsBefore = bridge.calls.length;
    await assert.rejects(() => engine.compile(LEVEL1, { target: 'routed' }), /unknown_after_timeout/);
    assert.equal(bridge.calls.length, callsBefore);
  }));
});

test('0.4.0: unrouted > 0 sets routing incomplete and stops before zones', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1, { skipNets: ['VCC'] }));
    await assert.rejects(() => engine.compile(LEVEL1, { target: 'routed' }), /Routing reconciliation reported \d+ unrouted/);
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'incomplete');
    assert.ok(state.routing.reconciliation.unroutedCount > 0);
    // VCC pads carry the net but no copper: reported as floating pads.
    assert.ok(state.routing.reconciliation.floatingPads.some((u) => u.net === 'VCC'));
    // Zone stage never ran.
    assert.ok(!bridge.calls.some((c) => c.name === 'add_copper_pour'));
    assert.ok(!bridge.calls.some((c) => c.name === 'refill_zones'));
    assert.equal(state.manufacturing.status, 'pending');
  }));
});

test('0.4.0: routing preflight gates — empty board snapshot and router unavailability', async () => {
  await withShims(() => withTempRoot(async (root) => {
    // (a) PCB reconciliation gate: the pipeline completes schematic+pcb, then
    // the board snapshot loses its footprints (drift) — the routing preflight
    // must block before the router runs.
    const bridgeA = new FakeBridge();
    let pcbProvider = () => bridgeA.pcbSnapshot();
    const engineA = new KiCadFlowEngine(bridgeA, {
      projectDir: root,
      inspectSchematic: bridgeA.snapshot,
      inspectPcb: () => pcbProvider(),
    });
    const backendA = fakeRoutingBackend(bridgeA, LEVEL1);
    engineA.setRoutingBackendForTest(backendA);
    const designA = { ...LEVEL1, project: { name: 'gate-empty-pcb' } };
    await engineA.compile(designA, { target: 'pcb', skipVerification: true });
    pcbProvider = async () => ({ components: [], nets: [] }); // board drifted
    await assert.rejects(
      () => engineA.compile(designA, { target: 'routed' }),
      /Routing preflight blocked: the \.kicad_pcb snapshot contains no footprints/,
    );
    assert.equal(backendA.runs, 0, 'router never ran');

    // (b) Router unavailable → backend preflight fails with a blocking error,
    // routing phase marked failed, no export_dsn attempted.
    const bridgeB = new FakeBridge();
    const engineB = makeEngine(bridgeB, root);
    engineB.setRoutingBackendForTest({
      name: 'freerouting',
      async preflight() { throw new Error('Routing pipeline blocked: freerouting jar not found at /nonexistent.jar.'); },
      async route() { throw new Error('must not run'); },
    });
    await assert.rejects(
      () => engineB.compile({ ...LEVEL1, project: { name: 'gate-no-router' } }, { target: 'routed' }),
      /Routing pipeline blocked/,
    );
    const stateB = JSON.parse(await readFile(join(root, 'gate-no-router', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(stateB.routing.status, 'failed');
  }));
});

test('0.4.0: ERC gate on routing preflight — errors stop before any routing mutation', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    const backend = fakeRoutingBackend(bridge, LEVEL1);
    engine.setRoutingBackendForTest(backend);
    const ercOverride = join(root, 'erc-bad.json');
    await writeFile(ercOverride, JSON.stringify({
      coordinate_units: 'mm', kicad_version: '10.0.6',
      sheets: [{ violations: [{ type: 'pin_to_pin', severity: 'error', description: 'units overlap' }] }],
    }), 'utf8');
    await withEnv({ ERC_OVERRIDE: ercOverride }, async () => {
      await engine.compile(LEVEL1, { target: 'pcb', skipVerification: true });
      await assert.rejects(
        () => engine.compile(LEVEL1, { target: 'routed' }),
        /ERC blocked the pipeline: 1 error\(s\)/,
      );
    });
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'failed');
    assert.equal(backend.runs, 0, 'router never ran');
  }));
});

test('0.4.0: final DRC with remaining unrouted connections blocks Level-1 completion', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    const drcOverride = join(root, 'drc-unrouted.json');
    await writeFile(drcOverride, JSON.stringify({
      coordinate_units: 'mm', violations: [], schematic_parity: [],
      unconnected_items: [{ items: [{}] }, { items: [{}] }],
    }), 'utf8');
    await withEnv({ DRC_OVERRIDE: drcOverride }, async () => {
      await assert.rejects(
        () => engine.compile(LEVEL1, { target: 'routed' }),
        /Final DRC blocked: 2 unrouted connection\(s\) remain/,
      );
    });
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'failed');
    assert.equal(state.manufacturing.status, 'pending');
  }));
});

test('0.4.0: final DRC timeout leaves routing unknown_after_timeout', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    await withEnv({
      DRC_FAIL_ON_CALL: '2', // pcb-phase drc is call 1; the final DRC is call 2
      DRC_COUNT_FILE: join(root, 'drc-count'),
    }, async () => {
      await assert.rejects(() => engine.compile(LEVEL1, { target: 'routed' }), /timed?\s*out/i);
    });
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'unknown_after_timeout');
    assert.equal(state.routing.lastOperation.tool, 'kicad-cli pcb drc (final)');
    assert.equal(state.manufacturing.status, 'pending');
  }));
});

test('0.4.0: routing reconciliation rejects unknown-net traces, outside-board tracks and via shorts', () => {
  const design = validateAndNormalizeIR(LEVEL1).design;
  const pcbText = routedPcbText(
    {
      components: [
        { ref: 'J1', lib: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', x: 10, y: 10, rotation: 0, pads: [{ pad: '1', net: 'VCC' }, { pad: '2', net: 'GND' }] },
        { ref: 'R1', lib: 'Resistor_SMD:R_0603_1608Metric', x: 30, y: 10, rotation: 0, pads: [{ pad: '1', net: 'VCC' }, { pad: '2', net: 'SIG' }] },
        { ref: 'R2', lib: 'Resistor_SMD:R_0603_1608Metric', x: 30, y: 30, rotation: 0, pads: [{ pad: '1', net: 'SIG' }, { pad: '2', net: 'GND' }] },
        { ref: 'C1', lib: 'Capacitor_SMD:C_0603_1608Metric', x: 10, y: 30, rotation: 0, pads: [{ pad: '1', net: 'VCC' }, { pad: '2', net: 'GND' }] },
      ],
    },
    design.nets,
    {
      extraTracks: [
        { x1: 45, y1: 20, x2: 50, y2: 20, netName: 'GHOST', netNumber: 99 },
        { x1: -5, y1: 20, x2: 0, y2: 20, netName: 'VCC', netNumber: 2 },
      ],
      vias: [
        { x: 20, y: 20, net: 'GND' },
        { x: 20, y: 20, net: 'VCC' },
      ],
      zones: [{ net: 'GND', layer: 'B.Cu', minThickness: 0.2 }],
    },
  );
  const snapshot = parseRoutingBoard(pcbText);
  const pcbSnapshot = {
    components: [
      { ref: 'J1', x: 10, y: 10, rotation: 0, pads: [{ pad: '1', net: 'VCC' }, { pad: '2', net: 'GND' }] },
      { ref: 'R1', x: 30, y: 10, rotation: 0, pads: [{ pad: '1', net: 'VCC' }, { pad: '2', net: 'SIG' }] },
      { ref: 'R2', x: 30, y: 30, rotation: 0, pads: [{ pad: '1', net: 'SIG' }, { pad: '2', net: 'GND' }] },
      { ref: 'C1', x: 10, y: 30, rotation: 0, pads: [{ pad: '1', net: 'VCC' }, { pad: '2', net: 'GND' }] },
    ],
  };
  const report = reconcileRoutingDesign(design, snapshot, { components: pcbSnapshot.components });
  assert.equal(report.ok, false);
  assert.ok(report.unknownNetTraces.some((t) => t.includes('GHOST')));
  assert.ok(report.outsideBoard.length >= 1);
  assert.equal(report.viaShorts.length, 1);
  assert.ok(report.issues.some((i) => i.includes('unknown net')));
  assert.ok(report.issues.some((i) => i.includes('outside the board outline')));
  assert.ok(report.issues.some((i) => i.includes('via short')));
});

test('0.4.0: zone reconciliation — missing, unfilled, thin and unexpected zones all fail', () => {
  const design = validateAndNormalizeIR(LEVEL1).design;
  const mk = (zones) => parseRoutingBoard(routedPcbText({ components: [] }, design.nets, { zones }));
  // Missing: declared GND zone absent.
  const missing = reconcileZones(design, mk([]));
  assert.equal(missing.ok, false);
  assert.ok(missing.issues[0].problem.includes('no board zone found'));

  // Unfilled: zone present but no filled_polygon.
  const unfilled = reconcileZones(design, mk([{ net: 'GND', layer: 'B.Cu', filled: false }]));
  assert.equal(unfilled.ok, false);
  assert.ok(unfilled.issues.some((i) => i.problem.includes('not filled')));

  // Thin: minThickness below the declared minWidth.
  const thin = reconcileZones(design, mk([{ net: 'GND', layer: 'B.Cu', minThickness: 0.1 }]));
  assert.equal(thin.ok, false);
  assert.ok(thin.issues.some((i) => i.problem.includes('minThickness')));

  // Unexpected: board carries a zone the IR never declared.
  const extra = reconcileZones(design, mk([
    { net: 'GND', layer: 'B.Cu', minThickness: 0.2 },
    { net: 'VCC', layer: 'F.Cu', minThickness: 0.2 },
  ]));
  assert.equal(extra.ok, false);
  assert.ok(extra.issues.some((i) => i.problem.includes('unexpected zone on board')));
});

test('0.4.0: no IR zones + stale board zone → pipeline stops (zones are never inferred)', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    const noZones = { ...LEVEL1, zones: [] };
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, noZones, {
      extraZones: [{ net: 'GND', layer: 'B.Cu', minThickness: 0.2 }],
    }));
    await assert.rejects(() => engine.compile(noZones, { target: 'routed' }), /no IR zones declared/);
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'failed');
  }));
});

test('0.4.0: every IR zone declaration becomes exactly one pour, zones pass reconciliation', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    const twoZones = {
      ...LEVEL1,
      project: { name: 'level1-two-zones' },
      zones: [
        { net: 'GND', layer: 'B.Cu', minWidthMm: 0.2 },
        { net: 'VCC', layer: 'F.Cu', priority: 1, fill: 'solid', thermal: 'solid' },
      ],
    };
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, twoZones));
    const result = await engine.compile(twoZones, { target: 'routed' });
    assert.equal(result.zones.ok, true);
    assert.equal(result.zones.expectedZones, 2);
    assert.equal(result.zones.actualZones, 2);
    // Exactly one add_copper_pour per declaration, in IR order.
    assert.equal(bridge.pourCalls.length, 2);
    assert.equal(bridge.pourCalls[0].net, '/GND');
    assert.equal(bridge.pourCalls[0].layer, 'B.Cu');
    assert.equal(bridge.pourCalls[1].net, '/VCC');
    assert.equal(bridge.pourCalls[1].layer, 'F.Cu');
    // priority is stripped by the server zod schema; engine must not send it.
    assert.ok(!('priority' in bridge.pourCalls[1]));
    // refill_zones ran once.
    assert.equal(bridge.calls.filter((c) => c.name === 'refill_zones').length, 1);
    assert.equal(state_ok_helper(bridge), true);
  }));
});

function state_ok_helper(bridge) {
  return bridge.reportedZones.every((z) => z.isFilled === true);
}

test('0.4.0: refill_zones failure is fatal for Level-1 (no silent skip)', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    bridge.refillFails = true;
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    await assert.rejects(() => engine.compile(LEVEL1, { target: 'routed' }), /zone filler subprocess failed/);
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'failed');
    assert.equal(state.routing.lastOperation.tool, 'refill_zones');
  }));
});

test('0.4.0: zone reconciliation desync — pour succeeded but board lacks the zone → pipeline stops', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    // The backend writes a routed board WITHOUT the declared zone: the server
    // reports success (pour + refill) but the authoritative file disagrees.
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1, { omitZones: true }));
    await assert.rejects(
      () => engine.compile(LEVEL1, { target: 'routed' }),
      /Zone reconciliation failed: .*no board zone found for net 'GND' on layer 'B\.Cu'/s,
    );
    // The server-side pour did run; the verdict still comes from the file.
    assert.equal(bridge.pourCalls.length, 1);
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'failed');
    assert.ok(!state.completed.includes('routed'), 'routed is never completed on zone desync');
  }));
});

test('0.4.0: manufacturing target completes the full Level-1 pipeline from scratch', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    const result = await engine.compile(LEVEL1, { target: 'manufacturing' });
    assert.equal(result.level1Complete, true);
    assert.ok(result.manufacturing.outputDir.endsWith('manufacturing'));
    const outDir = result.manufacturing.outputDir;

    // Manifest: reproducible identity + traceability of every artifact.
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.pluginVersion, PLUGIN_VERSION);
    assert.equal(manifest.kicadVersion, '10.0.6');
    assert.deepEqual(manifest.board.copperLayers, ['F.Cu', 'B.Cu']);
    assert.equal(manifest.board.widthMm, 60);
    assert.equal(manifest.board.heightMm, 40);
    assert.match(manifest.drc, /errors=0/);
    assert.match(manifest.drc, /unconnected=0/);
    assert.ok(manifest.files.length >= 10, 'gerbers + drill + positions + cpl + bom + zip all hashed');
    for (const f of manifest.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);

    // BOM: 4 functional rows (R1 10k / R2 1k differ → no grouping), header included.
    const bom = await readFile(join(outDir, 'BOM.csv'), 'utf8');
    const bomLines = bom.trim().split('\n');
    assert.equal(bomLines.length, 5);
    assert.ok(bomLines[0].startsWith('Comment,Designator,Footprint,Qty,LCSC'));
    assert.ok(bom.includes(',R1,'));
    assert.ok(bom.includes(',R2,'));
    assert.ok(bom.includes(',J1,'));
    assert.ok(bom.includes(',C1,'));

    // CPL: J1 PosY -20.0 → Mid Y 20 (KiCad 10 negate); artifacts only, no #PWR.
    const cpl = await readFile(join(outDir, 'CPL.csv'), 'utf8');
    assert.match(cpl, /^J1,PWR,PinHeader,30,20,0,top$/m);
    assert.ok(!cpl.includes('#PWR'), 'artifact-only BOM refs never leak into the CPL');

    // ZIP: real bytes, PK magic.
    const zip = await readFile(result.manufacturing.gerberZip);
    assert.ok(zip.length > 2);
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);

    // State: manufacturing phase complete + fingerprint + completion chain.
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.version, 3);
    assert.equal(state.manufacturing.status, 'complete');
    assert.ok(state.fingerprints.manufacturing);
    assert.ok(state.completed.includes('routed'));
    assert.ok(state.completed.includes('manufacturing'));
    assert.equal(state.artifacts.gerbers, result.manufacturing.gerberZip);
  }));
});

test('0.4.0: manufacturing idempotency — reuse with zero repack and zero new bridge calls', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    const first = await engine.compile(LEVEL1, { target: 'manufacturing' });
    const callsAfterFirst = bridge.calls.length;
    const manifestAfterFirst = await readFile(join(first.manufacturing.outputDir, 'manifest.json'), 'utf8');

    const second = await engine.compile(LEVEL1, { target: 'manufacturing' });
    assert.equal(second.reused, true);
    assert.equal(second.mcpCalls.length, 0);
    assert.equal(bridge.calls.length, callsAfterFirst, 'no new bridge calls on reuse');
    assert.equal(second.level1Complete, true);
    // The returned pack is the state-restored result, byte-identical manifest.
    assert.equal(second.manufacturing.outputDir, first.manufacturing.outputDir);
    const manifestAfterSecond = await readFile(join(second.manufacturing.outputDir, 'manifest.json'), 'utf8');
    assert.equal(manifestAfterSecond, manifestAfterFirst, 'no repack on reuse');
  }));
});

test('0.4.0: manufacturing gate — skipVerification chain stops with ERC missing', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    await engine.compile(LEVEL1, { target: 'pcb', skipVerification: true });
    await assert.rejects(
      () => engine.compile(LEVEL1, { target: 'manufacturing', skipVerification: true }),
      /Manufacturing gate blocked:.*ERC did not run/s,
    );
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.ok(!state.completed.includes('manufacturing'));
  }));
});

test('0.4.0: multi-call chain pcb → manufacturing with ERC passes the gate (persisted ERC)', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    const pcb = await engine.compile(LEVEL1, { target: 'pcb' }); // runs ERC
    assert.equal(pcb.erc.errors, 0);
    const mfg = await engine.compile(LEVEL1, { target: 'manufacturing', skipVerification: true });
    // skipVerification keeps kicad-cli silent, but the persisted ERC from the
    // pcb phase satisfies the Level-1 gate.
    assert.equal(mfg.level1Complete, true);
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.ok(state.schematic.erc, 'ERC report persisted in state');
    assert.equal(state.schematic.erc.errors, 0);
  }));
});

test('0.4.0: design drift guard — different IR refuses to touch an existing project', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    const first = await engine.compile(LEVEL1, { target: 'routed' });
    assert.equal(first.reused, false);
    const drifted = {
      ...LEVEL1,
      board: { ...LEVEL1.board, routing: { ...LEVEL1.board.routing, timeoutSeconds: 600 } },
    };
    await assert.rejects(
      () => engine.compile(drifted, { target: 'routed' }),
      /Existing project was generated from a different Circuit IR/,
    );
  }));
});

test('0.4.0: legacy board target stays on the 0.3.0 chain, routed target extends it', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    const backend = fakeRoutingBackend(bridge, LEVEL1);
    engine.setRoutingBackendForTest(backend);
    const legacy = await engine.compile(LEVEL1, { target: 'board' });
    assert.equal(legacy.routing, undefined, 'board never routes');
    assert.ok(!legacy.mcpCalls.includes('export_dsn'));
    assert.ok(!legacy.mcpCalls.includes('import_ses'));
    assert.equal(backend.runs, 0, 'router never ran for legacy board');
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.ok(state.completed.includes('pcb'));
    assert.ok(!state.completed.includes('routed'));

    // Extending the same project to routed works without forceRebuild.
    const routed = await engine.compile(LEVEL1, { target: 'routed' });
    assert.equal(routed.reused, false);
    assert.equal(routed.zones.ok, true);
    assert.equal(backend.runs, 1);
    const stateAfter = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.ok(stateAfter.completed.includes('routed'));
  }));
});

test('0.4.0: v2 state migrates to v3 on load and routing completes on top', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    await engine.compile(LEVEL1, { target: 'pcb' });
    const statePath = join(root, 'level1-generic', '.kicad-flow', 'state.json');
    // Simulate a 0.3.0-era state file: version 2, no routing/manufacturing.
    const v2 = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(v2.version, 3, '0.4.0 writes v3 from the first call');
    delete v2.routing;
    delete v2.manufacturing;
    delete v2.fingerprints?.routing;
    delete v2.fingerprints?.manufacturing;
    v2.version = 2;
    v2.completed = v2.completed.filter((c) => c !== 'routed' && c !== 'manufacturing');
    await writeFile(statePath, JSON.stringify(v2, null, 2) + '\n', 'utf8');

    const result = await engine.compile(LEVEL1, { target: 'routed' });
    assert.equal(result.reused, false);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.version, 3, 'migrated to v3 on write');
    assert.equal(state.routing.status, 'complete');
    assert.ok(state.routing.reconciliation.ok);
    assert.ok(state.completed.includes('routed'));
  }));
});

test('0.4.0: evaluateManufacturingGate — every unmet Level-1 condition is reported', () => {
  const clean = {
    version: 3, designHash: 'h', createdAt: '', updatedAt: '',
    completed: ['schematic', 'pcb', 'routed'], artifacts: {},
    schematic: { status: 'complete', reconciliation: { ok: true }, erc: { errors: 0, warnings: 0, violations: [] } },
    pcb: { status: 'complete', reconciliation: { ok: true } },
    routing: {
      status: 'complete',
      reconciliation: { ok: true, unroutedCount: 0 },
      finalDrc: { errors: 0, warnings: 0, unconnected: 0 },
    },
  };
  assert.deepEqual(evaluateManufacturingGate(clean), []);

  const unrouted = structuredClone(clean);
  unrouted.routing.reconciliation.unroutedCount = 2;
  assert.ok(evaluateManufacturingGate(unrouted).some((m) => m.includes('unrouted')));

  const notComplete = structuredClone(clean);
  notComplete.routing.status = 'incomplete';
  assert.ok(evaluateManufacturingGate(notComplete).some((m) => m.includes("routing phase is 'incomplete'")));

  const noDrc = structuredClone(clean);
  delete noDrc.routing.finalDrc;
  assert.ok(evaluateManufacturingGate(noDrc).some((m) => m.includes('final DRC')));

  const drcErrors = structuredClone(clean);
  drcErrors.routing.finalDrc = { errors: 1, warnings: 0, unconnected: 0 };
  assert.ok(evaluateManufacturingGate(drcErrors).some((m) => m.includes('final DRC')));

  const noErc = structuredClone(clean);
  delete noErc.schematic.erc;
  assert.ok(evaluateManufacturingGate(noErc).some((m) => m.includes('ERC')));
});

test('0.4.0: buildManufacturingPack direct — reproducible ZIP byte-for-byte across runs', async () => {
  await withShims(() => withEnv({ GT: 'gtl' }, () => withTempRoot(async (root) => {
    const projectDir = join(root, 'pack-direct');
    const pcbPath = join(projectDir, 'pack-direct.kicad_pcb');
    await mkdir(projectDir, { recursive: true });
    await writeFile(pcbPath, '(kicad_pcb (version 20241229) (generator "pcbnew"))\n', 'utf8');
    const design = {
      ...LEVEL1,
      project: { name: 'pack-direct' },
      components: [
        ...LEVEL1.components,
        { ref: 'TP1', symbol: 'Device:R', value: '0R', footprint: 'Resistor_SMD:R_0603_1608Metric', block: 'testpoint', excludeFromBom: true, excludeFromCpl: true },
      ],
      zones: [],
    };
    const args = {
      projectName: 'pack-direct',
      projectDir,
      pcbPath,
      design,
      copperLayers: ['F.Cu', 'B.Cu'],
      boardWidthMm: 60,
      boardHeightMm: 40,
      drcStatus: 'errors=0, warnings=0, unconnected=0',
      excludeCplRefs: ['TP1'],
    };
    const pack1 = await buildManufacturingPack(args);
    assert.ok(pack1.gerberZip);
    assert.ok(pack1.bom);
    assert.ok(pack1.cpl);
    assert.ok(pack1.manifest);
    assert.equal(pack1.drillFiles.length, 2);
    assert.equal(pack1.gerberFiles.length, 8);
    const manifest1 = JSON.parse(await readFile(pack1.manifest, 'utf8'));
    assert.equal(manifest1.pluginVersion, PLUGIN_VERSION);
    assert.equal(manifest1.drc, 'errors=0, warnings=0, unconnected=0');
    // excludeFromBom keeps TP1 out of the BOM and the CPL.
    const bom = await readFile(pack1.bom, 'utf8');
    assert.ok(!bom.includes('TP1'));
    const cpl = await readFile(pack1.cpl, 'utf8');
    assert.ok(!cpl.includes('TP1'));
    const zip1 = await readFile(pack1.gerberZip);
    assert.equal(zip1[0], 0x50);
    assert.equal(zip1[1], 0x4b);

    // Reproducibility: identical inputs → identical ZIP bytes.
    const zip1Hex = createHash('sha256').update(zip1).digest('hex');
    const pack2 = await buildManufacturingPack(args);
    const zip2 = await readFile(pack2.gerberZip);
    const zip2Hex = createHash('sha256').update(zip2).digest('hex');
    assert.equal(zip2Hex, zip1Hex, 'ZIP is reproducible (sorted entries, fixed timestamps)');
    // Real KiCad emits Protel extensions (GT=gtl): all 8 gerbers found, ZIP
    // must carry the gerbers themselves, not just the drill files.
    assert.equal(pack1.gerberFiles.filter((f) => f.endsWith('.gtl') || f.endsWith('.gm1')).length, 8);
    const zipList = (await import('child_process')).execFileSync('python3', ['-c', 'import sys,zipfile;[print(n) for n in zipfile.ZipFile(sys.argv[1]).namelist()]', pack1.gerberZip]).toString();
    assert.equal(zipList.trim().split('\n').filter((n) => n.endsWith('.gtl') || n.endsWith('.gm1')).length, 8, 'ZIP contains the 8 Protel gerbers');
  })));
});

test('0.4.0: drill export with no Excellon files is blocked', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const projectDir = join(root, 'pack-nodrill');
    const pcbPath = join(projectDir, 'pack-nodrill.kicad_pcb');
    await mkdir(projectDir, { recursive: true });
    await writeFile(pcbPath, '(kicad_pcb)\n', 'utf8');
    await assert.rejects(
      () => withEnv({ NO_DRILL: '1' }, () => buildManufacturingPack({
        projectName: 'pack-nodrill',
        projectDir,
        pcbPath,
        copperLayers: ['F.Cu', 'B.Cu'],
      })),
      /no Excellon files/,
    );
  }));
});

test('0.4.0: empty gerber output is blocked naming the offending file', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const projectDir = join(root, 'pack-emptygerber');
    const pcbPath = join(projectDir, 'pack-emptygerber.kicad_pcb');
    await mkdir(projectDir, { recursive: true });
    await writeFile(pcbPath, '(kicad_pcb)\n', 'utf8');
    await assert.rejects(
      () => withEnv({ EMPTY_GERBER: '1' }, () => buildManufacturingPack({
        projectName: 'pack-emptygerber',
        projectDir,
        pcbPath,
        copperLayers: ['F.Cu', 'B.Cu'],
      })),
      /is empty or missing.*x-F_Cu\.gbr/s,
    );
  }));
});

test('0.4.0: query_zones desync — server reports the zone unfilled while the file has it filled → pipeline stops', async () => {
  await withShims(() => withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = makeEngine(bridge, root);
    engine.setRoutingBackendForTest(fakeRoutingBackend(bridge, LEVEL1));
    // The board file records a filled zone, but the live server cross-check
    // reports it unfilled: the conservative verdict is failure. (refill_zones
    // marks every reported zone filled, so intercept query_zones directly.)
    const origCall = bridge.call.bind(bridge);
    bridge.call = async function (name, args) {
      if (name === 'query_zones') {
        const text = JSON.stringify({
          success: true,
          zones: [{ net: '/GND', layers: ['B.Cu'], isFilled: false }],
        });
        return { raw: {}, text, json: JSON.parse(text), isError: false };
      }
      return origCall(name, args);
    };
    await assert.rejects(
      () => engine.compile(LEVEL1, { target: 'routed' }),
      /Zone live check: zone 'GND' on 'B\.Cu' is reported unfilled/,
    );
    const state = JSON.parse(await readFile(join(root, 'level1-generic', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.routing.status, 'failed');
  }));
});
