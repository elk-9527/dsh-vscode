'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const vscode = {
  Uri: { file: value => ({ fsPath: value }), parse: value => ({ scheme: value.split(':')[0], fsPath: value.slice(7) }) },
  workspace: { isTrusted: true, getWorkspaceFolder: () => ({ uri: { fsPath: 'C:/project' } }) },
  commands: { executeCommand: async () => {} },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };
const { DshPanelView } = require('../src/panel/view');
Module._load = originalLoad;
const { MessageQueue, snapshotMessage } = require('../src/panel/queue');
const { draftKey } = require('../src/panel/drafts');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function idle(panel) { for (let n = 0; n < 40; n++) { await tick(); if (!panel.queue.active) return; } throw new Error('queue did not settle'); }
function fixture() {
  const output = [], calls = [], client = new EventEmitter(); client.isConnected = true; client.closeSession = async () => {};
  const panel = new DshPanelView({ extensionUri: {}, log() {}, kernels: { release() {}, acquire() {}, live() {} } });
  panel.view = { webview: { postMessage: async message => { output.push(structuredClone(message)); } } };
  panel.workdir = () => 'C:/project'; panel.config = () => ({}); panel.refreshPermission = async () => {};
  const session = new EventEmitter(); Object.assign(session, { sessionId: 'original', cwd: 'C:/project', client, messages: new Map(), configOptions: [], busy: false, dispose() {}, stop() {} });
  panel.session = session; panel.client = client; panel.connections.client = client; panel.connections.status = { instanceId: 'kernel-1' };
  panel.ensureConnection = async () => panel.session;
  session.send = async (text, { attachments }) => { calls.push({ text, attachments }); return { stopReason: 'end_turn' }; };
  panel.wire(session, client);
  return { panel, session, client, output, calls };
}

