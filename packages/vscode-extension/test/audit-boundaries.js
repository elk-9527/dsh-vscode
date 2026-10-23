'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { DshConnectionService } = require('../src/connection/service');
const { SkillFileStore } = require('../../dsh-bridge-sdk/lib/skill-files');
const { checkSchema } = require('../../dsh-bridge-sdk/lib/schema');

const tick = () => new Promise(resolve => setImmediate(resolve));
const pending = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

async function connections() {
  const ready = pending();
  let client;
  const service = new DshConnectionService({ makeClient: options => {
    client = new EventEmitter(); Object.assign(client, options, {
      async connect() { await ready.promise; client.isConnected = true; },
      close() { client.isConnected = false; },
    }); return client;
  } });
  try {
    const connecting = service.connect({ host: '127.0.0.1', port: 49123 });
    const outcome = connecting.then(() => 'connected', () => 'cancelled');
    service.disconnect(); ready.resolve();
    assert.equal(await outcome, 'cancelled', 'Disconnect must invalidate an unfinished connection');
    assert.equal(service.client, undefined);
    assert.equal(client.isConnected, false);
  } finally { service.dispose(); }

  const opened = [], waits = [];
  const multiple = new DshConnectionService({ makeClient: options => {
    const wait = pending(), fake = new EventEmitter(); waits.push(wait); opened.push(fake);
    Object.assign(fake, options, { async connect() { await wait.promise; fake.isConnected = true; }, close() { fake.isConnected = false; } });
    return fake;
  } });
  try {
    const first = multiple.connect({ host: '127.0.0.1', port: 49123 });
    const second = multiple.connect({ host: '127.0.0.1', port: 49124 });
    const third = multiple.connect({ host: '127.0.0.1', port: 49125 });
    waits[0].resolve(); await first; await tick();
    assert.equal(opened.length, 2, 'Only one replacement connection may start at a time');
    waits[1].resolve(); await second; await tick();
    assert.equal(opened.length, 3); waits[2].resolve(); await third;
    assert.deepEqual(opened.map(item => item.isConnected), [false, false, true]);
    assert.equal(multiple.client.port, 49125);
  } finally { for (const wait of waits) wait.resolve(); multiple.dispose(); }

  const attempts = [], gates = [];
  const racing = new DshConnectionService({ makeClient: options => {
    const gate = pending(), fake = new EventEmitter(); gates.push(gate); attempts.push(fake);
    Object.assign(fake, options, { async connect() { await gate.promise; fake.isConnected = true; }, close() { fake.isConnected = false; } }); return fake;
  } });
  try {
    const a = racing.connect({ host: '127.0.0.1', port: 49131 });
    const aFailure = assert.rejects(a, /target A failed/);
    const b = racing.connect({ host: '127.0.0.1', port: 49132 });
    const bOutcome = b.then(value => ({ value }), error => ({ error }));
    gates[0].reject(new Error('target A failed')); await aFailure; await tick();
    assert.equal(attempts.length, 2, 'A failed target must not prevent another target from attempting a connection');
    gates[1].resolve(); assert.equal((await bOutcome).value.port, 49132);
    racing.disconnect();
    const sameA = racing.connect({ host: '127.0.0.1', port: 49133 });
    const sameB = racing.connect({ host: '127.0.0.1', port: 49133 });
    assert.equal(attempts.length, 3); gates[2].resolve();
    assert.equal(await sameA, await sameB, 'Concurrent callers for one target share one handshake');
    racing.disconnect();
    const closingA = racing.connect({ host: '127.0.0.1', port: 49134 });
    const closingB = racing.connect({ host: '127.0.0.1', port: 49135 });
    const closing = Promise.allSettled([closingA, closingB]); racing.dispose(); gates[3].resolve();
    assert((await closing).every(result => result.status === 'rejected'));
    assert.equal(attempts.length, 4, 'A waiter must not create a connection after service shutdown');
    assert(attempts.every(fake => !fake.isConnected));
  } finally { gates.forEach(gate => gate.resolve()); racing.dispose(); }

  const reconnectGates = [], reconnectClients = [];
  const reconnect = new DshConnectionService({ makeClient: options => {
    const gate = pending(), fake = new EventEmitter(); reconnectGates.push(gate); reconnectClients.push(fake);
    Object.assign(fake, options, { async connect() { await gate.promise; fake.isConnected = true; }, close() { fake.isConnected = false; } }); return fake;
  } });
  try {
    const old = reconnect.connect({ host: '127.0.0.1', port: 49136 });
    const oldResult = assert.rejects(old, /连接已取消/); reconnect.disconnect();
    const fresh = reconnect.connect({ host: '127.0.0.1', port: 49136 });
    reconnectGates[0].resolve(); await oldResult; await tick();
    assert.equal(reconnectClients.length, 2, 'An explicit reconnect does not inherit a cancelled handshake from an older generation');
    reconnectGates[1].resolve(); assert.equal(await fresh, reconnectClients[1]);
  } finally { reconnectGates.forEach(gate => gate.resolve()); reconnect.dispose(); }

  const sessions = new DshConnectionService();
  const makeSessionClient = () => Object.assign(new EventEmitter(), { isConnected: true, starts: 0, closedSessions: [],
    async newSession() { return { sessionId: 'session-' + ++this.starts }; },
    async closeSession(id) { this.closedSessions.push(id); }, close() { this.isConnected = false; } });
  const oldSessionClient = makeSessionClient(), freshSessionClient = makeSessionClient(), reply = pending();
  sessions.client = oldSessionClient;
  oldSessionClient.newSession = async () => { await reply.promise; return { sessionId: 'old-session' }; };
  try {
    const late = sessions.sessionFor('review:fixture', 'fixture');
    const lateResult = assert.rejects(late, /销毁|变化/); await tick();
    assert.equal(oldSessionClient.listenerCount('update'), 1);
    sessions.disconnect(); sessions.client = freshSessionClient;
    assert.equal(oldSessionClient.listenerCount('update'), 0, 'Disconnect disposes sessions that are still opening');
    reply.resolve(); await lateResult;
    const fresh = await sessions.sessionFor('review:fixture', 'fixture');
    assert.equal(fresh.client, freshSessionClient, 'Late old replies cannot be cached by a replacement connection');
    assert.equal(fresh.sessionId, 'session-1');
    const shared = await Promise.all([sessions.sessionFor('review:other', 'other'), sessions.sessionFor('review:other', 'other')]);
    assert.equal(shared[0], shared[1]); assert.equal(freshSessionClient.starts, 2, 'Concurrent surface requests create one session');
    const beforeReplacement = sessions.sessionFor('review:other', 'third');
    const afterReplacement = sessions.sessionFor('review:other', 'fourth');
    await beforeReplacement; const final = await afterReplacement;
    assert.equal(final.cwd, 'fourth'); assert.deepEqual(freshSessionClient.closedSessions, ['session-2', 'session-3']);
    let invoked = false; sessions.client = oldSessionClient; oldSessionClient.isConnected = true;
    await assert.rejects(sessions.runSession(fresh, () => { invoked = true; }), /会话已变化/);
    assert.equal(invoked, false, 'Queued turns cannot execute on a session from another connection');
    sessions.client = freshSessionClient;
  } finally { reply.resolve(); sessions.dispose(); }
}

