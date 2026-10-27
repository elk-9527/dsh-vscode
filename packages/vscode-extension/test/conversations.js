'use strict';
const assert = require('node:assert/strict'), Module = require('node:module'), path = require('node:path');
const { EventEmitter } = require('node:events');
const storage = new Map(), panels = [], notices = [], cwd = path.resolve('build/conversation-fixture');
const uri = fsPath => ({ fsPath, toString: () => fsPath }), disposable = { dispose() {} };
const vscode = {
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath || '', ...parts)), file: uri }, ViewColumn: { Beside: -2 },
  workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(cwd) }], getWorkspaceFolder: () => ({ uri: uri(cwd) }), getConfiguration: () => ({ inspect: () => ({}), get() {} }) },
  window: {
    showInformationMessage: async text => notices.push(text),
    createWebviewPanel(type, title, position, options) {
      panels.forEach(panel => { panel.active = false; });
      const callbacks = [], output = [];
      const panel = { type, title, position, options, active: true, output,
        webview: { cspSource: 'fixture', asWebviewUri: value => value, onDidReceiveMessage: () => disposable, postMessage: async value => output.push(value) },
        onDidDispose: callback => { callbacks.push(callback); return disposable; }, reveal() { this.revealed = true; },
        dispose() { if (this.closed) return; this.closed = true; callbacks.forEach(fn => fn()); },
      };
      panels.push(panel); return panel;
    },
  },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
const { DshPanelView } = require('../src/panel/view');
const { ConversationPanels, MAX_CONVERSATIONS, CONVERSATION_VIEW } = require('../src/panel/conversations');
Module._load = load;
const { draftKey } = require('../src/panel/drafts');
const { commandChoices } = require('../src/workflow/commands');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test) { for (let i = 0; i < 100; i++) { if (test()) return; await tick(); } throw Error('Fixture did not settle'); }
const workspaceState = { get: key => storage.get(key), update: async (key, value) => storage.set(key, structuredClone(value)) };
let sequence = 0;
function makeView(options) {
  const view = new DshPanelView({ ...options, kernels: { live() {}, acquire() {}, release() {} } });
  view.workdir = () => cwd; view.config = () => ({}); view.refreshPermission = async () => {}; return view;
}
function connect(view) {
  const client = new EventEmitter(); client.isConnected = true; client.closedSessions = 0; client.closeSession = async () => { client.closedSessions++; };
  client.close = () => { client.isConnected = false; client.emit('close', 'fixture close'); };
  const session = new EventEmitter();
  Object.assign(session, { sessionId: 'session-' + ++sequence, cwd, client, messages: new Map(), configOptions: [], calls: [], busy: false, stopped: 0,
    dispose() { this.removeAllListeners(); }, stop() { this.stopped++; this.finish?.('cancelled'); },
    send(text) {
      this.calls.push(text); this.busy = true; this.emit('busy', { busy: true });
      return new Promise(resolve => { this.finish = (status = 'completed') => {
        if (!this.busy) return;
        this.emit('text', { id: this.sessionId, delta: text }); this.emit('done', { id: this.sessionId, status });
        this.busy = false; this.emit('busy', { busy: false }); resolve({ stopReason: status === 'cancelled' ? 'cancelled' : 'end_turn' });
      }; });
    },
  });
  view.session = session; view.client = client; view.connections.client = client; view.connections.status = { instanceId: 'shared-kernel' };
  view.ensureConnection = async () => view.session; view.wire(session, client); return session;
}
(async () => {
  const manager = new ConversationPanels({ vscode, options: { extensionUri: uri('extension'), workspaceState, log() {} }, createView: makeView, setup() {} });
  const source = makeView(manager.options); source.view = { webview: { postMessage: async () => true } };
  const original = connect(source); original.busy = true; source.openConversation = () => manager.open({ source });
  await source.onWebviewMessage({ type: 'send', requestId: 1, text: 'original queued message' });
  const epoch = source.queueEpoch;
  assert.equal(await source.newSession(), true);
  assert(original.busy); assert.equal(original.stopped, 0); assert.equal(source.client.closedSessions, 0);
  assert.equal(source.queueEpoch, epoch); assert.equal(source.queue.paused, false); assert.equal(source.queue.items[0].text, 'original queued message'); assert.equal(source.newSessionPending, null);
  const first = manager.windows.get(1).view, one = connect(first);
  assert.notEqual(first.connections, source.connections); assert.equal(panels[0].type, CONVERSATION_VIEW);
  assert(panels[0].webview.html.includes('data-conversation-slot="1"')); assert.equal(panels[0].options.retainContextWhenHidden, true);
  await first.reveal(); assert.equal(panels[0].revealed, true);
  await manager.open({ source }); const second = manager.windows.get(2).view, two = connect(second); assert.equal(manager.current(), second);
  await first.onWebviewMessage({ type: 'send', requestId: 1, text: 'first tab stream' });
  await second.onWebviewMessage({ type: 'send', requestId: 1, text: 'second tab stream' });
  await until(() => one.busy && two.busy); assert.notEqual(first.queue.active, second.queue.active);
  await first.onWebviewMessage({ type: 'stop' }); await until(() => !first.queue.active);
  assert.equal(one.stopped, 1); assert(two.busy); assert(original.busy);
  assert(first.liveTranscript.some(event => event.type === 'text' && event.delta === 'first tab stream'));
  assert(!second.liveTranscript.some(event => event.delta === 'first tab stream'));
  two.finish(); await until(() => !second.queue.active); assert(second.liveTranscript.some(event => event.delta === 'second tab stream'));
  const draft = text => ({ version: 1, cwd, savedAt: Date.now(), text, attachments: [] });
  await Promise.all([first.draftStore.set(draft('first draft')), second.draftStore.set(draft('second draft')), first.draftStore.flush(), second.draftStore.flush()]);
  assert.equal(storage.get(`dshPanel.conversation.1:${draftKey(cwd)}`).text, 'first draft');
  assert.equal(storage.get(`dshPanel.conversation.2:${draftKey(cwd)}`).text, 'second draft'); assert(!storage.has(draftKey(cwd)));
  panels[0].dispose(); assert(second.client.isConnected); assert(source.client.isConnected); assert(first.connections.closed); assert.equal(manager.windows.size, 1);
  const restored = vscode.window.createWebviewPanel(CONVERSATION_VIEW, 'restored', {}, {});
  await manager.open({ panel: restored, source, state: { conversationSlot: 1, conversationSessionId: 'restore-session', cwd } });
  const recovered = manager.windows.get(1).view;
  assert.equal(recovered.resumeTarget, 'restore-session'); assert.equal(recovered.draftStore.read(cwd).text, 'first draft'); assert.equal(recovered.connections.closed, false);
  const choices = commandChoices('', { busy: true }); assert.equal(choices.find(item => item.name === 'new').disabled, false); assert.equal(choices.find(item => item.name === 'model').disabled, true);
  while (manager.windows.size < MAX_CONVERSATIONS) await manager.open({ source });
  assert.equal(await manager.open({ source }), false); assert.equal(manager.windows.size, MAX_CONVERSATIONS); assert.equal(notices.length, 1);
  manager.dispose(); await Promise.all([...manager.retiring]); assert.equal(manager.windows.size, 0); assert(source.client.isConnected); assert.equal(original.stopped, 0);
  await assert.rejects(manager.open(), /关闭/); source.dispose();
  console.log('Concurrent tabs, busy routing, stream/stop/queue isolation, storage restoration, connection ownership and bounded disposal passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
