import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFpLibTable, parseFootprintPads, resolveFootprintLibs, resolveFootprintPath } from '../dist/footprint-preflight.js';
import { KiCadFlowEngine } from '../dist/engine.js';

test('parseFpLibTable extracts lib entries', () => {
  const text = [
    '(fp_lib_table',
    '  (version 7)',
    '  (lib (name "Fuse") (type "KiCad") (uri "${KICAD10_FOOTPRINT_DIR}/Fuse.pretty") (options "") (descr "d"))',
    '  (lib (name "Nest") (type "Table") (uri "/tmp/other/fp-lib-table") (options "") (descr "d"))',
    ')',
  ].join('\n');
  const libs = parseFpLibTable(text);
  assert.equal(libs.length, 2);
  assert.deepEqual(
    libs[0],
    { name: 'Fuse', type: 'KiCad', uri: '${KICAD10_FOOTPRINT_DIR}/Fuse.pretty' },
  );
  assert.equal(libs[1].type, 'Table');
});

test('resolveFootprintLibs follows nested Table entries and overrides by version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-fp-'));
  try {
    const nested = join(root, 'template-fp-lib-table');
    await writeFile(nested, [
      '(fp_lib_table',
      '  (lib (name "NestedLib") (type "KiCad") (uri "/nested/NestedLib.pretty") (options "") (descr ""))',
      '  (lib (name "Shared") (type "KiCad") (uri "/nested/Shared.pretty") (options "") (descr ""))',
      ')',
    ].join('\n'));
    const v9 = join(root, '9.0');
    const v10 = join(root, '10.0');
    await mkdir(v9, { recursive: true });
    await mkdir(v10, { recursive: true });
    await writeFile(join(v9, 'fp-lib-table'), [
      '(fp_lib_table (lib (name "Shared") (type "KiCad") (uri "/v9/Shared.pretty") (options "") (descr "")))',
    ].join('\n'));
    await writeFile(join(v10, 'fp-lib-table'), [
      '(fp_lib_table (lib (name "Nest") (type "Table") (uri "' + nested + '") (options "") (descr "")))',
    ].join('\n'));
    const saved = process.env.KICAD_CONFIG_HOME;
    process.env.KICAD_CONFIG_HOME = root;
    try {
      const libs = await resolveFootprintLibs();
      // 10.0 wins over 9.0 for the same nick; its nested Table is inlined at
      // the 10.0 position, so the nested Shared overrides the v9 one.
      assert.equal(libs.dirs.get('Shared'), '/nested/Shared.pretty');
      assert.equal(libs.dirs.get('NestedLib'), '/nested/NestedLib.pretty');
      assert.ok(libs.tables.some((t) => t.includes('template-fp-lib-table')));
    } finally {
      if (saved === undefined) delete process.env.KICAD_CONFIG_HOME;
      else process.env.KICAD_CONFIG_HOME = saved;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveFootprintPath probes default roots for unresolved KICADn_FOOTPRINT_DIR', async () => {
  const libs = { dirs: new Map([['Fuse', '${KICAD10_FOOTPRINT_DIR}/Fuse.pretty']]), tables: [] };
  const resolved = await resolveFootprintPath('Fuse:Fuse_1206_3216Metric', libs);
  // On machines with the real KiCad install this resolves; the path contract
  // is what must hold either way.
  if (resolved.path) {
    assert.match(resolved.path, /Fuse\.pretty\/Fuse_1206_3216Metric\.kicad_mod$/);
    const text = await readFile(resolved.path, 'utf8');
    assert.ok(text.includes('(pad '));
  } else {
    assert.equal(resolved.problem, 'module_not_found');
  }
});

test('parseFootprintPads returns non-empty pad names only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-mod-'));
  try {
    const mod = join(root, 'R_0805.kicad_mod');
    await writeFile(mod, [
      '(module "R_0805"',
      '  (pad "1" smd rect (at -0.9 0))',
      '  (pad "2" smd rect (at 0.9 0))',
      '  (pad "" np_thru_hole circle (at 0 0))',
      ')',
    ].join('\n'));
    const pads = await parseFootprintPads(mod);
    assert.deepEqual([...pads].sort(), ['1', '2']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function footprintTable(root, nick, prettyDir) {
  return [
    '(fp_lib_table',
    `  (lib (name "${nick}") (type "KiCad") (uri "${prettyDir}") (options "") (descr ""))`,
    ')',
  ].join('\n');
}

test('engine footprint preflight rejects declared footprint with missing pad before mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kicad-flow-fp-'));
  try {
    const pretty = join(root, 'TestLib.pretty');
    await mkdir(pretty, { recursive: true });
    await writeFile(join(pretty, 'R_0805.kicad_mod'), [
      '(module "R_0805"',
      '  (pad "A" smd rect (at -0.9 0))',
      '  (pad "B" smd rect (at 0.9 0))',
      ')',
    ].join('\n'));
    const config = join(root, 'kicad-cfg');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'fp-lib-table'), footprintTable(config, 'TestLib', pretty));

    const saved = process.env.KICAD_CONFIG_HOME;
    process.env.KICAD_CONFIG_HOME = config;
    try {
      const design = {
        version: 1,
        project: { name: 'fp-preflight', profile: 'generic' },
        blocks: ['b'],
        components: [
          { ref: 'R1', symbol: 'Device:R', value: '10k', footprint: 'TestLib:R_0805', block: 'b' },
        ],
        nets: [
          { name: 'SIG', pins: [{ ref: 'R1', pin: '1' }, { ref: 'R1', pin: '2' }] },
        ],
      };
      // Minimal schematic flow: the preflight must fire BEFORE batch_add_components.
      const added = [];
      const bridge = {
        tools: new Set(['create_project', 'batch_list_symbol_pins', 'batch_add_components', 'batch_connect', 'batch_add_no_connects', 'batch_edit_schematic_components', 'validate_schematic']),
        async start() { return [...this.tools].map((name) => ({ name })); },
        hasTool(name) { return this.tools.has(name); },
        snapshot: async () => ({ componentRefs: [...added], nets: [] }),
        async call(name, args = {}) {
          if (name === 'create_project') {
            await mkdir(args.path, { recursive: true });
            await writeFile(join(args.path, `${args.name}.kicad_sch`), '(kicad_sch)');
            await writeFile(join(args.path, `${args.name}.kicad_pcb`), '(kicad_pcb)');
            await writeFile(join(args.path, `${args.name}.kicad_pro`), '{}');
          }
          if (name === 'batch_list_symbol_pins') {
            return { raw: {}, text: 'Device:R — 2 pin(s):\n    Pin 1 () — type: passive at (0,2.54) angle=0\n    Pin 2 () — type: passive at (0,-2.54) angle=0', isError: false };
          }
          if (name === 'batch_add_components') for (const c of args.components) added.push(c.reference);
          return { raw: {}, text: 'ok', isError: false };
        },
        async callIfAvailable(name, args) { return this.call(name, args); },
      };
      const engine = new KiCadFlowEngine(bridge, { projectDir: join(root, 'proj'), inspectSchematic: bridge.snapshot });
      await assert.rejects(
        engine.compile(design, { target: 'schematic', skipVerification: true }),
        (error) => {
          assert.match(error.message, /Strict footprint preflight rejected 2 footprint issue/);
          assert.match(error.message, /design uses pin '1' but footprint pads are: \[A, B\]/);
          return true;
        },
      );
      assert.equal(added.length, 0); // no component reached batch_add_components
    } finally {
      if (saved === undefined) delete process.env.KICAD_CONFIG_HOME;
      else process.env.KICAD_CONFIG_HOME = saved;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