async function bridge(cwd) {
  const { IdeBridge } = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/bridge/runtime.js')));
  const runtime = new IdeBridge({ endpoint: { instanceId: 'test', matches: value => value === 'fixture', dispose() {} } });
  const a = { respond() {} }, b = { respond() {} };
  try {
    await runtime.request('auth', { instanceId: 'test', bootstrapToken: 'fixture', clientId: 'owner:part' }, a);
    await runtime.request('auth', { instanceId: 'test', bootstrapToken: 'fixture', clientId: 'owner' }, b);
    runtime.registerProvider({ id: 'fixture', name: 'Fixture', version: '1', capabilities: [
      { id: 'fixture.action', title: 'Read', kind: 'action', riskTier: 'read', effects: [] },
      { id: 'fixture.resource', title: 'Resource', kind: 'resource', riskTier: 'read', effects: [] },
    ], invoke: (_id, _input, context) => ({ trusted: context.workspaceTrusted, owner: context.clientId }) });
    const operation = await runtime.request('invoke', { requestId: 'read', capabilityId: 'fixture.action', context: { cwd, workspaceTrusted: false } }, a);
    await tick();
    const result = await runtime.request('operation/get', { operationId: operation.operationId }, a);
    assert.equal(result.result.trusted, false, 'Read operations must preserve workspace trust');
    const input = { capabilityId: 'fixture.resource', context: { cwd, workspaceTrusted: true } };
    const one = await runtime.request('invoke', { ...input, requestId: 'request' }, a);
    const two = await runtime.request('invoke', { ...input, requestId: 'part:request' }, b);
    assert.notEqual(one.value.owner, two.value.owner, 'Client and request IDs must not collide when containing colons');
  } finally { runtime.dispose(); }
}

function skills(cwd) {
  const context = { cwd, clientId: 'fixture', workspaceTrusted: true, userInitiated: true, approved: true };
  const store = new SkillFileStore({ roots: () => ({ project: path.join(cwd, 'skills') }) });
  const content = '---\nname: example\n---\nInstructions.\n';
  const created = store.preview({ action: 'create', name: 'example', scope: 'project', content }, context);
  assert.throws(() => store.commit(created.planId, { ...context, approved: 'false' }), /确认/, 'Approval must be the boolean true');
  store.commit(created.planId, context);
  for (let i = 0; i < 2; i++) {
    const plan = store.preview({ action: 'update', file: created.file, content: content + i }, context);
    store.commit(plan.planId, context);
  }
  const entry = store.trash(context)[0];
  const record = path.join(path.dirname(entry.trashFile), entry.id + '.json');
  const metadata = JSON.parse(fs.readFileSync(record, 'utf8')); metadata.time = 42;
  fs.writeFileSync(record, JSON.stringify(metadata));
  assert.doesNotThrow(() => store.trash(context), 'A damaged recovery record must not break all recovery entries');
  assert(!store.trash(context).some(item => item.id === entry.id));
}

(async () => {
  const failures = [];
  const fixtures = path.resolve(__dirname, '../../../build/test-boundaries'); fs.mkdirSync(fixtures, { recursive: true });
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(fixtures, 'dsh-boundaries-')));
  try {
    for (const [name, test] of [
      ['connection cancellation and replacement serialization', connections],
      ['bridge trust and request identity', () => bridge(cwd)],
      ['skill approval and recovery metadata', () => skills(cwd)],
      ['schema definition rejection', () => {
        for (const schema of [{ type: '' }, { properties: null }, { items: false }, { required: null }, { enum: null }, { maxItems: 1.5 }]) {
          assert.throws(() => checkSchema(schema, undefined, true), error => error.code === -32046, JSON.stringify(schema));
        }
        assert.doesNotThrow(() => checkSchema({ type: 'number', minimum: -10, maximum: -1 }, -5));
        assert.throws(() => checkSchema({ type: 'number', maximum: -1 }, 0), error => error.code === -32046);
      }],
    ]) {
      try { await test(); console.log('PASS ' + name); }
      catch (error) { failures.push(name); console.error('FAIL ' + name, error.message); }
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  assert.equal(failures.length, 0, failures.join(', '));
})().catch(error => { console.error(error); process.exitCode = 1; });
