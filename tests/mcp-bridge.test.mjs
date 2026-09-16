import test from 'node:test';
import assert from 'node:assert/strict';
import { McpBridge } from '../dist/mcp-bridge.js';

// Guards the 0.2.6 transport fix: @modelcontextprotocol/sdk >= 1.30 signs
// callTool as (params, resultSchema?, options?). Passing the timeout object
// as the second argument made protocol.js validate every tool response
// against a plain object and crash with
// "TypeError: v3Schema.safeParse is not a function" on every MCP mutation,
// while start/listTools (no callTool) kept working.

class StubClient {
  constructor() {
    this.seen = [];
  }

  async connect() {}

  async listTools() {
    return { tools: [{ name: 'batch_list_symbol_pins' }] };
  }

  async callTool(params, resultSchema, options) {
    this.seen.push({ params, resultSchema, options });
    return { content: [{ type: 'text', text: 'Device:R — 2 pin(s):' }] };
  }

  async close() {}
}

function bridgeWithStubClient(timeoutMs = 1234) {
  const bridge = new McpBridge({ command: 'node', args: [], callTimeoutMs: timeoutMs });
  bridge.client = new StubClient();
  bridge.tools.set('batch_list_symbol_pins', { name: 'batch_list_symbol_pins' });
  return bridge;
}

test('0.2.6: McpBridge forwards tool params verbatim as first callTool argument', async () => {
  const bridge = bridgeWithStubClient();
  const result = await bridge.call('batch_list_symbol_pins', { symbols: ['Device:R'] });
  assert.equal(result.isError, false);
  assert.equal(bridge.client.seen.length, 1);
  const [call] = bridge.client.seen;
  assert.deepEqual(call.params, { name: 'batch_list_symbol_pins', arguments: { symbols: ['Device:R'] } });
});

test('0.2.6: McpBridge passes timeout as callTool options (third argument)', async () => {
  const bridge = bridgeWithStubClient(1234);
  await bridge.call('batch_list_symbol_pins', { symbols: ['Device:R'] });
  const [call] = bridge.client.seen;
  assert.equal(call.resultSchema, undefined);
  assert.deepEqual(call.options, { timeout: 1234 });
});
