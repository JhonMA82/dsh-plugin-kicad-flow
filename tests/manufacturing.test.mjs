import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePosCsv, toBomCsv, toCplCsv, bomRowsFromDesign, deriveGerberLayers } from '../dist/manufacturing.js';
import { parseErcJson, parseDrcJson } from '../dist/verification.js';

test('KiCad 10 position CSV is mapped to JLCPCB CPL with Y negation', () => {
  // KiCad 10 `kicad-cli pcb export pos` reports PosY = -boardY; the CPL
  // transform negates Y back to board coordinates (verified against KiCad
  // 10.0.6 output). Board height is deliberately NOT involved.
  const csv = 'Ref,Val,Package,PosX,PosY,Rot,Side\nR1,10k,R_0603,12.5,-7.0,90,front\n';
  const rows = parsePosCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Mid X'], 12.5);
  assert.equal(rows[0]['Mid Y'], 7);
  assert.equal(rows[0].Layer, 'top');
  assert.match(toCplCsv(rows), /R1,10k,R_0603,12\.5,7,90,top/);
  assert.match(toBomCsv([{ Designator: 'R1', Comment: '10k', Footprint: 'R_0603', Qty: 1, LCSC: 'C25804' }]), /C25804/);
});

test('CPL excludes artifacts and declared opt-outs, keeps board coordinates', () => {
  const csv = [
    'Ref,Val,Package,PosX,PosY,Rot,Side',
    'C1,100n,C_0603,5,-2.5,0,front',
    'R1,10k,R_0603,20,-8,180,back',
    '#PWR01,PWR_FLAG,,1,-1,0,front',
  ].join('\n');
  const rows = parsePosCsv(csv, { excludeRefs: ['C1'] });
  assert.deepEqual(rows.map((r) => r.Designator), ['R1']);
  assert.equal(rows[0]['Mid Y'], 8); // -(-8) = 8, board coordinate
  assert.equal(rows[0].Layer, 'bottom');
});

test('BOM rows group by value/footprint/LCSC and skip artifacts', () => {
  const design = {
    version: 1,
    project: { name: 'x' },
    components: [
      { ref: 'R1', symbol: 'Device:R', value: '10k', footprint: 'R_0603' },
      { ref: 'R2', symbol: 'Device:R', value: '10k', footprint: 'R_0603' },
      { ref: 'R3', symbol: 'Device:R', value: '1k', footprint: 'R_0603' },
      { ref: '#PWR01', symbol: 'power:PWR_FLAG', value: 'PWR_FLAG' },
      { ref: 'TP1', symbol: 'Connector:TestPoint', value: 'TP', footprint: 'TestPoint', excludeFromBom: true },
    ],
    nets: [],
  };
  const rows = bomRowsFromDesign(design);
  assert.equal(rows.length, 2);
  const r10k = rows.find((r) => r.Comment === '10k');
  assert.equal(r10k.Designator, 'R1,R2');
  assert.equal(r10k.Qty, 2);
  assert.ok(!rows.some((r) => r.Designator.includes('#PWR01')));
  assert.ok(!rows.some((r) => r.Designator.includes('TP1')));
});

test('gerber layer set derives from parsed board copper layers', () => {
  assert.deepEqual(deriveGerberLayers(['F.Cu', 'B.Cu']), ['F.Cu', 'F.Mask', 'F.SilkS', 'F.Paste', 'B.Cu', 'B.Mask', 'B.SilkS', 'Edge.Cuts']);
  assert.deepEqual(deriveGerberLayers(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']), ['F.Cu', 'F.Mask', 'F.SilkS', 'F.Paste', 'B.Cu', 'B.Mask', 'B.SilkS', 'In1.Cu', 'In2.Cu', 'Edge.Cuts']);
  // Empty copper list cannot happen from a parsed board; the fallback lives
  // in buildManufacturingPack, not in this pure derivation.
});

test('ERC parser keeps KiCad 10.0.x position-unit workaround', () => {
  const r = parseErcJson({
    kicad_version: '10.0.6', coordinate_units: 'mm',
    sheets: [{ violations: [{ severity: 'error', type: 'x', description: 'x', pos: { x: 1, y: 2 } }] }],
  });
  assert.equal(r.errors, 1);
  assert.deepEqual(r.violations[0].posMm, { x: 25.4, y: 50.8 });
});

test('DRC unconnected count is not double-counted when array and count coexist', () => {
  const r = parseDrcJson({ coordinate_units: 'mm', violations: [], unconnected_items: [{ type: 'u' }], unconnected_items_count: 1 });
  assert.equal(r.unconnected, 1);
});
