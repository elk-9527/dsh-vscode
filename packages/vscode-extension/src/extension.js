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
const { DshConnectionService } = require('./connection/service');
const { BridgeViews } = require('./bridge/views');
const { randomUUID } = require('node:crypto');
const { kernelManager } = require('./panel/kernel-manager');
const {
  runDshSync,
  redactSensitiveOutput,
  runningDesktopExecutables,
} = require('./door/locate');
const { preparePanelProfile } = require('./door/setup');
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

  // 自定义安装目录只有在桌面端运行时才能从进程路径发现；一旦发现便记在扩展自己的
  // globalState 中。之后桌面端关闭，面板仍能找到同一套 0.2 CLI 并自启 web 配置集。
  const DESKTOP_PATH_KEY = 'dshPanel.desktopExecutable';
  const rememberedDesktop = context.globalState.get(DESKTOP_PATH_KEY);
  const detectedDesktops = runningDesktopExecutables();
  if (detectedDesktops[0] && detectedDesktops[0] !== rememberedDesktop) {
    context.globalState.update(DESKTOP_PATH_KEY, detectedDesktops[0]);
  }
  const CLIENT_ID_KEY = 'dshPanel.bridge.clientId';
  const clientId = context.workspaceState.get(CLIENT_ID_KEY) || randomUUID();
  void context.workspaceState.update(CLIENT_ID_KEY, clientId);
  const connections = new DshConnectionService({ log, clientId });
  const view = new DshPanelView({
    extensionUri: context.extensionUri,
    log,
    connections,
    desktopExecutables: [rememberedDesktop, ...detectedDesktops].filter(Boolean),
  });
  const nativeViews = new BridgeViews({ context, connections, panel: view, log });
  context.subscriptions.push(connections);

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
     * 显式准备面板的命令行配置集：缺少时从 web 模板创建，随后安装或更新接入点。
     * desktop 配置集由桌面应用独占，CLI 不允许修改；因此这条命令只处理设置中的
     * fallbackProfile（默认 vscode-panel），不会碰桌面端正在使用的配置集。
     */
    vscode.commands.registerCommand('dshPanel.setupProfile', async () => {
      const profile = view.config().fallbackProfile;
      const stopped = kernelManager(log).disposeAll('准备或修复配置集');
      if (stopped) log('info', `准备配置前停止了 ${stopped} 个由面板启动的后台内核`);
      const candidates = view.candidatesFor(view.config());
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `正在准备 DSH 配置集 ${profile}`,
            cancellable: false,
          },
          async (progress) => {
            // 先找出真正可执行的一条；默认的裸 `dsh` 不在 PATH 时继续尝试 Desktop 0.2 入口。
            let command;
            const failures = [];
            for (const candidate of candidates) {
              progress.report({ message: `检测 ${redactSensitiveOutput(candidate)}` });
              await new Promise((resolve) => setImmediate(resolve));
              try {
                runDshSync({ command: candidate, args: ['--version'], timeoutMs: 15000 });
                command = candidate;
                break;
              } catch (error) {
                failures.push(error.message);
              }
            }
            if (!command) {
              throw new Error(
                `没有找到可运行的 DSH CLI。${failures.length ? `\n${failures.join('\n')}` : ''}`,
              );
            }
            progress.report({ message: '创建配置并同步插件…' });
            await new Promise((resolve) => setImmediate(resolve));
            return preparePanelProfile({ command, profile });
          },
        );
        const synced = Array.isArray(result.syncedPlugins) ? result.syncedPlugins.length : 0;
        const message = result.created
          ? `已创建 ${profile}，并同步 ${synced} 个桌面端插件。`
          : `已修复 ${profile}${synced ? `，并同步 ${synced} 个桌面端插件` : ''}。`;
        log('info', message);
        if (Array.isArray(result.skippedPlugins) && result.skippedPlugins.length > 0) {
          log(
            'warn',
            `以下插件使用本地或无法复现的来源，未自动同步：${result.skippedPlugins.map((item) => item.name).join('、')}`,
          );
        }
        const choice = await vscode.window.showInformationMessage(message, '重新连接');
        if (choice === '重新连接') await view.reconnect();
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        log('error', `准备配置失败：${redactSensitiveOutput(message)}`);
        const choice = await vscode.window.showErrorMessage(
          `无法准备 DSH 配置：${redactSensitiveOutput(message)}`,
          '查看日志',
        );
        if (choice === '查看日志') channel.show(true);
      }
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
  return Object.freeze({
    apiVersion: 1,
    listCapabilities: () => nativeViews.refresh(),
    getConnectionStatus: async () => (await connections.ensure()).doorStatus(),
    review: request => nativeViews.reviewRequest({ ...request, userInitiated: request?.userInitiated === true }),
  });
}

function deactivate() {
  /*
   * 窗口关闭时回收空闲的自启内核；有插件任务的内核继续完成任务，
   * 接入点在无连接且任务结束后的宽限期自行退出。
   */
  try {
    const count = kernelManager().disposeAll('VS Code 窗口关闭', { preserveBridgeRuns: true });
    if (count > 0) console.log(`[dsh-panel] 窗口关闭，回收 ${count} 个后台 DSH 内核`);
  } catch (error) {
    console.error(`[dsh-panel] 回收后台内核出错：${error && error.message ? error.message : error}`);
  }
}

module.exports = { activate, deactivate };
