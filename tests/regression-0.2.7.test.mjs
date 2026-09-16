import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiCadFlowEngine } from '../dist/engine.js';
import { expectedPowerFlags, PWR_FLAG_SYMBOL } from '../dist/artifacts.js';
import { validateAndNormalizeIR } from '../dist/ir.js';
import { reconcileDesignToSnapshot, parseKiCadNetlistXml } from '../dist/reconciliation.js';
import { computeEndpointCoordinates, detectEndpointCollisions } from '../dist/layout.js';

// ---------------------------------------------------------------------------
// Same faithful harness as regression-0.2.6, plus the power:PWR_FLAG artifact
// symbol so compiler artifacts pass the strict preflight like any symbol.
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
  nets = new Map();

  async start() { return [...this.tools].map((name) => ({ name })); }
  hasTool(name) { return this.tools.has(name); }

  snapshot = async () => {
    const nets = [...this.nets.entries()].map(([name, nodes]) => ({
      rawName: name,
      name: name.startsWith('/') ? name.slice(1) : name,
      nodes: nodes.map((n) => ({ ...n })),
    }));
    // 0.2.7.1: schematic-derived artifact facts (ref + label net at pin).
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
    return { raw: {}, text: 'ok', isError: false };
  }

  async callIfAvailable(name, args = {}) {
    return this.tools.has(name) ? this.call(name, args) : undefined;
  }
}

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-027-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Miniature of the authorized VCM intent: exactly GND and VBAT_FILT are
// powerDriven; every other rail (VCC5) is NOT — even with power pins.
const MINI_VCM_027 = {
  version: 1,
  project: { name: 'mini-vcm-027', profile: 'automotive' },
  blocks: ['input', 'power', 'controller'],
  components: [
    { ref: 'J2', symbol: 'Connector_Generic:Conn_01x02', block: 'input' },
    { ref: 'L1', symbol: 'Device:L_Ferrite', block: 'power' },
    { ref: 'C1', symbol: 'Device:C', block: 'power' },
    { ref: 'C2', symbol: 'Device:C', block: 'power' },
    { ref: 'U2', symbol: 'Device:R', value: 'LDO-proxy', block: 'power' },
    { ref: 'U1', symbol: 'MCU_Microchip_ATtiny:ATtiny1614-SS', block: 'controller', noConnectPins: ['8', '9'] },
  ],
  nets: [
    { name: 'GND', global: true, erc: { powerDriven: true }, pins: [{ ref: 'J2', pin: '2' }, { ref: 'U1', pin: '14' }, { ref: 'C1', pin: '2' }, { ref: 'C2', pin: '2' }] },
    { name: 'VBAT_FILT', erc: { powerDriven: true }, pins: [{ ref: 'L1', pin: '2' }, { ref: 'C1', pin: '1' }, { ref: 'C2', pin: '1' }, { ref: 'U2', pin: '2' }] },
    { name: 'VCC5', global: true, pins: [{ ref: 'U2', pin: '1' }, { ref: 'U1', pin: '1' }] },
    { name: 'VBAT_RAW', pins: [{ ref: 'J2', pin: '1' }, { ref: 'L1', pin: '1' }] },
    { name: 'ADC_ECT', pins: [{ ref: 'U1', pin: '11' }] },
  ],
};

// --- 1. powerDriven defaults to false ---------------------------------------

test('0.2.7: powerDriven defaults to false', () => {
  const design = {
    version: 1,
    project: { name: 'default-false' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [{ name: 'N1', pins: [{ ref: 'R1', pin: '1' }] }],
  };
  const result = validateAndNormalizeIR(design);
  assert.equal(result.ok, true);
  assert.equal(result.design.nets[0].erc, undefined);
  assert.deepEqual(expectedPowerFlags(result.design), []);
});

// --- 2. global:true does NOT imply powerDriven -------------------------------

test('0.2.7: global:true does not imply powerDriven', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM_027, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    // VCC5 is global but carries no erc block: zero flags on it.
    const vccFlags = result.reconciliation.powerFlagCounts.filter((x) => x.net === 'VCC5');
    assert.deepEqual(vccFlags, []);
    const vccArtifact = result.reconciliation.expectedArtifacts.filter((x) => x.net === 'VCC5');
    assert.deepEqual(vccArtifact, []);
  });
});

// --- 3. powerDriven:true generates exactly one PWR_FLAG -----------------------

