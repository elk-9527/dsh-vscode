import assert from 'node:assert/strict';
import { NdjsonBuffer, createOutboundRelay } from '../lib/frames.js';
import { gatePrompts, handleDoorPermission } from '../lib/index.js';
import { IdeBridge } from '../lib/bridge/runtime.js';

const encoder = new TextEncoder();
const tick = () => new Promise(resolve => setImmediate(resolve));

// Splitting every UTF-8 byte must preserve text, while a no-newline peer can
// never accumulate beyond the same raw frame budget.
{
  const frame = '{"text":"中文🙂"}\n';
  const parser = new NdjsonBuffer(64);
  const actual = [];
  for (const byte of encoder.encode(frame)) actual.push(...parser.push(Uint8Array.of(byte)));
  assert.deepEqual(actual, [frame]);
  assert.equal(parser.flush(), '');
  const small = new NdjsonBuffer(4);
  small.push(encoder.encode('1234'));
  assert.throws(() => small.push(encoder.encode('5')), /预算/);
  assert.throws(() => new NdjsonBuffer(4).push(encoder.encode('12345\n')), /预算/);
  assert.deepEqual(new NdjsonBuffer(4).push(encoder.encode('1\n2\n')), ['1\n', '2\n']);
}

// Kernel writes await the actual sink write. Side-channel notifications share
// the budget, inclusive of the currently blocked write, and disconnect visibly.
{
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let closed = 0;
  const state = { replies: new Map(), closeTransport() { closed++; } };
  const relay = createOutboundRelay(new WritableStream({ async write() { await barrier; } }), state, () => {}, { maxFrameBytes: 128, maxQueueBytes: 64 });
  const writer = relay.getWriter();
  let written = false;
  const writing = writer.write(encoder.encode('{"id":1}\n')).then(() => { written = true; });
  await tick(); assert.equal(written, false);
  const one = state.respond({ id: 2, result: 'x'.repeat(16) });
  const two = state.respond({ id: 3, result: 'x'.repeat(16) });
  await assert.rejects(two, /预算/);
  assert.equal(closed, 1);
  assert.equal(state.outboundBudget().closed, true);
  release(); await writing; await assert.rejects(one);
  await assert.rejects(writer.close());
}

// Auth and execution registration remain in input order, but a hung resource
// cannot prevent a same-chunk control/status request or an ACP permission reply.
{
  const bridge = new IdeBridge({ endpoint: { instanceId: 'one', matches: value => value === 'secret', dispose() {} } });
  let release;
  bridge.registerProvider({ id: 'slow', name: 'Slow', version: '1', capabilities: [{ id: 'slow.read', title: 'Read', kind: 'resource', riskTier: 'read', effects: [], inputSchema: {} }],
    invoke() { return new Promise(resolve => { release = resolve; }); } });
  const replies = [];
  const state = { bridge, sessions: new Set(), pending: new Map(), respond: frame => replies.push(frame), modelRoute: {} };
  const input = [
    { id: 1, method: 'dsh-door/bridge/auth', params: { instanceId: 'one', bootstrapToken: 'secret', clientId: 'client' } },
    { id: 2, method: 'dsh-door/bridge/invoke', params: { requestId: 'r', capabilityId: 'slow.read', context: { cwd: process.cwd() } } },
    { id: 3, method: 'dsh-door/bridge/catalog' },
    { id: 4, method: 'dsh-door/status' },
    { id: 5, result: { outcome: 'approved' } },
  ].map(frame => JSON.stringify(frame)).join('\n') + '\n';
  let sourceController;
  const source = new ReadableStream({ start(controller) { sourceController = controller; controller.enqueue(encoder.encode(input)); } });
  const reader = gatePrompts(source, state, () => {}).getReader();
  const forwarded = await reader.read();
  assert.equal(JSON.parse(new TextDecoder().decode(forwarded.value)).id, 5);
  await tick();
  assert.deepEqual(replies.map(frame => frame.id).sort(), [1, 3, 4]);
  assert.equal(bridge.activeCount(), 1);
  release({ ok: true }); await tick();
  assert.deepEqual(replies.find(frame => frame.id === 2).result, { mode: 'immediate', value: { ok: true } });
  sourceController.close(); await reader.read(); await bridge.dispose();
}

// The shared kernel handler is unreachable for another connection's session.
{
  const replies = []; const calls = [];
  const handler = { async get(id) { calls.push(['get', id]); return {}; }, async set(id, value) { calls.push(['set', id, value]); return {}; } };
  const state = { sessions: new Set(['a']), permissionHandler: handler, respond: frame => replies.push(frame) };
  const set = id => JSON.stringify({ id: 1, method: 'dsh-door/permission/set', params: { id, value: 'write' } });
  await handleDoorPermission(set('b'), state, () => {});
  assert.equal(replies.at(-1).error.code, -32003); assert.equal(calls.length, 0);
  await handleDoorPermission(set('a'), state, () => {});
  assert.deepEqual(calls, [['set', 'a', 'write']]);
  state.sessions.delete('a');
  await handleDoorPermission(set('a'), state, () => {});
  assert.equal(replies.at(-1).error.code, -32003); assert.equal(calls.length, 1);
}
console.log('Transport: split UTF-8, raw/queue budgets, backpressure, nonblocking control frames and permission ownership passed');
