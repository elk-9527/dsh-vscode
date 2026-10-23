'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DshConnectionService } = require('../src/connection/service');
const { findingLocation, repositorySnapshot } = require('../src/bridge/results');
const { ensureProcessAlive, queryWindows } = require('../src/bridge/process');
let created = 0;
class FakeClient extends EventEmitter {
  constructor(options) { super(); Object.assign(this, options); created++; }
  async connect() { await new Promise(resolve => setImmediate(resolve)); this.isConnected = true; }
  close() { this.isConnected = false; }
}
(async () => {
  const denied = () => { throw Object.assign(new Error(), { code: 'EPERM' }); };
  let queries = 0;
  await ensureProcessAlive(123, { platform: 'win32', kill: () => {}, query: async () => { queries++; return false; } });
  assert.equal(queries, 0, 'Successful existence probes do not launch a shell');
  await assert.rejects(ensureProcessAlive(123, { platform: 'win32', kill: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }, query: async () => { queries++; return true; } }));
  assert.equal(queries, 0, 'Missing processes cannot be accepted by a fallback query');
  await assert.rejects(ensureProcessAlive(123, { platform: 'win32', kill: denied, query: async () => { throw new Error('query timeout'); } }));
  await ensureProcessAlive(123, { platform: 'win32', kill: denied, query: async pid => pid === 123 });
  await assert.rejects(ensureProcessAlive(123, { platform: 'win32', kill: denied, query: async () => false }));
  await assert.rejects(ensureProcessAlive(123, { platform: 'linux', kill: denied, query: async () => true }));
  await assert.rejects(ensureProcessAlive(-1));
  if (process.platform === 'win32') { assert(await queryWindows(process.pid)); assert.equal(await queryWindows(2147483647), false); }
  const service = new DshConnectionService({ makeClient: options => new FakeClient(options) });
  const [a, b] = await Promise.all([service.connect({ host: '127.0.0.1', port: 49123 }), service.connect({ host: '127.0.0.1', port: 49123 })]);
  assert.equal(a, b); assert.equal(created, 1);
  const panel = service.acquire('panel'), tree = service.acquire('tree');
  panel.dispose(); assert(a.isConnected); assert.equal(service.consumers.size, 1);
  tree.dispose(); assert(a.isConnected);
  service.setStatus({ capabilities: {} }); assert.equal((await service.bridge.catalog()).protocolVersion, 0);
  a.isConnected = false; a.emit('close'); assert.equal(service.client, undefined);
  await service.connect({ host: '127.0.0.1', port: 49123 }); assert.equal(created, 2);
  service.dispose(); assert.equal(service.client, undefined);
  const { BridgeClient } = require('../src/bridge/client');
  const authClient = new EventEmitter(); let sent = 0;
  authClient.request = async () => { sent++; return {}; };
  const guarded = new BridgeClient({ client: authClient, status: { capabilities: { bridge: { protocolVersion: 1 } } } });
  const abort = new AbortController(); guarded.auth = async () => { abort.abort(); };
  await assert.rejects(guarded.request('invoke', {}, { beforeSend: () => { if (abort.signal.aborted) throw Object.assign(new Error('cancelled'), { code: -32800 }); } }), error => error.code === -32800);
  assert.equal(sent, 0, 'Cancellation during authentication prevents invoke');
  let trusted = true; guarded.auth = async force => { if (force) trusted = false; };
  authClient.request = async () => { sent++; throw Object.assign(new Error('expired'), { code: -32041 }); };
  await assert.rejects(guarded.request('invoke', {}, { beforeSend: () => { if (!trusted) throw Object.assign(new Error('restricted'), { code: -32044 }); } }), error => error.code === -32044);
  assert.equal(sent, 1, 'Trust is checked again after renewal, before a retried invoke'); guarded.dispose();
  const cwd = require('../../../tools/test-workspace.cjs').createFixture('bridge-result'); fs.writeFileSync(path.join(cwd, 'sample.txt'), 'a\nb\n');
  assert.equal(findingLocation(cwd, { file: 'sample.txt', startLine: 2 }).start, 1);
  assert.equal(findingLocation(cwd, { file: '../outside.txt', startLine: 1 }), undefined);
  assert.equal(findingLocation(cwd, { file: 'sample.txt', startLine: 100 }), undefined);
  assert.equal(findingLocation(cwd, { file: 'sample.txt', startLine: 1, endLine: 0 }), undefined);
  const snapshot = await repositorySnapshot(path.resolve(__dirname, '../../..')); assert.equal(snapshot.fingerprint.length, 64);
  console.log('Shared connection concurrency, view release, legacy fallback and diagnostic boundaries passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
