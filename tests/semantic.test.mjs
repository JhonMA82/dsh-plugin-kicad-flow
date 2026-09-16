import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticToolFailure } from '../dist/semantic.js';

test('detects batch component partial failures hidden in successful MCP envelopes', () => {
  const text = 'Added 0 component(s), 52 error(s).\n  ✗ R1 (Device:R): Library not found';
  assert.equal(semanticToolFailure('batch_add_components', text), text);
});

test('accepts clean batch component result', () => {
  assert.equal(semanticToolFailure('batch_add_components', 'Added 52 component(s), 0 error(s).'), undefined);
});

test('detects downstream label failures', () => {
  const text = 'Placed 0 label(s), 87 failed\n  ✗ U1/1: component not found';
  assert.equal(semanticToolFailure('batch_connect', text), text);
});

test('detects symbol preflight errors', () => {
  const text = 'Device:R — 2 pin(s)\n\nErrors:\n  BadLib:Foo: symbol not found';
  assert.equal(semanticToolFailure('batch_list_symbol_pins', text), text);
});
