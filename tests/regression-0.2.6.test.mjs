import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiCadFlowEngine } from '../dist/engine.js';
import {
  computeEndpointCoordinates,
  detectEndpointCollisions,
  resolveOriginCollisions,
  schematicPlacements,
  MIN_ORIGIN_SEPARATION_MM,
} from '../dist/layout.js';
import { normalizePinId, parseSymbolPinPreflight, verifyDesignPins } from '../dist/pin-data.js';
import { semanticToolFailure } from '../dist/semantic.js';

// ---------------------------------------------------------------------------
// Faithful harness model: preflight pin text in the exact KiCAD-MCP-Server
// format (multi-digit and alphanumeric numbers included), name-based label
// joins, and unconnected-pin modelling so no-connect classification is real.
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
  'Diode:1N4148': [
    ['1', '', 'passive', -1.27, 0, 0],
    ['2', '', 'passive', 1.27, 0, 0],
  ],
  'Relay:Relay_SPDT': [
    ['11', '', 'passive', 5.08, -7.62, 90],
    ['12', '', 'passive', 2.54, 7.62, 270],
    ['14', '', 'passive', 7.62, 7.62, 270],
    ['A1', '', 'passive', -5.08, 7.62, 270],
    ['A2', '', 'passive', -5.08, -7.62, 90],
  ],
  'Transistor_FET:Q_NMOS_GDS': [
    ['1', 'G', 'input', -5.08, 0, 0],
    ['2', 'D', 'passive', 2.54, 5.08, 270],
    ['3', 'S', 'passive', 2.54, -5.08, 90],
  ],
  'MCU_Microchip_ATtiny:ATtiny1614-SS': [
    ['1', 'VCC', 'power_in', 0, 10.16, 0],
    ['8', 'PB1', 'bidirectional', -7.62, -10.16, 0],
    ['9', 'PB0', 'bidirectional', -7.62, -7.62, 0],
    ['11', 'PA1', 'bidirectional', 7.62, -5.08, 180],
    ['14', 'GND', 'power_in', 0, -10.16, 0],
  ],
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
  ]);
  calls = [];
  refs = [];
  refSymbols = new Map();
  noConnects = new Set();
  nets = new Map();
  timeoutConnectCall = undefined;
  connectCalls = 0;

  async start() { return [...this.tools].map((name) => ({ name })); }
  hasTool(name) { return this.tools.has(name); }

  snapshot = async () => {
    const nets = [...this.nets.entries()].map(([name, nodes]) => ({
      rawName: name,
      name: name.startsWith('/') ? name.slice(1) : name,
      nodes: nodes.map((n) => ({ ...n })),
    }));
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
    return { componentRefs: [...this.refs], nets };
  };

  async call(name, args = {}) {
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
      }
    }
    if (name === 'batch_add_no_connects') {
      for (const p of args.pins) this.noConnects.add(`${p.componentRef}/${p.pinName}`);
    }
    if (name === 'batch_connect') {
      this.connectCalls++;
      if (this.timeoutConnectCall === this.connectCalls) throw new Error('MCP error -32001: Request timed out');
      const prefix = args.labelType === 'global_label' ? '' : '/';
      for (const [ref, pins] of Object.entries(args.connections)) {
        for (const [pin, net] of Object.entries(pins)) {
          const key = `${prefix}${net}`;
          const nodes = this.nets.get(key) ?? [];
          if (!nodes.some((n) => n.ref === ref && n.pin === pin)) nodes.push({ ref, pin, pinFunction: pin });
          this.nets.set(key, nodes);
        }
      }
    }
    return { raw: {}, text: 'ok', isError: false };
  }

  async callIfAvailable(name, args = {}) {
    return this.tools.has(name) ? this.call(name, args) : undefined;
  }
}

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-026-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A miniature vcm-controller: relay bypass + one FET compensation slice +
// global rails + declared no-connects.
const MINI_VCM = {
  version: 1,
  project: { name: 'mini-vcm', profile: 'automotive' },
  blocks: ['input', 'bypass', 'compensation', 'controller'],
  components: [
    { ref: 'J2', symbol: 'Connector_Generic:Conn_01x02', block: 'input' },
    { ref: 'J3', symbol: 'Connector_Generic:Conn_01x02', block: 'input' },
    { ref: 'K1', symbol: 'Relay:Relay_SPDT', value: 'G5V-1-DC5', block: 'bypass' },
    { ref: 'D5', symbol: 'Diode:1N4148', block: 'bypass' },
    { ref: 'Q7', symbol: 'Transistor_FET:Q_NMOS_GDS', value: '2N7002', block: 'bypass' },
    { ref: 'R5', symbol: 'Device:R', value: '1k', block: 'bypass' },
    { ref: 'R6', symbol: 'Device:R', value: '10k', block: 'bypass' },
    { ref: 'R1', symbol: 'Device:R', value: '100k', block: 'bypass' },
    { ref: 'Q1', symbol: 'Transistor_FET:Q_NMOS_GDS', value: 'AO3400', block: 'compensation' },
    { ref: 'Q6', symbol: 'Transistor_FET:Q_NMOS_GDS', value: 'AO3400', block: 'compensation' },
    { ref: 'R20', symbol: 'Device:R', value: '100R', block: 'compensation' },
    { ref: 'R25', symbol: 'Device:R', value: '100R', block: 'compensation' },
    { ref: 'U1', symbol: 'MCU_Microchip_ATtiny:ATtiny1614-SS', block: 'controller', noConnectPins: ['8', '9'] },
    { ref: 'C3', symbol: 'Device:C', value: '100n', block: 'controller' },
  ],
  nets: [
    { name: 'GND', global: true, pins: [{ ref: 'J2', pin: '2' }, { ref: 'J3', pin: '2' }, { ref: 'U1', pin: '14' }, { ref: 'C3', pin: '2' }, { ref: 'Q1', pin: '3' }, { ref: 'Q6', pin: '3' }, { ref: 'Q7', pin: '3' }, { ref: 'R5', pin: '2' }] },
    { name: 'VCC5', global: true, pins: [{ ref: 'U1', pin: '1' }, { ref: 'C3', pin: '1' }, { ref: 'K1', pin: 'A1' }, { ref: 'D5', pin: '2' }] },
    { name: 'ECT_S_SIG', pins: [{ ref: 'J2', pin: '1' }, { ref: 'K1', pin: '12' }, { ref: 'R6', pin: '1' }, { ref: 'R1', pin: '1' }] },
    { name: 'ECT_MOD', pins: [{ ref: 'K1', pin: '14' }, { ref: 'R6', pin: '2' }, { ref: 'R20', pin: '1' }, { ref: 'R25', pin: '1' }] },
    { name: 'ECT_ECU_SIG', pins: [{ ref: 'J3', pin: '1' }, { ref: 'K1', pin: '11' }] },
    { name: 'RELAY_LOW', pins: [{ ref: 'K1', pin: 'A2' }, { ref: 'D5', pin: '1' }, { ref: 'Q7', pin: '2' }] },
    { name: 'RELAY_GATE', pins: [{ ref: 'R5', pin: '1' }, { ref: 'Q7', pin: '1' }] },
    { name: 'ADC_ECT', pins: [{ ref: 'R1', pin: '2' }, { ref: 'U1', pin: '11' }] },
    { name: 'DRAIN0', pins: [{ ref: 'R20', pin: '2' }, { ref: 'Q1', pin: '2' }] },
    { name: 'DRAIN5', pins: [{ ref: 'R25', pin: '2' }, { ref: 'Q6', pin: '2' }] },
    { name: 'GATE0', pins: [{ ref: 'Q1', pin: '1' }] },
    { name: 'GATE5', pins: [{ ref: 'Q6', pin: '1' }] },
  ],
};

