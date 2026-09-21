'use strict';

/**
 * 侧边栏面板。
 *
 * 职责共三项：
 * 1. 维持一条可用连接 —— 先连接桌面端的 ACP 接入点插件（dsh-acp-door），连接失败时按用户批准的
 *    策略在后台启动一个 DSH（共用同一份 $DSH_HOME）；
 * 2. 把 {@link DshSession} 的事件转换为 webview 消息；
 * 3. 把 webview 的消息转换为对会话的操作。
 *
 * 本文件是直接调用 vscode API 的少数位置之一（另一处是 extension.js），
 * 因此会话逻辑可以在命令行中单独测试。
 */

const vscode = require('vscode');
const path = require('node:path');
const os = require('node:os');
const { DoorClient } = require('../door/client');
const { DshSession } = require('../dsh/session');
const { describeError } = require('../dsh/errors');
// 权限预设：中文标签与失败说明（纯函数，见该文件开头关于清单不硬编码的说明）。
const { decorateOptions, currentLabel, explainPermissionFailure, DISPLAY_ONLY } = require('../dsh/permission');
const {
  probePort,
  dshCommandCandidates,
  explainKernelFailure,
  panelProfileCandidates,
  redactSensitiveOutput,
} = require('../door/locate');
const { resolveLoopbackHost } = require('../door/endpoint');
const { renderHtml, makeNonce } = require('../panel/html');
const localSessions = require('../dsh/sessions');
const { kernelManager } = require('../panel/kernel-manager');
const { readUserSetting } = require('./settings');

const VIEW_ID = 'dshPanel.chat';

