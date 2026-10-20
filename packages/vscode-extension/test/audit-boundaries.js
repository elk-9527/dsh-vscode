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
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

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
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boundaries-')));
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
