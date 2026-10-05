'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), { EventEmitter } = require('node:events'), { execFileSync } = require('node:child_process');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-views-'))), cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
execFileSync('git', ['init', '-q', cwd]); fs.writeFileSync(path.join(cwd, 'sample.js'), 'const sum = 1;\n');
execFileSync('git', ['-C', cwd, 'add', '.']); execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
process.env.DSH_HOME = path.join(root, 'dsh');
const profileDir = path.join(process.env.DSH_HOME, 'profiles', 'custom-panel'); fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } }, token: 'PRIVATE_MODEL_TOKEN' }));
const commands = new Map(), trees = new Map(), diagnostics = new Map(), stored = new Map(), opened = [];
const disposable = { dispose() {} };
const uri = text => ({ fsPath: text.replace(/^file:/, ''), scheme: text.split(':')[0], toString: () => text });
class Emitter { constructor() { this.event = fn => { this.fn = fn; return disposable; }; } fire(value) { this.fn?.(value); } dispose() {} }
let provider, onSave, onClose, copied;
const vscode = {
  EventEmitter: Emitter, TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }, ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ProgressLocation: { Notification: 15 }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }, Range: class { constructor(...args) { this.args = args; } },
  Uri: { file: file => uri('file:' + file), parse: uri },
  commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; }, executeCommand: async (name, ...args) => commands.get(name)?.(...args) },
  env: { clipboard: { writeText: async text => { copied = text; } } },
  window: { registerTreeDataProvider: (name, tree) => { trees.set(name, tree); return disposable; }, showErrorMessage: async () => {}, showInformationMessage: () => new Promise(() => {}),
    showTextDocument: async doc => { if (!opened.includes(doc)) opened.push(doc); }, showQuickPick: async items => items[0],
    withProgress: async (_, fn) => fn({}, { onCancellationRequested: () => disposable }) },
  languages: { createDiagnosticCollection: () => ({ set: (key, value) => diagnostics.set(key.toString(), value), delete: key => diagnostics.delete(key.toString()), dispose() {} }) },
  workspace: { isTrusted: true, workspaceFolders: [{ name: 'fixture', uri: uri('file:' + cwd) }], textDocuments: opened,
    getWorkspaceFolder: key => (process.platform === 'win32' ? path.resolve(key.fsPath).toLowerCase() === cwd.toLowerCase() : path.resolve(key.fsPath) === cwd) ? {} : undefined,
    registerTextDocumentContentProvider: (_, value) => { provider = value; return disposable; },
    openTextDocument: async key => ({ uri: key, getText: () => provider.provideTextDocumentContent(key) }),
    onDidSaveTextDocument: fn => { onSave = fn; return disposable; }, onDidCloseTextDocument: fn => { onClose = fn; return disposable; } },
};
const original = Module._load; Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
const { BridgeViews } = require('../src/bridge/views'); Module._load = original;
const connections = new EventEmitter(); let instance = 'kernel-one', available = true, authorized = true, mode = 'completed', invokeCount = 0;
const requests = [], snapshots = new Map(); let catalogCalls = 0;
const catalog = { capabilities: [
  { id: 'michengai.code-review.run', title: '审查代码变更', riskTier: 'execute', provider: { id: 'review', name: '审查' }, availability: { state: 'available' } },
  ...['list', 'read', 'health'].map(action => ({ id: 'linxin.skill-explorer.' + action, title: action, riskTier: 'read', provider: { id: 'skills', name: '技能' }, availability: { state: 'available' } })),
] };
Object.assign(connections, { clientId: 'client-one', sessions: new Map(), acquire() {}, release() {}, ensure: async () => { if (!available) throw new Error('disconnected'); },
  snapshot: () => ({ connected: available, authorized: available && authorized, supported: connections.bridge.supported, version: '0.2.0', instanceId: instance, profile: 'custom-panel', state: available ? 'ready' : 'disconnected' }) });
connections.bridge = { supported: true, catalog: async () => { catalogCalls++; return catalog; },
  request: async (method, params) => {
    if (method === 'invoke' && params.capabilityId.startsWith('linxin.skill-explorer.')) {
      const value = params.capabilityId.endsWith('.list') ? { groups: [{ key: 'project', title: 'Project', skills: [{ id: 'fixture-skill', name: 'fixture-skill', description: 'Fixture skill', modelInvocable: true }] }] }
        : params.capabilityId.endsWith('.read') ? { content: 'FIXTURE_SKILL_BODY' } : { ok: true, skills: 1, complete: true };
      return { mode: 'immediate', value };
    }
    if (method === 'invoke') { invokeCount++; requests.push(params); const id = 'run-' + invokeCount; snapshots.set(id, { status: mode, seq: 2, acceptedAt: new Date().toISOString(), result: { summary: 'report', findings: [{ title: 'Finding', body: 'Issue', file: 'sample.js', startLine: 1, priority: 'P2' }] } }); connections.emit('operation', { operationId: id, seq: 1, type: 'started' }); return { mode: 'operation', operationId: id }; }
    if (method === 'operation/get') { if (mode === 'expired') throw Object.assign(new Error(), { code: -32047 }); if (mode === 'network') throw new Error('network'); return snapshots.get(params.operationId); }
    if (method === 'cancel') { const op = snapshots.get(params.operationId); op.status = 'cancelled'; return { status: 'cancelled' }; }
  } };