(async () => {
  const raw = { kind: 'file', text: 'accepted', uri: 'file:///later', name: 'code.js' };
  const frozen = snapshotMessage('hello', [raw]); raw.text = 'changed';
  assert.equal(frozen.attachments[0].text, 'accepted'); assert.equal(frozen.attachments[0].kind, 'content'); assert.equal(frozen.attachments[0].uri, undefined);
  assert(Object.isFrozen(frozen.attachments[0]));
  const capacity = new MessageQueue(); capacity.add(frozen, {}, 1); capacity.take();
  for (let n = 2; n <= 5; n++) capacity.add(frozen, {}, n);
  assert.throws(() => capacity.add(frozen, {}, 6), /5/); capacity.finish('failed'); assert.equal(capacity.items.length, 5);

  const ordered = fixture(), gate = deferred();
  ordered.session.send = async (text, { attachments }) => { ordered.calls.push({ text, attachments }); if (text === 'first') await gate.promise; return { stopReason: 'end_turn' }; };
  await ordered.panel.onWebviewMessage({ type: 'send', requestId: 1, text: 'first' });
  assert(ordered.output.some(item => item.type === 'sendResult' && item.phase === 'accepted'));
  assert(!ordered.output.some(item => item.type === 'sendCompleted'));
  const attachment = { kind: 'selection', text: 'old selection', name: 'code.js' };
  await ordered.panel.onWebviewMessage({ type: 'send', requestId: 2, text: 'second', attachments: [attachment] }); attachment.text = 'new selection';
  await ordered.panel.onWebviewMessage({ type: 'send', requestId: 2, text: 'second', attachments: [{ ...attachment, text: 'old selection' }] });
  assert.equal(ordered.panel.queue.items.length, 1);
  gate.resolve(); await idle(ordered.panel);
  assert.deepEqual(ordered.calls.map(item => item.text), ['first', 'second']); assert.equal(ordered.calls[1].attachments[0].text, 'old selection');
  assert.equal(ordered.output.filter(item => item.type === 'sendCompleted').length, 2);

  const failed = fixture(), failGate = deferred(); let failing = true;
  failed.session.send = async text => { failed.calls.push(text); if (text === 'fail' && failing) { await failGate.promise; throw new Error('quota'); } return { stopReason: 'end_turn' }; };
  await failed.panel.acceptMessage({ requestId: 10, text: 'fail' }); await failed.panel.acceptMessage({ requestId: 11, text: 'next' });
  failGate.resolve(); await idle(failed.panel);
  assert.deepEqual(failed.calls, ['fail']); assert.equal(failed.panel.queue.paused, true); assert.equal(failed.panel.queue.items[0].failed, true);
  assert(failed.output.some(item => item.type === 'sendCompleted' && item.retained));
  failing = false; await failed.panel.queueAction({ action: 'continue' }); await idle(failed.panel); assert.deepEqual(failed.calls, ['fail', 'fail', 'next']);

  for (const cause of ['stop', 'view-close', 'disconnect', 'switch']) {
    const current = fixture(), activeGate = deferred();
    current.session.send = async text => { current.calls.push(text); if (text === 'active') await activeGate.promise; return { stopReason: 'end_turn' }; };
    await current.panel.acceptMessage({ requestId: 20, text: 'active' }); await current.panel.acceptMessage({ requestId: 21, text: 'waiting' });
    if (cause === 'stop') await current.panel.onWebviewMessage({ type: 'stop' });
    else if (cause === 'view-close') { current.panel.view = undefined; current.panel.pauseQueue('view closed'); }
    else if (cause === 'disconnect') current.client.emit('close', 'lost');
    else await current.panel.changeSession(async () => false, 'switch');
    activeGate.resolve(); await idle(current.panel); assert.deepEqual(current.calls, ['active'], cause); assert(current.panel.queue.paused, cause);
  }

  const binding = fixture(); binding.session.busy = true;
  await binding.panel.acceptMessage({ requestId: 30, text: 'bound' }); binding.panel.queue.pause('manual'); binding.session.busy = false; binding.session.sessionId = 'other';
  await assert.rejects(binding.panel.queueAction({ action: 'continue' }), /原会话/); assert.equal(binding.calls.length, 0);
  await binding.panel.queueAction({ action: 'edit', id: binding.panel.queue.items[0].id }); assert.equal(binding.panel.queue.items.length, 0);
  assert(binding.output.some(item => item.type === 'queueEdit' && item.text === 'bound'));
  assert.equal(binding.output.find(item => item.type === 'queueEdit' && item.text === 'bound').cwd, 'C:/project');
  assert.equal(binding.panel.queue.paused, false);
  await binding.panel.queueAction({ action: 'edit', id: 'already-gone' });
  assert(binding.output.some(item => item.type === 'queueEdit' && item.id === 'already-gone' && item.error === '此消息已不在队列中'));
  binding.session.busy = true; await binding.panel.acceptMessage({ requestId: 31, text: 'retain on retrieval failure' });
  const retrievalId = binding.panel.queue.items[0].id, realChange = binding.panel.queue.onChange;
  binding.panel.queue.onChange = () => { throw new Error('cannot publish queue'); };
  await binding.panel.queueAction({ action: 'edit', id: retrievalId });
  assert.equal(binding.panel.queue.items[0].id, retrievalId); assert(binding.output.some(item => item.type === 'queueEdit' && item.id === retrievalId && item.error));
  binding.panel.queue.onChange = realChange;

  const emptySwitch = fixture(); emptySwitch.session.start = async () => { emptySwitch.session.sessionId = 'new-empty'; };
  assert.equal(await emptySwitch.panel.newSession(), true); assert.equal(emptySwitch.panel.queue.paused, false);
  await emptySwitch.panel.acceptMessage({ requestId: 32, text: 'first in new conversation' }); await idle(emptySwitch.panel);
  assert.deepEqual(emptySwitch.calls.map(item => item.text), ['first in new conversation']);
  const emptyHistory = fixture(); emptyHistory.panel.readHistory = async () => ({ result: { entries: [] }, via: 'door' });
  await emptyHistory.panel.sendHistoryReplay('past'); emptyHistory.panel.returnToConversation();
  assert.equal(emptyHistory.panel.queue.paused, false);
  await emptyHistory.panel.acceptMessage({ requestId: 33, text: 'back in current conversation' }); await idle(emptyHistory.panel);
  assert.deepEqual(emptyHistory.calls.map(item => item.text), ['back in current conversation']);

  const history = fixture(), historyGate = deferred();
  history.panel.post({ type: 'user', text: 'real question' }); history.panel.post({ type: 'assistant', id: 'live' });
  history.panel.readHistory = async () => { await historyGate.promise; return { result: { entries: [{ kind: 'user', text: 'past' }] }, via: 'door' }; };
  const reading = history.panel.sendHistoryReplay('past');
  await assert.rejects(history.panel.send('must not send'), /只读历史/);
  history.session.emit('text', { id: 'live', delta: 'still working' });
  assert(!history.output.some(item => item.type === 'text' && item.delta === 'still working'));
  history.panel.postError('live connection error');
  assert(!history.output.some(item => item.type === 'error' && item.message === 'live connection error'));
  history.panel.returnToConversation(); historyGate.resolve(); await reading;
  assert(!history.output.some(item => item.type === 'replay'));
  const snapshot = history.output.find(item => item.type === 'conversationSnapshot'); assert(snapshot.events.some(item => item.type === 'text' && item.delta === 'still working'));
  assert(snapshot.events.some(item => item.type === 'error' && item.message === 'live connection error'));

  const brokenHistory = fixture(); brokenHistory.panel.readHistory = async () => { throw new Error('history unavailable'); };
  await brokenHistory.panel.sendHistoryReplay('missing');
  assert(brokenHistory.output.some(item => item.type === 'error' && item.historical));
  assert(!brokenHistory.panel.liveTranscript.some(item => item.type === 'error'));
  await brokenHistory.panel.onWebviewMessage({ type: 'ready' });
  assert(!brokenHistory.output.some(item => item.type === 'conversationSnapshot'));

  const restore = fixture(); restore.panel.readHistory = async () => ({ result: { entries: [] }, via: 'door' }); restore.session.resume = async () => { throw new Error('not found'); };
  await restore.panel.resumeHistory('missing'); assert.equal(restore.panel.historyReadonly, true); await assert.rejects(restore.panel.send('unsafe'), /只读历史/);
  restore.panel.returnToConversation(); assert.equal(restore.panel.historyReadonly, false);

  const reopened = fixture(); reopened.panel.post({ type: 'user', text: 'persisted question' });
  reopened.panel.post({ type: 'assistant', id: 'persisted' }); reopened.panel.post({ type: 'text', id: 'persisted', delta: 'persisted answer' });
  await reopened.panel.onWebviewMessage({ type: 'ready' });
  assert(reopened.output.some(item => item.type === 'conversationSnapshot' && item.events.some(event => event.text === 'persisted question')));
  reopened.panel.readHistory = async () => ({ result: { entries: [{ kind: 'user', text: 'historical' }] }, via: 'door' });
  await reopened.panel.sendHistoryReplay('old'); const snapshotsBefore = reopened.output.filter(item => item.type === 'conversationSnapshot').length;
  await reopened.panel.onWebviewMessage({ type: 'ready' });
  assert.equal(reopened.output.filter(item => item.type === 'conversationSnapshot').length, snapshotsBefore);
  assert.equal(reopened.output.filter(item => item.type === 'replay').length, 2);

  const switchingDraft = fixture(), savedDrafts = new Map(), oldFolder = vscode.workspace.getWorkspaceFolder;
  switchingDraft.panel.workspaceState = { get: key => savedDrafts.get(key), update: async (key, value) => savedDrafts.set(key, value) };
  switchingDraft.panel.workdir = () => 'C:/project/B';
  vscode.workspace.getWorkspaceFolder = uri => uri.fsPath.startsWith('C:/project/') ? {} : undefined;
  try {
    const leavingDraft = { version: 1, cwd: 'C:/project/A', savedAt: Date.now(), text: 'departing A', attachments: [] };
    await switchingDraft.panel.onWebviewMessage({ type: 'draft', draft: leavingDraft }); await switchingDraft.panel.draftWrites;
    assert.equal(savedDrafts.get(draftKey(leavingDraft.cwd)).text, 'departing A');
    assert.equal(savedDrafts.has(draftKey('C:/project/B')), false);
    for (const cwd of ['C:/outside', 'relative', 'C:/project/\0bad']) {
      await switchingDraft.panel.onWebviewMessage({ type: 'draft', draft: { ...leavingDraft, cwd } }); await switchingDraft.panel.draftWrites;
      assert.equal(savedDrafts.size, 1);
    }
    vscode.workspace.isTrusted = false;
    await switchingDraft.panel.onWebviewMessage({ type: 'draft', draft: { ...leavingDraft, text: 'untrusted old directory' } }); await switchingDraft.panel.draftWrites;
    assert.equal(savedDrafts.get(draftKey(leavingDraft.cwd)).text, 'departing A');
    savedDrafts.set(draftKey('C:/project/B'), { ...leavingDraft, cwd: 'C:/project/B', text: 'saved B', attachments: [{ kind: 'content', name: 'file', text: 'private' }] });
    switchingDraft.panel.postWorkspaceMeta();
    const restoreB = switchingDraft.output.at(-1), metaB = switchingDraft.output.at(-2);
    assert.equal(metaB.type, 'meta'); assert.equal(metaB.trusted, false);
    assert.equal(restoreB.type, 'draftRestore'); assert.equal(restoreB.cwd, metaB.cwd); assert.equal(restoreB.draft.text, 'saved B'); assert.deepEqual(restoreB.draft.attachments, []);
    switchingDraft.panel.postWorkspaceMeta('C:/project/empty');
    assert.equal(switchingDraft.output.at(-1).cwd, 'C:/project/empty'); assert.equal(switchingDraft.output.at(-1).draft, undefined);
  } finally { vscode.workspace.getWorkspaceFolder = oldFolder; vscode.workspace.isTrusted = true; }

  const capture = fixture(), captureGate = deferred(), finishes = [];
  capture.panel.workflow = { begin: async () => { await captureGate.promise; return { id: 'captured' }; }, finish: async (_turn, outcome) => { finishes.push(outcome); } };
  await capture.panel.acceptMessage({ requestId: 40, text: 'must not start after stop' });
  await tick(); await capture.panel.onWebviewMessage({ type: 'stop' }); captureGate.resolve(); await idle(capture.panel);
  assert.equal(capture.calls.length, 0); assert.deepEqual(finishes, ['failed']); assert.equal(capture.panel.queue.items[0].failed, true);
  assert.equal(capture.output.find(item => item.type === 'sendCompleted').cwd, 'C:/project');

  for (const phase of ['begin', 'finish']) {
    const recording = fixture(), recordingGate = deferred();
    recording.panel.workflow = {
      recording: false,
      begin: async function () { if (phase === 'begin') { this.recording = true; await recordingGate.promise; this.recording = false; } return {}; },
      finish: async function () { if (phase === 'finish') { this.recording = true; await recordingGate.promise; this.recording = false; } },
    };
    await recording.panel.acceptMessage({ requestId: `${phase}-active`, text: 'first' }); await tick();
    assert(recording.panel.queue.active); assert.equal(recording.session.busy, false); assert(recording.panel.workflow.recording);
    assert.equal(await recording.panel.acceptMessage({ requestId: `${phase}-queued`, text: 'second' }), true, `Queue during ${phase}`);
    assert.equal(recording.panel.queue.items[0].text, 'second');
    recordingGate.resolve(); await idle(recording.panel);
    assert.deepEqual(recording.calls.map(item => item.text), ['first', 'second']);
  }
  const independentRecording = fixture(); independentRecording.panel.workflow = { recording: true };
  assert.equal(await independentRecording.panel.acceptMessage({ requestId: 'independent-recording', text: 'wait' }), false);
  assert.equal(independentRecording.panel.queue.items.length, 0);

  const blocked = fixture(); blocked.panel.workflow = { activeTest: {}, publish() {} };
  assert.equal(await blocked.panel.acceptMessage({ requestId: 41, text: 'during test' }), false);
  assert.equal(blocked.panel.queue.items.length, 0); assert(blocked.output.some(item => item.type === 'sendResult' && item.phase === 'rejected'));

  const invalid = fixture();
  for (const message of [{ requestId: 42, text: 'x'.repeat(256 * 1024 + 1) }, { requestId: 43, text: 'bad attachments', attachments: {} }, { requestId: 44, text: 'bad snapshot', attachments: [{ kind: 'content' }] }]) {
    assert.equal(await invalid.panel.acceptMessage(message), false);
    assert(invalid.output.some(item => item.type === 'sendResult' && item.requestId === message.requestId && item.phase === 'rejected' && item.success === false));
  }
  invalid.session.busy = true; await invalid.panel.acceptMessage({ requestId: 45, text: 'original request' });
  assert.equal(await invalid.panel.acceptMessage({ requestId: 45, text: 'different request' }), false);
  assert(invalid.output.some(item => item.type === 'sendResult' && item.requestId === 45 && item.phase === 'rejected'));
  assert.equal(invalid.panel.queue.items[0].text, 'original request');

  const reconnect = fixture(), commands = [], realCommand = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async id => { commands.push(id); };
  try {
    reconnect.session.busy = true; await reconnect.panel.onWebviewMessage({ type: 'errorAction', action: 'reconnect' });
    assert.equal(commands.length, 0); assert(reconnect.output.some(item => item.type === 'error' && /当前任务仍在运行/.test(item.message)));
    await reconnect.panel.onWebviewMessage({ type: 'errorAction', action: 'settings' }); await reconnect.panel.onWebviewMessage({ type: 'errorAction', action: 'log' });
    reconnect.session.busy = false;
    let recovered = 0; reconnect.panel.teardown = () => { recovered++; reconnect.panel.pauseQueue('recovery'); };
    reconnect.panel.postError('无法连接'); const recoveryScope = reconnect.output.filter(item => item.type === 'error').at(-1).human.recoveryScope;
    await reconnect.panel.onWebviewMessage({ type: 'errorAction', action: 'reconnect', recoveryScope, requestId: 'recover' });
    assert.deepEqual(commands, ['workbench.action.openSettings', 'dshPanel.showLog']); assert.equal(recovered, 1);
    assert(reconnect.output.some(item => item.type === 'recoveryResult' && item.requestId === 'recover' && item.success));
  } finally { vscode.commands.executeCommand = realCommand; }

  const configChange = fixture(), configGate = deferred(); let activeChanges = 0, maxChanges = 0;
  configChange.session.configOptions = [{ id: 'model', currentValue: 'old', options: [{ value: 'old' }, { value: 'new' }] }];
  configChange.session.setModel = async value => {
    activeChanges++; maxChanges = Math.max(maxChanges, activeChanges); configChange.calls.push(value);
    if (configChange.calls.length === 1) await configGate.promise;
    configChange.session.configOptions[0].currentValue = value === 'new' ? 'old' : value;
    activeChanges--;
  };
  const firstChange = configChange.panel.onWebviewMessage({ type: 'setModel', requestId: 'setting-1', value: 'new', cwd: 'C:/project', sessionId: 'original' });
  const nextChange = configChange.panel.onWebviewMessage({ type: 'setModel', requestId: 'setting-2', value: 'old', cwd: 'C:/project', sessionId: 'original' });
  await tick(); assert.deepEqual(configChange.calls, ['new']); assert.equal(configChange.session.configOptions[0].currentValue, 'old');
  assert.equal(configChange.output.filter(item => item.type === 'settingResult' && item.phase === 'pending').length, 2);
  await assert.rejects(configChange.panel.send('blocked during setting'), /设置/);
  await assert.rejects(configChange.panel.queueAction({ action: 'continue' }), /设置/);
  await assert.rejects(configChange.panel.newSession(), /设置/);
  assert.equal(await configChange.panel.reconnect(), false);
  configGate.resolve(); await Promise.all([firstChange, nextChange]); assert.equal(maxChanges, 1);
  assert.deepEqual(configChange.calls, ['new', 'old']); assert.equal(configChange.panel.configPending, 0);
  assert(configChange.output.some(item => item.type === 'settingResult' && item.requestId === 'setting-1' && item.success && item.currentValue === 'old'));
  configChange.session.setModel = async () => { throw new Error('configuration denied'); };
  await configChange.panel.onWebviewMessage({ type: 'setModel', requestId: 'setting-failed', value: 'new' });
  assert(configChange.output.some(item => item.type === 'settingResult' && item.requestId === 'setting-failed' && item.success === false));
  assert.equal(configChange.session.configOptions[0].currentValue, 'old');
  for (const cause of ['history', 'cwd', 'session', 'queue', 'test', 'undo', 'switch']) {
    const guarded = fixture(); let changed = 0; guarded.session.setModel = async () => { changed++; };
    const request = { type: 'setModel', value: 'new', requestId: cause, cwd: 'C:/project', sessionId: 'original' };
    if (cause === 'history') guarded.panel.historyReadonly = true;
    else if (cause === 'cwd') request.cwd = 'C:/other';
    else if (cause === 'session') request.sessionId = 'other';
    else if (cause === 'queue') guarded.panel.queue.active = { id: 'finishing' };
    else if (cause === 'test') guarded.panel.workflow = { activeTest: true };
    else if (cause === 'undo') guarded.panel.workflow = { undoing: true };
    else guarded.panel.newSessionPending = Promise.resolve();
    await guarded.panel.onWebviewMessage(request); assert.equal(changed, 0, cause);
    assert(guarded.output.some(item => item.type === 'settingResult' && item.phase === 'completed' && !item.success), cause);
  }
  const permission = fixture(); let permissionCalls = 0;
  permission.client.permissionSet = async () => { permissionCalls++; return { currentValue: 'read-only', options: [{ value: 'read-only' }, { value: 'full-access' }] }; };
  permission.session.busy = true;
  await permission.panel.onWebviewMessage({ type: 'setPermission', value: 'full-access', requestId: 'permission' });
  assert.equal(permissionCalls, 1); assert(permission.output.some(item => item.type === 'notice' && /仅可查看/.test(item.text)));
  assert(!permission.output.some(item => item.type === 'notice' && /完全权限/.test(item.text)));
  const failedPermission = fixture(), failedReadGate = deferred(); let failedPermissionCalls = 0, failedPermissionReads = 0;
  failedPermission.panel.refreshPermission = DshPanelView.prototype.refreshPermission;
  failedPermission.client.permissionSet = async () => {
    if (++failedPermissionCalls === 1) throw new Error('permission rejected');
    return { currentValue: 'read-only', options: [{ value: 'read-only' }] };
  };
  failedPermission.client.permissionGet = async () => {
    failedPermissionReads++;
    await failedReadGate.promise;
    return { currentValue: 'read-only', options: [{ value: 'read-only' }] };
  };
  const permissionFailure = failedPermission.panel.onWebviewMessage({ type: 'setPermission', value: 'full-access', requestId: 'permission-failed' });
  await tick();
  assert.equal(failedPermissionReads, 1);
  assert(failedPermission.panel.permissionPending);
  assert(!failedPermission.output.some(item => item.requestId === 'permission-failed' && item.phase === 'completed'), 'Failure stays pending until the actual permission readback finishes');
  await assert.rejects(failedPermission.panel.setPreset('ptc'), /设置/);
  await assert.rejects(failedPermission.panel.newSession(), /设置/);
  await assert.rejects(failedPermission.panel.resumeHistory('history'), /设置/);
  assert.equal(await failedPermission.panel.reconnect(), false);
  await failedPermission.panel.onWebviewMessage({ type: 'setPermission', value: 'full-access', requestId: 'permission-early-retry' });
  assert.equal(failedPermissionCalls, 1, 'A retry cannot run before the permission readback');
  const permissionPost = failedPermission.panel.post.bind(failedPermission.panel);
  let retryAfterCompletion;
  failedPermission.panel.post = message => {
    permissionPost(message);
    if (message.requestId === 'permission-failed' && message.phase === 'completed') {
      assert.equal(failedPermission.panel.permissionPending, null, 'Completed is published only after the backend unlocks');
      assert.equal(failedPermission.panel.permission.currentValue, 'read-only');
      retryAfterCompletion = failedPermission.panel.onWebviewMessage({ type: 'setPermission', value: 'full-access', requestId: 'permission-after-completed' });
    }
  };
  failedReadGate.resolve(); await permissionFailure; await retryAfterCompletion;
  const failedCompletion = failedPermission.output.find(item => item.requestId === 'permission-failed' && item.phase === 'completed');
  assert.equal(failedCompletion.success, false);
  assert(failedPermission.output.findIndex(item => item.type === 'permissionState') < failedPermission.output.indexOf(failedCompletion));
  assert.equal(failedPermissionCalls, 2); assert.equal(failedPermissionReads, 1, 'Failure reads actual permissions once; a confirmed retry needs no extra read');
  assert(failedPermission.output.some(item => item.requestId === 'permission-after-completed' && item.success));
  for (const cause of ['stop', 'close-view', 'new-source']) {
    const latePermission = fixture(), latePermissionRead = deferred(); let lateReads = 0;
    latePermission.panel.refreshPermission = DshPanelView.prototype.refreshPermission;
    latePermission.client.permissionSet = async () => { throw new Error('permission rejected'); };
    latePermission.client.permissionGet = async () => {
      lateReads++; await latePermissionRead.promise;
      return { currentValue: 'read-only', options: [] };
    };
    const lateFailure = latePermission.panel.onWebviewMessage({ type: 'setPermission', value: 'full-access', requestId: `late-permission-${cause}` });
    await tick();
    assert(!latePermission.output.some(item => item.requestId === `late-permission-${cause}` && item.phase === 'completed'), cause);
    if (cause === 'stop') await latePermission.panel.onWebviewMessage({ type: 'stop' });
    else if (cause === 'close-view') latePermission.panel.view = undefined;
    else latePermission.panel.session = { ...latePermission.session, sessionId: 'new-source' };
    latePermissionRead.resolve(); await lateFailure;
    assert.equal(latePermission.panel.permissionPending, null, cause);
    assert.equal(lateReads, 1, cause);
    assert(!latePermission.output.some(item => item.requestId === `late-permission-${cause}` && item.success), cause);
    if (cause === 'new-source') {
      assert(!latePermission.output.some(item => item.type === 'permissionState'));
      assert(latePermission.output.some(item => item.requestId === `late-permission-${cause}` && item.sessionId === 'original' && item.success === false));
    } else assert.equal(latePermission.panel.permission.currentValue, 'read-only', cause);
  }
  permission.panel.historyReadonly = true;
  await permission.panel.onWebviewMessage({ type: 'setPermission', value: 'full-access', requestId: 'history-permission' });
  assert.equal(permissionCalls, 1); assert(permission.output.some(item => item.requestId === 'history-permission' && item.success === false));
  const interruptedPermission = fixture(), permissionWait = deferred();
  interruptedPermission.client.permissionSet = async () => { await permissionWait.promise; return { currentValue: 'read-only', options: [] }; };
  interruptedPermission.session.busy = true;
  const changingPermission = interruptedPermission.panel.onWebviewMessage({ type: 'setPermission', value: 'full-access', requestId: 'stop-permission' });
  await tick(); await interruptedPermission.panel.onWebviewMessage({ type: 'stop' }); permissionWait.resolve(); await changingPermission;
  assert.equal(interruptedPermission.panel.permission.currentValue, 'read-only', 'Stopping the turn invalidates the request UI, but does not lose confirmed permission for the same session');
  assert(interruptedPermission.output.some(item => item.type === 'permissionState' && item.currentValue === 'read-only'));
  assert(!interruptedPermission.output.some(item => item.type === 'notice' && /内核已确认/.test(item.text)));
  const oldPermission = fixture(), permissionGate = deferred();
  oldPermission.panel.refreshPermission = DshPanelView.prototype.refreshPermission;
  oldPermission.client.permissionGet = async () => { await permissionGate.promise; return { currentValue: 'full-access', options: [] }; };
  const readingPermission = oldPermission.panel.refreshPermission(); oldPermission.panel.session = { ...oldPermission.session, sessionId: 'new' };
  permissionGate.resolve(); await readingPermission; assert(!oldPermission.output.some(item => item.type === 'permissionState'));
  const orderedPermission = fixture(), readGate = deferred(); let reads = 0;
  orderedPermission.panel.refreshPermission = DshPanelView.prototype.refreshPermission;
  orderedPermission.client.permissionGet = async () => { if (++reads === 1) { await readGate.promise; return { currentValue: 'full-access', options: [] }; } return { currentValue: 'read-only', options: [] }; };
  const oldRead = orderedPermission.panel.refreshPermission(); await orderedPermission.panel.refreshPermission(); readGate.resolve(); await oldRead;
  assert.equal(orderedPermission.panel.permission.currentValue, 'read-only');
  for (const cause of ['busy', 'queue', 'test', 'recording', 'undo', 'switch', 'connecting']) {
    const guarded = fixture(); let teardown = 0; guarded.panel.teardown = () => { teardown++; };
    if (cause === 'busy') guarded.session.busy = true;
    else if (cause === 'queue') guarded.panel.queue.active = { id: 'prepare' };
    else if (cause === 'switch') guarded.panel.newSessionPending = Promise.resolve();
    else if (cause === 'connecting') guarded.panel.connecting = Promise.resolve();
    else guarded.panel.workflow = { [cause === 'test' ? 'activeTest' : cause === 'undo' ? 'undoing' : 'recording']: true };
    assert.equal(await guarded.panel.reconnect(), false, cause); assert.equal(teardown, 0, cause);
  }
  const recovery = fixture(), recoveryGate = deferred(); let recoveries = 0;
  recovery.panel.queue.add(snapshotMessage('held draft', []), { cwd: 'C:/project', sessionId: 'original' }, 'held');
  recovery.panel.teardown = () => { recoveries++; recovery.panel.pauseQueue('recovering'); };
  recovery.panel.ensureConnection = async () => { await recoveryGate.promise; return recovery.session; };
  recovery.panel.historyReadonly = true; recovery.panel.historyId = 'past';
  const restoreOne = recovery.panel.reconnect({ requestId: 'restore-1' }), restoreTwo = recovery.panel.reconnect({ requestId: 'restore-2' });
  await tick(); assert.equal(recoveries, 1); await assert.rejects(recovery.panel.queueAction({ action: 'continue' }), /恢复/);
  assert(recovery.panel.queue.paused); recoveryGate.resolve(); await Promise.all([restoreOne, restoreTwo]);
  assert(recovery.panel.historyReadonly); assert.equal(recovery.panel.historyId, 'past'); assert(recovery.panel.queue.paused);
  assert(!recovery.output.some(item => item.type === 'reset')); assert.equal(recovery.calls.length, 0);
  assert.equal(recovery.output.filter(item => item.type === 'recoveryResult' && item.phase === 'completed' && item.success).length, 2);
  for (const cause of ['cwd', 'session', 'connection', 'session-object', 'session-id']) {
    const staleRecovery = fixture(); let teardown = 0; staleRecovery.panel.teardown = () => { teardown++; };
    staleRecovery.panel.postError('无法连接'); const scope = staleRecovery.output.at(-1).human.recoveryScope;
    if (cause === 'cwd') staleRecovery.panel.workdir = () => 'C:/other';
    else if (cause === 'session') staleRecovery.panel.contextSessionSerial++;
    else if (cause === 'session-object') staleRecovery.panel.session = { ...staleRecovery.session };
    else if (cause === 'session-id') staleRecovery.session.sessionId = 'other';
    else staleRecovery.panel.recoveryGeneration++;
    await staleRecovery.panel.onWebviewMessage({ type: 'errorAction', action: 'reconnect', recoveryScope: scope, requestId: cause });
    assert.equal(teardown, 0, cause); assert(staleRecovery.output.some(item => item.requestId === cause && item.success === false), cause);
  }
  const failedRecovery = fixture(); failedRecovery.panel.teardown = () => {}; failedRecovery.panel.ensureConnection = async () => { throw new Error('connection refused'); };
  assert.equal(await failedRecovery.panel.reconnect({ requestId: 'failed-recovery' }), false); assert.equal(failedRecovery.panel.reconnectPending, null);
  failedRecovery.panel.ensureConnection = async () => failedRecovery.session;
  assert.equal(await failedRecovery.panel.reconnect({ requestId: 'retry-recovery' }), true); assert.equal(failedRecovery.calls.length, 0);
  const sharedTurn = fixture(); let disconnects = 0; sharedTurn.panel.teardown = () => { disconnects++; };
  sharedTurn.panel.connections.turns.set('another-surface-session', Promise.resolve());
  assert.equal(await sharedTurn.panel.reconnect(), false); assert.equal(disconnects, 0);

  const cancelledRestore = fixture(), replayGate = deferred(); let resumed = 0, resets = 0;
  cancelledRestore.panel.workflow = { reset() { resets++; }, publish() {} };
  cancelledRestore.panel.readHistory = async () => { await replayGate.promise; return { result: { entries: [] }, via: 'door' }; };
  cancelledRestore.session.resume = async () => { resumed++; };
  const restoring = cancelledRestore.panel.resumeHistory('will-cancel'); await tick(); cancelledRestore.panel.returnToConversation(); replayGate.resolve();
  assert.equal(await restoring, false); assert.equal(resumed, 0); assert.equal(resets, 0);
  cancelledRestore.panel.readHistory = async () => ({ result: { entries: [] }, via: 'door' }); cancelledRestore.session.resume = async () => { throw new Error('failed'); };
  await cancelledRestore.panel.resumeHistory('failed'); assert.equal(resets, 0);

  for (const navigation of ['other-history', 'current']) {
    const navigating = fixture(), resumeGate = deferred();
    navigating.panel.post({ type: 'user', text: 'original conversation' });
    navigating.panel.readHistory = async (_type, id) => ({ result: { card: { id }, entries: [{ kind: 'user', text: id }] }, via: 'door' });
    navigating.session.resume = async id => { await resumeGate.promise; navigating.session.sessionId = id; };
    const resuming = navigating.panel.resumeHistory('restored'); await tick();
    if (navigation === 'other-history') await navigating.panel.sendHistoryReplay('reading');
    else navigating.panel.returnToConversation();
    resumeGate.resolve(); await resuming;
    assert.equal(navigating.session.sessionId, 'restored');
    assert.equal(navigating.panel.liveTranscript[0].card.id, 'restored');
    if (navigation === 'other-history') {
      assert.equal(navigating.panel.historyReadonly, true); assert.equal(navigating.panel.historyId, 'reading');
      assert.equal(navigating.output.filter(item => item.type === 'replay').at(-1).card.id, 'reading');
      await assert.rejects(navigating.panel.send('must remain readonly'), /只读历史/);
      navigating.panel.returnToConversation();
    }
    assert.equal(navigating.panel.historyReadonly, false);
    assert.equal(navigating.output.filter(item => item.type === 'conversationSnapshot').at(-1).events[0].card.id, 'restored');
  }

  const bounded = fixture(); bounded.panel.post({ type: 'assistant', id: 'same' });
  for (let n = 0; n < 100; n++) bounded.panel.post({ type: 'tool', id: 'same', tool: { toolCallId: 'tool-1', status: n === 99 ? 'completed' : 'in_progress' } });
  assert.equal(bounded.panel.liveTranscript.filter(item => item.type === 'tool').length, 1);
  bounded.panel.post({ type: 'user', text: 'large prior turn' }); bounded.panel.post({ type: 'assistant', id: 'large' });
  bounded.panel.post({ type: 'text', id: 'large', delta: 'x'.repeat(4 * 1024 * 1024) });
  bounded.panel.post({ type: 'user', text: 'newest question' }); bounded.panel.post({ type: 'assistant', id: 'newest' });
  bounded.panel.post({ type: 'text', id: 'newest', delta: 'y'.repeat(4 * 1024 * 1024) });
  assert(bounded.panel.liveTranscriptTruncated); assert(bounded.panel.liveTranscriptBytes <= 8 * 1024 * 1024);
  assert(bounded.panel.liveTranscript.some(item => item.text === 'newest question'));
  bounded.panel.setLiveTranscript([{ type: 'replay', readonly: false, entries: [
    { kind: 'user', text: 'old replay question' }, { kind: 'assistant', text: 'a'.repeat(5 * 1024 * 1024) },
    { kind: 'user', text: 'latest replay question' }, { kind: 'assistant', text: 'b'.repeat(4 * 1024 * 1024) },
  ] }]);
  assert(bounded.panel.liveTranscriptTruncated); assert(bounded.panel.liveTranscriptBytes <= 8 * 1024 * 1024);
  assert.equal(bounded.panel.liveTranscript[0].entries[0].text, 'latest replay question');

  const mode = fixture(); mode.panel.turnSent = true;
  mode.panel.onPresets({ presets: [{ id: 'actual' }, { id: 'next' }], current: 'actual' }); await mode.panel.setPreset('next');
  const preset = mode.output.filter(item => item.type === 'presets').at(-1); assert.equal(preset.current, 'actual'); assert.equal(preset.pending, 'next');
  mode.panel.pushSnapshot(); assert.equal(mode.output.filter(item => item.type === 'presets').at(-1).pending, 'next');

  const meta = (current, requested) => ({ configOptions: [], _meta: { 'dsh-door': { presets: [{ id: 'actual' }, { id: 'next' }, { id: 'historical' }], current, requested } } });
  const reconnectMode = fixture(), originalConnect = net.connect;
  reconnectMode.panel.currentPreset = 'actual'; reconnectMode.panel.preset = 'next'; reconnectMode.panel.resumeTarget = 'original';
  reconnectMode.panel.config = () => ({ hostAccepted: true, host: '127.0.0.1', port: 1, autoStart: false });
  reconnectMode.panel.connections.connect = async () => reconnectMode.client; reconnectMode.panel.connections.setStatus = () => {};
  reconnectMode.client.doorStatus = async () => ({});
  let reconnectPreset;
  reconnectMode.client.resumeSession = async (_id, _cwd, { preset }) => { reconnectPreset = preset; return meta(preset, preset); };
  net.connect = () => { const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.destroy = () => {}; queueMicrotask(() => socket.emit('connect')); return socket; };
  try { await reconnectMode.panel.connectInternal(); } finally { net.connect = originalConnect; }
  assert.equal(reconnectPreset, 'actual');
  assert.equal(reconnectMode.panel.currentPreset, 'actual'); assert.equal(reconnectMode.panel.preset, 'next');
  assert.equal(reconnectMode.output.filter(item => item.type === 'presets').at(-1).pending, 'next');

  for (const originalPreset of ['historical', undefined]) {
    const historyMode = fixture(); historyMode.panel.turnSent = true;
    historyMode.panel.onPresets({ presets: [{ id: 'actual' }, { id: 'next' }, { id: 'historical' }], current: 'actual' }); await historyMode.panel.setPreset('next');
    historyMode.panel.readHistory = async () => ({ result: { card: { preset: originalPreset }, entries: [] }, via: 'door' });
    let requested;
    historyMode.session.resume = async (id, _cwd, { preset }) => { requested = preset; historyMode.session.sessionId = id; historyMode.session.doorMeta = meta('historical', preset)._meta['dsh-door']; historyMode.panel.onPresets(historyMode.session.doorMeta); };
    await historyMode.panel.resumeHistory('past');
    assert.equal(requested, originalPreset); assert.equal(historyMode.panel.currentPreset, 'historical'); assert.equal(historyMode.panel.preset, 'next');
    assert.equal(historyMode.output.filter(item => item.type === 'presets').at(-1).pending, 'next');
  }
  const explicitMode = fixture(); explicitMode.panel.preset = 'next';
  explicitMode.panel.readHistory = async () => ({ result: { card: { preset: 'historical' }, entries: [] }, via: 'door' });
  explicitMode.session.resume = async (id, _cwd, { preset }) => {
    assert.equal(preset, 'next'); explicitMode.session.sessionId = id;
    explicitMode.session.doorMeta = meta('actual', preset)._meta['dsh-door']; explicitMode.panel.onPresets(explicitMode.session.doorMeta);
  };
  await explicitMode.panel.resumeHistory('explicit', { preset: 'next' });
  assert.equal(explicitMode.panel.currentPreset, 'actual'); assert.equal(explicitMode.panel.preset, 'next');
  const unknownMode = fixture(); unknownMode.panel.turnSent = true;
  unknownMode.panel.onPresets({ presets: [{ id: 'actual' }, { id: 'next' }], current: 'actual' }); await unknownMode.panel.setPreset('next');
  unknownMode.panel.readHistory = async () => ({ result: { card: {}, entries: [] }, via: 'door' });
  unknownMode.session.resume = async id => { unknownMode.session.sessionId = id; };
  await unknownMode.panel.resumeHistory('unknown-mode'); unknownMode.panel.pushSnapshot();
  const unknownPresets = unknownMode.output.filter(item => item.type === 'presets').at(-1);
  assert.equal(unknownPresets.current, undefined); assert.equal(unknownPresets.pending, 'next');

  for (const cause of ['cwd', 'session-object', 'session-id', 'view', 'trust', 'cancel', 'new-query', 'switch']) {
    const context = fixture(), readGate = deferred();
    let readSignal;
    context.panel.composer.select = async (_id, signal) => { readSignal = signal; await readGate.promise; return { kind: 'content', text: 'original body', name: 'code.js' }; };
    context.panel.composer.query = async () => ({ items: [], note: '' });
    const selecting = context.panel.onWebviewMessage({ type: 'composerSelect', id: 'candidate', requestId: cause, origin: 'context', source: 'search', cwd: 'C:/project' });
    await tick();
    if (cause === 'cwd') context.panel.workdir = () => 'C:/project/other';
    else if (cause === 'session-object') context.panel.session = { ...context.session };
    else if (cause === 'session-id') context.session.sessionId = 'another';
    else if (cause === 'view') context.panel.view = { ...context.panel.view };
    else if (cause === 'trust') vscode.workspace.isTrusted = false;
    else if (cause === 'cancel') await context.panel.onWebviewMessage({ type: 'composerCancel' });
    else if (cause === 'new-query') await context.panel.onWebviewMessage({ type: 'composerQuery', trigger: '@', query: 'new', requestId: 'replacement' });
    else await context.panel.changeSession(async () => false, 'context-switch');
    readGate.resolve(); await selecting;
    assert(!context.output.some(item => item.type === 'composerSelected' && item.requestId === cause && item.item), cause);
    if (cause === 'cancel' || cause === 'new-query') assert(readSignal.aborted, cause);
    vscode.workspace.isTrusted = true;
  }
  const directContext = fixture(); let selectedId, selectedOptions;
  directContext.panel.composer.query = async (_trigger, _query, _signal, options) => { assert.equal(options.source, 'file'); return { items: [{ id: 'whole-file' }] }; };
  directContext.panel.composer.select = async (id, _signal, options) => { selectedId = id; selectedOptions = options; return { kind: 'content', text: 'whole document', name: 'code.js' }; };
  await directContext.panel.onWebviewMessage({ type: 'contextAdd', source: 'file', requestId: 'add-whole', cwd: 'C:/project' });
  const added = directContext.output.find(item => item.type === 'composerSelected');
  assert.equal(selectedId, 'whole-file'); assert.equal(selectedOptions.origin, 'context');
  assert.equal(added.cwd, 'C:/project'); assert.equal(added.sessionId, 'original'); assert.equal(added.origin, 'context'); assert.equal(added.item.text, 'whole document');
  assert.equal(directContext.calls.length, 0);
  await directContext.panel.onWebviewMessage({ type: 'composerCommand', origin: 'context', id: 'command:stop', requestId: 'no-command' });
  assert(directContext.output.some(item => item.requestId === 'no-command' && /不能执行命令/.test(item.error)));
  const revealSnapshot = fixture(), revealGate = deferred();
  revealSnapshot.panel.reveal = async () => revealGate.promise;
  const originalAttachment = { kind: 'selection', text: 'before reveal', name: 'code.js', sourcePath: 'C:/project/code.js', scope: 'selection', startLine: 2, endLine: 3, isDirty: true, snapshotAt: '2026-10-12T00:00:00.000Z' };
  const revealing = revealSnapshot.panel.attach([originalAttachment]);
  originalAttachment.text = 'changed after addition'; revealGate.resolve(); await revealing;
  const mounted = revealSnapshot.output.find(item => item.type === 'attach');
  assert.equal(mounted.items[0].text, 'before reveal'); assert.equal(mounted.items[0].sourcePath, 'C:/project/code.js');
  assert.equal(mounted.items[0].startLine, 2); assert.equal(mounted.cwd, 'C:/project'); assert.equal(mounted.sessionId, 'original');
  for (const cause of ['cwd', 'session', 'view', 'trust']) {
    const revealRace = fixture(), revealWait = deferred();
    revealRace.panel.reveal = async () => revealWait.promise;
    const adding = revealRace.panel.attach([{ kind: 'content', text: 'original', name: 'code.js' }]);
    if (cause === 'cwd') revealRace.panel.workdir = () => 'C:/project/other';
    else if (cause === 'session') revealRace.session.sessionId = 'other';
    else if (cause === 'view') revealRace.panel.view = { ...revealRace.panel.view };
    else vscode.workspace.isTrusted = false;
    revealWait.resolve(); await assert.rejects(adding, /重新添加上下文/, cause);
    assert(!revealRace.output.some(item => item.type === 'attach'), cause);
    vscode.workspace.isTrusted = true;
  }
  const firstEditor = fixture(); firstEditor.panel.view = undefined; firstEditor.panel.session = undefined;
  firstEditor.panel.composer.fromEditor = async (_editor, wanted) => { assert.equal(wanted, 'file'); return { kind: 'content', scope: 'file', name: 'code.js', text: 'first editor snapshot' }; };
  firstEditor.panel.reveal = async () => {
    firstEditor.panel.view = { webview: { postMessage: async message => firstEditor.output.push(structuredClone(message)) } };
    firstEditor.panel.session = firstEditor.session;
    firstEditor.session.emit('session', { sessionId: firstEditor.session.sessionId });
  };
  await firstEditor.panel.addEditorContext({}, 'file');
  assert(firstEditor.output.some(item => item.type === 'attach' && item.sessionId === 'original' && item.items[0].text === 'first editor snapshot'));
  assert.equal(firstEditor.calls.length, 0);
  for (const cause of ['explicit-switch', 'second-session', 'reconnecting']) {
    const firstRace = fixture(); firstRace.panel.view = undefined; firstRace.panel.session = undefined;
    if (cause === 'reconnecting') firstRace.panel.resumeTarget = 'previous-conversation';
    firstRace.panel.reveal = async () => {
      firstRace.panel.view = { webview: { postMessage: async message => firstRace.output.push(message) } };
      firstRace.panel.session = firstRace.session;
      firstRace.session.emit('session', { sessionId: 'original' });
      if (cause === 'explicit-switch') firstRace.panel.pauseQueue('explicit switch');
      if (cause === 'second-session') { firstRace.session.sessionId = 'second'; firstRace.session.emit('session', { sessionId: 'second' }); }
      if (cause === 'reconnecting') firstRace.panel.resumeTarget = undefined;
    };
    await assert.rejects(firstRace.panel.attach([{ kind: 'content', name: 'code.js', text: 'initial' }]), /重新添加上下文/, cause);
    assert(!firstRace.output.some(item => item.type === 'attach'), cause);
  }
  const grantEvent = vscode.workspace.onDidGrantWorkspaceTrust;
  const trustHandlers = new Set();
  vscode.workspace.onDidGrantWorkspaceTrust = callback => { trustHandlers.add(callback); return { dispose() { trustHandlers.delete(callback); } }; };
  const grantRace = fixture(), editorGate = deferred();
  vscode.workspace.onDidGrantWorkspaceTrust = grantEvent;
  let editorSignal;
  grantRace.panel.composer.fromEditor = async (_editor, _wanted, signal) => { editorSignal = signal; await editorGate.promise; return { kind: 'content', text: 'old trust body', name: 'code.js' }; };
  const oldTrustReading = grantRace.panel.addEditorContext({}, 'file');
  vscode.workspace.isTrusted = false; vscode.workspace.isTrusted = true;
  for (const callback of [...trustHandlers]) callback();
  editorGate.resolve(); await assert.rejects(oldTrustReading, /重新添加上下文/);
  assert(editorSignal.aborted); assert.equal(grantRace.panel.editorContextReads.size, 0);
  assert(!grantRace.output.some(item => item.type === 'attach'));
  const oldLink = fixture(); let diskReads = 0;
  const originalOpen = vscode.workspace.openTextDocument;
  vscode.workspace.openTextDocument = async () => { diskReads++; return { getText: () => 'late disk body' }; };
  try {
    await oldLink.panel.acceptMessage({ text: 'legacy', requestId: 'legacy-link', attachments: [{ kind: 'file', uri: 'file:///C:/project/code.js', name: 'code.js' }] });
    assert.equal(diskReads, 0); assert.equal(oldLink.calls.length, 0);
    assert(oldLink.output.some(item => item.type === 'sendResult' && item.phase === 'rejected' && /重新添加/.test(item.error)));
  } finally { vscode.workspace.openTextDocument = originalOpen; }

  const actionMethods = { test: 'run', cancelTest: 'cancel', previewTest: 'preview', attachTest: 'attach', prepareTest: 'prepare', logTest: 'supplement', taskTerminals: 'openTerminal' };
  for (const [action, method] of Object.entries(actionMethods)) {
    const evidence = fixture(); let received, providedLog;
    evidence.panel.tests = { [method]: async (identity, log) => {
      received = identity; providedLog = log; assert(identity.current());
      return { items: [{ id: 'test:execution', kind: 'content', scope: 'test', source: 'test', name: 'test result', text: 'native exit 1; terminal output unavailable' }], ...(action === 'prepareTest' ? { text: 'Prepare a repair and re-run tests after sending.' } : {}) };
    } };
    await evidence.panel.onWebviewMessage({ type: 'workflowAction', action, turnId: 'turn', testId: 'execution', requestId: action, cwd: 'C:/project', sessionId: 'original', logText: 'user supplied' });
    assert.equal(received.turnId, 'turn'); assert.equal(received.testId, 'execution'); assert.equal(received.requestId, action);
    if (action === 'logTest') assert.equal(providedLog, 'user supplied');
    const reply = evidence.output.find(item => item.type === 'workflowResult');
    assert.equal(reply.action, action); assert.equal(reply.requestId, action); assert.equal(reply.turnId, 'turn'); assert.equal(reply.testId, 'execution');
    assert.equal(reply.cwd, 'C:/project'); assert.equal(reply.sessionId, 'original'); assert.equal(reply.items[0].scope, 'test');
    assert(!evidence.output.some(item => item.type === 'attach' || item.type === 'user' || item.type === 'sendResult'));
    assert.equal(evidence.calls.length, 0); assert.equal(evidence.panel.queue.items.length, 0); assert.equal(evidence.panel.queue.active, undefined);
  }
  for (const cause of ['cwd', 'session-object', 'session-id', 'view', 'trust', 'epoch', 'trust-epoch', 'session-serial', 'history']) {
    for (const action of ['previewTest', 'attachTest', 'prepareTest', 'logTest']) {
      const lateEvidence = fixture(), evidenceGate = deferred(); let current;
      lateEvidence.panel.tests = { [actionMethods[action]]: async identity => {
        current = identity.current; await evidenceGate.promise;
        return { items: [{ kind: 'content', name: 'result', text: 'old evidence' }], text: 'old repair draft' };
      } };
      const pending = lateEvidence.panel.onWebviewMessage({ type: 'workflowAction', action, turnId: 'turn', testId: 'execution', requestId: `${action}-${cause}`, cwd: 'C:/project', sessionId: 'original' });
      await tick();
      if (cause === 'cwd') lateEvidence.panel.workdir = () => 'C:/project/other';
      else if (cause === 'session-object') lateEvidence.panel.session = { ...lateEvidence.session };
      else if (cause === 'session-id') lateEvidence.session.sessionId = 'other';
      else if (cause === 'view') lateEvidence.panel.view = { ...lateEvidence.panel.view };
      else if (cause === 'trust') vscode.workspace.isTrusted = false;
      else if (cause === 'epoch') lateEvidence.panel.queueEpoch++;
      else if (cause === 'trust-epoch') lateEvidence.panel.contextTrustEpoch++;
      else if (cause === 'session-serial') lateEvidence.panel.contextSessionSerial++;
      else lateEvidence.panel.historyReadonly = true;
      assert.equal(current(), false, `${action}/${cause}`);
      evidenceGate.resolve(); await pending;
      assert(!lateEvidence.output.some(item => item.type === 'workflowResult' || item.type === 'attach'), `${action}/${cause}`);
      assert.equal(lateEvidence.calls.length, 0); assert.equal(lateEvidence.panel.queue.items.length, 0);
      vscode.workspace.isTrusted = true;
    }
  }
  const invalidEvidence = fixture(); let inspected = 0;
  invalidEvidence.panel.tests = { preview: async () => { inspected++; throw new Error('该执行已被覆盖，请查看保留的执行。'); } };
  await invalidEvidence.panel.onWebviewMessage({ type: 'workflowAction', action: 'previewTest', requestId: 'expired', turnId: 'turn', testId: 'old', cwd: 'C:/project', sessionId: 'original' });
  assert.equal(inspected, 1); assert(invalidEvidence.output.some(item => item.type === 'workflowResult' && item.requestId === 'expired' && /覆盖/.test(item.error)));
  await invalidEvidence.panel.onWebviewMessage({ type: 'workflowAction', action: 'previewTest', turnId: 'turn', testId: 'old' });
  assert.equal(inspected, 1); assert(invalidEvidence.output.some(item => item.type === 'workflowResult' && /标识缺失/.test(item.error)));
  for (const stale of [{ cwd: 'C:/project/old' }, { sessionId: 'departed' }]) {
    await invalidEvidence.panel.onWebviewMessage({ type: 'workflowAction', action: 'previewTest', requestId: 'wrong-scope', ...stale });
    assert.equal(inspected, 1);
  }

  const staleCommand = fixture(); let commandsRun = 0;
  staleCommand.panel.executeComposerCommand = async () => { commandsRun++; };
  for (const stale of [{ cwd: 'C:/project/old' }, { sessionId: 'departed' }]) {
    await staleCommand.panel.onWebviewMessage({ type: 'composerCommand', id: 'command:model', requestId: 'old-command', ...stale });
  }
  assert.equal(commandsRun, 0);
  const modelChoice = vscode.window; const modelGate = deferred();
  vscode.window = { showQuickPick: async () => { await modelGate.promise; return { value: 'new-model' }; } };
  try {
    const modelRace = fixture(); modelRace.session.configOptions = [{ id: 'model', options: [{ value: 'new-model' }] }];
    modelRace.panel.setModel = async () => { commandsRun++; };
    const choosingModel = modelRace.panel.onWebviewMessage({ type: 'composerCommand', id: 'command:model', requestId: 'model-race', cwd: 'C:/project', sessionId: 'original' });
    await tick(); modelRace.panel.queueEpoch++; modelGate.resolve(); await choosingModel;
    assert.equal(commandsRun, 0); assert(!modelRace.output.some(item => item.type === 'composerSelected'));
    const currentCommand = fixture(); currentCommand.session.configOptions = [{ id: 'model', currentValue: 'new-model', options: [{ value: 'new-model' }] }];
    currentCommand.panel.setModel = async value => { assert.equal(value, 'new-model'); commandsRun++; };
    await currentCommand.panel.onWebviewMessage({ type: 'composerCommand', id: 'command:model', requestId: 'current-command', cwd: 'C:/project', sessionId: 'original' });
    assert.equal(commandsRun, 1);
    assert(currentCommand.output.some(item => item.type === 'composerSelected' && item.command && item.cwd === 'C:/project' && item.sessionId === 'original'));
    const activeCommand = fixture(); activeCommand.panel.queue.active = { id: 'preparing' };
    await activeCommand.panel.onWebviewMessage({ type: 'composerCommand', id: 'command:model', requestId: 'active-command' });
    assert(activeCommand.output.some(item => item.type === 'composerSelected' && /当前任务/.test(item.error)));
  } finally { vscode.window = modelChoice; }

  console.log('Panel usability: queue ordering, immutable context, failure retention, interruption boundaries, history isolation, mode truth and scoped test evidence passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
