import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKiCadNetlistXml, reconcileDesignToSnapshot } from '../dist/reconciliation.js';

const XML = `<?xml version="1.0"?>
<export>
  <components>
    <comp ref="U1"></comp>
    <comp ref="R1"></comp>
  </components>
  <nets>
    <net code="1" name="/SIG">
      <node ref="U1" pin="9" pinfunction="PB0"/>
      <node ref="R1" pin="1" pinfunction="1"/>
    </net>
    <net code="2" name="GND">
      <node ref="U1" pin="14" pinfunction="GND"/>
    </net>
    <net code="3" name="unconnected-(R1-Pad2)">
      <node ref="R1" pin="2" pinfunction="2"/>
    </net>
  </nets>
</export>`;

test('parses local KiCad net names and pin functions', () => {
  const snapshot = parseKiCadNetlistXml(XML);
  assert.deepEqual(snapshot.componentRefs, ['U1', 'R1']);
  assert.equal(snapshot.nets[0].rawName, '/SIG');
  assert.equal(snapshot.nets[0].name, 'SIG');
  assert.equal(snapshot.nets[0].nodes[0].pinFunction, 'PB0');
});

test('reconciliation compares IR pin names against pinfunction and allows declared no-connects', () => {
  const design = {
    version: 1,
    project: { name: 'reconcile' },
    components: [
      { ref: 'U1', symbol: 'MCU:U' },
      { ref: 'R1', symbol: 'Device:R', noConnectPins: ['2'] },
    ],
    nets: [
      { name: 'SIG', pins: [{ ref: 'U1', pin: 'PB0' }, { ref: 'R1', pin: '1' }] },
      { name: 'GND', global: true, pins: [{ ref: 'U1', pin: 'GND' }] },
    ],
  };
  const report = reconcileDesignToSnapshot(design, parseKiCadNetlistXml(XML));
  assert.equal(report.ok, true);
  assert.equal(report.matchedNets, 2);
  assert.equal(report.allowedNoConnect.length, 1);
  assert.equal(report.unexpectedUnconnected.length, 0);
});

test('reconciliation rejects duplicate references and extra endpoints', () => {
  const snapshot = parseKiCadNetlistXml(XML);
  snapshot.componentRefs.push('R1');
  snapshot.nets[0].nodes.push({ ref: 'U1', pin: '10', pinFunction: 'PB1' });
  const design = {
    version: 1,
    project: { name: 'bad' },
    components: [{ ref: 'U1', symbol: 'MCU:U' }, { ref: 'R1', symbol: 'Device:R', noConnectPins: ['2'] }],
    nets: [{ name: 'SIG', pins: [{ ref: 'U1', pin: 'PB0' }, { ref: 'R1', pin: '1' }] }, { name: 'GND', pins: [{ ref: 'U1', pin: 'GND' }] }],
  };
  const report = reconcileDesignToSnapshot(design, snapshot);
  assert.equal(report.ok, false);
  assert.deepEqual(report.duplicateReferences, ['R1']);
  assert.equal(report.netIssues.find((x) => x.name === 'SIG').unexpectedEndpoints.length, 1);
});
