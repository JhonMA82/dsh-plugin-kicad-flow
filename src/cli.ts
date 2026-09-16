#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { validateAndNormalizeIR } from './ir.js';
import { connectionMaps, pcbPlacements, schematicPlacements } from './layout.js';

function usage(): never {
  console.error(`Usage:
  kicad-flow validate <design.json>
  kicad-flow normalize <design.json> [output.json]
  kicad-flow preview <design.json>`);
  process.exit(2);
}

const [, , command, input, output] = process.argv;
if (!command || !input) usage();
const path = resolve(input);
const raw = JSON.parse(await fs.readFile(path, 'utf8'));
const result = validateAndNormalizeIR(raw);

if (command === 'validate') {
  console.log(JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings }, null, 2));
  process.exit(result.ok ? 0 : 1);
}
if (!result.ok || !result.design) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
if (command === 'normalize') {
  const text = JSON.stringify(result.design, null, 2) + '\n';
  if (output) await fs.writeFile(resolve(output), text, 'utf8');
  else process.stdout.write(text);
  process.exit(0);
}
if (command === 'preview') {
  console.log(JSON.stringify({
    design: result.design,
    schematicPlacements: schematicPlacements(result.design),
    pcbPlacements: pcbPlacements(result.design),
    connections: connectionMaps(result.design),
  }, null, 2));
  process.exit(0);
}
usage();