test('0.2.7: powerDriven net gets exactly one PWR_FLAG', async () => {
  await withTempRoot(async (root) => {
    const design = {
      version: 1,
      project: { name: 'one-flag' },
      components: [{ ref: 'R1', symbol: 'Device:R' }],
      nets: [
        { name: 'RAIL', erc: { powerDriven: true }, pins: [{ ref: 'R1', pin: '1' }] },
        { name: 'SIG', pins: [{ ref: 'R1', pin: '2' }] },
      ],
    };
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(design, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    assert.deepEqual(result.reconciliation.expectedArtifacts, [{ ref: '#PWR01', net: 'RAIL' }]);
    assert.deepEqual(result.reconciliation.powerFlagCounts, [{ net: 'RAIL', count: 1 }]);
    assert.equal(bridge.refs.filter((x) => x === '#PWR01').length, 1);
    assert.ok(bridge.calls.some((x) => x.name === 'batch_add_components' && x.args.components.some((c) => c.reference === '#PWR01' && c.symbol === PWR_FLAG_SYMBOL)));
  });
});

// --- 4. two powerDriven nets generate exactly two PWR_FLAGs --------------------

test('0.2.7: two powerDriven nets get exactly two deterministic PWR_FLAGs', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM_027, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    assert.deepEqual(result.reconciliation.expectedArtifacts, [
      { ref: '#PWR01', net: 'GND' },
      { ref: '#PWR02', net: 'VBAT_FILT' },
    ]);
    assert.deepEqual(result.reconciliation.powerFlagCounts, [
      { net: 'GND', count: 1 },
      { net: 'VBAT_FILT', count: 1 },
    ]);
    const added = bridge.calls
      .filter((x) => x.name === 'batch_add_components')
      .flatMap((x) => x.args.components)
      .filter((c) => c.reference.startsWith('#PWR'));
    assert.equal(added.length, 2);
  });
});

// --- 5. resume never duplicates PWR_FLAG ---------------------------------------

test('0.2.7: resume adopts an attached PWR_FLAG without duplicating it', async () => {
  await withTempRoot(async (root) => {
    const design = {
      version: 1,
      project: { name: 'flag-resume' },
      components: [
        { ref: 'J1', symbol: 'Connector_Generic:Conn_01x02' },
        { ref: 'R1', symbol: 'Device:R' },
      ],
      nets: [
        { name: 'GND', global: true, erc: { powerDriven: true }, pins: [{ ref: 'J1', pin: '2' }, { ref: 'R1', pin: '2' }] },
        { name: 'SIG', pins: [{ ref: 'J1', pin: '1' }, { ref: 'R1', pin: '1' }] },
      ],
    };
    const bridge = new FakeBridge();
    bridge.refs = ['#PWR01', 'J1'];
    bridge.refSymbols.set('#PWR01', PWR_FLAG_SYMBOL);
    bridge.refSymbols.set('J1', 'Connector_Generic:Conn_01x02');
    bridge.nets.set('/GND', [
      { ref: 'J1', pin: '2', pinFunction: '2' },
      { ref: '#PWR01', pin: '1', pinFunction: '1' },
    ]);
    await mkdir(join(root, 'flag-resume'), { recursive: true });
    await writeFile(join(root, 'flag-resume', 'flag-resume.kicad_pro'), '{}');
    await writeFile(join(root, 'flag-resume', 'flag-resume.kicad_sch'), '(kicad_sch)');
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(design, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    assert.equal(bridge.refs.filter((x) => x === '#PWR01').length, 1, 'existing flag must not be duplicated');
    assert.equal(new Set(bridge.refs).size, bridge.refs.length);
    const flagAdds = bridge.calls
      .filter((x) => x.name === 'batch_add_components')
      .flatMap((x) => x.args.components)
      .filter((c) => c.reference.startsWith('#PWR'));
    assert.deepEqual(flagAdds, []);
    const gndFlags = result.reconciliation.powerFlagCounts.find((x) => x.net === 'GND');
    assert.deepEqual(gndFlags, { net: 'GND', count: 1 });
  });
});

// --- 6. PWR_FLAG enters checkpoint/state ---------------------------------------

test('0.2.7: PWR_FLAGs are recorded in state.json checkpoints', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM_027, { target: 'schematic', skipVerification: true });
    const state = JSON.parse(await readFile(join(result.projectDir, '.kicad-flow', 'state.json'), 'utf8'));
    assert.deepEqual(state.schematic.reconciliation.expectedArtifacts, [
      { ref: '#PWR01', net: 'GND' },
      { ref: '#PWR02', net: 'VBAT_FILT' },
    ]);
    assert.ok(state.schematic.confirmedComponentRefs.includes('#PWR01'));
    assert.ok(state.schematic.confirmedComponentRefs.includes('#PWR02'));
    assert.equal(state.schematic.reconciliation.missingArtifacts.length, 0);
  });
});

// --- 7. reconciliation accepts exactly the expected derived artifacts ----------

