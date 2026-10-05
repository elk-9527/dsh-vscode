import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdeBridge } from '../lib/bridge/runtime.js';
import { checkSchema, jsonValue } from '../lib/bridge/protocol.js';
import { createEndpoint } from '../lib/bridge/endpoint.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
const endpoint = createEndpoint(49123, home);
const record = JSON.parse(fs.readFileSync(path.join(home, 'run/dsh-acp-door/49123.json')));
let now = Date.now();
const bridge = new IdeBridge({ endpoint, now: () => now });
const events = [];
function state() { return { sessions: new Set(['s1']), agentsBySession: new Map([['s1', { id: 's1', session: { header: { cwd: home } } }]]), respond: frame => events.push(frame) }; }
const a = state(), b = state(); let calls = 0; let complete;
const descriptor = { id: 'test.run', title: '测试运行', kind: 'action', riskTier: 'execute', effects: ['workspace.read'], requiresSession: true,
  supportsCancellation: true, inputSchema: { type: 'object', properties: { label: { type: 'string', maxLength: 5 } }, additionalProperties: false } };
const dispose = bridge.registerProvider({ id: 'test', name: '测试', version: '1.0.0', capabilities: [descriptor], invoke: async (_id, _input, context) => {
  calls++; context.emit({ type: 'progress', payload: { message: '运行中' } });
  return new Promise(resolve => { complete = resolve; context.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }); });
} });
const request = { requestId: 'req1', capabilityId: 'test.run', input: { label: 'test' }, context: { cwd: home, sessionId: 's1', workspaceTrusted: true, userInitiated: true } };
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
try {
  assert.equal((await bridge.request('catalog', {}, a)).capabilities.length, 1);
  await rejected(bridge.request('invoke', request, a), -32041);
  await rejected(bridge.request('auth', { instanceId: endpoint.instanceId, bootstrapToken: 'wrong', clientId: 'a' }, a), -32042);
  await bridge.request('auth', { instanceId: endpoint.instanceId, bootstrapToken: record.bootstrapToken, clientId: 'a' }, a);
  await bridge.request('auth', { instanceId: endpoint.instanceId, bootstrapToken: record.bootstrapToken, clientId: 'b' }, b);
  await rejected(bridge.request('invoke', { ...request, context: { ...request.context, workspaceTrusted: false } }, a), -32044);
  await rejected(bridge.request('invoke', { ...request, context: { ...request.context, sessionId: 'other' } }, a), -32046);
  await rejected(bridge.request('invoke', { ...request, input: { label: 'toolong' } }, a), -32046);
  const operation = await bridge.request('invoke', request, a);
  const repeated = await bridge.request('invoke', request, a);
  assert.equal(operation.operationId, repeated.operationId); assert.equal(calls, 1);
  await rejected(bridge.request('invoke', { ...request, input: { label: 'new' } }, a), -32046);
  await rejected(bridge.request('operation/get', { operationId: operation.operationId }, b), -32047);
  assert.equal(events.filter(e => e.method?.endsWith('/event')).length, 2);
  const c = state(); bridge.detach(a);
  await bridge.request('auth', { instanceId: endpoint.instanceId, bootstrapToken: record.bootstrapToken, clientId: 'a' }, c);
  complete({ findings: [] }); await new Promise(resolve => setImmediate(resolve));
  const restored = await bridge.request('operation/get', { operationId: operation.operationId }, c);
  assert.equal(restored.status, 'completed'); assert.deepEqual(restored.result, { findings: [] });
  assert.equal((await bridge.request('cancel', { operationId: operation.operationId }, c)).status, 'completed');
  const second = await bridge.request('invoke', { ...request, requestId: 'req2' }, c);
  await bridge.request('cancel', { operationId: second.operationId }, c);
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await bridge.request('operation/get', { operationId: second.operationId }, c); assert.equal(cancelled.status, 'cancelled');
  assert.equal((await bridge.request('cancel', { operationId: second.operationId }, c)).status, 'cancelled');
  const third = await bridge.request('invoke', { ...request, requestId: 'req3' }, c); dispose();
  assert.equal((await bridge.request('operation/get', { operationId: third.operationId }, c)).result.reason, 'provider-unloaded');
  now += 900001; await rejected(bridge.request('operation/get', { operationId: third.operationId }, c), -32041);
  assert.equal((await bridge.request('catalog', {}, c)).capabilities.length, 0);
  const cycle = {}; cycle.self = cycle; assert.throws(() => jsonValue(cycle), error => error.code === -32046);
  assert.throws(() => jsonValue('x'.repeat(1024 * 1024)), error => error.code === -32049);
  assert.throws(() => checkSchema({ type: 'string', pattern: '*' }, undefined, true), error => error.code === -32046);
  assert.throws(() => bridge.registerProvider({ id: 'bad', name: 'bad', version: '1', capabilities: [{ ...descriptor, riskTier: 'unknown' }], invoke() {} }));
  assert(!JSON.stringify(bridge.catalog()).includes(record.bootstrapToken));
  console.log('Bridge: auth, isolation, schema, idempotency, reconnect, cancellation, unloading, expiry and redaction passed');
} finally { bridge.dispose(); assert(!fs.existsSync(path.join(home, 'run/dsh-acp-door/49123.json'))); }
