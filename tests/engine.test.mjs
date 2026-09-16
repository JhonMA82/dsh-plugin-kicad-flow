import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiCadFlowEngine } from '../dist/engine.js';

const PIN_DB = {
  'Device:R': [
    ['1', '', 'passive', 0, 2.54, 0],
    ['2', '', 'passive', 0, -2.54, 0],
  ],
  'Connector_Generic:Conn_01x02': [
    ['1', '', 'passive', -2.54, 0, 0],
    ['2', '', 'passive', 2.54, 0, 0],
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
    'batch_add_no_connects', 'batch_edit_schematic_components', 'validate_schematic',
  ]);
  calls = [];
  refs = [];
  nets = new Map();
  failPreflight = false;
  timeoutComponentCall = undefined;
  componentCalls = 0;

  async start() { return [...this.tools].map((name) => ({ name })); }
  hasTool(name) { return this.tools.has(name); }

  snapshot = async () => ({
    componentRefs: [...this.refs],
    nets: [...this.nets.entries()].map(([name, nodes]) => ({
      rawName: name,
      name: name.startsWith('/') ? name.slice(1) : name,
      nodes: nodes.map((n) => ({ ...n })),
    })),
  });

  async call(name, args = {}) {
    if (!this.tools.has(name)) throw new Error(`missing ${name}`);
    this.calls.push({ name, args });
    if (name === 'create_project') {
      await mkdir(args.path, { recursive: true });
      await writeFile(join(args.path, `${args.name}.kicad_pro`), '{}');
      await writeFile(join(args.path, `${args.name}.kicad_sch`), '(kicad_sch)');
      await writeFile(join(args.path, `${args.name}.kicad_pcb`), '(kicad_pcb)');
    }
    if (name === 'batch_list_symbol_pins') {
      await access(args.schematicPath);
      if (this.failPreflight) throw new Error('Failed to list pins: Unknown error');
      return { raw: {}, text: preflightText(args.symbols), isError: false };
    }
    if (name === 'batch_add_components') {
      await access(args.schematicPath);
      this.componentCalls++;
      if (this.timeoutComponentCall === this.componentCalls) throw new Error('MCP error -32001: Request timed out');
      for (const c of args.components) this.refs.push(c.reference);
    }
    if (name === 'batch_connect') {
      await access(args.schematicPath);
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

const DESIGN = {
  version: 1,
  project: { name: 'batch-smoke', profile: 'generic' },
  blocks: ['input', 'filter'],
  components: [
    { ref: 'J1', symbol: 'Connector_Generic:Conn_01x02', block: 'input' },
    { ref: 'R1', symbol: 'Device:R', value: '10k', block: 'filter' },
  ],
  nets: [
    { name: 'SIGNAL', pins: [{ ref: 'J1', pin: '1' }, { ref: 'R1', pin: '1' }] },
    { name: 'GND', global: true, pins: [{ ref: 'J1', pin: '2' }, { ref: 'R1', pin: '2' }] },
  ],
};

test('schematic compile reconciles actual state and writes v3 reusable checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-'));
  try {
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const first = await engine.compile(DESIGN, { target: 'schematic', skipVerification: true });
    assert.equal(first.reused, false);
    assert.equal(first.reconciliation.ok, true);
    assert.equal(first.reconciliation.expectedComponents, 2);
    assert.equal(first.reconciliation.matchedNets, 2);
    assert.equal(first.mcpCalls.filter((x) => x === 'batch_add_components').length, 1);
    assert.equal(first.mcpCalls.filter((x) => x === 'batch_connect').length, 2);

    const state = JSON.parse(await readFile(join(first.projectDir, '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.version, 3);
    assert.equal(state.schematic.status, 'complete');
    assert.deepEqual(state.completed, ['schematic']);
    assert.equal(state.schematic.reconciliation.ok, true);

    const second = await engine.compile(DESIGN, { target: 'schematic', skipVerification: true });
    assert.equal(second.reused, true);
    assert.deepEqual(second.mcpCalls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('strict symbol preflight stops before component mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-preflight-'));
  try {
    const bridge = new FakeBridge();
    bridge.failPreflight = true;
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    await assert.rejects(
      engine.compile(DESIGN, { target: 'schematic', skipVerification: true }),
      /Failed to list pins/,
    );
    assert.equal(bridge.refs.length, 0);
    assert.equal(bridge.calls.filter((x) => x.name === 'batch_add_components').length, 0);
    const state = JSON.parse(await readFile(join(root, 'batch-smoke', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.schematic.status, 'failed');
    assert.equal(state.schematic.lastOperation.kind, 'preflight');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('large schematic is chunked deterministically and never repeats confirmed refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-chunks-'));
  try {
    const components = Array.from({ length: 25 }, (_, i) => ({ ref: `R${i + 1}`, symbol: 'Device:R', value: '1k' }));
    const nets = components.map((c, i) => ({ name: `N${i + 1}`, pins: [{ ref: c.ref, pin: '1' }] }));
    const design = { version: 1, project: { name: 'chunked' }, components, nets };
    const bridge = new FakeBridge();
    const engine = new KiCadFlowEngine(bridge, {
      projectDir: root,
      inspectSchematic: bridge.snapshot,
      componentBatchSize: 12,
      connectionBatchSize: 16,
    });
    const result = await engine.compile(design, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    assert.equal(bridge.calls.filter((x) => x.name === 'batch_add_components').length, 3);
    assert.equal(bridge.calls.filter((x) => x.name === 'batch_connect').length, 2);
    assert.equal(new Set(bridge.refs).size, 25);
    assert.equal(bridge.refs.length, 25);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeout is checkpointed as unknown_after_timeout and compilation stops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-timeout-'));
  try {
    const components = Array.from({ length: 13 }, (_, i) => ({ ref: `R${i + 1}`, symbol: 'Device:R' }));
    const design = { version: 1, project: { name: 'timeout-case' }, components, nets: [] };
    const bridge = new FakeBridge();
    bridge.timeoutComponentCall = 2;
    const engine = new KiCadFlowEngine(bridge, {
      projectDir: root,
      inspectSchematic: bridge.snapshot,
      componentBatchSize: 12,
    });
    await assert.rejects(engine.compile(design, { target: 'schematic', skipVerification: true }), /timed out/i);
    assert.equal(bridge.refs.length, 12);
    const state = JSON.parse(await readFile(join(root, 'timeout-case', '.kicad-flow', 'state.json'), 'utf8'));
    assert.equal(state.schematic.status, 'unknown_after_timeout');
    assert.equal(state.schematic.lastOperation.status, 'unknown_after_timeout');
    assert.equal(state.schematic.confirmedComponentRefs.length, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('partial existing schematic is adopted read-only and only missing work is materialized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-resume-'));
  try {
    const bridge = new FakeBridge();
    bridge.refs = ['J1'];
    bridge.nets.set('/SIGNAL', [{ ref: 'J1', pin: '1', pinFunction: '1' }]);
    await mkdir(join(root, 'batch-smoke'), { recursive: true });
    await writeFile(join(root, 'batch-smoke', 'batch-smoke.kicad_pro'), '{}');
    await writeFile(join(root, 'batch-smoke', 'batch-smoke.kicad_sch'), '(kicad_sch)');
    const engine = new KiCadFlowEngine(bridge, { projectDir: root, inspectSchematic: bridge.snapshot });
    const result = await engine.compile(DESIGN, { target: 'schematic', skipVerification: true });
    assert.equal(result.reconciliation.ok, true);
    const addCalls = bridge.calls.filter((x) => x.name === 'batch_add_components');
    assert.equal(addCalls.length, 1);
    assert.deepEqual(addCalls[0].args.components.map((x) => x.reference), ['R1']);
    assert.equal(bridge.refs.filter((x) => x === 'J1').length, 1, 'existing reference must not be duplicated');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
