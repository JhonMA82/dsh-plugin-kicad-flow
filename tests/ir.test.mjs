import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAndNormalizeIR } from '../dist/ir.js';

const exampleUrl = new URL('../examples/rc-filter.ir.json', import.meta.url);

test('rc-filter example validates and normalizes', async () => {
  const input = JSON.parse(await readFile(exampleUrl, 'utf8'));
  const result = validateAndNormalizeIR(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.design?.version, 1);
  assert.equal(result.design?.project.name, 'rc-filter-demo');
  assert.equal(result.design?.components.length, 4);
  assert.equal(result.design?.board?.widthMm, 50);
});

test('duplicate pin ownership is rejected', () => {
  const input = {
    version: 1,
    project: { name: 'bad' },
    components: [
      { ref: 'R1', symbol: 'Device:R' },
      { ref: 'R2', symbol: 'Device:R' },
    ],
    nets: [
      { name: 'A', pins: [{ ref: 'R1', pin: '1' }] },
      { name: 'B', pins: [{ ref: 'R1', pin: '1' }, { ref: 'R2', pin: '1' }] },
    ],
  };
  const result = validateAndNormalizeIR(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes('assigned to both')));
});
