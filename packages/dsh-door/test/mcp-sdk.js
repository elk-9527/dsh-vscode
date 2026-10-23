import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const fromAcp = createRequire(fs.realpathSync(new URL('../node_modules/@deepseek-ai/dsh-acp/lib/index.js', import.meta.url)));
const dshMcpEntry = fromAcp.resolve('@deepseek-ai/dsh-mcp-client');
const fromDshMcp = createRequire(dshMcpEntry);
const { Client, StreamableHTTPClientTransport, specTypeSchemas } = fromDshMcp('@modelcontextprotocol/client');
const { StdioClientTransport } = fromDshMcp('@modelcontextprotocol/client/stdio');
assert.equal(typeof StreamableHTTPClientTransport, 'function'); assert.equal(typeof StdioClientTransport, 'function'); assert(specTypeSchemas);
// A protocol transport exercises the same resolved client used by DSH, without
// starting a model or loading credentials from an installed profile.
const seen = [];
const transport = {
  async start() {},
  async close() { this.onclose?.(); },
  async send(message) {
    seen.push(message.method);
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture', inputSchema: { type: 'object', properties: {} } }] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture result' }] };
    else throw new Error('Unexpected MCP request');
    queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
  },
};
const client = new Client({ name: 'dsh-compat-fixture', version: '1.0.0' });
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools[0].name, 'fixture');
  assert.equal((await client.callTool({ name: 'fixture', arguments: {} })).content[0].text, 'fixture result');
  assert(seen.includes('notifications/initialized'));
} finally { await client.close(); }
console.log('PASS DSH-resolved MCP client handshake, tool list/call and supported transport exports');