// --- 1. global:true is materialized ----------------------------------------

test('0.2.6: global:true nets are materialized with deterministic local labels', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    const gnd = result.reconciliation.netIssues.find((n) => n.name === 'GND');
    const vcc = result.reconciliation.netIssues.find((n) => n.name === 'VCC5');
    assert.equal(gnd, undefined);
    assert.equal(vcc, undefined);
    const connectCalls = bridge.calls.filter((x) => x.name === 'batch_connect');
    assert.ok(connectCalls.length >= 2);
    for (const call of connectCalls) assert.equal(call.args.labelType, 'label');
  });
});

// --- 2. multi-endpoint global net complete ----------------------------------

test('0.2.6: multi-endpoint global net appears complete in the netlist', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    await engine.compile(MINI_VCM, { target: 'schematic', skipVerification: true });
    const snapshot = await bridge.snapshot();
    const gnd = snapshot.nets.find((n) => n.name === 'GND');
    assert.ok(gnd);
    assert.equal(gnd.nodes.length, 8);
    const refs = gnd.nodes.map((n) => `${n.ref}:${n.pin}`).sort();
    assert.ok(refs.includes('Q1:3'));
    assert.ok(refs.includes('U1:14'));
  });
});

// --- 3. multi-digit numeric pins --------------------------------------------

