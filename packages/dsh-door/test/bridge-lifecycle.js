import assert from 'node:assert/strict';
import { IdeBridge } from '../lib/bridge/runtime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const home = process.cwd();
function fixture(options = {}) {
  let now = 1;
  const bridge = new IdeBridge({ now: () => now, ...options });
  const state = { bridgeOwner: 'test', bridgeLease: Infinity, sessions: new Set(), agentsBySession: new Map(), respond() {} };
  let calls = 0;
  const pending = [];
  const unload = bridge.registerProvider({ id: 'test', name: 'Test', version: '1', capabilities: ['resource', 'action', 'workflow'].map(kind => ({
    id: `test.${kind}`, title: kind, kind, riskTier: 'read', effects: [], supportsCancellation: true, inputSchema: {},
  })), invoke(id, input, context) { calls++; return new Promise((resolve, reject) => pending.push({ id, input, context, resolve, reject })); } });
  const request = (id, kind = 'resource', input = {}) => ({ requestId: id, capabilityId: `test.${kind}`, input, context: { cwd: home } });
  return { bridge, state, pending, unload, request, get calls() { return calls; }, advance(ms) { now += ms; } };
}

// Resources reserve the same concurrency slots, and an active idempotency entry
// survives TTL sweeps until the provider actually settles.
{
  const f = fixture({ limits: { active: 1 } });
  const first = f.bridge.request('invoke', f.request('one'), f.state);
  await tick();
  f.advance(600001);
  const duplicate = f.bridge.request('invoke', f.request('one'), f.state);
  const overLimit = f.bridge.request('invoke', f.request('two'), f.state);
  const limitResult = await Promise.race([overLimit.then(() => 'accepted', error => error.code), tick().then(() => 'still-running')]);
  assert.equal(limitResult, -32045, 'A resource must reject promptly when the active budget is full');
  assert.equal(f.calls, 1);
  f.pending[0].resolve({ value: 'done' });
  assert.deepEqual(await first, { mode: 'immediate', value: { value: 'done' } });
  assert.deepEqual(await duplicate, await first);
  assert.equal(f.calls, 1);
  await f.bridge.dispose();
}

// Large immediate results can be returned once without retaining an unlimited
// promise cache. Keep a small tombstone so a retry cannot repeat the provider.
// Expiration also runs during idle periods, without a subsequent request.
{
  const f = fixture({ limits: { requestBytes: 1024 }, sweepIntervalMs: 5 });
  const first = f.bridge.request('invoke', f.request('large'), f.state);
  await tick(); f.pending[0].resolve({ text: 'x'.repeat(4000) });
  assert.equal((await first).value.text.length, 4000);
  assert(f.bridge.requestBytes() <= 1024);
  await assert.rejects(f.bridge.request('invoke', f.request('large'), f.state), error => error.code === -32047);
  assert.equal(f.calls, 1);
  f.advance(1800001);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.bridge.requests.size, 0); assert.equal(f.bridge.operations.size, 0);
  await f.bridge.dispose();
}

// Cancel/complete races emit one terminal event and do not release the active
// slot just because cancellation has been requested.
{
  const f = fixture({ limits: { active: 1 } });
  const first = await f.bridge.request('invoke', f.request('cancel', 'action'), f.state);
  await f.bridge.request('cancel', { operationId: first.operationId }, f.state);
  assert.equal(f.bridge.activeCount(), 1);
  await assert.rejects(f.bridge.request('invoke', f.request('next', 'action'), f.state), error => error.code === -32045);
  f.pending[0].resolve({ result: 'late completion' }); await tick();
  const result = await f.bridge.request('operation/get', { operationId: first.operationId }, f.state);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.events.filter(e => ['failed', 'completed', 'cancelled'].includes(e.type)).length, 1);
  assert.equal(f.bridge.activeCount(), 0);
  await f.bridge.dispose();
}

// Unload requests cancellation, but cannot publish a terminal state or release
// scope/slot ownership before an uncooperative provider actually settles.
{
  const f = fixture({ limits: { active: 1 } });
  const accepted = await f.bridge.request('invoke', f.request('one', 'workflow'), f.state);
  await tick();
  f.unload();
  assert.equal(f.pending[0].context.signal.aborted, true);
  assert.equal((await f.bridge.request('operation/get', { operationId: accepted.operationId }, f.state)).status, 'running');
  let idle = false;
  void f.bridge.idle(f.state).then(() => { idle = true; });
  await tick();
  assert.equal(idle, false);
  assert.equal(f.bridge.activeCount(), 1);
  f.pending[0].resolve({ late: true });
  await tick();
  assert.equal(idle, true);
  assert.equal(f.bridge.activeCount(), 0);
  const final = await f.bridge.request('operation/get', { operationId: accepted.operationId }, f.state);
  assert.equal(final.status, 'failed'); assert.equal(final.result.reason, 'provider-unloaded');
  assert.equal((await f.bridge.request('operation/get', { operationId: accepted.operationId }, f.state)).events.filter(e => ['failed', 'completed', 'cancelled'].includes(e.type)).length, 1);
  await f.bridge.dispose();
}

// Disconnect cancels immediate resources, while resumable operations continue.
{
  const f = fixture();
  const resource = f.bridge.request('invoke', f.request('r'), f.state);
  const workflow = await f.bridge.request('invoke', f.request('w', 'workflow'), f.state);
  await tick();
  f.bridge.detach(f.state);
  assert.equal(f.pending[0].context.signal.aborted, true);
  assert.equal(f.pending[1].context.signal.aborted, false);
  f.pending[0].resolve({ late: true });
  f.pending[1].resolve({ ok: true });
  await assert.rejects(resource);
  await tick();
  const next = { ...f.state, agentsBySession: new Map() };
  assert.equal((await f.bridge.request('operation/get', { operationId: workflow.operationId }, next)).status, 'completed');
  await f.bridge.dispose();
}
console.log('Bridge lifecycle: resource budget, active deduplication, actual settlement, unload and disconnect passed');
