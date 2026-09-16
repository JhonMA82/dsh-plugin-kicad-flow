import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiCadFlowEngine } from '../dist/engine.js';
import { validateAndNormalizeIR } from '../dist/ir.js';
import { explicitNetclasses } from '../dist/netclasses.js';
import {
  computePcbPlacements,
  MIN_FP_SEPARATION_MM,
  parseKicadPcb,
  reconcilePcbDesign,
  detectPadCollisions,
  pcbFootprintRequirements,
} from '../dist/pcb.js';
import { classifyDrc } from '../dist/verification.js';

// ---------------------------------------------------------------------------
// 0.3.0 PCB Foundation regression tests.
// Faithful FakeBridge: schematic side mirrors regression-0.2.7; PCB side
// simulates create_board_from_schematic / set_board_size /
// batch_move_components / get_pads over a FOOTPRINT_DB of real pads.
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
  'Device:L_Ferrite': [
    ['1', '', 'passive', -2.54, 0, 0],
    ['2', '', 'passive', 2.54, 0, 0],
  ],
  'power:PWR_FLAG': [
    ['1', '', 'power_out', 0, 0, 0],
  ],
  'MCU_Microchip_ATtiny:ATtiny1614-SS': [
    ['1', 'VCC', 'power_in', 0, 10.16, 0],
    ['8', 'PB1', 'bidirectional', -7.62, -10.16, 0],
    ['9', 'PB0', 'bidirectional', -7.62, -7.62, 0],
    ['11', 'PA1', 'bidirectional', 7.62, -5.08, 180],
    ['14', 'GND', 'power_in', 0, -10.16, 0],
  ],
};