connections.sessionFor = async () => ({ sessionId: 'fixture-session' });
const attachments = []; let chatCwd = cwd;
const panel = { config: () => ({ fallbackProfile: 'custom-panel' }), workdir: () => chatCwd, attach: async items => attachments.push(...items), wantedPreset: () => undefined, kernels: { live() {}, acquire() {}, release() {}, entries: new Map() } };
const context = { subscriptions: [], workspaceState: { get: (key, fallback) => stored.get(key) || fallback, update: async (key, value) => { stored.set(key, JSON.parse(JSON.stringify(value))); } } };
(async () => {
  const view = new BridgeViews({ context, connections, panel, log() {} });
  const capabilityTree = trees.get('dshPanel.capabilities'); let treeChanges = 0, treeLoads = 0;
  const redraw = async () => { treeLoads++; return capabilityTree.getChildren(); };
  capabilityTree.onDidChangeTreeData(() => { treeChanges++; if (treeLoads < 5) setImmediate(() => void redraw()); });
  await redraw(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(treeLoads, 1, 'Loading a visible tree must settle instead of requesting another redraw');
  assert.equal(catalogCalls, 1); assert.equal(treeChanges, 0);
  const actions = await capabilityTree.getChildren(); assert.deepEqual(actions.map(item => item.label), ['审查代码', '浏览技能']);
  assert(actions.every(item => item.collapsibleState === vscode.TreeItemCollapsibleState.None));
  assert.deepEqual(await capabilityTree.getChildren(actions[1]), []);
  await vscode.commands.executeCommand(actions[1].command.command, ...(actions[1].command.arguments || []));
  assert(opened.some(doc => doc.getText().includes('FIXTURE_SKILL_BODY')), 'The visible skill action opens its selected body');
  await commands.get('dshPanel.bridge.diagnose')();
  const health = opened.find(doc => doc.uri.toString().includes('health.md')).getText();
  assert(health.includes('技能服务正常') && health.includes('1 个') && !health.includes('"ok"'));
  await commands.get('dshPanel.bridge.refresh')(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(treeChanges, 1); assert.equal(treeLoads, 2, 'An explicit refresh causes one bounded redraw');
  const beforeReviewChanges = treeChanges;
  await assert.rejects(view.reviewRequest({ cwd, input: { mode: 'base', ref: 'missing-fixture-branch' } }), error => error.code === -32051); assert.equal(invokeCount, 0);
  const concurrent = await Promise.allSettled([view.reviewRequest({ cwd, input: { mode: 'worktree' } }), view.reviewRequest({ cwd, input: { mode: 'worktree' } })]);
  assert.equal(concurrent.filter(x => x.status === 'fulfilled').length, 1); assert.equal(concurrent.find(x => x.status === 'rejected').reason.code, -32045); assert.equal(invokeCount, 1);
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(treeChanges, beforeReviewChanges, 'Review progress only updates operation records');
  const first = view.operations.get('run-1'); assert(first.uri, JSON.stringify({ status: first.status, reason: first.reason, cwd: first.cwd, workspace: cwd })); assert.equal(diagnostics.size, 1);
  const completedItem = await trees.get('dshPanel.operations').getChildren();
  assert.equal(completedItem[0].contextValue, 'dshCompletedReview');
  const beforeAttachCalls = invokeCount;
  await commands.get('dshPanel.bridge.attachReview')(completedItem[0]);
  assert.equal(attachments.length, 1); assert.equal(attachments[0].kind, 'review'); assert(attachments[0].text.includes('Finding'));
  assert.equal(attachments[0].uri, undefined); assert.equal(invokeCount, beforeAttachCalls, 'Attaching a report must not execute a model operation');
  await view.attachReview('missing-report'); assert.equal(attachments.length, 1);
  chatCwd = root; await view.attachReview(first.id); assert.equal(attachments.length, 1, 'Reports must not enter another workspace chat'); chatCwd = cwd;
  vscode.workspace.isTrusted = false; await assert.rejects(view.attachReview(first.id), error => error.code === -32044); assert.equal(attachments.length, 1); vscode.workspace.isTrusted = true;
  const originalResult = first.result; first.result = { rawText: '界'.repeat(256 * 1024 / 3 + 1) };
  await view.attachReview(first.id); assert.equal(attachments.length, 1, 'Report size is measured in UTF-8 bytes'); first.result = originalResult;
  fs.writeFileSync(path.join(cwd, 'sample.js'), 'const sum = 2;\n');
  await view.attachReview(first.id); assert.equal(attachments.length, 2); assert(attachments[1].text.includes('快照已变化')); assert(attachments[1].detail.includes('代码已变化'));
  const retries = await Promise.all([view.retry('run-1'), view.retry('run-1')]); assert(retries[0] && !retries[1]); assert.equal(invokeCount, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId); assert.notEqual(first.fingerprint, view.operations.get('run-2').fingerprint); assert(view.operations.has('run-1'));
  assert.equal(view.operations.get('run-2').retryOf, 'run-1'); assert(opened.some(doc => doc.getText().includes('代码快照已变化')));
  await view.removeOperation('run-1'); assert.equal(diagnostics.size, 1, 'Removing an older report must preserve the newer report diagnostics');
  const priorCalls = invokeCount; connections.emit('operation', { operationId: 'run-1', seq: 99, type: 'completed' }); assert(!view.operations.has('run-1'));
  await view.clearFinished(); assert.equal(diagnostics.size, 0); assert.equal(invokeCount, priorCalls); assert.equal(view.operations.size, 0);
  assert(opened.some(doc => doc.getText().includes('Finding')), 'Open report text remains readable after record cleanup');
  await commands.get('dshPanel.bridge.diagnoseConfig')(); await commands.get('dshPanel.bridge.copyDiagnostics')(); assert(copied.includes('custom-panel') && !copied.includes('PRIVATE_MODEL_TOKEN'));
  connections.bridge.supported = false; const legacy = await view.capabilityChildren(); assert(legacy.every(item => item.description.includes('不支持'))); connections.bridge.supported = true;
  authorized = false; connections.bridge.auth = async () => { connections.emit('state', { state: 'authorization-expired' }); throw Object.assign(new Error(), { code: -32052 }); };
  const unauthenticated = await view.capabilityChildren(); assert.equal(view.catalog.capabilities.length, 4); assert(unauthenticated.every(item => item.description.includes('未通过身份验证')));
  await new Promise(resolve => setTimeout(resolve, 30)); const expiredChanges = treeChanges;
  connections.emit('state', { state: 'authorization-expired' }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(treeChanges, expiredChanges, 'Repeated failed authentication must not reload the visible tree');
  authorized = true; connections.bridge.auth = async () => {};
  mode = 'network'; await view.reviewRequest({ cwd, input: { mode: 'worktree' } }); assert.equal(view.operations.get('run-3').status, 'pending-restore');
  assert(!view.operations.remove('run-3')); const beforeRestore = invokeCount;
  instance = 'kernel-two'; await view.restore(); assert.equal(view.operations.get('run-3').status, 'unrecoverable'); assert.equal(invokeCount, beforeRestore);
  mode = 'expired'; await view.reviewRequest({ cwd, input: { mode: 'worktree' } }); assert.equal(view.operations.get('run-4').status, 'unrecoverable'); assert.equal(invokeCount, beforeRestore + 1);
  mode = 'running'; const pending = view.reviewRequest({ cwd, input: { mode: 'worktree' } });
  while (!view.operations.has('run-5')) await new Promise(resolve => setImmediate(resolve));
  await view.cancel('run-5'); await pending; assert.equal(view.operations.get('run-5').status, 'cancelled');
  const beforeCancelledAttach = attachments.length; await view.attachReview('run-5'); assert.equal(attachments.length, beforeCancelledAttach);
  vscode.workspace.isTrusted = false; await assert.rejects(view.retry('run-5'), error => error.code === -32044);
  const restricted = await view.capabilityChildren(); assert(restricted.some(item => item.description.includes('受信任')));
  vscode.workspace.isTrusted = true; mode = 'completed';
  const reviewAction = (await capabilityTree.getChildren()).find(item => item.id === 'michengai.code-review.run');
  const clicked = await vscode.commands.executeCommand(reviewAction.command.command, ...(reviewAction.command.arguments || []));
  assert.equal(clicked?.status, 'completed'); assert(clicked.uri, 'The visible review action opens its completed report');
  const permissionClient = new EventEmitter(); permissionClient.isConnected = true;
  const answers = [], permissionSession = { client: permissionClient, sessionId: 'review-session', answerPermission: (id, option) => answers.push([id, option]) };
  const permissionOptions = [{ name: '本次允许', optionId: 'allow-once' }, { name: '拒绝', optionId: 'reject-once' }];
  const releasePermissions = view.reviewPermissions(permissionSession);
  permissionClient.emit('permission', 11, { sessionId: 'other-session', options: permissionOptions });
  permissionClient.emit('permission', 12, { sessionId: 'review-session', options: permissionOptions });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(answers, [[12, 'allow-once']]);
  const originalQuickPick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async () => ({ optionId: 'invented' });
  permissionClient.emit('permission', 13, { sessionId: 'review-session', options: permissionOptions });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(answers[1], [13, undefined]);
  vscode.window.showQuickPick = () => new Promise(() => {});
  permissionClient.emit('permission', 14, { sessionId: 'review-session', options: permissionOptions });
  releasePermissions(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(answers[2], [14, undefined]); assert.equal(permissionClient.listenerCount('permission'), 0);
  vscode.window.showQuickPick = originalQuickPick;
  onSave({ uri: uri('file:' + path.join(cwd, 'sample.js')) }); onClose(opened[0]); view.dispose();
  assert.equal(view.timers.size, 0); assert.equal(connections.listenerCount('operation'), 0);
  console.log('Stable flat actions, skill and review command dispatch, readable health, bounded refresh, diagnosis, retry, recovery and cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
