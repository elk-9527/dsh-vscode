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
const { kernelManager } = require('./panel/kernel-manager');
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
      vscode.window.showInformationMessage('先打开一个文件。');
      return;
    }
    const item = DshPanelView.attachmentFromEditor(editor, view.workdir());
    if (!item) {
      vscode.window.showInformationMessage('这个编辑器拿不到文件路径。');
      return;
    }
    if (wanted === 'selection' && item.kind !== 'selection') {
      vscode.window.showInformationMessage('先选中一段代码。');
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
    /**
     * 「DSH：停掉后台内核」—— 面板自己拉起来的那个内核是常驻的
     * （视图关掉后还会留 10 分钟，好让面板重开时接着用）。想立刻收掉、
     * 或者想确认"到底还有没有我起的进程"，用这条命令。
     * 它只收**本扩展自己拉起来的**，绝不碰桌面端那个。
     */
    vscode.commands.registerCommand('dshPanel.stopKernel', () => {
      const stopped = kernelManager(log).disposeAll('用户手动停掉');
      const text = stopped > 0 ? `已停掉 ${stopped} 个后台 DSH。` : '没有本扩展拉起的后台 DSH。';
      log('info', text);
      vscode.window.showInformationMessage(text);
    }),
    /**
     * 「DSH：打开面板」—— 把侧边栏面板展开并聚焦。
     *
     * 为什么必须有这个命令：面板挂在活动栏里，得先发现那个图标才能点开。
     * 早上真机试的时候，扩展明明激活了，但"面板从来没被打开过"（日志里只有
     * 启动那一行）—— 找不到入口，就等于这东西不存在。所以补一条命令：
     * 命令面板里搜 "DSH" 就能进来。
     */
    vscode.commands.registerCommand('dshPanel.open', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
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
   * 第一次装上之后给一条提示。
   *
   * 理由同上：装完不重启/不留意，活动栏里多出来的图标很容易被忽略，
   * 用户看到的就是"装了个没用的东西"。只在**从没打开过面板**时提示一次，
   * 之后永远不再打扰（记在 globalState 里）。
   */
  const HINT_KEY = 'dshPanel.openHintShown';
  if (!context.globalState.get(HINT_KEY)) {
    context.globalState.update(HINT_KEY, true);
    log('info', '首次启动：提示用户面板在哪里');
    vscode.window
      .showInformationMessage(
        '面板已就绪：点活动栏的对话图标，或搜「DSH：打开面板」。',
        '现在就打开',
      )
      .then((choice) => {
        if (choice === '现在就打开') {
          return vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        }
        return undefined;
      });
  }

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
  /*
   * 窗口关了：把本扩展拉起来的后台内核全收掉，一个孤儿都不留。
   *
   * 注意区别：**视图销毁不收**（那只是释放引用，10 分钟宽限内重开面板还能
   * 接着用同一个内核），**窗口关闭才收**。见 src/panel/kernel-manager.js。
   */
  try {
    const count = kernelManager().disposeAll('VS Code 窗口关闭');
    if (count > 0) console.log(`[dsh-panel] 窗口关闭，收掉 ${count} 个后台 DSH 内核`);
  } catch (error) {
    console.error(`[dsh-panel] 收后台内核出错：${error && error.message ? error.message : error}`);
  }
}

module.exports = { activate, deactivate };