/** target 是否位于 base 目录之内（Windows 上大小写不敏感，path.relative 会处理）。 */
function pathIsInside(target, base) {
  const rel = path.relative(base, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 该错误是否为「对端不存在此方法」（该插件 0.0.8 之前未提供的历史旁路方法）。 */
function isMissingMethod(error, text) {
  return Boolean(error && (error.code === -32601 || /-32601/.test(text)))
    || /method not found|不支持.*dsh-door\/sessions/i.test(String(text || ''));
}

class DshPanelView {
  /**
   * @param {object} options
   * @param {vscode.Uri} options.extensionUri
   * @param {(level: string, message: string) => void} options.log
   * @param {string[]} [options.spawnArgs] **仅供测试使用**：自启内核时额外附加的参数。
   *   生产路径始终为空数组 —— 正常启动不需要任何额外参数。测试用它附加一个
   *   `--patch`，把接入点指向其它端口，这样测试「从零启动」时不需要占用 47821
   *   （桌面端运行时该端口上已存在接入点，否则该测试只能跳过）。
   */
  constructor({ extensionUri, log, spawnArgs = [], kernels }) {
    this.extensionUri = extensionUri;
    this.log = log;
    this.spawnArgs = spawnArgs;
    /**
     * 后台内核的归属 —— 归**扩展**所有，不属于本视图（见 kernel-manager.js 开头）。
     *
     * 这一条是 2026-09-19 那次"对话进行数次后即断开"问题的结构性修复：原实现中视图一旦销毁
     * 就终止内核，而视图的销毁条件很常见（折叠侧边栏、拖动面板、重载窗口）。
     * 现在视图仅作为内核的"使用者"：销毁 = 释放引用，引用归零后仍保留宽限期，
     * 该期间重新打开面板会继续使用同一个内核。
     */
    this.kernels = kernels || kernelManager(log);
    /** @type {vscode.WebviewView|undefined} */
    this.view = undefined;
    /** @type {DoorClient|undefined} */
    this.client = undefined;
    /** @type {object|undefined} 0.0.14+ 接入点返回的不含凭据的诊断状态。 */
    this.doorStatus = undefined;
    /** @type {DshSession|undefined} */
    this.session = undefined;
    /** @type {{dispose: () => void}|undefined} 本扩展启动的后台 DSH。 */
    this.background = undefined;
    /** 防止并发重复连接。 */
    this.connecting = null;
    /**
     * 断线后需要恢复的会话 id。
     *
     * 需要该字段的原因：ACP 的 `session/resume` 经实测**能够恢复上下文**
     * （见 test/resume.js：断线后新连接执行 resume，会话仍记得断线前要求它记住的数字，
     * 而新建的会话无法回答该数字）。因此断线后不应静默切换为一个无记忆的新会话 ——
     * 那会使用户误认为该会话仍记得此前的对话，而实际上上下文已经丢失。
     * @type {string|undefined}
     */
    this.resumeTarget = undefined;
    /**
     * 接入现成的 DSH 之后，若该 DSH 无法切换权限 → 改用面板自行启动的 DSH。
     *
     * 原因（2026-09-19 深夜用户报告"修改之后无法切换权限了"）：
     * 面板默认先连接 `dshPanel.port`（47821）上现成的那台 —— 桌面端运行时该处即为
     * **桌面端的内核**，而桌面配置集中的 ACP 接入点插件（dsh-acp-door）版本为 0.0.7（该配置集由桌面端自行
     * 管理，面板无法修改），该版本没有权限方法，因此选择器只能显示「不可切换」。
     * 用户观察到的结果是「权限无法切换」，而非「哪个接入点版本过低」—— 因此此处不由用户
     * 自行判断：**无法切换权限时改用可切换权限的内核**（面板自行启动的那台使用较新的接入点插件）。
     *
     * 两个判定开关，不应随意置位：`ownKernelOnly` 仅在该路径中置位（置位后不再检查
     * 47821，避免反复切换）；`switchedKernel` 保证单个面板只切换一次。
     */
    this.ownKernelOnly = false;
    this.switchedKernel = false;
    /**
     * 自启时仅监测面板自身的端口（不把配置项所指端口上现成的旧版接入点视为启动成功）。
     * 仅在「接入的内核无法切换权限 → 改用面板自行启动的内核」这条路径中置位。
     */
    this.ownPortOnly = false;
    /**
     * 连接流程正在判定「是否改用可切换权限的内核」期间，暂不输出「无法切换权限」的提示。
     * 判定结束后由 connectInternal 调用 explainPermissionOnce 补充输出（仅在未切换时补充）。
     */
    this.quietPermissionNotice = false;
    /**
     * 下一段新对话使用的 agent preset（用户在面板中选择的值，或配置项中的默认值）。
     *
     * 该字段针对「下一段」而非「当前这段」的原因：内核不允许在会话开始之后更换预设
     * （实测报错 `agent-preset/locked`），这是内核的设计，而非本扩展未实现该功能。
     * 因此面板中更换预设的语义为：**下一段新对话**使用该预设。
     * @type {string|undefined}
     */
    this.preset = undefined;
    /**
     * 当前这段会话是否发送过消息。
     *
     * 仅用于判定「更换预设时是否可以直接重新开启一段会话」：尚未发送过消息的会话重新开启
     * 代价为零，用户不需要再次点击新建。
     */
    this.turnSent = false;
    /** 该插件最近一次上报的预设清单，用于界面重新加载时补发。 */
    this.lastPresets = undefined;
    /**
     * 最近一次读到的权限预设（该插件返回的原始载荷：`{currentValue, options}`）。
     *
     * 面板只缓存、不作为真值来源的原因：权限是**内核**的状态，面板只是它的一个视图。
     * 缓存仅用于两件事：界面重新加载时先补发上一次的结果（避免出现空白），
     * 以及查找中文标签。真值在每次会话确定后重新读取。
     * @type {{currentValue: string, options: Array<object>}|undefined}
     */
    this.permission = undefined;
    /**
     * 权限读取失败时的说明（该插件版本过低 / 配置集中未挂载权限服务 / 其它错误）。
     *
     * 这三种情况都**不属于面板故障**，因此不写入对话流作为报错，而是让选择器显示
     * 一句解释 —— 用户看到的是「此处无法切换的原因」，而不是整屏错误信息。
     * @type {{state: string, text: string, detail?: string}|undefined}
     */
    this.permissionUnavailable = undefined;
    /**
     * 已经在对话流中输出过一次的「读取失败」原因（'old-door' / 'no-service' / …）。
     *
     * 每种原因只输出一次：接入桌面端内核（该插件 0.0.7）时每次建立会话都会读取失败，
     * 每次都输出会造成冗余信息。断开重连时清除该字段（用户可能在此期间升级了该插件）。
     * @type {string|undefined}
     */
    this.permissionNotice = undefined;
    /**
     * 本轮连接中历史会话的读取来源：'door' | 'local' | undefined（尚未确定）。
     *
     * 缓存该字段是为了避免每次打开历史会话都发起一次注定失败的往返：该插件版本过低属于**常态**
     * （用户配置集中的该插件会被桌面端重写回旧版），第一次收到 -32601 之后即改用本地读取，
     * 本轮连接中不再向该插件查询。重连时清除，使已升级该插件的用户有机会恢复经由该插件读取。
     * @type {'door'|'local'|undefined}
     */
    this.historyVia = undefined;
    /** 每个客户端在面板层注册的 close 处理器；主动拆除前需要先移除。 */
    this.clientCloseHandlers = new WeakMap();
    /**
     * 等待用户作答的反向权限请求。面板被关闭时必须主动回“取消”，否则内核会一直
     * 等待一个已经不存在的 webview，当前模型回合也就永远无法结束。
     * @type {Map<number|string, {client: DoorClient, session: DshSession}>}
     */
    this.pendingPermissionRequests = new Map();
  }

  // ── 视图 ────────────────────────────────────────────

  /**
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const nonce = makeNonce();
    webview.html = renderHtml({
      cspSource: webview.cspSource,
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css')).toString(),
      markdownUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown.js')).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')).toString(),
      nonce,
    });
    webview.onDidReceiveMessage((message) => this.onWebviewMessage(message));
    webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.view = undefined;
      this.cancelPendingPermissionRequests(undefined, '面板已关闭');
      // 视图不再存在时释放“正在使用后台内核”的引用。会话连接本身暂时保留：
      // 宽限期内重新打开面板可以继续同一会话；宽限期到期后 manager 回收内核，
      // 正常的 close 处理会记录 resumeTarget，之后可恢复上下文。
      this.kernels.release(this);
      this.log('info', '面板视图已销毁，已释放后台 DSH 的使用引用');
    });
    // 宽限期内重新建立视图：重新声明正在使用该后台内核，取消原定回收计时。
    if (this.background) {
      const cfg = this.config();
      const owned = this.kernels.live(cfg.host, cfg.selfStartPort);
      if (owned && owned.background === this.background) this.kernels.acquire(this, owned);
    }
    this.log('info', '面板已打开');
  }

  /** 向界面发送一条消息（界面未打开时直接丢弃，不报错）。 */
  post(message) {
    const view = this.view;
    if (!view) return;
    view.webview.postMessage(message).then(undefined, (error) => {
      this.log('warn', `向界面发送消息失败：${error && error.message ? error.message : error}`);
    });
  }

  /**
   * 向界面报告一个错误，**同时将其转换为可读的中文说明**。
   *
   * 不能直接发送 `error.message` 的原因：内核的报错原样穿过 ACP，
   * 用户看到的会是一段英文 JSON（最典型的是 429 额度限制）。面板的作用
   * 即在于避免用户直接阅读该内容。错误分类由 `dsh/errors.js` 完成（纯函数，便于测试），
   * 此处只负责把「中文说明 + 原文」一并发送 —— 原文不做任何删减。
   */
  postError(message, human) {
    const shaped = human && human.title ? human : describeError(message);
    this.post({ type: 'error', message: shaped.raw || message, human: shaped });
  }

  // ── 界面发来的消息 ──────────────────────────────────

  async onWebviewMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    try {
      switch (message.type) {
        case 'ready': {
          // 界面可能刚打开，也可能被重新加载（会话仍然存在）——
          // 后一种情况需要补发当前状态，否则界面上没有内容。
          // 顶栏的工作目录不依赖连接，先发送。
          this.post({ type: 'meta', cwd: this.workdir() });
          const existing = this.session;
          await this.ensureConnection();
          if (existing) this.pushSnapshot();
          break;
        }
        case 'send':
          await this.send(message.text, message.attachments);
          break;
        case 'stop':
          this.session ? this.session.stop() : undefined;
          break;
        case 'newSession':
          await this.newSession();
          break;
        case 'setModel':
          await this.setModel(message.value);
          break;
        case 'setPreset':
          await this.setPreset(message.value);
          break;
        case 'setPermission':
          await this.setPermission(message.value);
          break;
        case 'refreshPermission':
          await this.refreshPermission();
          break;
        case 'permission':
          this.answerPendingPermission(message.requestId, message.optionId);
          break;
        case 'historyList':
          await this.sendHistoryList();
          break;
        case 'historyOpen':
          await this.sendHistoryReplay(message.id);
          break;
        case 'historyResume':
          await this.resumeHistory(message.id);
          break;
        case 'openLink':
          this.openLink(message.href);
          break;
        default:
          this.log('warn', `收到界面发来的未知消息：${message.type}`);
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      this.log('error', `处理界面消息时出错（${message.type}）：${text}`);
      this.postError(text);
      this.post({ type: 'busy', busy: false });
    }
  }

  openLink(href) {
    // 仅放行 http/https，其它协议（file:、command: …）不经过此处处理。
    if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) {
      this.log('warn', `拒绝打开非 http(s) 链接：${href}`);
      return;
    }
    vscode.env.openExternal(vscode.Uri.parse(href));
  }

  // ── 连接 ────────────────────────────────────────────

  config() {
    const cfg = vscode.workspace.getConfiguration('dshPanel');
    const read = (key, fallback) => readUserSetting(cfg, key, fallback);
    const endpoint = resolveLoopbackHost(read('host', '127.0.0.1'));
    const minutes = Number(read('kernelIdleMinutes', 10));
    // 面板自行启动的内核在"没有面板使用它"之后仍可存活的时间（默认 10 分钟）。
    // 设为 0 = 面板关闭时立即回收（旧行为）。视图只是使用者，内核由扩展管理 ——
    // 见 src/panel/kernel-manager.js。
    this.kernels.setIdleMs(
      Number.isFinite(minutes) && minutes >= 0 ? minutes * 60000 : 10 * 60000,
    );
    return {
      host: endpoint.host,
      hostAccepted: endpoint.accepted,
      port: read('port', 47821) || 47821,
      /**
       * 面板**自行**启动的内核所使用的接入点监听端口。
       *
       * 与 port 分开的原因：`port` 表示"连接哪一个接入点"（默认 47821，桌面端的接入点
       * 也监听该端口，存在接入点即连接）。而面板自启的内核一律使用自身端口 —— 此前它也占用
       * 47821，两个内核竞争同一端口时，竞争失败的一方不会开放监听，用户只能停留在"正在启动…"提示上持续等待。
       */
      selfStartPort: read('selfStartPort', 47831) || 47831,
      autoStart: read('autoStart', true) !== false,
      fallbackProfile: read('fallbackProfile', 'vscode-panel') || 'vscode-panel',
      dshCommand: read('dshCommand', 'dsh') || 'dsh',
      provider: read('provider', '') || '',
      model: read('model', '') || '',
      preset: read('preset', '') || '',
      cwd: read('cwd', '') || '',
    };
  }

  workdir() {
    // 使用 trim 之后的值：内核会拒绝空 cwd（"cwd must be an absolute path: "），
    // 而配置项中填入若干空格是常见情况 —— 该情况应当回退到工作区或主目录，
    // 而不是把一串空格作为路径发送。
    const configured = String(this.config().cwd || '').trim();
    if (configured) return configured;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return require('node:os').homedir();
  }

  /** 确保存在一条可用连接（可重复调用）。 */
  ensureConnection() {
    if (this.session) return Promise.resolve(this.session);
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInternal().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * 后备启动时需要尝试的候选命令（单独成方法：测试中可以隔离自动候选，
   * 仅测试「命令不可用」这一条路径）。
   */
  candidatesFor(cfg) {
    return dshCommandCandidates({ dshCommand: cfg.dshCommand, homedir: os.homedir() });
  }

  /**
   * 后备启动时需要尝试的候选配置集（同理：测试中可仅保留配置项中指定的那一个）。
   *
   * 需要尝试多个配置集的原因：`desktop` 配置集由桌面端独占，命令行无法启动
   * （2026-09-19 实测：`error: profile "desktop" is managed exclusively by the
   * Electron application`）。用户未修改过配置项时使用的正是该默认值，因此面板
   * 在"桌面端未运行"时必然无法启动 —— 而"桌面端未运行"正是最需要面板自行启动的
   * 情况。因此：先按配置项尝试，失败后在 `$DSH_HOME/profiles` 中查找已安装接入点插件、
   * 且不专属于桌面端的配置集继续尝试。
   */
  profilesFor(cfg) {
    return panelProfileCandidates({ configured: cfg.fallbackProfile, homedir: os.homedir() });
  }

  /**
   * 在后台启动 DSH：按候选命令逐个尝试，以最先开放接入点监听者为准。
   *
   * 采用「逐个尝试」而非仅使用配置项中那一条的原因：默认值为直接给出的命令 `dsh`，
   * 本机通常未将其放入 VS Code 可见的 PATH（用户遇到的面板启动失败即由此导致），
   * 仅尝试一条等同于要求用户「先启动桌面端才能使用面板」。候选清单见
   * {@link dshCommandCandidates}：配置项中填写的优先，其次是默认安装位置的
   * `node …/@deepseek-ai/dsh/lib/bin.js`。
   *
   * 等待时间：存在下一个候选时只等待 30 秒（无法启动的命令通常立即退出，
   * 不值得为其耗费两分钟）；最后一个候选等待满 120 秒 —— 真实内核冷启动也可能较慢。
   *
   * @returns {Promise<{ok: boolean, command?: string, detail?: string}>}
   */
  async spawnFallback(cfg) {
    // 顶栏只显示简短状态；"启动原因""使用哪个配置集"这类说明写入对话流。
    this.post({ type: 'status', state: 'connecting', detail: '正在启动…' });
    /*
     * 首先查询本扩展是否已在"面板自身的端口"上启动过仍在运行的内核。
     *
     * 这一段是"视图销毁不等于内核终止"的落实位置：面板关闭后重新打开，或者
     * 另一个 VS Code 窗口已经启动过一个内核时，都应当**继续使用**同一个进程，
     * 而不是再次启动一个（多启动的进程还会与该进程竞争端口）。
     *
     * 注意两点：
     * ① 查询的是 selfStartPort —— 面板启动的内核其接入点固定在端口上（不是 cfg.port，
     *    后者是桌面端内核的端口）。
     * ② 需要等待接入点真正开放监听之后再返回：内核仍在运行但接入点未监听（正在启动 /
     *    接入点启动失败）时直接返回"成功"，用户随后会遇到原因不明的握手失败。
     *    若等待不到接入点，则回收该内核并重新启动一个。
     */
    const reusable = this.kernels.live(cfg.host, cfg.selfStartPort);
    if (reusable) {
      const door = await this.waitForFallbackDoor(
        reusable.background && reusable.background.child,
        cfg.host,
        this.fallbackPorts(cfg),
        15000,
      );
      if (door.ok) {
        this.background = reusable.background;
        this.kernels.acquire(this, reusable);
        this.log('info', `面板自行启动的内核仍在运行（${cfg.host}:${door.port}），继续使用该内核，不重新启动`);
        this.post({ type: 'notice', text: '继续使用当前正在运行的 DSH。' });
        return { ok: true, command: reusable.command, profile: reusable.profile, port: door.port };
      }
      this.log('warn', '本扩展启动的内核仍在运行，但其接入点始终未开放监听 —— 回收该内核并重新启动');
      this.kernels.stop(reusable.key, '内核仍在运行但接入点未开放监听，重新启动');
    }

    const profiles = this.profilesFor(cfg);
    // 对话流中只保留一句最简说明；使用哪个配置集、等待多久只写入日志（用户不查看该内容）。
    this.post({ type: 'notice', text: '正在启动 DSH…' });
    this.log('info', `端口上不存在接入点，按配置自行启动一个 DSH 内核（配置集：${profiles[0]}，接入点固定为 ${cfg.host}:${cfg.selfStartPort}）`);

    const candidates = this.candidatesFor(cfg);
    if (candidates.length === 0) {
      return {
        ok: false,
        human: {
          title: '无法找到 DSH，无法自行启动。',
          advice: '在设置中指定 DSH 的安装位置，或先启动桌面端。',
          raw:
            '无法确定 DSH 的启动方式：设置 dshPanel.dshCommand 为空，' +
            '默认安装位置（~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js）也未找到。',
        },
      };
    }

    // 先按配置集、再按命令：同一配置集仅更换命令写法属于"最后手段"，而更换配置集往往
    // 才是真正的原因（配置项中指定的配置集无法启动）。
    const plans = [];
    for (const profile of profiles) {
      for (const command of candidates) plans.push({ profile, command });
    }

    const failures = [];
    const kinds = new Set();
    for (let i = 0; i < plans.length; i += 1) {
      const { profile, command } = plans[i];
      const hasMore = i + 1 < plans.length;
      // 逐项尝试候选命令只写入日志，顶栏不需要随之变化。
      this.log('info', `尝试启动：${redactSensitiveOutput(command)}（配置集：${profile}）`);
      let entry;
      try {
        // 交由 manager 启动并登记：这样"视图销毁"不会终止该进程，另一个窗口也可以复用。
        // 接入点固定在面板自身的端口上（该插件读取 DSH_ACP_DOOR_PORT，见 dsh-door/lib/port.js）。
        // 配置集中的 port 是**默认值**，不是命令；内核由哪一方启动，端口即由该方决定。
        entry = this.kernels.spawn({
          host: cfg.host,
          port: cfg.selfStartPort,
          command,
          profile,
          log: this.log,
          extraArgs: this.spawnArgs,
        });
      } catch (error) {
        failures.push(`「${redactSensitiveOutput(command)}」无法启动：${this.errText(error)}`);
        continue;
      }
      const background = entry.background;
      this.background = background;
      const outcome = await this.waitForFallbackDoor(
        background.child,
        cfg.host,
        this.fallbackPorts(cfg),
        hasMore ? 30000 : 120000,
      );
      if (outcome.ok) {
        // 启动成功：该内核归本视图使用（引用计数 +1）。
        // 接入点实际监听的端口即为连接端口（旧版接入点只识别该配置集配置的端口）。
        this.kernels.acquire(this, entry);
        if (outcome.port !== cfg.selfStartPort) {
          this.log('warn', `该配置集中的接入点未识别端口设置，监听在 ${outcome.port}（该配置集中的接入点插件为旧版）`);
        }
        return { ok: true, command, profile, port: outcome.port };
      }
      // 启动失败：回收该进程之后再尝试下一条（killTree 同时终止子进程，不遗留孤儿进程）。
      // 回收之前先取出该进程自身输出的最后几行 —— 失败原因位于其中。
      const stderr = typeof background.stderrTail === 'function' ? background.stderrTail() : '';
      const explained = explainKernelFailure({ profile, stderr });
      this.kernels.stop(entry.key, '自启失败，改用其它配置集重试');
      this.background = undefined;
      kinds.add(explained.kind);
      if (stderr) this.log('warn', `内核退出原因（${profile}）：${stderr.split('\n')[0]}`);
      failures.push(
        fallbackFailureText({
          command,
          profile,
          host: cfg.host,
          port: cfg.port,
          exitedEarly: outcome.exitedEarly,
          stderr,
          explained,
        }),
      );
      if (!hasMore) break;
    }

    return {
      ok: false,
      human: {
        title: '无法启动 DSH',
        advice: fallbackAdvice(kinds),
        raw:
          `启动 DSH 内核失败（共尝试 ${plans.length} 种启动方式）：\n` +
          failures.join('\n\n'),
      },
    };
  }

  /**
   * 等待后备启动的内核开放接入点监听；该进程**启动后立即退出**时提前报告。
   *
   * 不能只等待 waitForPort 的原因：命令有误（最典型的是 dsh 不在 PATH 中、
   * 或者 dshPanel.dshCommand 填写了不存在的路径）时，进程会立即退出，
   * 而 waitForPort 会持续等待满 120 秒 —— 用户停留在"正在后台启动 DSH…"提示上
   * 等待两分钟，最终只得到"接入点未监听"的结论，且需要自行推测原因。
   * 进程既已退出，继续等待没有意义。
   *
   * `port` 可以是单个端口，也可以是端口列表：面板将接入点端口固定为 `selfStartPort`
   * （通过环境变量），但**用户配置集中的接入点插件可能仍是旧版**（不识别该环境变量），该情况下
   * 只会在该配置集配置的端口上监听。仅监测一个端口时，该情况会表现为"内核已经启动，
   * 却等待满两分钟仍报告接入点未监听"，而接入点实际监听在另一个端口上。因此：以先开放监听者为准，
   * 返回值中的 `port` 即为实际连接的端口。
   *
   * `timeoutMs` 仅用于使测试能在数秒内进入"等待超时"分支 ——
   * 生产路径不传入该参数，取值为两分钟。
   */
  /**
   * 面板自行启动内核时，监测哪些端口以等待接入点开放监听。
   *
   * 默认监测两个：**面板自身的端口**（`selfStartPort`，较新的接入点插件识别该环境变量、
   * 会在该端口监听）和配置项中的端口（`dshPanel.port`）—— 旧版接入点插件不识别环境变量，
   * 只在该配置集配置的端口上监听，同时监测两者才不至于等待满两分钟。
   *
   * 例外：`ownPortOnly`（"接入的内核无法切换权限，改用面板自行启动的内核"这条路径）。
   * 该情况下**仅监测面板自身的端口** —— 否则配置项所指端口上现成的旧版接入点会被判定为"新内核已启动完成"，
   * 从而再次接入同一内核，切换未能生效（2026-09-20 真实窗口自检发现的问题即为该情况：
   * 日志中记录了该配置集的接入点插件未识别端口设置、监听在 47821 的事实，接入的仍是桌面端的内核）。
   */
  fallbackPorts(cfg) {
    if (this.ownPortOnly) return [cfg.selfStartPort];
    return [cfg.selfStartPort, cfg.port];
  }

  async waitForFallbackDoor(child, host, port, timeoutMs = 120000) {
    let exit = null;
    const onExit = (code, signal) => {
      exit = { code, signal };
    };
    if (child && typeof child.once === 'function') child.once('exit', onExit);
    const ports = Array.isArray(port) ? port : [port];
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const candidate of ports) {
          if (candidate && (await probePort(host, candidate))) return { ok: true, port: candidate };
        }
        if (exit) {
          // 刚退出时端口可能仍在关闭过程中，需要再次确认才能判定失败。
          for (const candidate of ports) {
            if (candidate && (await probePort(host, candidate))) {
              return { ok: true, port: candidate };
            }
          }
          this.log('warn', `后备内核已退出（code=${exit.code} signal=${exit.signal}），不再继续等待`);
          return { ok: false, exitedEarly: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { ok: false, exitedEarly: false };
    } finally {
      if (child && typeof child.removeListener === 'function') child.removeListener('exit', onExit);
    }
  }

  async connectInternal() {
    const cfg = this.config();
    this.post({ type: 'status', state: 'connecting', detail: '正在连接…' });

    if (!cfg.hostAccepted) {
      // 不记录用户配置的原始内容，避免把误填的 URL 参数写入日志。
      this.log('warn', '连接地址不是本机回环地址，已拒绝连接');
      this.postError('连接地址仅支持本机回环地址。', {
        title: '仅支持本机连接',
        advice: '请将连接地址恢复为默认值。',
        raw: 'dshPanel.host 仅允许 127.0.0.1 或 localhost；不支持远程地址、端口转发或隧道。',
      });
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      return undefined;
    }

    /*
     * 连接端口的确定顺序（2026-09-19 修改）：
     *
     * 1. `dshPanel.port`（默认 47821）上存在接入点 → **接入该内核**。这是桌面端的内核，
     *    也是"一个进程对应一个内核"的情形 —— 面板不自启，也不改动它。
     * 2. `dshPanel.selfStartPort`（默认 47831）上存在接入点 → 接入该内核，其背后的内核
     *    通常由**另一个 VS Code 窗口**启动，或由本窗口此前启动（面板关闭后重新
     *    打开）：复用该内核，不再启动新的进程（新启动的进程还会与其竞争端口）。
     *    仅当**内核由本扩展启动**时才记录为"本视图在用"（面板关闭后该内核才会进入宽限回收）；
     *    由其它来源启动的内核不做任何记录 —— 不回收非本扩展启动的内核。
     * 3. 两者均不存在 → 由面板启动一个，**接入点端口固定为 selfStartPort**（通过环境变量
     *    DSH_ACP_DOOR_PORT，见 dsh-door/lib/port.js）。
     *
     * 区分两个端口的原因：面板自启的内核此前也使用 47821 —— 该端口正是桌面端内核
     * 所用的端口。两个内核竞争同一端口没有收益，竞争失败的一方不会开放监听，
     * 用户只能停留在"正在启动…"提示上持续等待。现在自启的内核一律使用自身端口，两者互不影响。
     */
    let target = cfg.port;
    let reachable = false;
    if (!this.ownKernelOnly && (await probePort(cfg.host, cfg.port))) {
      reachable = true;
      this.log('info', `端口 ${cfg.host}:${cfg.port} 上存在现成的接入点，接入该内核（不自行启动内核）`);
    } else if (await probePort(cfg.host, cfg.selfStartPort)) {
      target = cfg.selfStartPort;
      reachable = true;
      const mine = this.kernels.live(cfg.host, cfg.selfStartPort);
      if (mine) {
        // 由本扩展启动：记录为"本视图在用"，面板关闭后该内核才会进入宽限回收（否则会持续保留）。
        this.kernels.acquire(this, mine);
        this.background = mine.background;
      }
      this.log(
        'info',
        `面板自身的端口 ${cfg.host}:${cfg.selfStartPort} 上已存在接入点，接上去` +
          (mine ? '（由本扩展启动的内核，继续使用，不重新启动）' : '（非本扩展启动，本扩展不负责回收）'),
      );
      this.post({ type: 'notice', text: '继续使用当前正在运行的 DSH。' });
    } else if (cfg.autoStart) {
      const spawned = await this.spawnFallback(cfg);
      if (!spawned.ok) {
        this.postError(spawned.human.raw, spawned.human);
        this.post({ type: 'status', state: 'error', detail: '未连接' });
        return undefined;
      }
      target = spawned.port || cfg.selfStartPort;
      reachable = true;
    }

    if (!reachable) {
      this.postError('无法连接 DSH（自动启动已关闭）。');
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      return undefined;
    }
    // 后续所有涉及连接目标的位置均使用 target，不再使用 cfg.port。
    this.targetPort = target;

    const client = new DoorClient({ host: cfg.host, port: target, log: this.log });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      const text = error && error.message ? error.message : String(error);
      this.postError(`无法连接 DSH：${text}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      return undefined;
    }

    // 新版接入点会明确报告它准备给新会话使用哪个模型。旧版没有此方法时继续兼容；
    // 新版明确报告“没有模型”时则在建会话之前停止并给出可执行提示，避免用户直到
    // 发送第一条消息才看到晦涩的 `agent has no provider/model`。
    try {
      const status = await client.doorStatus();
      this.doorStatus = status;
      if (status?.version) this.log('info', `接入点插件版本 ${status.version}`);
      if (status?.model?.ready === false) {
        client.close();
        this.postError('DSH 还没有可供新对话使用的模型。', {
          title: '尚未选择模型',
          advice: '请先在 DSH 的模型设置中选择一个默认模型，再重新连接。',
          raw:
            '接入点插件已正常连接，但未能从 DSH 读取完整的 provider/model。' +
            (status.model.partialConfig
              ? '该插件配置中只填写了其中一项，这组不完整配置已被忽略。'
              : ''),
        });
        this.post({ type: 'status', state: 'error', detail: '未选择模型' });
        return undefined;
      }
      if (status?.model?.ready) {
        this.log(
          'info',
          `新会话初始模型 ${status.model.provider}/${status.model.model}` +
            `（来源=${status.model.source || 'unknown'}）`,
        );
      }
    } catch (error) {
      const text = this.errText(error);
      if (isMissingMethod(error, text)) {
        this.log('info', '接入点插件版本较旧，不提供状态诊断；继续使用兼容路径');
      } else {
        // 状态方法只是诊断增强，读取失败不应使一个原本可用的旧接入点失效。
        this.log('warn', `读取接入点状态失败，继续建会话：${text}`);
      }
    }

    this.client = client;
    const session = new DshSession({ client, log: this.log });
    this.session = session;
    this.wire(session, client);

    try {
      if (this.resumeTarget) {
        // 断线重连：先尝试恢复此前那个会话，恢复失败时才新建会话。
        const target = this.resumeTarget;
        try {
          // 同时把当前预设告知该插件：内核不会把经由该插件建立的会话的预设写入会话记录，
          // 该插件依赖该值指定（或依赖其自身记录的值）补充挂载 —— 不补充时，恢复的会话没有可用工具。
          await session.resume(target, this.workdir(), { preset: this.wantedPreset() });
          this.resumeTarget = undefined;
          // 恢复的是「已发送过消息」的会话：不应因更换预设而将其静默重新开启。
          this.turnSent = true;
          this.post({ type: 'notice', text: '已重新连接，上下文已恢复。' });
          this.post({ type: 'status', state: 'ready', detail: '就绪' });
          return session;
        } catch (error) {
          this.log('warn', `恢复旧会话失败，改为新建会话：${this.errText(error)}`);
          this.resumeTarget = undefined;
          this.post({ type: 'notice', text: '上一段会话未能恢复，此处为新对话。' });
        }
      }
      this.turnSent = false;
      await session.start({
        cwd: this.workdir(),
        provider: cfg.provider,
        model: cfg.model,
        preset: this.wantedPreset(cfg),
      });
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      this.postError(`新建对话失败：${text}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      return undefined;
    }

    /*
     * 会话确定之后，**在该流程内等待一次权限读取**，而不是仅依靠 session 事件
     * 异步触发。原因：接入的内核无法切换权限时（桌面端的内核即为该情况），
     * 面板需要改用自行启动的内核 —— 该决定必须发生在"本次连接返回之前"，
     * 否则会出现两条连接流程并行（前一条刚报告"就绪"，后一条又在建立会话）。
     *
     * 读取期间暂缓输出「无法切换权限」的解释（quietPermissionNotice）：
     * 能够切换内核时直接切换，用户不需要先读到一句"无法切换的原因"，再读到一句"已切换内核"。
     */
    this.quietPermissionNotice = true;
    try {
      await this.refreshPermission();
    } finally {
      this.quietPermissionNotice = false;
    }
    if (await this.maybeUseOwnKernel(this.permissionUnavailable)) return undefined;
    // 无法切换（或不满足切换条件）：此时才输出该中文说明。
    this.explainPermissionOnce();

    this.post({ type: 'status', state: 'ready', detail: '就绪' });
    return session;
  }

  /** 把会话与客户端的事件转发到界面。 */
  wire(session, client) {
    session.on('user', (payload) => this.post({ type: 'user', text: payload.text }));
    session.on('assistant', (payload) => this.post({ type: 'assistant', id: payload.id }));
    session.on('text', (payload) => this.post({ type: 'text', id: payload.id, delta: payload.delta }));
    session.on('thinking', (payload) =>
      this.post({ type: 'thinking', id: payload.id, delta: payload.delta }),
    );
    session.on('tool', (payload) => this.post({ type: 'tool', id: payload.id, tool: payload.tool }));
    session.on('done', (payload) => this.post({ type: 'done', id: payload.id, status: payload.status }));
    session.on('usage', (payload) =>
      this.post({ type: 'usage', used: payload.used, size: payload.size }),
    );
    session.on('config', (payload) => this.post({ type: 'config', configOptions: payload.configOptions }));
    session.on('presets', (payload) => this.onPresets(payload));
    session.on('busy', (payload) => {
      this.post({ type: 'busy', busy: payload.busy });
      this.post({
        type: 'status',
        state: payload.busy ? 'busy' : 'ready',
        detail: payload.busy ? '工作中…' : '就绪',
      });
    });
    session.on('session', (payload) => {
      this.log('info', `当前会话 ${payload.sessionId}`);
      // 会话确定后（新建/恢复/切换内核）读取一次权限：权限属于内核状态，
      // 更换内核或更换会话时取值可能不同，不能沿用上一次的结果。
      void this.refreshPermission();
    });

    client.on('permission', (requestId, params) => {
      // 视图可能在模型发出权限请求之前被折叠/销毁。此时没有人能够点击选项，
      // 必须立即回“取消”；仅把消息 post() 给不存在的视图会使内核永久等待。
      if (!this.view) {
        session.answerPermission(requestId, undefined);
        this.log('info', `面板未打开，已取消权限请求 #${requestId}`);
        return;
      }
      this.pendingPermissionRequests.set(requestId, { client, session });
      this.post({ type: 'permission', requestId, params });
    });
    const onClose = (reason) => {
      this.clientCloseHandlers.delete(client);
      client.off('close', onClose);
      this.dropPendingPermissionRequests(client);
      session.dispose();
      // 断开原因可能很长（内核原文），写入对话流；顶栏只显示"未连接"。
      this.postError(this.disconnectText(reason));
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      this.post({ type: 'busy', busy: false });
      // 记录该会话，下次连接时先尝试恢复（session/resume 经实测有效）。
      if (session.sessionId) this.resumeTarget = session.sessionId;
      // 使面板在下次执行「发送」时自动重连，而不是停留在无连接状态。
      if (this.session === session) this.session = undefined;
      if (this.client === client) {
        this.client = undefined;
        this.doorStatus = undefined;
      }
    };
    this.clientCloseHandlers.set(client, onClose);
    client.on('close', onClose);
  }

  /**
   * 连接断开后，向对话流输出中文说明。
   *
   * 2026-09-19 用户报告"对话进行数次后出现 read ECONNRESET"，查阅日志才发现面板自行
   * 启动的内核以**退出码 code=1** 终止，而面板只返回了一句通用的
   * "连接断开：read ECONNRESET" —— 用户无法判断该问题是否由自身操作引起。
   * 现在区分两种情形说明：
   *
   * - **本扩展启动的内核已终止** → 报告退出码 + 内核输出的最后内容（原文位于输出面板）；
   * - **连接的是其它来源正在运行的内核（通常为桌面端）** → 明确说明该内核已退出或重启，
   *   面板会自行更换内核，不需要检查配置。
   *
   * @param {string} reason 客户端提供的断开原因。
   */
  disconnectText(reason) {
    const background = this.background;
    const child = background && background.child;
    const died = child && typeof child.exitCode === 'number' && child.exitCode !== null;
    if (died) {
      const tail =
        typeof background.stderrTail === 'function' ? background.stderrTail() : '';
      const lastLine = tail ? tail.split(/\r?\n/).filter((line) => line.trim()).pop() : '';
      const why = lastLine ? `内核最后输出：${lastLine}` : '内核未输出任何内容即退出（可能由外部进程终止）';
      return (
        `DSH 自己退出了（code=${child.exitCode}）。${why}\n` +
        '可直接发送消息；完整输出见「输出 → DSH Panel」。'
      );
    }
    if (!background) {
      return (
        `连接断开：${reason}\n` +
        '那是别处的 DSH（通常为桌面端）已退出或重启。可直接发送消息。'
      );
    }
    return `连接断开：${reason}`;
  }

  /** 界面刚加载完成时，补发当前状态。 */
  pushSnapshot() {
    const session = this.session;
    if (!session) return;
    this.post({ type: 'status', state: session.busy ? 'busy' : 'ready', detail: session.busy ? '工作中…' : '就绪' });
    this.post({ type: 'config', configOptions: session.configOptions });
    if (this.lastPresets) this.post({ type: 'presets', ...this.lastPresets });
    // 权限：先补发上一次读取的结果（避免出现空白）；从未读取成功时发起一次读取。
    if (this.permission) this.postPermissionState(this.permission);
    else if (this.permissionUnavailable) this.post({ type: 'permissionState', unavailable: this.permissionUnavailable });
    else void this.refreshPermission();
    if (session.usage) this.post({ type: 'usage', used: session.usage.used, size: session.usage.size });
  }

  /**
   * 该插件上报了可用预设清单。
   *
   * 这份清单由**该插件向内核请求获得**（`agentPresets.list()`，每次调用重新扫描磁盘），
   * 因此用户在 `$DSH_HOME/.agent-presets/` 中自行编写的预设也会出现在面板中。
   */
  onPresets(payload) {
    const presets = Array.isArray(payload?.presets) ? payload.presets : [];
    const current = typeof payload?.current === 'string' && payload.current ? payload.current : undefined;
    if (current) this.preset = current;
    this.lastPresets = { presets, current, requested: payload?.requested };
    this.post({ type: 'presets', ...this.lastPresets });
    if (payload?.fallback) {
      this.post({
        type: 'notice',
        text: `「${payload.requested}」模式不存在，已使用「${this.labelOf(current)}」。`,
      });
    }
  }

  /** 预设的中文名称（该插件或内核提供了名称时使用该名称，否则回退为 id）。 */
  labelOf(id) {
    if (!id) return '默认';
    const list = this.lastPresets?.presets;
    const hit = Array.isArray(list) ? list.find((item) => item && item.id === id) : undefined;
    return (hit && hit.name) || id;
  }

  // ── 操作 ────────────────────────────────────────────

  async send(text, attachments = []) {
    const items = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    if ((!text || !text.trim()) && items.length === 0) return;
    const session = await this.ensureConnection();
    if (!session) return;
    // 自此该会话已「发送过消息」：更换预设时不能再静默重新开启该会话。
    this.turnSent = true;
    await session.send(text, { attachments: items });
  }

  // ── 历史会话 ──────────────────────────────────────────
  //
  // 数据位于本机 `$DSH_HOME/sessions`。两条读取途径：
  //   1. ACP 接入点插件（dsh-acp-door）0.0.8+ 的旁路方法 `dsh-door/sessions/list|get`；
  //   2. 面板自行读取本机磁盘。
  //
  // 第 2 条途径必要的原因：接入点插件安装在用户配置集中，而**该配置集由 DSH 桌面端自行
  // 管理**（2026-09-19 实测：该配置集中安装的接入点插件版本仍为 0.0.7，且 `dsh plugin --profile
  // desktop` 的增删操作会被拒绝），因此「接入点插件版本过低、没有旁路方法」属于常态而非异常。
  // 在此前仅实现第 1 条途径时，历史会话在**最常用的那种模式**（接入桌面端那一个内核）下
  // 直接不可用，并且要求用户执行「重启桌面端」—— 重启后该问题依然存在，等同于把
  // 扩展自身的依赖问题转由用户承担。面板与内核本就位于同一台机器，自行读取是可行的。

  /**
   * 读取一次历史会话。
   *
   * @param {'list'|'get'} kind
   * @param {string} [id] kind==='get' 时使用的会话 id。
   * @returns {Promise<{result: object, via: 'door'|'local'}>}
   */
  async readHistory(kind, id) {
    const localRoot = localSessions.resolveSessionsRoot();
    const client = this.client;

    // 能够向该插件查询时即通过该插件查询：这是本机 DSH 返回的正式数据来源。
    // `historyVia === 'local'` 表示本轮连接中已确认该插件没有此方法，
    // 因此不再在每次打开历史会话时发起一次注定失败的往返。
    if (this.historyVia !== 'local' && client && client.isConnected) {
      try {
        const result = kind === 'list'
          ? await client.listHistory()
          : await client.getHistory(String(id || ''));
        this.historyVia = 'door';
        return { result, via: 'door' };
      } catch (error) {
        const text = this.errText(error);
        if (!isMissingMethod(error, text)) throw error;
        this.historyVia = 'local';
        this.log('info', '该插件未提供历史会话的旁路方法（需要 0.0.8+），改为面板自行读取 $DSH_HOME/sessions');
      }
    }

    if (!localSessions.hasZstdSupport()) {
      throw new Error('本机 Node 不支持 zstd 压缩格式，无法解析会话文件');
    }
    const result = kind === 'list'
      ? localSessions.listSessions(localRoot)
      : localSessions.getSession(localRoot, String(id || ''));
    return { result, via: 'local' };
  }

  /**
   * 把历史会话清单发送给界面。
   *
   * 接入点插件版本过低时，上述本机读取途径会自动补上，不要求用户修改桌面端配置集。
   */
  async sendHistoryList() {
    try {
      const { result, via } = await this.readHistory('list');
      const sessions = Array.isArray(result && result.sessions) ? result.sessions : [];
      // 本地读取失败时（目录不可读等）原因会写入 error 字段，不应将其视为「没有历史会话」。
      if (sessions.length === 0 && result && result.error) throw new Error(result.error);
      this.post({ type: 'history', via, sessions, skipped: (result && result.skipped) || 0 });
    } catch (error) {
      this.post({ type: 'history', error: this.historyErrorText(error) });
    }
  }

  /** 把一段历史会话的回放发送给界面。 */
  async sendHistoryReplay(id) {
    try {
      const { result, via } = await this.readHistory('get', id);
      this.post({
        type: 'replay',
        via,
        card: result && result.card ? result.card : {},
        entries: Array.isArray(result && result.entries) ? result.entries : [],
        truncated: Boolean(result && result.truncated),
      });
    } catch (error) {
      this.postError(this.historyErrorText(error));
    }
  }

  /** 历史读取失败时向用户输出的说明（纯函数，便于测试）。 */
  historyErrorText(error) {
    const text = this.errText(error);
    if (isMissingMethod(error, text)) {
      // 调用方可能直接传入该插件返回的错误；向用户只说明读取能力不足，
      // 版本号、包名记录在日志中。
      return '该 DSH 版本过低，无法读取其历史会话。';
    }
    return `读取历史会话失败：${text}`;
  }

  /**
   * 从历史会话中恢复一段会话：先回放记录，再尝试通过 `session/resume` 恢复上下文。
   *
   * 两项操作同时进行的原因：用户点击「接回」的预期是「继续此前的对话」，仅有上下文
   * 而无记录（或仅有记录而无上下文）都属于不完整的结果。resume 失败（内核已重启、
   * 内存中不存在该会话）时明确说明「以上仅为回放」，不将回放表示为恢复成功。
   */
  async resumeHistory(id) {
    const session = await this.ensureConnection();
    if (!session) return;
    await this.sendHistoryReplay(id);
    if (session.busy) {
      this.post({ type: 'notice', text: '当前正在工作，结束后再进行恢复。' });
      return;
    }
    try {
      await session.resume(String(id || ''), this.workdir(), { preset: this.wantedPreset() });
      this.turnSent = true;
      this.resumeTarget = undefined;
      this.post({ type: 'notice', text: '已恢复该历史会话。' });
      this.post({ type: 'status', state: 'ready', detail: '就绪' });
    } catch (error) {
      // 面板自身的说明放在第一行（简短），内核原文另起一行附上（原文较长不影响 ——
      // 它属于"原始信息"，而非面板附加的说明）。见 §文案要短 那条测试。
      this.log('warn', `恢复历史会话失败：${this.errText(error)}`);
      this.post({
        type: 'notice',
        text: `上下文未能恢复，以上内容仅为回放。\n原因：${clip(this.errText(error), 70)}`,
      });
    }
  }

  // ── 编辑器上下文（当前文件 / 选中的代码）────────────────

  /**
   * 把编辑器中的内容送入面板，成为输入框上方的一个「附件」。
   *
   * 采用送入面板而非直接代替用户发送的原因：用户执行该命令时，通常意图为
   * 「针对这段代码提问」——因此把上下文挂载为附件、把光标保留在输入框，
   * 使用户继续输入。VS Code 中其它 AI 扩展也采用该做法。
   *
   * @param {Array<object>} items
   */
  async attach(items) {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (list.length === 0) return;
    // 面板可能尚未展开（该命令可直接从命令面板调用），先使其显示。
    await this.reveal();
    this.post({ type: 'attach', items: list });
  }

  /**
   * 使面板显示出来。
   *
   * 展开视图只能通过 VS Code 自身的命令 `<viewId>.focus`，
   * 因此此处只能使用 executeCommand —— 在测试用的模拟 vscode 中该命令不存在，
   * 此时记录一条日志并视为未发生错误（附件本身仍然挂载）。
   */
  async reveal() {
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } catch (error) {
      this.log('warn', `展开面板失败（不影响附件挂载）：${this.errText(error)}`);
    }
  }

  /** 把命令面板或右键菜单提供的编辑器信息整理为附件结构。 */
  static attachmentFromEditor(editor, workdir) {
    if (!editor || !editor.document) return undefined;
    const document = editor.document;
    const uri = document.uri;
    const absolute = uri && uri.fsPath ? uri.fsPath : document.fileName;
    if (!absolute) return undefined;
    // 名称使用相对于工作目录的路径：模型与用户查看时都更短、更明确。
    let name = absolute;
    if (workdir && pathIsInside(absolute, workdir)) {
      name = path.relative(workdir, absolute).split('\\').join('/');
    }
    const base = {
      name,
      uri: uri && typeof uri.toString === 'function' ? uri.toString() : `file://${absolute}`,
      mimeType: 'text/plain',
    };

    const selection = editor.selection;
    const selected = selection && !selection.isEmpty ? document.getText(selection) : '';
    if (selected && selected.trim()) {
      return {
        ...base,
        kind: 'selection',
        text: selected,
        language: document.languageId,
        detail: `选中 ${selection.end.line - selection.start.line + 1} 行`,
        id: `${name}:${selection.start.line + 1}-${selection.end.line + 1}`,
      };
    }
    return { ...base, kind: 'file', detail: '当前文件', id: name };
  }

  /** 下一段新对话使用的预设：面板中选择的值优先，其次是配置项中的默认值。 */
  wantedPreset(cfg = this.config()) {
    return this.preset || cfg.preset || undefined;
  }

  async newSession() {
    const session = await this.ensureConnection();
    if (!session) return;
    const cfg = this.config();
    const old = session.sessionId;
    this.post({ type: 'reset' });
    // 用户主动请求新对话时，不再尝试恢复上一段会话。
    this.resumeTarget = undefined;
    this.turnSent = false;
    // 新建会话前需要先关闭旧会话，避免内核中累积大量空会话。
    if (old) {
      try {
        await this.client.closeSession(old);
        this.log('info', `已关闭旧会话 ${old}`);
      } catch (error) {
        this.log('warn', `关闭旧会话失败（不影响后续操作）：${this.errText(error)}`);
      }
    }
    try {
      await session.start({
        cwd: this.workdir(),
        provider: cfg.provider,
        model: cfg.model,
        preset: this.wantedPreset(cfg),
      });
      this.post({ type: 'status', state: 'ready', detail: '就绪' });
    } catch (error) {
      this.postError(`新建对话失败：${this.errText(error)}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
    }
  }

  async setModel(value) {
    if (!this.session) return;
    await this.session.setModel(value);
  }

  /**
   * 用户在面板中更换了 agent preset。
   *
   * 内核不允许在一段会话中途更换预设（`agent-preset/locked`，实测），
   * 因此此处只有两条路径：
   *   - 该会话尚未发送过消息 → 直接按新预设重新开启一段（代价为零，用户不需要另行点击新建）；
   *   - 该会话已发送过消息 → 记录该预设，并明确说明下一段新对话使用该预设，不将更换表示为已生效。
   */
  async setPreset(value) {
    const preset = typeof value === 'string' ? value.trim() : '';
    if (!preset) return;
    this.preset = preset;
    if (this.session && !this.turnSent) {
      this.log('info', `预设已改为 ${preset}；当前会话尚未发送过消息，直接重新开启一段`);
      await this.newSession();
      this.post({ type: 'notice', text: `已按「${this.labelOf(preset)}」重新开启。` });
      return;
    }
    this.log('info', `预设已改为 ${preset}（下一段新对话生效）`);
    this.post({ type: 'notice', text: `「${this.labelOf(preset)}」：自下一段新对话生效。` });
  }

  /**
   * 读取一次当前会话的权限预设（该插件 ≥0.0.12 的 `dsh-door/permission/get`）。
   *
   * 每次都向内核查询、而非由面板自行记录的原因：权限是**内核**的状态
   * （会话的 `permissions` 投影）。桌面端修改了权限、用户修改了配置集中的默认值、
   * 某个插件（例如 Auto Approval）调整了该项取值时，面板都应当如实显示 ——
   * 这也是「与桌面端同步」的实现方式：同一份清单、同一个真值来源。
   *
   * 读取失败**不计为错误**：该插件版本过低（0.0.11 及以下）或该配置集未挂载权限服务都属于常态。
   * 此时选择器显示一句解释（见 dsh/permission.js），其它功能不受影响。
   */
  async refreshPermission() {
    const client = this.client;
    const sessionId = this.session && this.session.sessionId;
    if (!client || !sessionId || typeof client.permissionGet !== 'function') return;
    try {
      const payload = await client.permissionGet(sessionId);
      this.permission = payload;
      this.permissionUnavailable = undefined;
      this.postPermissionState(payload);
      // 记录一行日志：真实窗口自检（tools/vscode-check.js）依据该日志证明
      // 「面板确实从内核读取到了权限清单」，而不是依据界面的显示结果。
      this.log('info', `当前权限：${currentLabel(payload.currentValue, payload.options)}（${payload.currentValue}）`);
    } catch (error) {
      const shaped = explainPermissionFailure({ code: error && error.code, message: this.errText(error) });
      this.permission = undefined;
      this.permissionUnavailable = shaped;
      this.post({ type: 'permissionState', unavailable: shaped });
      this.log('info', `权限预设读取失败（${shaped.state}）：${this.errText(error)}`);
      // 顶栏按钮只显示「不可切换」四个字（该栏宽度受限，完整文字会被截断），
      // 说明原因需要通过此处输出。
      // 每种原因只输出一次：接入桌面端内核时，每次建立会话都会进入该分支。
      //
      // ⚠️ 以下两种情况下此处**暂不输出**，由连接流程决定输出哪一句：
      // ① `quietPermissionNotice`（连接流程正在读取本次权限，可能切换内核 ——
      //    已切换时不再解释"无法切换的原因"）；
      // ② 已输出过的同一种原因（去重逻辑位于 explainPermissionOnce 中）。
      if (!this.quietPermissionNotice) this.explainPermissionOnce();
    }
  }

  /**
   * 输出「此处无法切换权限」的中文说明 —— **每种原因只输出一次**。
   *
   * 单独成方法的原因：连接流程需要先完成「是否改用可切换权限的内核」的判定，
   * 之后才输出该说明；而权限读取本身可能被触发两次（建立会话的事件 + 连接流程
   * 中的显式等待），两处都需要使用同一个去重标记。
   */
  explainPermissionOnce() {
    const shaped = this.permissionUnavailable;
    if (!shaped) return;
    if (this.permissionNotice === shaped.state) return;
    this.permissionNotice = shaped.state;
    // 两行都简短，而且**都不含内部术语**：不出现「dsh-acp-door」「0.0.12」这类内部词
    // 这类内部词（用户 2026-09-19 的意见为：内部组件名称不应出现在界面文案中）。
    // 版本号、包名只记录在日志中。
    this.post({
      type: 'notice',
      text: `${shaped.text}${shaped.detail ? `\n${shaped.detail}` : ''}`,
    });
  }

  /**
   * 权限无法切换时，判断是否值得改用面板自行启动的 DSH。
   *
   * 判据（`shouldSwitchToOwnKernel`，纯函数、便于测试）：
   * - 仅 `old-door`（**接入点插件版本过低**）这一种情况可以通过切换内核解决 —— 面板自行启动的内核
   *   使用本扩展配套的新版插件。`no-service`（该 DSH 未提供权限设置）切换任何内核都无效，
   *   应如实说明；`error` 同理。
   * - 需要**当前接入的正是现成的那台内核**（`dshPanel.port`）。已在面板自行启动的内核上时再切换，
   *   属于无效操作（面板自行启动的内核也无法切换时 = 本机环境问题，如实说明比切换更有效）。
   * - 用户已关闭自动启动（`dshPanel.autoStart = false`）时不切换：用户已明确表示
   *   「不在后台启动进程」，应当遵从该设置，只解释无法切换的原因。
   * - 一个面板只切换一次（`switchedKernel`）。
   *
   * 切换后为**新会话**：旧会话仍保存在磁盘上（可在历史会话中查看），并未被删除。
   */
  async maybeUseOwnKernel(shaped) {
    const cfg = this.config();
    const decided = shouldSwitchToOwnKernel({
      state: shaped && shaped.state,
      targetPort: this.targetPort,
      cfgPort: cfg.port,
      autoStart: cfg.autoStart,
      switched: this.switchedKernel,
    });
    if (!decided) return false;
    this.switchedKernel = true;
    this.ownKernelOnly = true;
    /*
     * 另有一项更关键的设置：**仅识别面板自身的端口**。配置项所指端口上现成的旧版接入点仍在监听，
     * 若自启等待过程将其判定为"新内核已启动完成"，则会再次接入同一内核（切换未生效）——
     * 真实窗口自检中发现的问题即为该情况。
     */
    this.ownPortOnly = true;
    this.log(
      'info',
      `接入的 ${cfg.host}:${cfg.port} 无法切换权限（${shaped.state}），` +
        `改用面板自己启动的（${cfg.host}:${cfg.selfStartPort}，配置集：自启配置集）`,
    );
    this.post({ type: 'notice', text: '该 DSH 版本过低，已改用面板自行启动的内核。' });
    // 仅断开连接，不终止任何内核（teardown 不操作进程）。
    this.teardown();
    this.resumeTarget = undefined;
    await this.connectInternal();
    return true;
  }

  /** 把一份权限载荷发送给界面（中文标签统一在此处添加）。 */
  postPermissionState(payload) {
    const options = decorateOptions(payload.options, payload.currentValue);
    this.post({
      type: 'permissionState',
      currentValue: payload.currentValue,
      options,
      label: currentLabel(payload.currentValue, payload.options),
      defaultPreset: payload.defaultPreset,
    });
  }

  /**
   * 用户在面板中更换了权限预设。
   *
   * 与 agent preset（`setPreset`）**不同**：后者无法更换当前会话的预设（内核
   * 报错 `agent-preset/locked`），而权限**随时可以更换** —— 内核即按此设计
   * （`/permission`、桌面端的选择器均支持中途切换）。因此此处直接切换，
   * 不重新开启会话，也不使用「下一段生效」这类表述。
   *
   * 切换结果以**内核回读的值为准**（不做乐观更新）：即使某项设置被其它机制限制，
   * 界面显示的仍是真实状态，而不是用户预期的状态。
   */
  async setPermission(value) {
    const client = this.client;
    const sessionId = this.session && this.session.sessionId;
    const wanted = typeof value === 'string' ? value.trim() : '';
    if (!client || !sessionId || !wanted) return;
    if (typeof client.permissionSet !== 'function') return;
    // 展示项（custom）不是可切换的目标：内核的 resolve() 对其直接抛出异常。界面上该项已显示为
    // 灰色且点击不发送消息，但 webview 可能使用旧版 bundle，因此在此处再加一道判定 ——
    // 否则用户会收到「无法读取当前权限」的提示，与实际情况不符。
    if (DISPLAY_ONLY.has(wanted)) {
      this.post({ type: 'notice', text: '该项仅表示当前状态，不是可切换的选项。' });
      return;
    }
    const label = currentLabel(wanted, this.permission && this.permission.options);
    try {
      const payload = await client.permissionSet(sessionId, wanted);
      this.permission = payload;
      this.permissionUnavailable = undefined;
      this.postPermissionState(payload);
      this.post({ type: 'notice', text: `权限已切到「${label}」。` });
      this.log('info', `权限已切换到 ${wanted}（内核回读 ${payload.currentValue}）`);
    } catch (error) {
      // 失败时需要说明失败类型（接入点插件版本过低 / 名称不正确 / 会话不存在），并把界面
      // 恢复为真实状态 —— 否则用户会误认为切换已经生效。
      const shaped = explainPermissionFailure({ code: error && error.code, message: this.errText(error) });
      this.postError(`${shaped.text}${shaped.detail ? `\n${shaped.detail}` : ''}`);
      // 本次由用户主动触发，说明一次即可：预先记录去重标记，
      // 避免后续重新读取时把同一句说明作为「notice」再次输出。
      this.permissionNotice = shaped.state;
      await this.refreshPermission();
    }
  }

  async reconnect() {
    this.log('info', '用户请求重新连接');
    this.teardown();
    this.post({ type: 'reset' });
    await this.ensureConnection();
  }

  errText(error) {
    return error && error.message ? error.message : String(error);
  }

  /**
   * 把一段可能很长的原文截短（仅用于**附加在**面板说明之后的引用）。
   *
   * 需要截短的原因：内核报错常达上百字，直接放入提示会形成大段文本 ——
   * 用户已两次提出该意见。完整原文另有记录位置（日志，以及错误卡片的折叠区），
   * 此处只需足以判断属于哪一类问题。
   */
  clip(text, max = 70) {
    return clip(text, max);
  }

  /** 回答仍在等待的权限请求；未知或已回答的 id 不得写回当前连接。 */
  answerPendingPermission(requestId, optionId) {
    const pending = this.pendingPermissionRequests.get(requestId);
    if (!pending || pending.session !== this.session) {
      this.log('warn', `忽略不存在或已经结束的权限请求 #${requestId}`);
      return false;
    }
    this.pendingPermissionRequests.delete(requestId);
    pending.session.answerPermission(requestId, optionId);
    return true;
  }

  /**
   * 取消指定客户端（或全部客户端）尚未回答的权限请求。
   * 删除记录先于写回，确保连接恰在此刻断开时也不会重复作答。
   */
  cancelPendingPermissionRequests(client, reason) {
    for (const [requestId, pending] of [...this.pendingPermissionRequests]) {
      if (client && pending.client !== client) continue;
      this.pendingPermissionRequests.delete(requestId);
      try {
        pending.session.answerPermission(requestId, undefined);
        this.log('info', `${reason || '连接结束'}，已取消权限请求 #${requestId}`);
      } catch (error) {
        this.log('warn', `取消权限请求 #${requestId} 失败：${this.errText(error)}`);
      }
    }
  }

  /** 连接已经关闭时只清理本地记录，不再向失效 socket 写回复。 */
  dropPendingPermissionRequests(client) {
    for (const [requestId, pending] of [...this.pendingPermissionRequests]) {
      if (pending.client === client) this.pendingPermissionRequests.delete(requestId);
    }
  }

  teardown() {
    this.cancelPendingPermissionRequests(undefined, '连接正在关闭');
    if (this.session) {
      this.session.dispose();
      this.session = undefined;
    }
    if (this.client) {
      const client = this.client;
      const onClose = this.clientCloseHandlers.get(client);
      if (onClose) client.off('close', onClose);
      this.clientCloseHandlers.delete(client);
      client.close();
      this.client = undefined;
    }
    this.doorStatus = undefined;
    // 下一轮连接重新判定历史会话的读取来源（用户可能在此期间升级了接入点插件）。
    this.historyVia = undefined;
    // 权限相关说明也重新输出一次（接入点插件可能已升级）。
    this.permissionNotice = undefined;
    this.permissionUnavailable = undefined;
  }

  dispose() {
    this.teardown();
    /*
     * 关键的一行（2026-09-19 修改）：**不终止内核，只释放引用**。
     *
     * 此处原为 `this.background.dispose()` —— 视图一旦销毁即终止内核，
     * 而视图的销毁条件很常见（折叠侧边栏、拖动面板、Reload Window、另一个窗口关闭）。
     * 现在交由 manager 处理：引用归零后仍保留宽限期（默认 10 分钟），该期间重新打开
     * 面板会继续使用同一个内核 —— 不重启，也不需要 resume。
     */
    this.kernels.release(this);
    this.background = undefined;
  }
}

/**
 * 把一段原文截短（超过 `max` 时添加省略号）。纯函数，便于测试。
 *
 * 仅用于"附加在面板说明之后的引用"：完整原文始终另有记录位置（日志、
 * 错误卡片的折叠区），提示中不需要显示整屏内容。
 */
function clip(text, max = 70) {
  const value = String(text === undefined || text === null ? '' : text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 面板自行启动内核失败时向用户展示的原文（纯函数，便于测试）。
 *
 * 两种失败需要作为两件不同的事情说明，因为**解决途径不同**：
 * - 进程启动后立即退出 → 命令不正确（dsh 不在 PATH 中、dshCommand 指向错误）；
 * - 进程仍在运行但端口未开放监听 → 该配置集中可能未安装接入点插件，或接入点被指向了其它端口。
 * 将两者合并为一句"接入点未监听"，用户只能自行推测原因。
 *
 * ⚠️ 这段是**折叠区的原始信息**（`human.raw`），不是对话流中的提示行 ——
 * 因此可以包含具体命令、配置集名称、后续处理方式；顶栏与提示行才是需要简短的位置。
 */
function fallbackFailureText({ command, profile, host, port, exitedEarly, stderr, explained }) {
  // 内核已说明原因时如实转述 —— 不应让面板的推测覆盖内核自身的说明。
  const said = explained && explained.kind !== 'unknown' ? explained : null;
  const safeCommand = redactSensitiveOutput(command);
  const raw = redactSensitiveOutput(stderr).trim();
  // 使用哪个命令或哪个配置集属于排障细节，写入原文段落即可，中文说明行只陈述结论。
  const tail = `\n[${safeCommand} · profile=${profile}]${raw ? `\n内核原话：${raw}` : ''}`;

  if (exitedEarly) {
    if (said) {
      return `无法启动 DSH：该进程启动后立即退出（${said.reason}）。${said.advice}${tail}`;
    }
    return `无法启动 DSH：该进程启动后立即退出 —— 通常是找不到 DSH，或设置里的命令填写有误。${tail}`;
  }
  return (
    `DSH 已启动，但无法连接（${host}:${port} 上没有应答）。有两种可能：该配置中` +
    `未安装连接组件（dsh plugin --profile ${profile} list 中应当有 dsh-acp-door），` +
    '或其 port 需要跟随 dshPanel.selfStartPort 一并修改。' +
    tail
  );
}

/**
 * 权限无法切换时，判断是否应当改用面板自行启动的 DSH（纯函数，便于测试）。
 *
 * 仅在**这一种**情形下切换：接入的是现成的那台内核（而非面板自行启动的）、对方仅为**接入点
 * 插件版本过低**（`old-door`，面板自行启动的内核使用配套的新版插件）、用户未关闭自动启动、
 * 且该面板尚未切换过。
 *
 * 不切换的情形同样有依据：
 * - `no-service`：该 DSH 未提供权限设置 —— 改用面板自行启动的内核结果相同，如实说明
 *   比无效切换更有效；
 * - `error`：读取失败不等于不支持（网络瞬时异常、会话不存在），不应急于改变连接结构；
 * - 已在面板自行启动的内核上：切换属于无效操作；
 * - `autoStart === false`：用户已明确要求不在后台启动进程；
 * - `switched`：一个面板只切换一次，不允许反复切换。
 *
 * @param {object} input
 * @param {string} [input.state] `explainPermissionFailure` 返回的 state。
 * @param {number|string|undefined} input.targetPort 当前连接的端口。
 * @param {number|string} input.cfgPort `dshPanel.port`（现成的那台内核监听该端口）。
 * @param {boolean} input.autoStart 用户是否允许自动启动内核。
 * @param {boolean} input.switched 该面板此前是否切换过。
 * @returns {boolean}
 */
function shouldSwitchToOwnKernel({ state, targetPort, cfgPort, autoStart, switched } = {}) {
  if (state !== 'old-door') return false;
  if (switched) return false;
  if (!autoStart) return false;
  if (targetPort === undefined || cfgPort === undefined) return false;
  return String(targetPort) === String(cfgPort);
}

/**
 * 所有启动方式均失败之后，向用户输出**与原因对应**的建议。
 *
 * 此处原为固定的一句"把 dshCommand 填成完整命令" —— 而当失败原因为
 * "该配置集无法通过命令行启动"（2026-09-19 那次）时，该表述会将用户引向错误方向。
 *
 * ⚠️ 这几句是**给用户看的**（错误卡片的"怎么办"那一行）：不出现「接入点插件」
 * 「接入点插件」「设置项全名」这类内部词。
 */
function fallbackAdvice(kinds) {
  if (kinds.has('app-managed-profile')) {
    return '该配置集只能由桌面端启动：先启动桌面端，或在设置中更换配置集。';
  }
  if (kinds.has('wrong-app-flags')) {
    return '该配置集无法启动：在设置中更换配置集后重试。';
  }
  if (kinds.has('port-in-use')) {
    return '该端口已被其它程序占用：关闭该程序，或在设置中更换端口。';
  }
  return '先启动桌面端，或在设置中指定 DSH 的安装位置。';
}

module.exports = {
  DshPanelView,
  VIEW_ID,
  fallbackFailureText,
  fallbackAdvice,
  shouldSwitchToOwnKernel,
  isMissingMethod,
};