test('0.2.7: reconciliation accepts exactly the expected derived artifacts', async () => {
  await withTempRoot(async (root) => {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(MINI_VCM_027, { target: 'schematic', skipVerification: true });
    const report = result.reconciliation;
    assert.equal(report.ok, true);
    assert.equal(report.expectedComponents, 6);
    assert.equal(report.actualComponents, 8, '6 functional + 2 artifacts');
    assert.deepEqual(report.unexpectedComponents, []);
    assert.deepEqual(report.missingArtifacts, []);
    assert.deepEqual(report.misattachedArtifacts, []);
    assert.deepEqual(report.unexpectedArtifacts, []);
  });
});

// --- 8. unexpected PWR_FLAG fails reconciliation --------------------------------

test('0.2.7: unexpected PWR_FLAG fails reconciliation', () => {
  const design = {
    version: 1,
    project: { name: 'flag-guard' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [{ name: 'RAIL', erc: { powerDriven: true }, pins: [{ ref: 'R1', pin: '1' }] }],
  };
  const xml = `<?xml version="1.0"?>
<export>
  <components>
    <comp ref="R1"></comp>
    <comp ref="#PWR01"></comp>
    <comp ref="#PWR77"></comp>
  </components>
  <nets>
    <net code="1" name="/RAIL">
      <node ref="R1" pin="1" pinfunction="1"/>
      <node ref="#PWR01" pin="1" pinfunction="1"/>
    </net>
    <net code="2" name="/SIG">
      <node ref="#PWR77" pin="1" pinfunction="1"/>
      <node ref="R1" pin="2" pinfunction="2"/>
    </net>
  </nets>
</export>`;
  const snapshot = parseKiCadNetlistXml(xml);
  const report = reconcileDesignToSnapshot(design, snapshot, expectedPowerFlags(design));
  assert.equal(report.ok, false);
  assert.ok(report.unexpectedComponents.includes('#PWR77'), 'arbitrary extra artifact is an unexpected component');
  assert.ok(report.unexpectedArtifacts.some((x) => x.includes('#PWR77')));
});

// --- 9. collision detection includes PWR_FLAG endpoints -------------------------

test('0.2.7: collision detection includes PWR_FLAG endpoints', () => {
  const placements = new Map([
    // R1 pin 2 lands exactly on #PWR01 pin 1 at (37.78, 185.24).
    ['R1', { ref: 'R1', x: 37.78, y: 187.78, rotation: 0 }],
    ['#PWR01', { ref: '#PWR01', x: 37.78, y: 185.24, rotation: 0 }],
  ]);
  // computeEndpointCoordinates keys offsets by REFERENCE (same keying the
  // engine uses after the 0.2.7 hardening).
  const pinOffsets = new Map([
    ['R1', new Map([['2', { x: 0, y: -2.54 }]])],
    ['#PWR01', new Map([['1', { x: 0, y: 0 }]])],
  ]);
  const coords = computeEndpointCoordinates(
    [
      { ref: 'R1', pin: '2', net: 'VBAT_FILT' },
      { ref: '#PWR01', pin: '1', net: 'GND' },
    ],
    placements,
    pinOffsets,
  );
  const collisions = detectEndpointCollisions(coords);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].nets, ['GND', 'VBAT_FILT']);
});

// --- 10. VCC5 gets no flag just for containing power pins -----------------------

test('0.2.7: a net with power pins but no erc.powerDriven gets no PWR_FLAG', () => {
  const design = {
    version: 1,
    project: { name: 'no-flag' },
    components: [{ ref: 'U2', symbol: 'Device:R' }],
    nets: [
      // Symbol choice is irrelevant here; the point is absence of the erc block.
      { name: 'VCC5', global: true, pins: [{ ref: 'U2', pin: '1' }] },
    ],
  };
  assert.deepEqual(expectedPowerFlags(design), []);
});

// --- 11. VCM fixture declares exclusively GND and VBAT_FILT ---------------------

test('0.2.7: VCM fixture IRs declare powerDriven exclusively on GND and VBAT_FILT', async () => {
  for (const path of ['/home/juan/dev/Kicad/vcm-controller.slim.ir.json', '/home/juan/dev/Kicad/vcm-controller.ir.json']) {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const driven = raw.nets.filter((n) => n.erc?.powerDriven === true).map((n) => n.name).sort();
    assert.deepEqual(driven, ['GND', 'VBAT_FILT'], path);
    const gnd = raw.nets.find((n) => n.name === 'GND');
    const vbat = raw.nets.find((n) => n.name === 'VBAT_FILT');
    assert.equal(gnd.global, true, 'GND keeps global:true');
    assert.equal(vbat.global ?? false, false, 'VBAT_FILT stays non-global');
    for (const net of raw.nets) {
      if (net.name === 'GND' || net.name === 'VBAT_FILT') continue;
      assert.equal(net.erc, undefined, `net ${net.name} must not carry an erc block`);
    }
  }
});