test('0.2.6: multi-digit numeric pins 11/12/14 resolve', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM, { target: 'schematic', skipVerification: true });
    const snapshot = await bridge.snapshot();
    const byName = new Map(snapshot.nets.map((n) => [n.name, n]));
    assert.ok(byName.get('ECT_S_SIG').nodes.some((n) => n.ref === 'K1' && n.pin === '12'));
    assert.ok(byName.get('ECT_MOD').nodes.some((n) => n.ref === 'K1' && n.pin === '14'));
    assert.ok(byName.get('ECT_ECU_SIG').nodes.some((n) => n.ref === 'K1' && n.pin === '11'));
    assert.equal(result.reconciliation.ok, true);
  });
});

// --- 4. alphanumeric pins ----------------------------------------------------

test('0.2.6: alphanumeric pins A1/A2 resolve without a K1 exception', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM, { target: 'schematic', skipVerification: true });
    const snapshot = await bridge.snapshot();
    const byName = new Map(snapshot.nets.map((n) => [n.name, n]));
    assert.ok(byName.get('VCC5').nodes.some((n) => n.ref === 'K1' && n.pin === 'A1'));
    assert.ok(byName.get('RELAY_LOW').nodes.some((n) => n.ref === 'K1' && n.pin === 'A2'));
    assert.equal(result.reconciliation.ok, true);
  });
});

// --- 5. collision detector reproduces Q1-D == Q6-S ----------------------------

test('0.2.6: endpoint collision detector reproduces the Q1-D/Q6-S overlap', async () => {
  const qOffsets = new Map([
    ['1', { x: -5.08, y: 0 }],
    ['2', { x: 2.54, y: 5.08 }],
    ['3', { x: 2.54, y: -5.08 }],
  ]);
  const placements = new Map([
    ['Q1', { ref: 'Q1', x: 218.44, y: 92.71, rotation: 0 }],
    ['Q6', { ref: 'Q6', x: 218.44, y: 102.87, rotation: 0 }],
  ]);
  const pinOffsets = new Map([['Q1', qOffsets], ['Q6', qOffsets]]);
  const coords = computeEndpointCoordinates(
    [
      { ref: 'Q1', pin: '2', net: 'DRAIN0' },
      { ref: 'Q6', pin: '3', net: 'GND' },
    ],
    placements,
    pinOffsets,
  );
  const collisions = detectEndpointCollisions(coords);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].nets, ['DRAIN0', 'GND']);
  assert.ok(Math.abs(collisions[0].x - 220.98) < 0.05);
  assert.ok(Math.abs(collisions[0].y - 97.79) < 0.05);
  // Same-net sharing is intentional and must not report.
  const sameNet = detectEndpointCollisions(
    computeEndpointCoordinates(
      [
        { ref: 'Q1', pin: '2', net: 'DRAIN0' },
        { ref: 'Q1', pin: '2', net: 'DRAIN0' },
      ],
      placements,
      pinOffsets,
    ),
  );
  assert.equal(sameNet.length, 0);
});

