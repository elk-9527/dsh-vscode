'use strict';
const assert = require('node:assert/strict'), Module = require('node:module'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createFixture } = require('../../../tools/test-workspace.cjs');
const { HistorySummaryCache, CACHE_KEY } = require('../src/panel/history-cache');
const root = createFixture('history-sync');
const previousLoad = Module._load;
let DshPanelView;
try {
  Module._load = function (name, ...args) { return name === 'vscode' ? { workspace: { isTrusted: true } } : previousLoad.call(this, name, ...args); };
  ({ DshPanelView } = require('../src/panel/view'));
} finally { Module._load = previousLoad; }
function storage() { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => values.set(key, structuredClone(value)) }; }
function panel(client, state = storage()) {
  const messages = [];
  return Object.assign(Object.create(DshPanelView.prototype), {
    client, messages, workspaceState: state, config: () => ({ host: '127.0.0.1', port: 49123 }), workdir: () => root,
    post: message => messages.push(message), log() {}, errText: error => error.message, historyErrorText: error => error.message,
  });
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
(async () => {
  const { createSessionQueryHistory } = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/kernel/history.js')));
  const headers = ['one', 'two', 'three'].map(id => ({ id, cwd: root }));
  const registry = { archivedSessionIds: ['three'],
    async archiveSession(id) { if (id === 'busy') throw Object.assign(new Error('busy'), { name: 'WorkspaceActiveSessionError' }); this.archivedSessionIds = [...new Set([...this.archivedSessionIds, id])]; },
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id); } };
  const handler = createSessionQueryHistory({ listSessions: async () => headers.map(header => ({ header })),
    readTitleSnapshots: async ids => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: headers.find(header => header.id === id), title: { title: id } } })),
    readSession: async id => ({ session: headers.find(header => header.id === id), events: [] }),
  }, () => {}, { getWorkspaceRegistry: () => registry });
  const clients = [];
  function client() {
    const transport = Object.assign(new EventEmitter(), { isConnected: true, stateReads: 0,
      listHistory: params => handler.list(params),
      async historyState() { this.stateReads++; return handler.state(); },
      async archiveHistory(id, archived) { const result = await handler.archive(id, archived); clients.forEach(item => item.emit('notification', 'dsh-door/history-changed', { archiveRevision: result.archiveRevision })); return result; },
    });
    clients.push(transport); return transport;
  }
  const first = panel(client()), second = panel(client());
  await first.sendHistoryList({ limit: 30, requestId: 1 }); await second.sendHistoryList({ limit: 30, requestId: 1 });
  assert.equal(first.messages.at(-1).total, 2); assert.equal(first.messages.at(-1).archiveSupported, true);
  assert.deepEqual(first.messages.at(-1).sessions.map(item => item.id), ['one', 'two']);
  const state = first.workspaceState;
  const oldRevision = first.historyArchiveRevision;
  await second.archiveHistory({ id: 'one', archived: true, requestId: 'archive:1' }); await settle();
  assert.equal(second.messages.at(-1).type, 'historyArchiveResult'); assert.equal(second.messages.at(-1).success, true);
  assert(first.messages.some(message => message.type === 'historyChanged'), 'Archive changes on another surface invalidate and notify the first panel');
  assert.notEqual(first.historyArchiveRevision, oldRevision);
  assert.equal(first.historyCacheContext().cache.get(first.historyCacheContext().source, { limit: 30 }), undefined);
  assert(!second.messages.some(message => message.type === 'historyChanged'), 'Own archive completion avoids a duplicate list refresh');
  first.messages.length = 0;
  await first.sendHistoryList({ limit: 30, requestId: 2 });
  assert.equal(first.messages.length, 1); assert.equal(first.messages[0].total, 1);
  assert.equal(first.messages[0].sessions[0].id, 'two');
  await first.sendHistoryList({ limit: 30, archived: true, requestId: 3 });
  assert.equal(first.messages.at(-1).total, 2); assert(first.messages.at(-1).sessions.every(card => card.archived));
  const context = first.historyCacheContext();
  assert.equal(context.cache.get(context.source, { limit: 30 }).total, 1);
  assert.equal(context.cache.get(context.source, { limit: 30, archived: true }).total, 2);
  first.messages.length = 0;
  await first.sendHistoryList({ limit: 30, archived: true, refresh: true, requestId: 4 });
  assert.equal(first.messages.length, 1); assert.equal(first.messages[0].via, 'door', 'Manual sync bypasses cached archive state');
  await second.archiveHistory({ id: 'one', archived: false, requestId: 'restore:1' }); await settle();
  assert(!registry.archivedSessionIds.includes('one'));
  await first.sendHistoryList({ limit: 30, requestId: 5 });
  assert.equal(first.messages.at(-1).total, 2);
  await second.archiveHistory({ id: 'busy', archived: true, requestId: 'busy:1' });
  assert.equal(second.messages.at(-1).success, false); assert(second.messages.at(-1).error.includes('运行中的任务'));
  assert(!registry.archivedSessionIds.includes('busy'));

  await first.sendHistoryList({ limit: 30, requestId: 6 });
  first.client.off('notification', first.historyNotificationListener);
  await handler.archive('one', true); // Simulate changes while the panel was disconnected.
  const reloaded = panel(client(), state);
  await reloaded.sendHistoryList({ limit: 30, requestId: 7 });
  assert.equal(reloaded.client.stateReads, 1, 'Validate persisted archive revision before showing cached rows after reconnect');
  assert.equal(reloaded.messages.length, 1, 'Do not flash a cached row archived while disconnected');
  assert.equal(reloaded.messages[0].sessions[0].id, 'two');
  assert.equal(reloaded.client.listenerCount('notification'), 1);
  reloaded.observeHistory(reloaded.client); assert.equal(reloaded.client.listenerCount('notification'), 1);
  const replacement = client(); reloaded.observeHistory(replacement);
  assert.equal(reloaded.client.listenerCount('notification'), 0);
  assert.equal(replacement.listenerCount('notification'), 1);

  const oldState = storage(), source = context.source;
  await oldState.update(CACHE_KEY, { version: 1, entries: [{ key: JSON.stringify([source, { limit: 30, offset: 0, query: '', cwd: '' }]), at: Date.now(), result: { sessions: [{ id: 'old-unfiltered-cache' }] } }] });
  assert.equal(new HistorySummaryCache(oldState).get(source, { limit: 30 }), undefined, 'Pre-sync caches cannot reintroduce archived records');
  const unknown = panel(client()), unknownScope = unknown.historyCacheContext();
  await unknownScope.cache.put(unknownScope.source, { limit: 30 }, { sessions: [{ id: 'unfiltered-old-server' }], total: 1200, offset: 0, archiveStateKnown: false });
  await unknown.sendHistoryList({ limit: 30, requestId: 8 });
  assert.equal(unknown.messages.length, 1, 'Connected panels never flash cache whose archive state was unknown');
  assert.equal(unknown.messages[0].via, 'door');
  console.log('PASS shared DSH archive state, cross-panel invalidation, own-write deduplication, scope isolation, force sync, active-session refusal and reconnect cache validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
