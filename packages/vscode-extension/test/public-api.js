'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { EventEmitter } = require('node:events');
const { DshConnectionService } = require('../src/connection/service');
const { PublicApi } = require('../src/api/service');
const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-')));
const client = new EventEmitter(); Object.assign(client, { isConnected: true, count: 0, active: 0, maxActive: 0, closed: [], replies: [],
  newSession: async () => ({ sessionId: 's' + ++client.count }), resumeSession: async () => ({}), closeSession: async id => client.closed.push(id), doorStatus: async () => ({ connectionCount: 1, model: { ready: true, source: 'fixture' }, capabilities: { history: true }, runtime: { acpVersion: 'fixture' }, bootstrapSecret: 'must-not-export' }), respond: (id, value) => client.replies.push({ id, value }),
  prompt: async (id, text, options) => {
    client.maxActive = Math.max(client.maxActive, ++client.active);
    try {
      client.emit('permission', 'unrelated', { sessionId: 'someone-else', options: [{ optionId: 'allow', name: 'Allow' }] });
      if (text === 'permission') client.emit('permission', 'permission', { sessionId: id, options: [{ optionId: 'allow', name: 'Allow' }] });
      client.emit('update', id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      await new Promise(resolve => { const timer = setTimeout(resolve, 15); options.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      if (text === 'fail') throw new Error('fixture failure'); return { stopReason: options.signal.aborted ? 'cancelled' : 'end_turn' };
    } finally { client.active--; }
  },
});
const connections = new DshConnectionService(); connections.client = client; connections.status = { instanceId: 'instance' };
const operations = new Map(); const catalog = { capabilities: [{ id: 'read', riskTier: 'read' }, { id: 'write', riskTier: 'workspace-write' }, { id: 'run', riskTier: 'execute' }] };
connections.bridge = { supported: true, catalog: async () => catalog, request: async (method, params) => {
  if (method === 'invoke') { if (params.capabilityId === 'run') { operations.set('owned', { status: 'running' }); return { mode: 'operation', operationId: 'owned' }; } return { mode: 'immediate', value: params.context }; }
  if (method === 'cancel') operations.get(params.operationId).status = 'cancelled'; return operations.get(params.operationId);
} };
const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { isTrusted: true, getWorkspaceFolder: uri => path.relative(cwd, uri.fsPath).startsWith('..') ? undefined : {} } };
const panel = { config: () => ({}), wantedPreset: () => 'standard', workdir: () => cwd, reveal: async () => {}, adoptSession: async session => { panel.session = session; } };
const views = { refresh: async () => catalog, reviewRequest: async value => value, operations: new Map(), retain() {}, release() {} };
const context = { subscriptions: [] }, service = new PublicApi({ vscode, context, connections, panel, views }), api = service.exports;
(async () => {
  assert.equal(api.apiVersion, 1); assert.equal(api.apiRevision, 2); assert(Object.isFrozen(api));
  const status = await api.getConnectionStatus(); assert.equal(status.model.ready, true); assert.equal(status.capabilities.history, true); assert.equal(status.runtime.acpVersion, 'fixture'); assert.equal(status.bootstrapSecret, undefined, 'Connection metadata preserves v1 fields without exporting transport fields');
  await assert.rejects(api.createSession({ cwd }), error => error.code === -32044);
  await assert.rejects(api.createSession({ cwd: path.dirname(cwd), userInitiated: true }));
  const handle = await api.createSession({ cwd, userInitiated: true }); assert(Object.isFrozen(handle)); assert(!('client' in handle));
  assert.equal((await api.restoreSession({ cwd, sessionId: handle.sessionId, userInitiated: true })).id, handle.id);
  const events = []; const first = api.prompt(handle, 'one', { userInitiated: true, onEvent: event => events.push(event) });
  const second = api.prompt(handle, 'two', { userInitiated: true });
  await assert.rejects(api.closeSession(handle), error => error.code === -32045); await Promise.all([first, second]); assert.equal(client.maxActive, 1); assert(events.some(event => event.delta === 'one'));
  await assert.rejects(api.prompt(handle, 'fail', { userInitiated: true })); assert.equal((await api.prompt(handle, 'after', { userInitiated: true })).stopReason, 'end_turn');
  const abort = new AbortController(); const pending = api.prompt(handle, 'permission', { userInitiated: true, signal: abort.signal, onPermission: () => new Promise(() => {}) });
  setTimeout(() => abort.abort(), 5); assert.equal((await pending).stopReason, 'cancelled'); await new Promise(resolve => setImmediate(resolve)); assert.equal(client.replies.at(-1).value.outcome.outcome, 'cancelled'); assert(!client.replies.some(reply => reply.id === 'unrelated'));
  await api.prompt(handle, 'permission', { userInitiated: true, onPermission: () => 'wrong-option' }); assert.equal(client.replies.at(-1).value.outcome.outcome, 'cancelled');
  await api.prompt(handle, 'permission', { userInitiated: true, onPermission: () => 'allow' }); assert.equal(client.replies.at(-1).value.outcome.optionId, 'allow');
  await assert.rejects(api.prompt(handle, '界'.repeat(100000), { userInitiated: true }));
  await assert.rejects(api.prompt({ id: 'foreign' }, 'x', { userInitiated: true }), error => error.code === -32047);
  vscode.workspace.isTrusted = false; await assert.rejects(api.prompt(handle, 'x', { userInitiated: true }), error => error.code === -32044); await assert.rejects(api.invokeCapability({ cwd, capabilityId: 'write', userInitiated: true }), error => error.code === -32044); vscode.workspace.isTrusted = true;
  await assert.rejects(api.invokeCapability({ cwd, capabilityId: 'run' }), error => error.code === -32044);
  assert.equal((await api.invokeCapability({ cwd, capabilityId: 'read' })).value.approved, false);
  await api.invokeCapability({ cwd, capabilityId: 'run', userInitiated: true }); assert(connections.consumers.has('api-operation:owned')); await api.cancel({ kind: 'operation', id: 'owned' }); assert(!connections.consumers.has('api-operation:owned'));
  await assert.rejects(api.getOperation('foreign'), error => error.code === -32047);
  let updates = 0; const subscription = api.onDidChangeConnection(() => updates++); connections.emit('state', { state: 'ready' }); assert.equal(updates, 1); subscription.dispose(); connections.emit('state', { state: 'ready' }); assert.equal(updates, 1);
  service.sessions.get(handle.id).session.sessionId = 'changed'; await assert.rejects(api.prompt(handle, 'x', { userInitiated: true }), error => error.code === -32047); service.sessions.get(handle.id).session.sessionId = handle.sessionId;
  connections.status.instanceId = 'changed'; await assert.rejects(api.prompt(handle, 'x', { userInitiated: true }), error => error.code === -32047); connections.status.instanceId = 'instance';
  await api.openPanel(handle); assert.equal(panel.session.sessionId, handle.sessionId); await api.closeSession(handle); assert.equal(client.closed.length, 0, 'Panel handoff must preserve the shared session');
  const restoredPanel = await api.restoreSession({ cwd, sessionId: handle.sessionId, userInitiated: true }); assert.equal(service.sessions.get(restoredPanel.id).session, panel.session, 'An already active panel session must be adopted instead of resumed twice'); await api.closeSession(restoredPanel);
  const other = await api.createSession({ cwd, userInitiated: true }); await api.closeSession(other); assert(client.closed.includes(other.sessionId));
  service.dispose(); panel.session.dispose(); await assert.rejects(api.listCapabilities()); assert.equal(client.listenerCount('update'), 0); fs.rmSync(cwd, { recursive: true, force: true });
  console.log('Public API sessions, FIFO turns, streaming, permission isolation, cancellation, trust, operation ownership, stale identities, events and handoff passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
