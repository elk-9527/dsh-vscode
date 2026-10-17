'use strict';
const assert = require('node:assert/strict');
const { registerChat } = require('../src/chat/participant');
const disposable = { dispose() {} }, commands = new Map(), calls = [], outputs = [], sessions = [];
let cancelled = false, currentRequest, callback;
const api = { createSession: async value => { calls.push(['create', value]); const handle = { id: String(sessions.length), cwd: value.cwd, sessionId: 's' + sessions.length }; sessions.push(handle); return handle; }, restoreSession: async value => { calls.push(['restore', value]); return sessions.find(item => item.sessionId === value.sessionId); }, closeSession: async value => calls.push(['close', value]), openPanel: async value => calls.push(['panel', value]), invokeCapability: async value => { calls.push(['capability', value]); return { mode: 'immediate', value: { groups: [{ title: 'Project', skills: [{ name: 'example', description: 'Example' }] }] } }; }, review: async value => { calls.push(['review', value]); return { result: { summary: 'Review', findings: [] } }; }, prompt: async (handle, text, options) => { currentRequest = options; calls.push(['prompt', handle, text]); options.onEvent({ type: 'text', delta: 'Reply' }); if (cancelled) callback(); return { session: handle, stopReason: 'end_turn' }; } };
const vscode = { chat: { createChatParticipant: (id, handler) => { assert.equal(id, 'dshPanel.dsh'); return { dispose() {} }; } }, Uri: { joinPath: (...items) => items.join('/') }, workspace: { workspaceFolders: [{ uri: { fsPath: 'workspace' } }], getWorkspaceFolder: () => ({ uri: { fsPath: 'workspace' } }) }, window: { showQuickPick: async items => items[0] }, commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; }, executeCommand: async id => calls.push(['command', id]) } };
const context = { subscriptions: [], extensionUri: 'extension' }, stream = { markdown: value => outputs.push(value), progress() {}, button: value => outputs.push(value) }, token = { isCancellationRequested: false, onCancellationRequested: fn => { callback = fn; return disposable; } };
(async () => {
  assert.equal(registerChat({ vscode: { chat: {} }, context, api }), undefined);
  const chat = registerChat({ vscode, context, api }); assert.equal(chat.participant.iconPath, 'extension/media/dsh.svg');
  const first = await chat.handler({ prompt: 'Hello' }, { history: [] }, stream, token); assert.equal(first.metadata.dsh.sessionId, 's0'); assert(outputs.includes('Reply')); assert(outputs.some(item => item.command === 'dshPanel.chat.openSession'));
  const history = [{ result: first }]; await chat.handler({ prompt: 'Again' }, { history }, stream, token); assert.equal(sessions.length, 1); assert(calls.some(item => item[0] === 'restore'));
  if (process.platform === 'win32') { await chat.handler({ prompt: 'Case alias' }, { history: [{ result: { metadata: { dsh: { ...first.metadata.dsh, cwd: 'WORKSPACE' } } } }] }, stream, token); assert.equal(sessions.length, 1, 'Drive and directory casing must not start another conversation'); }
  await commands.get('dshPanel.chat.openSession')(first.metadata.dsh); assert(calls.some(item => item[0] === 'panel' && item[1].sessionId === 's0'));
  const fresh = await chat.handler({ command: 'new', prompt: '' }, { history }, stream, token); assert.notEqual(fresh.metadata.dsh.sessionId, first.metadata.dsh.sessionId); assert(calls.some(item => item[0] === 'close'));
  await chat.handler({ command: 'skills', prompt: '' }, { history: [] }, stream, token); assert(outputs.some(item => typeof item === 'string' && item.includes('example')));
  await chat.handler({ command: 'review', prompt: '' }, { history: [] }, stream, token); assert.equal(calls.find(item => item[0] === 'review')[1].userInitiated, true);
  const before = calls.filter(item => item[0] === 'prompt').length; await chat.handler({ command: 'open-panel', prompt: '' }, { history }, stream, token); assert.equal(calls.filter(item => item[0] === 'prompt').length, before);
  cancelled = true; await chat.handler({ prompt: 'Cancel' }, { history }, stream, token); assert.equal(currentRequest.signal.aborted, true);
  cancelled = false; const pick = vscode.window.showQuickPick; vscode.workspace.workspaceFolders = [{ name: 'First', uri: { fsPath: 'workspace' } }, { name: 'Second', uri: { fsPath: 'second' } }];
  vscode.window.showQuickPick = async () => undefined; const beforePick = sessions.length; await chat.handler({ prompt: 'Choose' }, { history: [] }, stream, token); assert.equal(sessions.length, beforePick, 'Cancelling the workspace picker must not create a session');
  vscode.window.showQuickPick = async items => items[1]; const multi = await chat.handler({ prompt: 'Second' }, { history: [] }, stream, token); assert.equal(multi.metadata.dsh.cwd, 'second');
  vscode.window.showQuickPick = pick;
  console.log('Native Chat optional registration, streaming, history, new session, review, skills, cancellation and same-session panel handoff passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