// --- 6. auto-layout separates colliding origins -------------------------------

test('0.2.6: auto-layout no longer superposes endpoints of different components', async () => {
  const placements = schematicPlacements(MINI_VCM);
  let min = Infinity;
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      min = Math.min(min, Math.hypot(placements[i].x - placements[j].x, placements[i].y - placements[j].y));
    }
  }
  assert.ok(min >= MIN_ORIGIN_SEPARATION_MM - 1e-9, `min origin separation ${min}`);
  // Deterministic: same input, same layout.
  assert.deepEqual(placements, schematicPlacements(MINI_VCM));
  // Previously colliding pair, forced onto the old grid, is separated.
  const legacy = resolveOriginCollisions(
    [
      { ref: 'Q1', x: 218.44, y: 92.71, rotation: 0 },
      { ref: 'Q6', x: 218.44, y: 102.87, rotation: 0 },
    ],
    new Set(),
  );
  const q1 = legacy.find((p) => p.ref === 'Q1');
  const q6 = legacy.find((p) => p.ref === 'Q6');
  const after = Math.hypot(q1.x - q6.x, q1.y - q6.y);
  assert.ok(after >= MIN_ORIGIN_SEPARATION_MM - 1e-9, `separated to ${after}`);
});

// --- 7. DRAIN5 acquires no extra endpoint --------------------------------------

test('0.2.6: DRAIN5 contains exactly R25-2 and Q6-2', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM, { target: 'schematic', skipVerification: true });
    const snapshot = await bridge.snapshot();
    const drain5 = snapshot.nets.find((n) => n.name === 'DRAIN5');
    assert.ok(drain5);
    assert.deepEqual(drain5.nodes.map((n) => `${n.ref}:${n.pin}`).sort(), ['Q6:2', 'R25:2']);
    const gnd = snapshot.nets.find((n) => n.name === 'GND');
    assert.ok(gnd.nodes.some((n) => n.ref === 'Q1' && n.pin === '3'));
    assert.ok(gnd.nodes.some((n) => n.ref === 'Q6' && n.pin === '3'));
    assert.equal(result.reconciliation.ok, true);
  });
});

// --- 8. representative design reconciles fully ----------------------------------

test('0.2.6: relay + FET + global rails reconcile with only declared no-connects', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM, { target: 'schematic', skipVerification: true });
    const report = result.reconciliation;
    assert.equal(report.expectedComponents, 14);
    assert.equal(report.actualComponents, 14);
    assert.deepEqual(report.duplicateReferences, []);
    assert.equal(report.expectedNets, 12);
    assert.equal(report.matchedNets, 12);
    assert.deepEqual(report.missingNets, []);
    assert.equal(report.netIssues.length, 0);
    assert.equal(report.expectedButUnconnected.length, 0);
    assert.equal(report.unexpectedUnconnected.length, 0);
    assert.deepEqual(
      report.allowedNoConnect.map((n) => `${n.ref}:${n.pin}`).sort(),
      ['U1:8', 'U1:9'],
    );
    assert.equal(report.ok, true);
  });
});

// --- 9. resume never duplicates references --------------------------------------

