'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { createFixture } = require('../../../tools/test-workspace.cjs');
const { HistorySummaryCache, CACHE_TTL } = require('../src/panel/history-cache');
const { historyOptions } = require('../src/dsh/history-query');
const root = createFixture('history-loading');
const originalLoad = Module._load;
let DshPanelView;
try {
  Module._load = function (name, ...args) { return name === 'vscode' ? { workspace: { isTrusted: true } } : originalLoad.call(this, name, ...args); };
  ({ DshPanelView } = require('../src/panel/view'));
} finally { Module._load = originalLoad; }
function storage() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => values.set(key, structuredClone(value)) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function panel(client) {
  const messages = [], state = storage();
  return Object.assign(Object.create(DshPanelView.prototype), {
    client, workspaceState: state, messages, address: { host: '127.0.0.1', port: 49123 }, cwd: root,
    config() { return this.address; }, workdir() { return this.cwd; }, log() {},
    post: message => messages.push(message), errText: error => error.message, historyErrorText: error => error.message,
  });
}
const options = historyOptions({ limit: 30 });
const page = (title, offset = 0) => ({ sessions: [{ id: `session-${offset}`, title, cwd: root }], total: 1200, offset, nextOffset: offset + 30,
  archiveStateKnown: true, archiveSupported: true, archiveRevision: 'a'.repeat(64) });