// Real pads per footprint. Pad numbers are strings exactly as in KiCad.
const FOOTPRINT_DB = {
  'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical': ['1', '2'],
  'Resistor_SMD:R_0603_1608Metric': ['1', '2'],
  'Capacitor_SMD:C_0603_1608Metric': ['1', '2'],
  'Inductor_SMD:L_0805_2012Metric': ['1', '2'],
  'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm': ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14'],
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
  ]);
  calls = [];
  refs = [];
  refSymbols = new Map();
  refFootprints = new Map();
  nets = new Map();
  boardSize = null;
  designRules = null;
  pcbFootprints = new Map(); // ref -> { lib, x, y, rotation, pads: [{pad, net}] }
  failOn = null; // { tool, message }

  async start() { return [...this.tools].map((name) => ({ name })); }
  hasTool(name) { return this.tools.has(name); }

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
      pads: fp.pads.map((p) => ({ ...p })),
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

  async call(name, args = {}) {
    if (this.failOn && this.failOn.tool === name) {
      throw new Error(this.failOn.message ?? 'request timed out');
    }
    if (!this.tools.has(name)) throw new Error(`missing ${name}`);
    this.calls.push({ name, args });
    if (name === 'create_project') {
      await mkdir(args.path, { recursive: true });
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
      // Net transfer: every component WITH a declared footprint materializes;
      // schematic-only artifacts (power:PWR_FLAG) have no footprint and never
      // become board footprints — exactly like real KiCad.
      for (const ref of this.refs) {
        const lib = this.refFootprints.get(ref);
        if (!lib) continue;
        const pads = (FOOTPRINT_DB[lib] ?? []).map((pad) => ({ pad, net: this.padNetFor(ref, pad) }));
        this.pcbFootprints.set(ref, { lib, x: 0, y: 0, rotation: 0, pads });
      }
    }
    if (name === 'set_board_size') this.boardSize = { width: args.width, height: args.height, unit: args.unit };
    if (name === 'set_design_rules') this.designRules = { ...args };
    if (name === 'batch_move_components') {
      for (const [ref, spec] of Object.entries(args.moves)) {
        const fp = this.pcbFootprints.get(ref);
        if (!fp) continue;
        fp.x = spec.x;
        fp.y = spec.y;
        fp.rotation = spec.rotation ?? 0;
      }
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
    return { raw: {}, text: 'ok', isError: false };
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

  async callIfAvailable(name, args = {}) {
    return this.tools.has(name) ? this.call(name, args) : undefined;
  }
}

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-030-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Miniature of the authorized VCM intent WITH explicit footprints: every
// functional component carries a real KiCad footprint; the powerDriven
// PWR_FLAG artifacts (GND, VBAT_FILT) stay schematic-only.
const MINI_PCB_030 = {
  version: 1,
  project: { name: 'mini-pcb-030', profile: 'automotive' },
  blocks: ['input', 'power', 'controller'],
  components: [
    { ref: 'J2', symbol: 'Connector_Generic:Conn_01x02', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', block: 'input' },
    { ref: 'L1', symbol: 'Device:L_Ferrite', footprint: 'Inductor_SMD:L_0805_2012Metric', block: 'power' },
    { ref: 'C1', symbol: 'Device:C', footprint: 'Capacitor_SMD:C_0603_1608Metric', block: 'power' },
    { ref: 'C2', symbol: 'Device:C', footprint: 'Capacitor_SMD:C_0603_1608Metric', block: 'power' },
    { ref: 'U2', symbol: 'Device:R', value: 'LDO-proxy', footprint: 'Resistor_SMD:R_0603_1608Metric', block: 'power' },
    { ref: 'U1', symbol: 'MCU_Microchip_ATtiny:ATtiny1614-SS', footprint: 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm', block: 'controller', noConnectPins: ['8', '9'] },
  ],
  nets: [
    { name: 'GND', global: true, erc: { powerDriven: true }, pins: [{ ref: 'J2', pin: '2' }, { ref: 'U1', pin: '14' }, { ref: 'C1', pin: '2' }, { ref: 'C2', pin: '2' }] },
    { name: 'VBAT_FILT', erc: { powerDriven: true }, pins: [{ ref: 'L1', pin: '2' }, { ref: 'C1', pin: '1' }, { ref: 'C2', pin: '1' }, { ref: 'U2', pin: '2' }] },
    { name: 'VCC5', global: true, pins: [{ ref: 'U2', pin: '1' }, { ref: 'U1', pin: '1' }] },
    { name: 'VBAT_RAW', pins: [{ ref: 'J2', pin: '1' }, { ref: 'L1', pin: '1' }] },
    { name: 'ADC_ECT', pins: [{ ref: 'U1', pin: '11' }] },
  ],
  board: { widthMm: 120, heightMm: 90, marginMm: 8 },
};

function makeEngine(bridge, root) {
  return new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
}

// --- 1. board constraints normalized with deterministic defaults -------------

test('0.3.0: board constraints normalize with documented deterministic defaults', () => {
  const minimal = validateAndNormalizeIR({
    version: 1,
    project: { name: 'board-defaults' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [{ name: 'N1', pins: [{ ref: 'R1', pin: '1' }] }],
  });
  assert.equal(minimal.ok, true);
  const board = minimal.design.board;
  assert.equal(board.layers, 2);
  assert.equal(board.clearanceMm, 0.2);
  assert.equal(board.trackWidthMm, 0.25);
  assert.equal(board.viaDiameterMm, 0.6);
  assert.equal(board.viaDrillMm, 0.3);

  const explicit = validateAndNormalizeIR({
    version: 1,
    project: { name: 'board-explicit' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [{ name: 'N1', pins: [{ ref: 'R1', pin: '1' }] }],
    board: { widthMm: 100, heightMm: 70, marginMm: 6, layers: 4, clearanceMm: 0.3, trackWidthMm: 0.5, viaDiameterMm: 0.8, viaDrillMm: 0.4 },
  });
  assert.equal(explicit.ok, true);
  const eb = explicit.design.board;
  assert.equal(eb.layers, 4);
  assert.equal(eb.clearanceMm, 0.3);
  assert.equal(eb.trackWidthMm, 0.5);
  assert.equal(eb.viaDiameterMm, 0.8);
  assert.equal(eb.viaDrillMm, 0.4);
});

// --- 2. board constraints validation errors -----------------------------------

test('0.3.0: invalid board constraints are rejected deterministically', () => {
  const base = (board) => ({
    version: 1,
    project: { name: 'board-invalid' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [{ name: 'N1', pins: [{ ref: 'R1', pin: '1' }] }],
    board,
  });
  for (const board of [{ layers: 0 }, { layers: 33 }, { layers: 2.5 }]) {
    const r = validateAndNormalizeIR(base(board));
    assert.equal(r.ok, false, `layers ${JSON.stringify(board)} must fail`);
  }
  const drill = validateAndNormalizeIR(base({ viaDiameterMm: 0.4, viaDrillMm: 0.5 }));
  assert.equal(drill.ok, false);
  const clearance = validateAndNormalizeIR(base({ clearanceMm: -0.1 }));
  assert.equal(clearance.ok, false);
  const track = validateAndNormalizeIR(base({ trackWidthMm: 0 }));
  assert.equal(track.ok, false);
});

// --- 3. explicitNetclasses: no profile inference -------------------------------

test('0.3.0: explicitNetclasses never injects automotive profile defaults', () => {
  const slim = {
    version: 1,
    project: { name: 'vcm-slim', profile: 'automotive' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [{ name: 'VCC5', pins: [{ ref: 'R1', pin: '1' }] }],
    // no netclasses declared
  };
  assert.deepEqual(explicitNetclasses(validateAndNormalizeIR(slim).design), []);

  const declared = validateAndNormalizeIR({
    version: 1,
    project: { name: 'explicit-classes', profile: 'automotive' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [
      { name: 'VCC5', pins: [{ ref: 'R1', pin: '1' }] },
      { name: 'SENSOR', class: 'Signals', pins: [{ ref: 'R1', pin: '2' }] },
    ],
    netclasses: [{ name: 'Signals', trackWidthMm: 0.4, clearanceMm: 0.2 }],
  }).design;
  const rules = explicitNetclasses(declared);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].nets, ['SENSOR']);
});

// --- 4. placements deterministic, explicit coords win ---------------------------

test('0.3.0: pcb placements are deterministic and respect explicit pcb coordinates', () => {
  const design = validateAndNormalizeIR({
    version: 1,
    project: { name: 'place-deterministic' },
    components: [
      { ref: 'R1', symbol: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric' },
      { ref: 'R2', symbol: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric', pcb: { x: 30, y: 20, rotation: 90 } },
      { ref: 'R3', symbol: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric' },
    ],
    nets: [],
    board: { widthMm: 80, heightMm: 60, marginMm: 5 },
  }).design;
  const a = computePcbPlacements(design);
  const b = computePcbPlacements(design);
  assert.deepEqual(a, b);
  const byRef = new Map(a.placements.map((p) => [p.ref, p]));
  assert.deepEqual({ x: byRef.get('R2').x, y: byRef.get('R2').y, rotation: byRef.get('R2').rotation }, { x: 30, y: 20, rotation: 90 });
  assert.ok(byRef.get('R1').x > 5 && byRef.get('R1').x < 75);
});

// --- 5. de-collision inside usable area ------------------------------------------

test('0.3.0: pcb placements de-collide crowded boards inside the usable area', () => {
  const design = validateAndNormalizeIR({
    version: 1,
    project: { name: 'place-crowded' },
    components: [
      { ref: 'R1', symbol: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric' },
      { ref: 'R2', symbol: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric' },
    ],
    nets: [],
    board: { widthMm: 120, heightMm: 25, marginMm: 5 },
  }).design;
  const plan = computePcbPlacements(design);
  assert.equal(plan.placements.length, 2);
  const [p1, p2] = plan.placements;
  const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  assert.ok(d >= MIN_FP_SEPARATION_MM - 1e-9, `separation ${d} < ${MIN_FP_SEPARATION_MM}`);
  for (const p of [p1, p2]) {
    assert.ok(p.x >= 5 && p.x <= 115 && p.y >= 5 && p.y <= 20, `placement (${p.x},${p.y}) out of bounds`);
  }
});

// --- 6. explicit/explicit collision STOP ------------------------------------------

test('0.3.0: explicit pcb coordinate collisions stop placement', () => {
  const design = validateAndNormalizeIR({
    version: 1,
    project: { name: 'place-explicit-collision' },
    components: [
      { ref: 'R1', symbol: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric', pcb: { x: 20, y: 20 } },
      { ref: 'R2', symbol: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric', pcb: { x: 25, y: 20 } },
    ],
    nets: [],
    board: { widthMm: 80, heightMm: 60, marginMm: 5 },
  }).design;
  assert.throws(() => computePcbPlacements(design), /explicit pcb coordinates collide/);
});

// --- 7. board too small STOP ------------------------------------------------------

test('0.3.0: placement stops deterministically when the board cannot hold the components', () => {
  const design = validateAndNormalizeIR({
    version: 1,
    project: { name: 'place-too-small' },
    components: Array.from({ length: 20 }, (_, i) => ({
      ref: `R${i + 1}`,
      symbol: 'Device:R',
      footprint: 'Resistor_SMD:R_0603_1608Metric',
    })),
    nets: [],
    board: { widthMm: 40, heightMm: 30, marginMm: 5 },
  }).design;
  assert.throws(computePcbPlacements.bind(null, design), /cannot hold|Enlarge/);
});

// --- 8. parseKicadPcb: footprints, pads, nets --------------------------------------

test('0.3.0: parseKicadPcb extracts footprints with positions, pads and nets', () => {
  const text = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (net 0 "")
  (net 1 "GND")
  (net 2 "VBAT_FILT")
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (uuid "aaa")
    (at 25 25 90)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "a1"))
    (property "Value" "10k" (at 0 0 0) (layer "F.Fab") (uuid "a2"))
    (pad "1" smd roundrect (at -0.85 0) (size 0.95 0.95) (layers "F.Cu") (roundrect_rratio 0.25) (net 1 "GND") (pintype "passive"))
    (pad "2" smd roundrect (at 0.85 0) (size 0.95 0.95) (layers "F.Cu") (roundrect_rratio 0.25) (net 2 "/VBAT_FILT") (pintype "passive"))
  )
  (footprint "Capacitor_SMD:C_0603_1608Metric"
    (layer "F.Cu")
    (at 40 25)
    (property "Reference" "C1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at -0.7 0) (size 0.8 0.8) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 0.7 0) (size 0.8 0.8) (layers "F.Cu"))
  )
)`;
  const snap = parseKicadPcb(text);
  assert.deepEqual(snap.nets, ['GND', 'VBAT_FILT']);
  assert.equal(snap.components.length, 2);
  const r1 = snap.components.find((c) => c.ref === 'R1');
  assert.equal(r1.lib, 'Resistor_SMD:R_0603_1608Metric');
  assert.deepEqual({ x: r1.x, y: r1.y, rotation: r1.rotation }, { x: 25, y: 25, rotation: 90 });
  assert.deepEqual(r1.pads.map((p) => [p.pad, p.net]), [['1', 'GND'], ['2', 'VBAT_FILT']]);
  const c1 = snap.components.find((c) => c.ref === 'C1');
  assert.deepEqual(c1.pads.map((p) => [p.pad, p.net]), [['1', 'GND'], ['2', null]]);
});

// --- 9. parseKicadPcb ignores unconnected-* net names ------------------------------

test('0.3.0: parseKicadPcb keeps unconnected-* out of the net list', () => {
  const text = `(kicad_pcb
  (net 0 "")
  (net 1 "GND")
  (net 2 "unconnected-(R1-Pad2)")
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 10 10)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at -0.85 0) (size 0.9 0.9) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 0.85 0) (size 0.9 0.9) (layers "F.Cu") (net 2 "unconnected-(R1-Pad2)"))
  )
)`;
  const snap = parseKicadPcb(text);
  assert.deepEqual(snap.nets, ['GND']);
  assert.equal(snap.components[0].pads[1].net, null);
});

// --- 10. pcb reconciliation PASS ----------------------------------------------------

test('0.3.0: pcb reconciliation passes on a matching board snapshot', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    const result = await engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true });
    const report = result.pcbReconciliation;
    assert.equal(report.ok, true);
    assert.equal(report.expectedComponents, 6);
    assert.equal(report.actualFootprints, 6);
    assert.equal(report.matchedNets, report.expectedNets);
    assert.deepEqual(report.missingFootprints, []);
    assert.deepEqual(report.artifactsOnBoard, []);
    // The two powerDriven artifacts must never become footprints.
    assert.ok(!bridge.pcbFootprints.has('#PWR01'));
    assert.ok(!bridge.pcbFootprints.has('#PWR02'));
    assert.ok(!result.mcpCalls.includes('autoroute'));
    assert.ok(!result.mcpCalls.includes('add_copper_pour'));
    assert.ok(result.deferred.some((d) => d.includes('autoroute')));
    assert.ok(result.mcpCalls.includes('set_design_rules'));
    assert.deepEqual(bridge.designRules, { clearance: 0.2, trackWidth: 0.25, viaDiameter: 0.6, viaDrill: 0.3 });
    assert.ok(result.mcpCalls.includes('get_pads'));
  });
});

// --- 11. pcb reconciliation: missing/unexpected/duplicate footprints ---------------

test('0.3.0: pcb reconciliation reports missing, unexpected and duplicate footprints', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    await engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true });
    const snapshot = await bridge.pcbSnapshot();
    // missing: drop U1; unexpected: add X99; duplicate: double U2.
    snapshot.components = snapshot.components.filter((c) => c.ref !== 'U1');
    snapshot.components.push({ ref: 'X99', lib: 'Device:C_Extra', x: 0, y: 0, rotation: 0, pads: [] });
    snapshot.components.push({ ...snapshot.components.find((c) => c.ref === 'U2') });
    const design = validateAndNormalizeIR(MINI_PCB_030).design;
    const report = reconcilePcbDesign(design, snapshot);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingFootprints, ['U1']);
    assert.deepEqual(report.unexpectedFootprints, ['X99']);
    assert.deepEqual(report.duplicateReferences, ['U2']);
    assert.ok(!report.padIssues.some((i) => i.ref === 'U1')); // U1 already reported missing
  });
});

// --- 12. wrong footprint + artifacts on board --------------------------------------

test('0.3.0: pcb reconciliation flags wrong footprints and #PWR artifacts on the board', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    await engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true });
    const snapshot = await bridge.pcbSnapshot();
    snapshot.components.find((c) => c.ref === 'L1').lib = 'Inductor_SMD:WRONG_1210';
    snapshot.components.push({ ref: '#PWR01', lib: 'power:PWR_FLAG', x: 0, y: 0, rotation: 0, pads: [] });
    const report = reconcilePcbDesign(validateAndNormalizeIR(MINI_PCB_030).design, snapshot);
    assert.equal(report.ok, false);
    assert.deepEqual(report.wrongFootprints, [{ ref: 'L1', expected: 'Inductor_SMD:L_0805_2012Metric', actual: 'Inductor_SMD:WRONG_1210' }]);
    assert.deepEqual(report.artifactsOnBoard, ['#PWR01']);
    assert.ok(report.unexpectedFootprints.includes('#PWR01'));
  });
});

// --- 13. pin↔pad verification -------------------------------------------------------

test('0.3.0: pad verification reports ref/symbol/footprint/pin and available pads', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    await engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true });
    const snapshot = await bridge.pcbSnapshot();
    const u2 = snapshot.components.find((c) => c.ref === 'U2');
    // missing pad: U2 pad '2' disappears from the footprint
    u2.pads = u2.pads.filter((p) => p.pad !== '2');
    // wrong net: U2 pad '1' moved to GND
    snapshot.components.find((c) => c.ref === 'U2').pads.find((p) => p.pad === '1').net = 'GND';
    // unconnected pad: U1 pad '14' loses its net
    snapshot.components.find((c) => c.ref === 'U1').pads.find((p) => p.pad === '14').net = null;
    const report = reconcilePcbDesign(validateAndNormalizeIR(MINI_PCB_030).design, snapshot);
    assert.equal(report.ok, false);
    const kinds = Object.fromEntries(report.padIssues.map((i) => [`${i.ref}/${i.expectedPin}`, i.kind]));
    assert.equal(kinds['U2/2'], 'missing_pad');
    assert.equal(kinds['U2/1'], 'wrong_net');
    assert.equal(kinds['U1/14'], 'unconnected_pad');
    const missing = report.padIssues.find((i) => i.kind === 'missing_pad');
    assert.equal(missing.symbol, 'Device:R');
    assert.equal(missing.footprint, 'Resistor_SMD:R_0603_1608Metric');
    assert.deepEqual(missing.availablePads, ['1']);    const wrong = report.padIssues.find((i) => i.kind === 'wrong_net');
    assert.equal(wrong.expectedNet, 'VCC5');
    assert.equal(wrong.actualNet, 'GND');
  });
});

// --- 14. nets: missing/unexpected ----------------------------------------------------

test('0.3.0: pcb reconciliation reports missing and unexpected nets', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    await engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true });
    const snapshot = await bridge.pcbSnapshot();
    snapshot.nets = snapshot.nets.filter((n) => n !== 'ADC_ECT');
    snapshot.nets.push('GHOST_NET');
    const report = reconcilePcbDesign(validateAndNormalizeIR(MINI_PCB_030).design, snapshot);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingNets, ['ADC_ECT']);
    assert.deepEqual(report.unexpectedNets, ['GHOST_NET']);
  });
});

// --- 15. classifyDrc ------------------------------------------------------------------

test('0.3.0: classifyDrc separates unrouted from structural/parity blockers', () => {
  const unrouted = classifyDrc({ errors: 0, warnings: 1, unconnected: 7, parity: 0, violations: [] });
  assert.equal(unrouted.blocking, false);
  assert.equal(unrouted.unroutedCount, 7);

  const structural = classifyDrc({
    errors: 1, warnings: 0, unconnected: 7, parity: 0,
    violations: [{ type: 'clearance', severity: 'error', description: 'too close' }],
  });
  assert.equal(structural.blocking, true);
  assert.match(structural.blockingReason, /clearance/);

  const parity = classifyDrc({
    errors: 0, warnings: 0, unconnected: 7, parity: 2, violations: [],
    parityViolations: [{ type: 'schematic_parity', severity: 'error', description: 'missing footprint' }],
  });
  assert.equal(parity.blocking, true);
  assert.equal(parity.parityIssues.length, 1);
});

// --- 16. engine pcb E2E PASS + resume reuse -------------------------------------------

test('0.3.0: engine pcb foundation compiles, reconciles and stays idempotent', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    const result = await engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true });
    assert.equal(result.target, 'pcb');
    assert.equal(result.reused, false);
    assert.equal(result.pcbReconciliation.ok, true);
    assert.ok(result.mcpCalls.includes('create_board_from_schematic'));
    assert.ok(result.mcpCalls.includes('set_board_size'));
    assert.ok(result.mcpCalls.includes('batch_move_components'));
    assert.ok(result.mcpCalls.includes('get_pads'));
    assert.ok(!result.mcpCalls.includes('autoroute'));
    assert.ok(result.deferred.some((d) => d.includes('autoroute')));
    // Deterministic placement actually moved components inside the board.
    const moves = bridge.calls.find((c) => c.name === 'batch_move_components').args.moves;
    assert.deepEqual(bridge.boardSize, { width: 120, height: 90, unit: 'mm' });
    for (const [ref, spec] of Object.entries(moves)) {
      assert.ok(spec.x >= 8 && spec.x <= 112 && spec.y >= 8 && spec.y <= 82, `${ref} outside usable area`);
    }
    // State v3 extension (0.4.0): routing/manufacturing phases live alongside
    // the completed 0.3.0 schematic/pcb phases.
    const state = JSON.parse(await readFile(join(root, 'mini-pcb-030', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.version, 3);
    assert.equal(state.routing?.status, 'pending');
    assert.equal(state.manufacturing?.status, 'pending');
    assert.equal(state.pcb.status, 'complete');
    assert.deepEqual(state.completed, ['schematic', 'pcb']);
    assert.deepEqual(state.pcb.confirmedFootprintRefs, ['C1', 'C2', 'J2', 'L1', 'U1', 'U2']);
    assert.equal(state.pcb.reconciliation.ok, true);
    // Resume: second compile reuses everything without MCP calls.
    const again = await engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true });
    assert.equal(again.reused, true);
    assert.deepEqual(again.mcpCalls, []);
    assert.equal(again.pcbReconciliation.ok, true);
  });
});

// --- 17. timeout → unknown_after_timeout → refusal ------------------------------------

test('0.3.0: pcb mutation timeout leaves unknown_after_timeout and refuses retry', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    bridge.failOn = { tool: 'batch_move_components', message: 'MCP request timed out after 660000ms' };
    await assert.rejects(
      () => engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true }),
      /timed out/i,
    );
    const state = JSON.parse(await readFile(join(root, 'mini-pcb-030', '.kicad-flow', 'state.json'), 'utf8'));
    // Schematic phase untouched and confirmed.
    assert.equal(state.schematic.status, 'complete');
    assert.deepEqual(state.completed, ['schematic']);
    assert.equal(state.pcb.status, 'unknown_after_timeout');
    assert.equal(state.pcb.lastOperation.status, 'unknown_after_timeout');
    assert.equal(state.pcb.lastOperation.tool, 'batch_move_components');
    // A follow-up compile must refuse before touching the bridge again.
    bridge.failOn = null;
    const callsBefore = bridge.calls.length;
    await assert.rejects(
      () => engine.compile(MINI_PCB_030, { target: 'pcb', skipVerification: true }),
      /unknown_after_timeout/,
    );
    assert.equal(bridge.calls.length, callsBefore);
  });
});

// --- 18. missing footprints STOP before board creation ---------------------------------

test('0.3.0: components without IR footprints stop the pcb pipeline before board creation', async () => {
  await withTempRoot(async (root) => {
    const bare = {
      ...MINI_PCB_030,
      components: MINI_PCB_030.components.map(({ footprint, ...rest }) => rest),
    };
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot, inspectPcb: bridge.pcbSnapshot });
    await assert.rejects(
      () => engine.compile(bare, { target: 'pcb', skipVerification: true }),
      /PCB preflight blocked: 6 component\(s\) have no footprint/,
    );
    const state = JSON.parse(await readFile(join(root, 'mini-pcb-030', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.schematic.status, 'complete');
    assert.equal(state.pcb.status, 'failed');
    assert.ok(!bridge.calls.some((c) => c.name === 'create_board_from_schematic'));
    assert.ok(!bridge.calls.some((c) => c.name === 'batch_move_components'));
    // Read-only preflight tool reports the same deterministic gap.
    const pre = await engine.pcbPreflight(bare);
    assert.equal(pre.ok, false);
    assert.equal(pre.footprints.missing.length, 6);
    assert.deepEqual(pre.footprints.artifactsExcluded, []);
    const requirements = pcbFootprintRequirements(validateAndNormalizeIR(MINI_PCB_030).design);
    assert.equal(requirements.missing.length, 0);
  });
});