// --- 0.2.7.1: schematic-text artifact parser ------------------------------------

test('0.2.7.1: parseSchematicPowerFlags resolves refs and attached nets from schematic text', async () => {
  const { parseSchematicPowerFlags } = await import('../dist/reconciliation.js');
  const SCH = `(kicad_sch
  (symbol "power:PWR_FLAG"
    (symbol "PWR_FLAG_1_1"
      (pin power_out line (at 0 0 90) (length 2.54)
        (number "1"))
    )
  )
  (symbol (lib_id "power:PWR_FLAG") (at 35.24 200.24 0)
    (property "Reference" "#PWR01")
  )
  (symbol (lib_id "power:PWR_FLAG") (at 50.48 200.24 0)
    (property "Reference" "#PWR02")
  )
  (symbol (lib_id "power:PWR_FLAG") (at 65.72 200.24 0)
    (property "Reference" "#PWR03")
  )
  (label "GND" (at 35.24 200.24 0))
  (global_label "VBAT_FILT" (at 50.48 200.24 270))
)`;
  const facts = parseSchematicPowerFlags(SCH);
  assert.deepEqual(facts, [
    { ref: '#PWR01', net: 'GND' },
    { ref: '#PWR02', net: 'VBAT_FILT' },
    { ref: '#PWR03', net: null },
  ]);
});

test('0.2.7.1: schematic facts drive reconciliation for attached, floating and unexpected flags', () => {
  const design = {
    version: 1,
    project: { name: 'facts' },
    components: [{ ref: 'R1', symbol: 'Device:R' }],
    nets: [
      { name: 'GND', erc: { powerDriven: true }, pins: [{ ref: 'R1', pin: '1' }] },
      { name: 'RAIL', erc: { powerDriven: true }, pins: [{ ref: 'R1', pin: '2' }] },
    ],
  };
  const expected = expectedPowerFlags(design); // #PWR01 GND, #PWR02 RAIL
  const xml = `<?xml version="1.0"?>
<export>
  <components><comp ref="R1"></comp></components>
  <nets>
    <net code="1" name="/GND"><node ref="R1" pin="1"/></net>
    <net code="2" name="/RAIL"><node ref="R1" pin="2"/></net>
  </nets>
</export>`;
  const snapshot = { ...parseKiCadNetlistXml(xml), schematicArtifacts: [
    { ref: '#PWR01', net: 'GND' },
    { ref: '#PWR02', net: null },
    { ref: '#PWR77', net: 'RAIL' },
  ] };
  const report = reconcileDesignToSnapshot(design, snapshot, expected);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missingArtifacts, []);
  assert.deepEqual(report.misattachedArtifacts, [{ ref: '#PWR02', net: 'RAIL' }]);
  assert.ok(report.unexpectedArtifacts.some((x) => x.includes('#PWR77')));
  assert.ok(report.unexpectedComponents.includes('#PWR77'));
  // Census counts flags physically on each net, including the unexpected one.
  assert.deepEqual(report.powerFlagCounts, [{ net: 'GND', count: 1 }, { net: 'RAIL', count: 1 }]);
  // All good: attached as expected, nothing extra.
  const okSnapshot = { ...snapshot, schematicArtifacts: [{ ref: '#PWR01', net: 'GND' }, { ref: '#PWR02', net: 'RAIL' }] };
  const okReport = reconcileDesignToSnapshot(design, okSnapshot, expected);
  assert.equal(okReport.ok, true);
  assert.deepEqual(okReport.powerFlagCounts, [{ net: 'GND', count: 1 }, { net: 'RAIL', count: 1 }]);
  assert.deepEqual(okReport.unexpectedComponents, []);
});

// --- 12. deterministic artifact layout stays inside the sheet area --------------

test('0.2.7: artifact placements are deterministic and separated from components', async () => {
  const { artifactPlacements, schematicPlacements, MIN_ORIGIN_SEPARATION_MM } = await import('../dist/layout.js');
  const functional = schematicPlacements(MINI_VCM_027);
  const artifacts = artifactPlacements(['#PWR01', '#PWR02'], functional);
  assert.deepEqual(artifacts, artifactPlacements(['#PWR01', '#PWR02'], functional));
  for (const a of artifacts) {
    for (const f of functional) {
      const d = Math.hypot(a.x - f.x, a.y - f.y);
      assert.ok(d >= MIN_ORIGIN_SEPARATION_MM - 1e-9, `artifact ${a.ref} too close to ${f.ref}: ${d}`);
    }
  }
  const d = Math.hypot(artifacts[0].x - artifacts[1].x, artifacts[0].y - artifacts[1].y);
  assert.ok(d >= MIN_ORIGIN_SEPARATION_MM - 1e-9);
});