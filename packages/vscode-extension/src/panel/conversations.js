'use strict';

const { DshPanelView } = require('./view');
const { TurnWorkflow } = require('../workflow/turns');
const { WorkspaceTests } = require('../workflow/tests');

const CONVERSATION_VIEW = 'dshPanel.conversation';
const MAX_CONVERSATIONS = 8;
const validSlot = value => Number.isInteger(value) && value >= 1 && value <= MAX_CONVERSATIONS;

/** Each editor tab owns its connection, queue and bounded persistence slot. */
class ConversationPanels {
  constructor({ vscode, options, createView = options => new DshPanelView(options), setup = (view, slot) => {
    view.workflow = new TurnWorkflow({ vscode, panel: view, scheme: `dsh-turn-${slot}` });
    view.tests = new WorkspaceTests({ vscode, workflow: view.workflow });
    view.composer.busy = () => Boolean(view.controlBusy());
  } }) {
    Object.assign(this, { vscode, options, createView, setup });
    this.windows = new Map();
    this.retiring = new Set();
  }

  current() { return [...this.windows.values()].find(item => item.panel.active)?.view; }

  async open({ source, panel, state } = {}) {
    await Promise.all([...this.retiring]);
    if (this.disposed) throw new Error('对话窗口已关闭。');
    const requested = state?.conversationSlot;
    const slot = validSlot(requested) && !this.windows.has(requested) ? requested
      : Array.from({ length: MAX_CONVERSATIONS }, (_, i) => i + 1).find(value => !this.windows.has(value));
    if (!slot) {
      if (panel) panel.dispose();
      await this.vscode.window.showInformationMessage('最多同时打开 8 个独立对话标签页，请先关闭不再使用的对话。');
      return false;
    }
    const storage = this.options.workspaceState;
    const workspaceState = {
      get: key => storage?.get(`dshPanel.conversation.${slot}:${key}`),
      update: (key, value) => storage?.update(`dshPanel.conversation.${slot}:${key}`, value),
    };
    const target = panel || this.vscode.window.createWebviewPanel(CONVERSATION_VIEW, `DSH 对话 ${slot + 1}`,
      { viewColumn: this.vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
    let view;
    try { view = this.createView({ ...this.options, workspaceState, conversationSlot: slot }); }
    catch (error) { target.dispose(); throw error; }
    const item = { view, panel: target };
    this.windows.set(slot, item);
    const dispose = () => {
      if (this.windows.get(slot) !== item) return;
      this.windows.delete(slot);
      const flush = Promise.allSettled([view.draftStore?.flush(), view.queuePersistence?.writes]);
      this.retiring.add(flush);
      void flush.finally(() => this.retiring.delete(flush));
      for (const cleanup of [() => view.session?.stop(), () => view.tests?.dispose(), () => view.workflow?.dispose(), () => view.dispose()]) {
        try { cleanup(); } catch (error) { this.options.log('warn', `关闭对话时清理失败：${error.message}`); }
      }
    };
    target.onDidDispose(dispose);
    try {
      view.openConversation = () => this.open({ source: view });
      view.skillInvoke = source?.skillInvoke;
      if (source) { view.preset = source.wantedPreset(); view.sessionCwd = source.workdir(); }
      if (panel && validSlot(requested) && slot === requested) {
        if (typeof state.conversationSessionId === 'string' && state.conversationSessionId.length <= 512) view.resumeTarget = state.conversationSessionId;
        if (typeof state.cwd === 'string') view.sessionCwd = state.cwd;
      }
      view.reveal = async () => target.reveal(undefined, false);
      this.setup(view, slot);
      view.resolveWebviewView(target);
      return true;
    } catch (error) { dispose(); target.dispose(); throw error; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of [...this.windows.values()]) item.panel.dispose();
  }
}

module.exports = { ConversationPanels, CONVERSATION_VIEW, MAX_CONVERSATIONS };
