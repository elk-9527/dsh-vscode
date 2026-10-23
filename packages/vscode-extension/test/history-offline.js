'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const history = require('../src/dsh/sessions');
const { HistorySummaryCache, CACHE_TTL } = require('../src/panel/history-cache');
const fixtures = path.resolve(__dirname, '../../../build/test-history-offline'); fs.mkdirSync(fixtures, { recursive: true });
const root = fs.mkdtempSync(path.join(fixtures, 'history-')), sessions = path.join(root, 'sessions');
const savedEnv = process.env.DSH_HOME; process.env.DSH_HOME = root;
const vscode = { workspace: { isTrusted: true } };
const originalLoad = Module._load;
Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };
const { DshPanelView } = require('../src/panel/view'); Module._load = originalLoad;
function store() { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => values.set(key, structuredClone(value)) }; }
function panel(state, client) { return Object.assign(Object.create(DshPanelView.prototype), { workspaceState: state, client, config: () => ({ host: '127.0.0.1', port: 49123 }), errText: error => error.message, log() {} }); }

(async () => { try {
  const modern = path.join(sessions, 'group', 'modern'); fs.mkdirSync(modern, { recursive: true });
  fs.writeFileSync(path.join(modern, 'session.v4.jsonl.zstd'), 'format owned by the kernel');
  const door = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/sessions.js')));
  for (const reader of [history, door]) {
    const result = await reader.listSessionsAsync(sessions); assert.deepEqual(result.sessions, []); assert.equal(result.unsupported, 1); assert(result.limited);
    await assert.rejects(reader.getSessionAsync(sessions, 'modern'), error => error.code === 'HISTORY_FORMAT_UNSUPPORTED');
    assert.equal(reader.listSessions(sessions).unsupported, 1);
    assert.throws(() => reader.getSession(sessions, 'modern'), error => error.code === 'HISTORY_FORMAT_UNSUPPORTED');
  }
  const legacy = path.join(sessions, 'group', 'legacy'); fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(JSON.stringify({ type: 'session', id: 'legacy', cwd: root, createdAt: 1 }) + '\n'));
  const mixed = await history.listSessionsAsync(sessions); assert.equal(mixed.sessions[0].id, 'legacy'); assert.equal(mixed.unsupported, 1);
  const state = store(); let current = [{ id: 'modern', title: 'Modern', cwd: root }, { id: 'other', title: 'Other', cwd: path.dirname(root) }];
  const client = { isConnected: true, listHistory: async options => ({ sessions: current.filter(item => !options.cwd || item.cwd === options.cwd), total: current.filter(item => !options.cwd || item.cwd === options.cwd).length, offset: 0 }) };
  const live = panel(state, client), scope = { cwd: root, limit: 100 };
  assert.equal((await live.readHistory('list', undefined, scope)).via, 'door');
  const offline = panel(state, undefined), cached = await offline.readHistory('list', undefined, scope);
  assert.equal(cached.via, 'cache'); assert(cached.result.cachedAt > 0); assert.equal(cached.result.sessions.length, 1); assert.equal(cached.result.cacheScope.cwd, root); assert(cached.result.limited);
  assert(!('entries' in cached.result));
  const unmatched = await offline.readHistory('list', undefined, { cwd: path.dirname(root) });
  assert.equal(unmatched.via, 'local'); assert.equal(unmatched.result.sessions.length, 0); assert.equal(unmatched.result.emptyReason, 'unsupported-format');
  await assert.rejects(offline.readHistory('get', 'modern'), error => error.code === 'HISTORY_FORMAT_UNSUPPORTED');
  fs.rmSync(modern, { recursive: true });
  assert((await offline.readHistory('list', undefined, scope)).result.limitation.includes('已删除'), 'Cached cards never claim a deleted session still exists');
  current = []; assert.equal((await live.readHistory('list', undefined, scope)).result.sessions.length, 0);
  const refreshed = await panel(state, undefined).readHistory('list', undefined, scope); assert.equal(refreshed.result.sessions.length, 0, 'Reconnect refresh replaces stale cached summaries');
  let now = Date.now(); const expiring = new HistorySummaryCache(store(), { now: () => now });
  await expiring.put('fixture', scope, { sessions: [{ id: 'only', cwd: root }], total: 1 }); now += CACHE_TTL + 1;
  assert.equal(expiring.get('fixture', scope), undefined);
  console.log('Offline history: v4-only and mixed formats, mirrored readers, explicit limitations, scoped summary cache, expiration, deleted history and reconnect refresh passed');
} finally { if (savedEnv === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedEnv; fs.rmSync(root, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
