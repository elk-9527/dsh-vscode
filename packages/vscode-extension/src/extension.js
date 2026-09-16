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
    // 改设置后让下次连接用新值；正在进行的会话不动。
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dshPanel')) {
        log('info', '设置已变更，下次新建/重连时生效');
      }
    }),
    { dispose: () => view.dispose() },
  );
}

function deactivate() {
  // 资源都在 subscriptions 里，VS Code 会替我们调 dispose。
}

module.exports = { activate, deactivate };