(async () => {
  const calls = [];
  let operation = async () => page('Cached title');
  const client = { isConnected: true, listHistory: params => { calls.push(params); return operation(params); } };
  const view = panel(client);
  await view.readHistory('list', undefined, options);
  let pending = deferred(); operation = () => pending.promise;
  let work = view.sendHistoryList({ limit: 30, requestId: 1 });
  assert.equal(view.messages.length, 1, 'Render cached page before the live query settles');
  assert.equal(view.messages[0].sessions[0].title, 'Cached title');
  assert.equal(view.messages[0].refreshing, true);
  assert.equal(view.messages[0].requestId, 1);
  assert(view.messages[0].limitation.includes('后台刷新当前页'));
  assert.equal(calls.length, 2, 'Only the requested page is refreshed');
  pending.resolve(page('Fresh title')); await work;
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[1].via, 'door');
  assert.equal(view.messages[1].refreshing, undefined);
  assert.equal(view.messages[1].sessions[0].title, 'Fresh title');

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, offset: 30, requestId: 2 });
  assert.equal(view.messages.length, 0, 'Do not reuse another page as this page');
  assert.equal(calls.at(-1).offset, 30); assert.equal(calls.at(-1).limit, 30);
  pending.resolve(page('Second page', 30)); await work;
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].offset, 30);
  assert.equal(calls.length, 3, 'Do not prefetch page three or the rest of the archive');

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, requestId: 3 });
  pending.reject(new Error('Title service failed')); await work;
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[1].sessions[0].title, 'Fresh title');
  assert.equal(view.messages[1].refreshError, 'Title service failed');
  assert.equal(view.messages[1].error, undefined, 'Refresh failure keeps the readable cache');
  assert(!view.messages[1].refreshing);

  view.messages.length = 0;
  const old = deferred(), latest = deferred();
  operation = params => params.offset ? latest.promise : old.promise;
  const stale = view.sendHistoryList({ limit: 30, requestId: 4 });
  const current = view.sendHistoryList({ limit: 30, offset: 30, requestId: 5 });
  const beforeLate = view.messages.length;
  old.resolve(page('Late obsolete result')); await stale;
  assert.equal(view.messages.length, beforeLate, 'Late response from a cancelled page cannot overwrite the new page');
  latest.resolve(page('Latest second page', 30)); await current;
  assert.equal(view.messages.at(-1).requestId, 5);

  view.messages.length = 0; pending = deferred(); operation = () => pending.promise;
  work = view.sendHistoryList({ limit: 30, query: 'older needle', requestId: 6 });
  assert.equal(view.messages.length, 0, 'Search cache is isolated from the normal listing');
  assert.equal(calls.at(-1).query, 'older needle');
  pending.resolve({ sessions: [{ id: 'old-match', title: 'Older needle' }], total: 1, offset: 0 }); await work;
  assert.equal(view.messages.at(-1).sessions[0].id, 'old-match');

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, projectOnly: true, requestId: 7 });
  assert.equal(view.messages.length, 0, 'Project cache is isolated from all workspaces');
  assert.equal(calls.at(-1).cwd, root);
  pending.resolve(page('Project title')); await work;
  assert.equal(view.messages.at(-1).sessions[0].title, 'Project title');

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, requestId: 8 });
  assert.equal(view.messages.length, 1);
  pending.resolve({ sessions: [], total: 0, offset: 0 }); await work;
  assert.equal(view.messages.at(-1).sessions.length, 0, 'Refresh removes records deleted since the cached listing');

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, requestId: 9 });
  view.cwd = path.join(root, 'other');
  const beforeCwdChange = view.messages.length;
  pending.resolve(page('Wrong workspace')); await work;
  assert.equal(view.messages.length, beforeCwdChange, 'Ignore a response after changing workspaces');
  view.cwd = root;

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, requestId: 10 });
  view.address.port++;
  const beforeSourceChange = view.messages.length;
  pending.resolve(page('Wrong source')); await work;
  assert.equal(view.messages.length, beforeSourceChange, 'Ignore a response after changing kernel sources');

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, requestId: 11 });
  assert.equal(view.messages.length, 0, 'A new kernel must not display the previous source cache');
  pending.reject(new Error('No cached page')); await work;
  assert.equal(view.messages.length, 1); assert.equal(view.messages[0].error, 'No cached page');

  let now = Date.now();
  view.historyCache = new HistorySummaryCache(storage(), { now: () => now });
  const context = view.historyCacheContext();
  await context.cache.put(context.source, options, page('Expired'));
  now += CACHE_TTL + 1; view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, requestId: 12 });
  assert.equal(view.messages.length, 0, 'Expired cache is not displayed');
  pending.resolve(page('Renewed')); await work;

  view.messages.length = 0; pending = deferred();
  work = view.sendHistoryList({ limit: 30, requestId: 13 });
  view.disposed = true;
  const beforeDispose = view.messages.length;
  pending.resolve(page('After dispose')); await work;
  assert.equal(view.messages.length, beforeDispose, 'Closed panels receive no background refresh');

  const { createSessionQueryHistory } = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/kernel/history.js')));
  const titleBatches = []; let fullReads = 0;
  const handler = createSessionQueryHistory({
    listSessions: async () => Array.from({ length: 1200 }, (_, i) => ({ header: { id: `session-${i}`, cwd: root } })),
    readTitleSnapshots: async ids => {
      titleBatches.push(ids);
      return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: { id, cwd: root }, title: { title: `Title ${id}` } } }));
    },
    readSession: async () => { fullReads++; throw new Error('Full transcript must stay lazy'); },
  });
  const first = await handler.list({ limit: 30 });
  assert.equal(first.total, 1200); assert.equal(first.sessions.length, 30); assert.equal(first.nextOffset, 30);
  assert.deepEqual(titleBatches[0], Array.from({ length: 30 }, (_, i) => `session-${i}`));
  assert.equal(titleBatches.length, 1); assert.equal(fullReads, 0);
  await handler.list({ limit: 30, offset: 30 });
  assert.deepEqual(titleBatches[1], Array.from({ length: 30 }, (_, i) => `session-${i + 30}`));
  assert.equal(titleBatches.length, 2); assert.equal(fullReads, 0);
  const found = await handler.list({ limit: 30, query: 'Title session-1199' });
  assert.equal(found.sessions[0].id, 'session-1199', 'Search still finds records beyond the pages visited');
  console.log('PASS current-page-only titles, cache before slow refresh, scope isolation, deletion, failure, cancellation, expiry, disposal and global search');
})().catch(error => { console.error(error); process.exitCode = 1; });
