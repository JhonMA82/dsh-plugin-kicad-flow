import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAndNormalizeIR } from '../dist/ir.js';
import { schematicPlacements, pcbPlacements, connectionMaps } from '../dist/layout.js';

const exampleUrl = new URL('../examples/rc-filter.ir.json', import.meta.url);

async function design() {
  const input = JSON.parse(await readFile(exampleUrl, 'utf8'));
  const result = validateAndNormalizeIR(input);
  assert.equal(result.ok, true);
  return result.design;
}

test('schematic placement is deterministic', async () => {
  const d = await design();
  assert.deepEqual(schematicPlacements(d), schematicPlacements(d));
  const refs = new Set(schematicPlacements(d).map((x) => x.ref));
  assert.equal(refs.size, d.components.length);
});

test('pcb placement stays within declared board', async () => {
  const d = await design();
  const placements = pcbPlacements(d);
  for (const p of placements) {
    assert.ok(p.x >= 0 && p.x <= d.board.widthMm, `${p.ref} x=${p.x}`);
    assert.ok(p.y >= 0 && p.y <= d.board.heightMm, `${p.ref} y=${p.y}`);
  }
});

test('connection maps batch pins by reference', async () => {
  const d = await design();
  const maps = connectionMaps(d);
  assert.equal(maps.local.J1['1'], 'VIN');
  assert.equal(maps.global.C1['2'], 'GND');
});
