import assert from 'node:assert/strict';
import { createSessionQueryHistory } from '../lib/kernel/history.js';
import { archiveSnapshot, archiveRevision, registerHistorySession } from '../lib/kernel/history-archive.js';
import requests from '../lib/history-requests.cjs';

const records = Array.from({ length: 120 }, (_, i) => ({ header: { id: `session-${i}`, cwd: process.cwd() } }));
const registry = {
  archivedSessionIds: records.slice(0, 100).map(record => record.header.id), calls: [],
  async archiveSession(id, options) {
    this.calls.push({ id, options });
    if (id === 'busy') throw Object.assign(new Error('busy'), { name: 'WorkspaceActiveSessionError' });
    if (!records.some(record => record.header.id === id)) throw new Error('Unknown session');
    if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id);
  },
  async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id); },
};
const batches = []; let fullReads = 0;
const service = {
  async listSessions() { return records; },
  async readTitleSnapshots(ids) {
    batches.push(ids);
    return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: records.find(record => record.header.id === id).header, title: { title: `Title ${id}` } } }));
  },
  async readSession(id) { fullReads++; return { session: records.find(record => record.header.id === id).header, events: [] }; },
};
const handler = createSessionQueryHistory(service, () => {}, { getWorkspaceRegistry: () => registry });
let result = await handler.list({ limit: 30 });
assert.equal(result.total, 20); assert.equal(result.sessions.length, 20);
assert.equal(result.archiveSupported, true); assert.equal(result.archiveStateKnown, true);
assert(result.sessions.every(card => card.archived === false));
assert.deepEqual(batches[0], records.slice(100).map(record => record.header.id), 'Archive filter runs before title reads and pagination');
result = await handler.list({ limit: 30, archived: true });
assert.equal(result.total, 100); assert.equal(result.nextOffset, 30);
assert(result.sessions.every(card => card.archived === true));
assert.deepEqual(batches[1], records.slice(0, 30).map(record => record.header.id));
assert.equal(fullReads, 0, 'Lists never replay archived bodies');
const listedMembers = ['session-110', 'session-111'];
registry.list = () => [{ sessionIds: listedMembers }];
registry.pinnedSessionIds = ['session-112'];
assert.equal((await handler.list({ limit: 30 })).total, 3, 'Default list matches DSH registered workspace members and pins');
const otherHistory = await handler.list({ limit: 30, unlisted: true });
assert.equal(otherHistory.total, 17, 'Unregistered old persistence stays accessible in a separate view');
assert(!otherHistory.sessions.some(card => listedMembers.includes(card.id)));
const listedRevision = (await handler.state()).archiveRevision;
listedMembers.push('session-113');
assert.notEqual((await handler.state()).archiveRevision, listedRevision, 'Workspace accounting invalidates history caches as well as archives');
delete registry.list; delete registry.pinnedSessionIds;
assert.equal((await handler.list({ archived: true, query: 'Title session-99', limit: 30 })).sessions[0].id, 'session-99');
assert.equal((await handler.list({ query: 'Title session-99', limit: 30 })).total, 0);
assert.equal((await handler.get('session-0')).card.archived, true);
const prior = (await handler.state()).archiveRevision;
result = await handler.archive('session-110', true);
assert.equal(result.archived, true); assert.notEqual(result.archiveRevision, prior);
assert.equal(registry.calls.at(-1).options, undefined, 'Never stop activity implicitly');
assert.equal((await handler.list({ limit: 30 })).total, 19);
await handler.archive('session-110', false);
assert.equal((await handler.state()).archiveRevision, prior);
assert.equal((await handler.list({ limit: 30 })).total, 20);
await assert.rejects(handler.archive('busy', true), /运行中的任务/);
assert(!registry.archivedSessionIds.includes('busy'));
const callsBeforeInvalid = registry.calls.length;
await assert.rejects(handler.archive('../outside', true), error => error.code === -32602);
await assert.rejects(handler.archive('session-110', 'true'), error => error.code === -32602);
assert.equal(registry.calls.length, callsBeforeInvalid);
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(handler.archive('session-110', true, { signal: cancelled.signal }), /abort/i);
assert.equal(registry.calls.length, callsBeforeInvalid);
assert.equal(archiveRevision(['b', 'a', 'a']), archiveRevision(['a', 'b']));
assert.throws(() => archiveSnapshot({ archivedSessionIds: null }), /归档状态/);
const unavailable = createSessionQueryHistory(service);
assert.equal((await unavailable.state()).archiveSupported, false);
assert.equal((await unavailable.list({ limit: 30 })).archiveStateKnown, false);
await assert.rejects(unavailable.list({ archived: true }), /不支持/);
await assert.rejects(unavailable.archive('session-110', true), error => error.code === -32601);

const replies = [], state = { sessionsHandler: handler, respond: value => replies.push(value) };
await requests.runHistoryRequest({ id: 1, method: 'dsh-door/sessions/state' }, 'state', state);
assert.equal(replies.at(-1).result.archiveSupported, true);
await requests.runHistoryRequest({ id: 2, method: 'dsh-door/sessions/archive', params: { id: 'session-110', archived: true } }, 'archive', state);
assert.equal(replies.at(-1).result.archived, true);
let finish;
state.sessionsHandler = { archive: async () => { await new Promise(resolve => { finish = resolve; }); return { archived: true }; } };
const committing = requests.runHistoryRequest({ id: 3, method: 'dsh-door/sessions/archive', params: { id: 'session-111', archived: true } }, 'archive', state);
await new Promise(resolve => setImmediate(resolve));
requests.cancelHistoryRequest({ method: '$/cancelRequest', params: { id: 3 } }, state);
finish(); await committing;
assert.equal(replies.at(-1).result.archived, true, 'Cancellation after commit began cannot report that a durable write was cancelled');
await new Promise(resolve => setImmediate(resolve));
assert.equal(state.historyReads.size, 0);
const registered = [];
const workspace = { attachSession: async id => registered.push(id) };
const registration = { resolveByPath: async () => workspace, create: async () => { throw new Error('Must reuse known workspace'); } };
assert.equal(await registerHistorySession(registration, { id: 'session-new', cwd: process.cwd() }), true);
assert.deepEqual(registered, ['session-new']);
registration.resolveByPath = async () => undefined;
registration.create = async cwd => { assert.equal(cwd, process.cwd()); return workspace; };
await registerHistorySession(registration, { id: 'session-resumed', cwd: process.cwd() });
assert.deepEqual(registered, ['session-new', 'session-resumed']);
assert.equal(await registerHistorySession(registration, { id: 'session-relative', cwd: '../relative' }), false);
assert.equal(await registerHistorySession(undefined, { id: 'legacy' }), false);
console.log('PASS DSH archive filtering before paging, lazy archived titles, canonical writes, activity guard, id validation, cancellation and unsupported kernels');