test('0.2.6: resume adopts partial relay wiring without duplicating K1', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    bridge.refs = ['K1', 'J3'];
    bridge.refSymbols.set('K1', 'Relay:Relay_SPDT');
    bridge.refSymbols.set('J3', 'Connector_Generic:Conn_01x02');
    bridge.nets.set('/ECT_ECU_SIG', [
      { ref: 'J3', pin: '1', pinFunction: '1' },
      { ref: 'K1', pin: '11', pinFunction: '11' },
    ]);
    await mkdir(join(root, 'mini-vcm'), { recursive: true });
    await writeFile(join(root, 'mini-vcm', 'mini-vcm.kicad_pro'), '{}');
    await writeFile(join(root, 'mini-vcm', 'mini-vcm.kicad_sch'), '(kicad_sch)');
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    assert.equal(bridge.refs.filter((x) => x === 'K1').length, 1);
    assert.equal(new Set(bridge.refs).size, bridge.refs.length);
  });
});

// --- 10. connection timeout stays unknown_after_timeout --------------------------

test('0.2.6: connection-phase timeout checkpoints unknown_after_timeout and stops', async () => {
  await withTempRoot(async (root) => {
    const design = {
      version: 1,
      project: { name: 'timeout-conn' },
      components: [
        { ref: 'J1', symbol: 'Connector_Generic:Conn_01x02' },
        { ref: 'R1', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'SIG', pins: [{ ref: 'J1', pin: '1' }, { ref: 'R1', pin: '1' }] },
        { name: 'GND', global: true, pins: [{ ref: 'J1', pin: '2' }, { ref: 'R1', pin: '2' }] },
      ],
    };
    const bridge = new FakeBridge();
    bridge.timeoutConnectCall = 1;
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    await assert.rejects(
      engine.compile(design, { target: 'schematic', skipVerification: true }),
      /timed out/i,
    );
    const state = JSON.parse(await readFile(join(root, 'timeout-conn', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.schematic.status, 'unknown_after_timeout');
    assert.equal(state.schematic.lastOperation.status, 'unknown_after_timeout');
    assert.equal(state.schematic.lastOperation.kind, 'connections');
  });
});

// --- pin-data unit coverage ------------------------------------------------------

test('0.2.6: preflight parser keeps multi-digit and alphanumeric pin identity', async () => {
  const text = preflightText(['Relay:Relay_SPDT', 'Transistor_FET:Q_NMOS_GDS']);
  const data = parseSymbolPinPreflight(text);
  assert.deepEqual([...data.get('Relay:Relay_SPDT').pins.keys()].sort(), ['11', '12', '14', 'A1', 'A2']);
  assert.ok(data.get('Transistor_FET:Q_NMOS_GDS').pins.has('2'));
  assert.equal(normalizePinId(' A1 '), 'A1');
  const bad = {
    version: 1,
    project: { name: 'bad-pin' },
    components: [{ ref: 'K1', symbol: 'Relay:Relay_SPDT' }],
    nets: [{ name: 'X', pins: [{ ref: 'K1', pin: '99' }] }],
  };
  const verification = verifyDesignPins(bad.components, bad.nets, data);
  assert.equal(verification.ok, false);
  assert.equal(verification.unknownPins[0].pin, '99');
});

test('0.2.6: unknown pin stops the compile before any component mutation', async () => {
  await withTempRoot(async (root) => {
    const bad = {
      version: 1,
      project: { name: 'bad-pin' },
      components: [{ ref: 'K1', symbol: 'Relay:Relay_SPDT' }],
      nets: [{ name: 'X', pins: [{ ref: 'K1', pin: '99' }] }],
    };
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    await assert.rejects(engine.compile(bad, { target: 'schematic', skipVerification: true }), /no matching symbol pin/);
    assert.equal(bridge.refs.length, 0);
    assert.equal(bridge.calls.filter((x) => x.name === 'batch_add_components').length, 0);
  });
});

test('0.2.6: batch_connect placing zero labels is a hard failure, not a silent skip', async () => {
  assert.ok(semanticToolFailure('batch_connect', 'Placed 0 label(s), 0 failed'));
  assert.equal(semanticToolFailure('batch_connect', 'Placed 16 label(s), 0 failed'), undefined);
});
