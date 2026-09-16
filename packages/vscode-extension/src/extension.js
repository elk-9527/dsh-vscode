'use strict';

/**
 * DSH Panel 的入口。
 *
 * 这里只做三件事：建输出通道、注册侧边栏视图、注册命令。
 * 真正的逻辑在 panel/view.js 和 dsh/session.js 里 —— 那两个文件
 * 能在命令行里单独跑起来测试，方便在没有编辑器的情况下调 bug。
 */

const vscode = require('vscode');
const { DshPanelView, VIEW_ID } = require('./panel/view');
/**
 * 建一个带时间戳的输出通道。
 *
 * 为什么不只用 console.log：扩展宿主的控制台用户看不到，
 * 出问题时需要一条「用户自己能打开看」的通道。
 *
 * @param {vscode.OutputChannel} channel
 * @returns {(level: string, message: string) => void}
 */
function makeLogger(channel) {
  return (level, message) => {
    const stamp = new Date().toISOString().slice(11, 23);
    channel.appendLine(`${stamp} [${level}] ${message}`);
  };
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const channel = vscode.window.createOutputChannel('DSH Panel');
  const log = makeLogger(channel);
  log('info', `DSH Panel 启动（VS Code ${vscode.version}）`);

  const view = new DshPanelView({ extensionUri: context.extensionUri, log });

  /**
   * 把「当前编辑器」里的东西挂进面板。
   *
   * 两个命令（带上当前文件 / 带上选中的代码）走的是同一条路，
   * 区别只在编辑器有没有选区 —— 有选区就带选中的那几行，没有就带整个文件。
   *
   * @param {'file'|'selection'} wanted
   */
  async function attachFromEditor(wanted) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('DSH：先打开一个文件，再把内容带进对话。');
      return;
    }
    const item = DshPanelView.attachmentFromEditor(editor, view.workdir());
    if (!item) {
      vscode.window.showInformationMessage('DSH：这个编辑器里拿不到文件路径，带不进去。');
      return;
    }
    if (wanted === 'selection' && item.kind !== 'selection') {
      vscode.window.showInformationMessage('DSH：先选中一段代码，再执行「把选中的代码带进对话」。');
      return;
    }
    log('info', `带进对话：${item.kind} ${item.name}${item.detail ? `（${item.detail}）` : ''}`);
    await view.attach([item]);
  }

  context.subscriptions.push(
    channel,
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, {
      // 切到别的视图时不要把聊天记录丢掉 —— 对聊天面板来说这比省内存重要。
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dshPanel.newSession', async () => {
      await view.newSession();
    }),
    vscode.commands.registerCommand('dshPanel.reconnect', async () => {
      await view.reconnect();
    }),
    vscode.commands.registerCommand('dshPanel.showLog', () => {
      channel.show(true);
    }),
    // 编辑器上下文：右键菜单和命令面板都能用。
    vscode.commands.registerCommand('dshPanel.attachFile', () => attachFromEditor('file')),
    vscode.commands.registerCommand('dshPanel.attachSelection', () => attachFromEditor('selection')),
    // 改设置后让下次连接用新值；正在进行的会话不动。
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dshPanel')) {
        log('info', '设置已变更，下次新建/重连时生效');
      }
    }),
    { dispose: () => view.dispose() },
  );

  /*
   * 自检开关：设了 DSH_PANEL_AUTOFOCUS=1 时，启动后自动把面板打开一次。
   *
   * 为什么需要它：这个面板平时要点活动栏图标才会出现，而「点一下」这件事
   * 在无人值守时做不到。有了这个开关，就能在真编辑器里验证「装上了 → 激活了
   * → 面板真的能展开 → 真的连上了 DSH」整条路，而不是只靠我猜。
   * 不设这个环境变量时完全没有影响。
   */
  if (process.env.DSH_PANEL_AUTOFOCUS === '1') {
    log('info', '自检模式：1.5 秒后自动打开面板（DSH_PANEL_AUTOFOCUS=1）');
    setTimeout(() => {
      vscode.commands.executeCommand(`${VIEW_ID}.focus`).then(
        () => log('info', '自检：已请求展开面板'),
        (error) => log('error', `自检：展开面板失败 ${error && error.message ? error.message : error}`),
      );
    }, 1500);
  }
}

function deactivate() {
  // 资源都在 subscriptions 里，VS Code 会替我们调 dispose。
}

module.exports = { activate, deactivate };
