'use strict';

/**
 * DSH Panel 的入口。
 *
 * 本文件只承担三件事：创建输出通道、注册侧边栏视图、注册命令。
 * 主要逻辑位于 panel/view.js 与 dsh/session.js 中 —— 这两个文件
 * 可以在命令行中单独运行测试，便于在没有编辑器的情况下定位缺陷。
 */

const vscode = require('vscode');
const { DshPanelView, VIEW_ID } = require('./panel/view');
const { kernelManager } = require('./panel/kernel-manager');
/**
 * 创建一个带时间戳的输出通道。
 *
 * 不使用 console.log 的原因：扩展宿主的控制台对用户不可见，
 * 出现问题时需要一条用户可以直接打开的通道。
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
   * 将当前编辑器中的内容挂载到面板。
   *
   * 两个命令（带上当前文件 / 带上选中的代码）使用同一条代码路径，
   * 区别仅在于编辑器是否存在选区：存在选区时附带选中的若干行，否则附带整个文件。
   *
   * @param {'file'|'selection'} wanted
   */
  async function attachFromEditor(wanted) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('当前没有打开的文件。');
      return;
    }
    const item = DshPanelView.attachmentFromEditor(editor, view.workdir());
    if (!item) {
      vscode.window.showInformationMessage('当前编辑器无法获取文件路径。');
      return;
    }
    if (wanted === 'selection' && item.kind !== 'selection') {
      vscode.window.showInformationMessage('当前没有选中的代码。');
      return;
    }
    log('info', `带进对话：${item.kind} ${item.name}${item.detail ? `（${item.detail}）` : ''}`);
    await view.attach([item]);
  }

  context.subscriptions.push(
    channel,
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, {
      // 切换到其他视图时保留聊天记录：对聊天面板而言该需求优先于节省内存。
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
     * 「DSH：停止后台内核」—— 面板自行启动的内核为常驻进程
     * （视图关闭后仍保留 10 分钟，以便面板重新打开时继续使用）。若需要立即回收，
     * 或者需要确认是否残留由本扩展启动的进程，可使用这条命令。
     * 该命令只回收**本扩展自行启动的内核**，不涉及桌面端启动的内核。
     */
    vscode.commands.registerCommand('dshPanel.stopKernel', () => {
      const stopped = kernelManager(log).disposeAll('用户手动停止');
      const text = stopped > 0 ? `已停止 ${stopped} 个后台 DSH。` : '没有本扩展启动的后台 DSH。';
      log('info', text);
      vscode.window.showInformationMessage(text);
    }),
    /**
     * 「DSH：打开面板」—— 展开侧边栏面板并使其获得焦点。
     *
     * 需要该命令的原因：面板位于活动栏中，必须先找到对应图标才能打开。
     * 某次真机验证中，扩展已经激活，但面板从未被打开（日志中只有
     * 启动那一行）—— 缺少入口等同于该功能不存在。因此补充一条命令：
     * 在命令面板中搜索 "DSH" 即可进入。
     */
    vscode.commands.registerCommand('dshPanel.open', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    // 编辑器上下文：右键菜单与命令面板均可调用。
    vscode.commands.registerCommand('dshPanel.attachFile', () => attachFromEditor('file')),
    vscode.commands.registerCommand('dshPanel.attachSelection', () => attachFromEditor('selection')),
    // 修改设置后，下次连接使用新值；正在进行的会话不受影响。
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dshPanel')) {
        log('info', '设置已变更，将在下次新建或重连时生效');
      }
    }),
    { dispose: () => view.dispose() },
  );

  /*
   * 首次安装后给出一条提示。
   *
   * 理由同上：安装后若不重启编辑器或不加留意，活动栏中新增的图标容易被忽略，
   * 用户会认为扩展没有实际作用。仅在**从未打开过面板**时提示一次，
   * 之后不再提示（记录在 globalState 中）。
   */
  const HINT_KEY = 'dshPanel.openHintShown';
  if (!context.globalState.get(HINT_KEY)) {
    context.globalState.update(HINT_KEY, true);
    log('info', '首次启动：提示用户面板的位置');
    vscode.window
      .showInformationMessage(
        '面板已就绪：点击活动栏的对话图标，或在命令面板搜索「DSH：打开面板」。',
        '立即打开',
      )
      .then((choice) => {
        if (choice === '立即打开') {
          return vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        }
        return undefined;
      });
  }

  /*
   * 自检开关：设置 DSH_PANEL_AUTOFOCUS=1 时，启动后自动打开面板一次。
   *
   * 需要该开关的原因：该面板通常需要点击活动栏图标才会显示，而该点击操作
   * 在无人值守环境中无法完成。使用该开关后，可在真实编辑器中验证「安装完成 → 扩展激活
   * → 面板可展开 → 成功连接到 DSH」这条完整路径，而不依赖推测。
   * 未设置该环境变量时没有任何影响。
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
   * 窗口关闭：回收本扩展启动的全部后台内核，不残留孤儿进程。
   *
   * 注意区别：**视图销毁时不回收**（该操作只释放引用，10 分钟宽限期内
   * 重开面板仍可使用同一内核），**窗口关闭时才回收**。见 src/panel/kernel-manager.js。
   */
  try {
    const count = kernelManager().disposeAll('VS Code 窗口关闭');
    if (count > 0) console.log(`[dsh-panel] 窗口关闭，回收 ${count} 个后台 DSH 内核`);
  } catch (error) {
    console.error(`[dsh-panel] 回收后台内核出错：${error && error.message ? error.message : error}`);
  }
}

module.exports = { activate, deactivate };
