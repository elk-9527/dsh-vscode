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
const { historyOptions } = require('../dsh/history-query');
const { historyMarkdown } = require('../dsh/history-export');
const { normalizeDraft, draftKey } = require('./drafts');
const { DraftPersistence } = require('./draft-persistence');
const { ComposerContext } = require('./completions');
const { MessageQueue, snapshotMessage } = require('./queue');
const { QueuePersistence } = require('./queue-persistence');
const { HistorySummaryCache } = require('./history-cache');
const { validWebviewMessage } = require('./protocol');
const { DshConnectionService } = require('../connection/service');
const { DshSession } = require('../dsh/session');
const { describeError } = require('../dsh/errors');
// 权限预设：中文标签与失败说明（纯函数，见该文件开头关于清单不硬编码的说明）。
const { decorateOptions, currentLabel, explainPermissionFailure, DISPLAY_ONLY } = require('../dsh/permission');
const {
  probePort,
  dshCommandCandidates,
  runningDesktopExecutablesAsync,
  explainKernelFailure,
  panelProfileCandidates,
  redactSensitiveOutput,
} = require('../door/locate');
const { resolveLoopbackHost } = require('../door/endpoint');
const { desktopProfilePatchArgs, syncPanelProfilePlugins } = require('../door/setup');
const { renderHtml, makeNonce } = require('../panel/html');
const localSessions = require('../dsh/sessions');
const { kernelManager } = require('../panel/kernel-manager');
const { readUserSetting } = require('./settings');

const VIEW_ID = 'dshPanel.chat';

/** target 是否位于 base 目录之内（Windows 上大小写不敏感，path.relative 会处理）。 */
function pathIsInside(target, base) {
  const rel = path.relative(base, target);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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
  constructor({ extensionUri, log, spawnArgs = [], kernels, desktopExecutables = [], connections, workspaceState }) {
    this.workspaceState = workspaceState;
    this.draftWrites = Promise.resolve();
    this.draftStore = new DraftPersistence({ get: key => this.workspaceState?.get(key), update: (key, value) => this.workspaceState.update(key, value) },
      { onError: error => this.log('warn', `保存草稿失败：${error.message}`) });
    this.contextTrustEpoch = 0;
    this.contextSessionSerial = 0;
    this.editorContextReads = new Set();
    this.contextTrustWatcher = vscode.workspace.onDidGrantWorkspaceTrust?.(() => {
      this.contextTrustEpoch++;
      this.composerQuery?.abort(); this.composerSelection?.abort();
      for (const controller of this.editorContextReads) controller.abort();
    });
    this.extensionUri = extensionUri;
    this.log = log;
    this.spawnArgs = spawnArgs;
    this.connections = connections || new DshConnectionService({ log });
    this.ownsConnections = !connections;
    this.connections.driver = () => this.ensureConnection();
    /** 曾经发现过的 DSH Desktop 安装位置；用于桌面端关闭后的自启。 */
    this.desktopExecutables = desktopExecutables;
    /**
     * 后台内核归扩展所有（见 kernel-manager.js）。视图销毁时释放使用引用；
     * 引用归零后保留宽限期，期间重新打开面板可继续使用同一内核。
     */
    this.kernels = kernels || kernelManager(log);
    this.kernelConsumer = this.ownsConnections ? this : this.connections;
    if (!this.ownsConnections) this.connections.bindKernels(this.kernels, () => {
      const cfg = this.config(); return this.kernels.live(cfg.host, cfg.selfStartPort);
    });
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
    /** 防止连续点击或快速切换模式时并发关闭/创建同一段会话。 */
    this.newSessionPending = null;
    this.configRequests = Promise.resolve();
    this.configPending = 0;
    this.permissionPending = null;
    this.reconnectPending = null;
    this.recoveryGeneration = 0;
    this.recoveryScopes = new Map();
    this.recoverySequence = 0;
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
     * 默认连接 `dshPanel.port`（47821）上的现有内核。桌面配置集由桌面端管理，
     * 旧版 ACP 接入点插件可能不提供权限方法，此时改用面板启动的兼容内核。
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
     * 多个工具可能同时发来确认请求，因此这里还负责排队：界面一次只显示一个，
     * 回答当前项后再显示下一项，不能用后来的请求覆盖先来的请求。
     * @type {Map<number|string, {client: DoorClient, session: DshSession, params: object}>}
     */
    this.pendingPermissionRequests = new Map();
    /** 当前已经显示在 webview 中的权限请求 id；undefined 表示没有。 */
    this.visiblePermissionRequestId = undefined;
    this.queue = new MessageQueue({ onChange: () => this.post(this.queue.state()) });
    this.pendingQueueEdits = new Map();
    this.queuePersistence = new QueuePersistence(workspaceState);
    try {
      const restored = this.queuePersistence.load();
      if (restored) { this.queue.items = restored.items; this.queue.paused = restored.paused; this.queue.reason = restored.reason; }
    } catch (error) { this.queue.recoveryBlocked = true; this.queue.paused = true; this.queue.reason = error.message; }
    this.queueEpoch = 0;
    this.sendRequests = new Map();
    for (const entry of this.queue.items) if (entry.requestId !== undefined) this.sendRequests.set(entry.requestId, {
      digest: entry.requestDigest || require('node:crypto').createHash('sha256').update(JSON.stringify({ text: entry.text, attachments: entry.attachments })).digest('hex'),
      promise: Promise.resolve(true), completed: false,
    });
    this.liveTranscript = [];
    this.liveTranscriptBytes = 0;
    this.liveTranscriptTruncated = false;
    this.historyReadonly = false;
    this.historyId = undefined;
    this.currentPreset = undefined;
    // ComposerContext immediately captures an already-open editor and reads
    // workdir(), which requires the kernel manager and session state above.
    this.composer = new ComposerContext({ vscode, workdir: () => this.workdir(), sessionId: () => this.session?.sessionId, invoke: (...args) => this.skillInvoke(...args), connected: () => Boolean(this.connections?.snapshot().connected) });
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
      this.pendingQueueEdits.clear();
      this.pauseQueue('面板已关闭，请重新打开后显式继续。');
      this.composerQuery?.abort();
      this.composerSelection?.abort();
      this.cancelPendingPermissionRequests(undefined, '面板已关闭');
      // 视图不再存在时释放“正在使用后台内核”的引用。会话连接本身暂时保留：
      // 宽限期内重新打开面板可以继续同一会话；宽限期到期后 manager 回收内核，
      // 正常的 close 处理会记录 resumeTarget，之后可恢复上下文。
      if (this.ownsConnections) this.kernels.release(this);
      else this.connections.release('panel');
      this.log('info', '面板视图已销毁，已释放后台 DSH 的使用引用');
    });
    // 宽限期内重新建立视图：重新声明正在使用该后台内核，取消原定回收计时。
    if (this.background) {
      const cfg = this.config();
      const owned = this.kernels.live(cfg.host, cfg.selfStartPort);
      if (owned && owned.background === this.background) this.kernels.acquire(this.kernelConsumer, owned);
    }
    this.log('info', '面板已打开');
  }

  /** 向界面发送一条消息（界面未打开时直接丢弃，不报错）。 */
  post(message) {
    const transcript = ['user', 'assistant', 'text', 'thinking', 'tool', 'done', 'notice', 'error'];
    if (message.type === 'reset') this.setLiveTranscript([]);
    if (transcript.includes(message.type) && !message.historical) {
      this.recordTranscript(message);
      if (this.historyReadonly) return;
    }
    const view = this.view;
    if (!view) return;
    view.webview.postMessage(message).then(undefined, (error) => {
      this.log('warn', `向界面发送消息失败：${error && error.message ? error.message : error}`);
    });
  }

  setLiveTranscript(events) {
    this.liveTranscript = [];
    this.liveTranscriptBytes = 0;
    this.liveTranscriptTruncated = false;
    for (const event of events) {
      const copy = structuredClone(event);
      if (copy.type === 'replay' && Array.isArray(copy.entries)) {
        const sizes = copy.entries.map(item => Buffer.byteLength(JSON.stringify(item)) + 1);
        let bytes = Buffer.byteLength(JSON.stringify({ ...copy, entries: [] })) + sizes.reduce((sum, size) => sum + size, 0);
        while (bytes > 8 * 1024 * 1024 && copy.entries.length) {
          const nextUser = copy.entries.findIndex((item, index) => index > 0 && item.kind === 'user');
          const count = nextUser > 0 ? nextUser : 1;
          copy.entries.splice(0, count);
          bytes -= sizes.splice(0, count).reduce((sum, size) => sum + size, 0);
          copy.truncated = true;
        }
        if (copy.truncated) this.liveTranscriptTruncated = true;
      }
      this.recordTranscript(copy);
    }
  }

  recordTranscript(message) {
    const copy = structuredClone(message);
    const merge = ['text', 'thinking', 'tool'].includes(copy.type) && this.liveTranscript.findLastIndex(item => item.type === copy.type && item.id === copy.id &&
      (copy.type !== 'tool' || item.tool?.toolCallId === copy.tool?.toolCallId));
    if (typeof merge === 'number' && merge >= 0) {
      const previous = this.liveTranscript[merge];
      this.liveTranscriptBytes -= Buffer.byteLength(JSON.stringify(previous));
      if (copy.type !== 'tool') copy.delta = previous.delta + copy.delta;
      this.liveTranscript[merge] = copy;
    } else this.liveTranscript.push(copy);
    this.liveTranscriptBytes += Buffer.byteLength(JSON.stringify(copy));
    while (this.liveTranscriptBytes > 8 * 1024 * 1024 || this.liveTranscript.length > 4000) {
      const nextUser = this.liveTranscript.findIndex((item, index) => index > 0 && item.type === 'user');
      if (nextUser > 0) {
        const removed = this.liveTranscript.splice(0, nextUser);
        this.liveTranscriptBytes -= removed.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
      } else {
        // A single very large turn still has a finite cache. Preserve message
        // identities, and explicitly report omitted old output on restoration.
        const index = this.liveTranscript.findIndex(item => !['user', 'assistant', 'done'].includes(item.type));
        if (index < 0) break;
        const [removed] = this.liveTranscript.splice(index, 1);
        this.liveTranscriptBytes -= Buffer.byteLength(JSON.stringify(removed));
      }
      this.liveTranscriptTruncated = true;
    }
  }

  postConversationSnapshot() {
    this.post({ type: 'conversationSnapshot', events: structuredClone(this.liveTranscript), truncated: this.liveTranscriptTruncated });
    if (this.liveTranscriptTruncated) this.post({ type: 'notice', historical: true, text: '较早的对话内容已从面板缓存中省略，可在历史记录中查看。' });
  }

  postWorkspaceMeta(cwd = this.workdir()) {
    if (this.lastDraftCwd && this.lastDraftCwd !== cwd) void this.draftStore.flush(this.lastDraftCwd).catch(error => this.log('warn', `保存草稿失败：${error.message}`));
    this.lastDraftCwd = cwd;
    const trusted = vscode.workspace.isTrusted;
    this.post({ type: 'meta', cwd, trusted, sessionId: this.session?.sessionId });
    this.post({ type: 'draftRestore', cwd, draft: normalizeDraft(this.draftStore.read(cwd), { cwd, trusted }) });
  }

  contextRequestScope(message = {}) {
    const cwd = this.workdir(), session = this.session;
    return { cwd, session, sessionId: session?.sessionId, view: this.view, epoch: this.queueEpoch, trusted: vscode.workspace.isTrusted,
      trustEpoch: this.contextTrustEpoch, sessionSerial: this.contextSessionSerial, resumeTarget: this.resumeTarget,
      matches: (!message.cwd || draftKey(message.cwd) === draftKey(cwd)) && (!message.sessionId || message.sessionId === session?.sessionId) };
  }

  contextRequestCurrent(scope) {
    return scope.matches && scope.view === this.view && scope.session === this.session && scope.sessionId === this.session?.sessionId &&
      draftKey(scope.cwd) === draftKey(this.workdir()) && scope.epoch === this.queueEpoch && scope.trusted === vscode.workspace.isTrusted &&
      scope.trustEpoch === this.contextTrustEpoch && scope.sessionSerial === this.contextSessionSerial && !this.newSessionPending && !this.historyReadonly;
  }

  contextReplyScope(scope, options) {
    return { cwd: scope.cwd, sessionId: scope.sessionId, origin: options.origin, source: options.source };
  }

  /**
   * 向界面报告一个错误，**同时将其转换为可读的中文说明**。
   *
   * 不能直接发送 `error.message` 的原因：内核的报错原样穿过 ACP，
   * 用户看到的会是一段英文 JSON（最典型的是 429 额度限制）。面板的作用
   * 即在于避免用户直接阅读该内容。错误分类由 `dsh/errors.js` 完成（纯函数，便于测试），
   * 此处只负责把「中文说明 + 原文」一并发送 —— 原文不做任何删减。
   */
  postError(message, human, { historical = false } = {}) {
    const shaped = human && human.title ? human : describeError(message);
    const actions = shaped.kind === 'connection' ? [{ id: 'reconnect', label: '重新连接' }, { id: 'log', label: '查看日志' }]
      : [{ id: 'settings', label: '打开扩展设置' }, { id: 'log', label: '查看日志' }];
    const recoveryScope = `recovery-${++this.recoverySequence}`;
    this.recoveryScopes.set(recoveryScope, { cwd: draftKey(this.workdir()), generation: this.recoveryGeneration, serial: this.contextSessionSerial,
      session: this.session, client: this.client, sessionId: this.session?.sessionId, resumeTarget: this.resumeTarget });
    if (this.recoveryScopes.size > 50) this.recoveryScopes.delete(this.recoveryScopes.keys().next().value);
    this.post({ type: 'error', message: shaped.raw || message, human: { ...shaped, actions, recoveryScope }, ...(historical ? { historical: true } : {}) });
  }

  // ── 界面发来的消息 ──────────────────────────────────

  async onWebviewMessage(message) {
    if (!validWebviewMessage(message)) return;
    try {
      switch (message.type) {
        case 'ready': {
          // 界面可能刚打开，也可能被重新加载（会话仍然存在）——
          // 后一种情况需要补发当前状态，否则界面上没有内容。
          // 顶栏的工作目录不依赖连接，先发送。
          this.postWorkspaceMeta();
          const existing = this.session;
          await this.ensureConnection();
          if (existing) this.pushSnapshot();
          if (this.historyReadonly) { if (this.lastHistoricalReplay) this.post(this.lastHistoricalReplay); }
          else if (existing) this.postConversationSnapshot();
          this.post(this.queue.state());
          this.post({ type: 'historyState', readonly: this.historyReadonly, id: this.historyId });
          break;
        }
        case 'send':
          await this.acceptMessage(message);
          break;
        case 'queueAction':
          await this.queueAction(message);
          break;
        case 'historyBack':
          this.returnToConversation();
          break;
        case 'errorAction':
          if (message.action === 'reconnect') {
            await this.reconnect(message);
          }
          else if (message.action === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Elk-ydy.dsh-acp-panel');
          else if (message.action === 'log') await vscode.commands.executeCommand('dshPanel.showLog');
          break;
        case 'draft': {
          const cwd = message.draft?.cwd;
          if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) break;
          // A directory switch may arrive before the departing draft's save.
          // Accept that draft only within the trusted workspace; it must keep
          // its own storage key instead of being rebound to the new directory.
          if (draftKey(cwd) !== draftKey(this.workdir()) && (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(cwd)))) break;
          const draft = normalizeDraft(message.draft, { cwd, trusted: vscode.workspace.isTrusted });
          if (draft && this.workspaceState) this.draftWrites = this.draftStore.set(draft).catch(error => this.log('warn', `保存草稿失败：${error.message}`));
          break;
        }
        case 'composerQuery': {
          this.composerQuery?.abort();
          this.composerSelection?.abort();
          const controller = new AbortController(); this.composerQuery = controller;
          const scope = this.contextRequestScope(message);
          if (!this.contextRequestCurrent(scope)) break;
          const options = { origin: message.origin === 'context' ? 'context' : 'syntax', source: message.source, requestId: message.requestId };
          const reply = { type: 'composerSuggestions', requestId: message.requestId, ...this.contextReplyScope(scope, options) };
          if (options.origin !== 'context' && message.trigger === '/' && typeof message.query === 'string') {
            const { commandChoices } = require('../workflow/commands');
            this.post({ ...reply, items: commandChoices(message.query, { busy: this.composer.busy(), trusted: vscode.workspace.isTrusted }), note: '命令可直接执行，正在查找可用技能…' });
          }
          try {
            const result = await this.composer.query(message.trigger, message.query, controller.signal, options);
            if (!controller.signal.aborted && this.contextRequestCurrent(scope)) this.post({ ...reply, ...result });
          } catch (error) {
            const { commandChoices } = require('../workflow/commands');
            if (!controller.signal.aborted && this.contextRequestCurrent(scope)) this.post({ ...reply, items: options.origin !== 'context' && message.trigger === '/' && typeof message.query === 'string' ? commandChoices(message.query, { busy: this.composer.busy(), trusted: vscode.workspace.isTrusted }) : [], note: this.errText(error) });
          }
          break;
        }
        case 'contextAdd':
        case 'composerSelect': {
          this.composerSelection?.abort();
          const controller = new AbortController(); this.composerSelection = controller;
          const scope = this.contextRequestScope(message);
          if (!this.contextRequestCurrent(scope)) break;
          const options = { origin: message.type === 'contextAdd' || message.origin === 'context' ? 'context' : 'syntax', source: message.source, queryRequestId: message.queryRequestId };
          const reply = { type: 'composerSelected', requestId: message.requestId, ...this.contextReplyScope(scope, options) };
          try {
            let id = message.id;
            if (message.type === 'contextAdd') {
              if (!['file', 'selection'].includes(message.source)) throw new Error('请选择当前文件或当前选区。');
              this.composerQuery?.abort();
              options.requestId = message.requestId;
              options.queryRequestId = message.requestId;
              const result = await this.composer.query('#', '', controller.signal, options);
              id = result.items[0]?.id;
              if (!id) throw new Error(message.source === 'selection' ? '当前没有可用选区，请在编辑器重新选择。' : '当前没有可引用的文件，请先打开文件。');
            }
            const item = await this.composer.select(id, controller.signal, options);
            if (!controller.signal.aborted && this.contextRequestCurrent(scope)) this.post({ ...reply, item });
          } catch (error) {
            if (!controller.signal.aborted && this.contextRequestCurrent(scope)) this.post({ ...reply, error: this.errText(error) });
          }
          break;
        }
        case 'composerCommand': {
          const scope = this.contextRequestScope(message);
          if (!this.contextRequestCurrent(scope)) break;
          const reply = { type: 'composerSelected', requestId: message.requestId, ...this.contextReplyScope(scope, { origin: message.origin === 'context' ? 'context' : 'syntax', source: message.source }) };
          try {
            if (message.origin === 'context') throw new Error('添加上下文入口只附加正文，不能执行命令。');
            await this.executeComposerCommand(message.id, scope);
            if (this.contextRequestCurrent(scope)) this.post({ ...reply, command: true });
          } catch (error) { if (this.contextRequestCurrent(scope)) this.post({ ...reply, error: this.errText(error) }); }
          break;
        }
        case 'workflowAction':
          await this.onWorkflowAction(message);
          break;
        case 'composerCancel':
          this.composerQuery?.abort();
          this.composerSelection?.abort();
          break;
        case 'stop':
          // 停止当前回合也必须撤销权限弹窗；只取消主请求会留下一个已经过期、
          // 但仍可点击的确认框，并可能让内核继续等待反向请求的回答。
          this.cancelPendingPermissionRequests(undefined, '用户停止了当前回合');
          this.pauseQueue('当前回合已停止，排队消息需显式继续。');
          this.session ? this.session.stop() : undefined;
          break;
        case 'newSession':
          await this.newSession();
          break;
        case 'setModel':
          await this.configureSession(message, () => this.setModel(message.value), 'model');
          break;
        case 'setOption':
          await this.configureSession(message, () => this.session.setOption(message.id, message.value), message.id);
          break;
        case 'setPreset':
          if (!this.contextRequestCurrent(this.contextRequestScope(message))) throw new Error('当前界面只读或对话已变化，请返回当前对话后修改模式。');
          await this.setPreset(message.value);
          break;
        case 'setPermission':
          await this.setPermission(message.value, message);
          break;
        case 'refreshPermission':
          await this.refreshPermission();
          break;
        case 'permission':
          this.answerPendingPermission(message.requestId, message.optionId);
          break;
        case 'historyList':
          await this.sendHistoryList(message);
          break;
        case 'historyOpen':
          await this.sendHistoryReplay(message.id);
          break;
        case 'historyResume':
          await this.resumeHistory(message.id);
          break;
        case 'historyExport':
          await this.exportHistory(message.id);
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
      if (message.type === 'send') this.post({ type: 'sendResult', requestId: message.requestId, success: false, phase: 'rejected', error: text });
      if (['setOption', 'setModel'].includes(message.type)) this.post({ type: 'config', configOptions: this.session?.configOptions || [] });
      if (message.type === 'setPermission') this.post({ type: 'settingResult', setting: 'permission', requestId: message.requestId, cwd: this.workdir(), sessionId: this.session?.sessionId, phase: 'completed', success: false, error: text, text });
      // 只有“本回合自身失败”才会在抛出前把 session.busy 复位。若是切换模型、
      // 读取历史等旁路操作失败，模型回合可能仍在执行；此处不能无条件把停止按钮
      // 变回发送按钮，否则界面会允许用户误发第二个并发回合。
      this.post({ type: 'busy', busy: Boolean(this.session && this.session.busy) });
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
    if (this.sessionCwd && vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(this.sessionCwd))) return this.sessionCwd;
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
  async candidatesFor(cfg) {
    const desktops = [
      ...this.desktopExecutables,
      ...await runningDesktopExecutablesAsync(),
    ].filter((value, index, all) => value && all.indexOf(value) === index);
    return dshCommandCandidates({
      dshCommand: cfg.dshCommand,
      homedir: os.homedir(),
      desktopExecutables: desktops,
      extensionDir: path.resolve(__dirname, '..', '..'),
    });
  }

   /** 优先使用指定的后备配置，再查找已安装接入点且可由命令行启动的配置集。 */
  profilesFor(cfg) {
    return panelProfileCandidates({ configured: cfg.fallbackProfile, homedir: os.homedir() });
  }

  /**
   * 在后台启动 DSH：按候选命令逐个尝试，以最先开放接入点监听者为准。
   *
    * `dsh` 可能不在 VS Code 可见的 PATH 中。候选清单见
    * {@link dshCommandCandidates}：配置项中填写的命令优先，其次是默认安装位置的
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
        this.kernels.acquire(this.kernelConsumer, reusable);
        this.log('info', `面板自行启动的内核仍在运行（${cfg.host}:${door.port}），继续使用该内核，不重新启动`);
        this.post({ type: 'notice', text: '继续使用当前正在运行的 DSH。' });
        return { ok: true, command: reusable.command, profile: reusable.profile, port: door.port };
      }
      this.log('warn', '本扩展启动的内核仍在运行，但其接入点始终未开放监听 —— 回收该内核并重新启动');
      this.kernels.stop(reusable.key, '内核仍在运行但接入点未开放监听，重新启动');
    }

    const profiles = this.profilesFor(cfg);
    // 启动过程只显示在顶栏状态中；配置集与等待细节写入日志。
    this.log('info', `端口上不存在接入点，按配置自行启动一个 DSH 内核（配置集：${profiles[0]}，接入点固定为 ${cfg.host}:${cfg.selfStartPort}）`);

    const candidates = await this.candidatesFor(cfg);
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
    // 同一配置集只需成功同步一次；命令不可用时允许下一条命令候选重试。
    const syncedProfiles = new Set();
    const syncAttempts = new Set();
    for (let i = 0; i < plans.length; i += 1) {
      const { profile, command } = plans[i];
      const hasMore = i + 1 < plans.length;
      // 逐项尝试候选命令只写入日志，顶栏不需要随之变化。
      this.log('info', `尝试启动：${redactSensitiveOutput(command)}（配置集：${profile}）`);

      /*
       * desktop 与 vscode-panel 是两个独立的依赖清单。此前准备命令只给后者安装连接组件，
       * 结果是：桌面端开着时模型能调用用户插件；桌面端关闭、自启 vscode-panel 后同一批
       * 插件全部消失。这里在真正自启前做一次差异同步，后续桌面端增装/升级插件也能跟上。
       *
       * 仅自动维护约定的 vscode-panel：测试配置集与用户自定义配置集不应被静默改写；
       * desktop 更不会在此处被写入。同步失败不阻止聊天启动，原有能力仍可继续使用，
       * 具体原因保留在日志中。
       */
      const syncKey = `${profile}\0${command}`;
      if (
        profile === 'vscode-panel'
        && !syncedProfiles.has(profile)
        && !syncAttempts.has(syncKey)
      ) {
        syncAttempts.add(syncKey);
        this.post({ type: 'status', state: 'connecting', detail: '正在同步插件与配置…' });
        try {
          const result = await syncPanelProfilePlugins({ command, profile });
          syncedProfiles.add(profile);
          if (result.synced.length > 0) {
            this.log('info', `已将桌面端的 ${result.synced.length} 个插件同步到 ${profile}：${result.synced.join('、')}`);
            this.post({ type: 'notice', text: `已同步 ${result.synced.length} 个 DSH 插件。` });
          }
          if (result.skipped.length > 0) {
            this.log(
              'warn',
              `有 ${result.skipped.length} 个桌面端插件使用本地或无法复现的来源，未自动同步：` +
                result.skipped.map((item) => item.name).join('、'),
            );
          }
        } catch (error) {
          this.log('warn', `同步桌面端插件失败，继续启动现有配置：${redactSensitiveOutput(this.errText(error))}`);
        }
      }
      let entry;
      try {
        /*
         * desktop 的插件配置（模型路由、开关、插件参数）不在 package.json，而在
         * cordis.patch.yml。自启实例通过 DSH 自身的 --patch 只读叠加这份配置；
         * 测试传入的覆盖参数放在最后，以便测试端口等显式要求仍拥有最高优先级。
         */
        const inheritedConfigArgs = desktopProfilePatchArgs({ profile });
        if (inheritedConfigArgs.length > 0) {
          this.log('info', `自启 ${profile} 将只读继承 desktop 的插件配置与模型路由`);
        }
        // 交由 manager 启动并登记：这样"视图销毁"不会终止该进程，另一个窗口也可以复用。
        // 接入点固定在面板自身的端口上（该插件读取 DSH_ACP_DOOR_PORT，见 dsh-door/lib/port.js）。
        // 配置集中的 port 是**默认值**，不是命令；内核由哪一方启动，端口即由该方决定。
        entry = this.kernels.spawn({
          host: cfg.host,
          port: cfg.selfStartPort,
          command,
          profile,
          log: this.log,
          extraArgs: [...inheritedConfigArgs, ...this.spawnArgs],
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
        this.kernels.acquire(this.kernelConsumer, entry);
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
    * 该情况下仅监测面板自身的端口，避免把原端口的旧内核误判为新内核。
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
    this.recoveryGeneration++;
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
     * 连接端口的确定顺序：
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
        this.kernels.acquire(this.kernelConsumer, mine);
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

    let client;
    try {
      client = await this.connections.connect({ host: cfg.host, port: target });
      if (this.view || this.ownsConnections) this.connections.acquire('panel');
    } catch (error) {
      if (client) client.close();
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
      this.connections.setStatus(status);
      if (status?.version) this.log('info', `接入点插件版本 ${status.version}`);
      if (status?.runtime?.acpVersion) this.log('info', `实际 ACP 运行时 ${status.runtime.acpVersion}；接入协议 ${status.protocolVersion || '未声明'}`);
      if (status?.capabilities?.historyKind || status?.capabilities?.permissionKind) {
        this.log(
          'info',
          `内核兼容适配：历史=${status.capabilities.historyKind || 'unknown'}` +
            `${status.capabilities.sessionFormat ? `/v${status.capabilities.sessionFormat}` : ''}，` +
            `权限=${status.capabilities.permissionKind || 'unavailable'}`,
        );
      }
      if (status?.model?.ready === false) {
        client.close();
        this.postError('DSH 还没有可供新对话使用的模型。', {
          title: '尚未选择模型',
          advice: '先在 DSH 中选择默认模型，再重新连接。下方扩展设置仅检查连接，不配置默认路由或凭据。',
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
    this.connections.setSession('panel', session);
    this.wire(session, client);
    this.post({ type: 'status', state: 'connecting', detail: this.resumeTarget ? '正在恢复会话上下文…' : '正在建立新会话…' });

    try {
      if (this.resumeTarget) {
        // 断线重连：先尝试恢复此前那个会话，恢复失败时才新建会话。
        const target = this.resumeTarget;
        try {
          // 同时把当前预设告知该插件：内核不会把经由该插件建立的会话的预设写入会话记录，
          // 该插件依赖该值指定（或依赖其自身记录的值）补充挂载 —— 不补充时，恢复的会话没有可用工具。
          await this.restoreSession(session, target, this.workdir(), this.currentPreset);
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
      // 连接若已在等待 session/new 期间断开，wire() 的 close 处理已经展示过一次
      // 断线说明并清空引用；这里不得再追加一张“新建失败”错误卡片。
      const alreadyClosed = this.session !== session || this.client !== client;
      if (alreadyClosed) return undefined;
      this.postError(`新建对话失败：${text}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      // TCP/ACP 已经接通并不代表会话已经可用。若 session/new 失败却保留
      // this.session，下一次发送会把这个“没有 sessionId 的半成品”当作正常连接，
      // 因而既不重连，也无法自行恢复。主动拆除本次连接，使下一次操作重新走完整建连流程。
      this.teardown();
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

    this.post({ type: 'status', state: 'ready', detail: '会话已建立，首个任务会验证模型请求。' });
    return session;
  }

  /** 把会话与客户端的事件转发到界面。 */
  wire(session, client) {
    this.unwire(session);
    const handlers = [];
    this.sessionBindings ||= new Map();
    const onSession = (name, listener) => { session.on(name, listener); handlers.push(() => session.off(name, listener)); };
    onSession('user', (payload) => this.post({ type: 'user', text: payload.text, attachments: payload.attachments }));
    onSession('assistant', (payload) => {
      if (this.workflow?.latest && !this.workflow.latest.finished) { this.workflow.latest.messageId = payload.id; this.workflow.publish(); }
      this.post({ type: 'assistant', id: payload.id });
    });
    onSession('text', (payload) => this.post({ type: 'text', id: payload.id, delta: payload.delta }));
    onSession('thinking', (payload) =>
      this.post({ type: 'thinking', id: payload.id, delta: payload.delta }),
    );
    onSession('tool', (payload) => this.post({ type: 'tool', id: payload.id, tool: payload.tool }));
    onSession('done', (payload) => {
      if (payload.status === 'error' || payload.status === 'cancelled') this.pauseQueue('当前回合未完成，请处理后显式继续。');
      this.post({ type: 'done', id: payload.id, status: payload.status });
    });
    onSession('usage', (payload) =>
      this.post({ type: 'usage', used: payload.used, size: payload.size }),
    );
    onSession('config', (payload) => this.post({ type: 'config', configOptions: payload.configOptions }));
    onSession('presets', (payload) => this.onPresets(payload));
    onSession('busy', (payload) => {
      this.post({ type: 'busy', busy: payload.busy });
      this.post({
        type: 'status',
        state: payload.busy ? 'busy' : 'ready',
        detail: payload.busy ? '工作中…' : '就绪',
      });
      if (!payload.busy) setTimeout(() => { void this.drainQueue(); }, 0);
    });
    onSession('session', (payload) => {
      this.contextSessionSerial++;
      this.workflow?.publish();
      this.log('info', `当前会话 ${payload.sessionId}`);
      this.composerQuery?.abort(); this.composerSelection?.abort();
      this.post({ type: 'meta', cwd: this.workdir(), trusted: vscode.workspace.isTrusted, sessionId: payload.sessionId });
      // 会话确定后（新建/恢复/切换内核）读取一次权限：权限属于内核状态，
      // 更换内核或更换会话时取值可能不同，不能沿用上一次的结果。
      void this.refreshPermission();
    });

    const onPermission = (requestId, params) => {
      if (params?.sessionId && params.sessionId !== session.sessionId) return;
      if (session.externalPermissionHandler) return;
      // 视图可能在模型发出权限请求之前被折叠/销毁。此时没有人能够点击选项，
      // 必须立即回“取消”；仅把消息 post() 给不存在的视图会使内核永久等待。
      if (!this.view) {
        session.answerPermission(requestId, undefined);
        this.log('info', `面板未打开，已取消权限请求 #${requestId}`);
        return;
      }
      this.pendingPermissionRequests.set(requestId, { client, session, params });
      this.showNextPendingPermissionRequest();
    };
    client.on('permission', onPermission); handlers.push(() => client.off('permission', onPermission));
    const onClose = (reason) => {
      this.pauseQueue('连接已中断，请恢复原对话后显式继续。');
      this.unwire(session);
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
      this.workflow?.publish();
    };
    this.clientCloseHandlers.set(client, onClose);
    client.on('close', onClose);
    handlers.push(() => { client.off('close', onClose); if (this.clientCloseHandlers.get(client) === onClose) this.clientCloseHandlers.delete(client); });
    this.sessionBindings.set(session, handlers);
  }
  unwire(session) { for (const dispose of this.sessionBindings?.get(session) || []) dispose(); this.sessionBindings?.delete(session); }

  /** 同一连接的活动会话直接交给面板，不重复 session/resume。 */
  async adoptSession(session, { cwd, preset } = {}) {
    if (this.newSessionPending || this.workflow?.activeTest || this.workflow?.recording || this.workflow?.undoing) throw new Error('请等测试、撤销或会话切换完成后再切换会话。');
    return this.changeSession(() => this.adoptSessionInternal(session, { cwd, preset }), `adopt:${session.sessionId}`);
  }

  async adoptSessionInternal(session, { cwd, preset } = {}) {
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) throw new Error('会话目录不在受信任工作区');
    if (session.client !== this.connections.client || !session.client.isConnected || this.session?.busy || session.busy || this.connections.turns?.has(this.session?.sessionId) || this.connections.turns?.has(session.sessionId)) throw new Error('当前无法切换会话');
    if (this.session !== session) {
      this.cancelPendingPermissionRequests(undefined, '切换会话'); this.unwire(this.session);
      this.session = session; this.client = session.client; this.wire(session, session.client); this.connections.setSession('panel', session);
    }
    this.sessionCwd = cwd; this.preset = preset; this.turnSent = session.messages.size > 0;
    this.workflow?.reset();
    this.resumeTarget = undefined; this.postWorkspaceMeta(cwd);
    const replay = await this.sendHistoryReplay(session.sessionId, { readonly: false });
    if (replay) this.setLiveTranscript([replay]);
    this.historyReadonly = false; this.historyId = undefined;
    this.post({ type: 'historyState', readonly: false });
    await this.refreshPermission(); this.pushSnapshot();
  }

  /**
   * 连接断开后，向对话流输出中文说明。
   *
   * 通用连接错误不能说明内核是否已经退出，因此按内核所有权补充退出信息：
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
    this.workflow?.publish();
    const session = this.session;
    if (!session) return;
    this.post({ type: 'meta', cwd: this.workdir(), trusted: vscode.workspace.isTrusted, sessionId: session.sessionId });
    this.post({ type: 'status', state: session.busy ? 'busy' : 'ready', detail: session.busy ? '工作中…' : '就绪' });
    this.post({ type: 'config', configOptions: session.configOptions });
    this.postPresets();
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
    if (current) { this.currentPreset = current; if (!this.preset || !this.restoringPreset && this.preset === payload?.requested) this.preset = current; }
    this.lastPresets = { presets, current, requested: payload?.requested };
    this.postPresets();
    if (payload?.fallback) {
      this.post({
        type: 'notice',
        text: `「${payload.requested}」模式不存在，已使用「${this.labelOf(current)}」。`,
      });
    }
  }

  async restoreSession(session, id, cwd, preset) {
    // A resumed session uses its original preset. Kernel normalization of that
    // preset must not replace the user's separate choice for the next session.
    this.restoringPreset = true;
    try {
      await session.resume(id, cwd, { preset });
      if (this.session === session && !session.doorMeta?.current) {
        this.currentPreset = undefined;
        if (this.lastPresets) this.lastPresets = { ...this.lastPresets, current: undefined };
        this.postPresets();
      }
    } finally { this.restoringPreset = false; }
  }

  postPresets() {
    if (this.lastPresets) this.post({ type: 'presets', ...this.lastPresets, current: this.currentPreset || this.lastPresets.current, pending: this.preset && this.preset !== this.currentPreset ? this.preset : undefined });
  }

  /** 预设的中文名称（该插件或内核提供了名称时使用该名称，否则回退为 id）。 */
  labelOf(id) {
    if (!id) return '默认';
    const list = this.lastPresets?.presets;
    const hit = Array.isArray(list) ? list.find((item) => item && item.id === id) : undefined;
    return (hit && hit.name) || id;
  }

  pauseQueue(reason) {
    this.queueEpoch++;
    void this.draftStore.flush().catch(error => this.log('warn', `保存草稿失败：${error.message}`));
    if (this.queue.recoveryBlocked) { this.queue.onChange(); return; }
    if (this.queue.active || this.queue.items.length) this.queue.pause(reason);
    else this.queue.resume();
  }

  persistQueue() {
    if (this.queue.recoveryBlocked) return Promise.reject(new Error(this.queue.reason));
    return this.queuePersistence.save(this.queue);
  }

  changeQueue(action) {
    const pending = (this.queueChanges || Promise.resolve()).catch(() => {}).then(action);
    this.queueChanges = pending; return pending;
  }

  async acceptMessage(message) {
    const requestId = message.requestId ?? require('node:crypto').randomUUID();
    let input, fingerprint, digest;
    try {
      input = structuredClone({ text: message.text, attachments: message.attachments ?? [] });
      if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 256 * 1024 || !Array.isArray(input.attachments) || input.attachments.length > 20) throw new Error('消息或附件超过限制，请缩小内容后重试。');
      fingerprint = JSON.stringify(input);
      digest = require('node:crypto').createHash('sha256').update(fingerprint).digest('hex');
      if (!(typeof requestId === 'string' && requestId.length <= 512 || typeof requestId === 'number' && Number.isFinite(requestId))) throw new Error('发送标识无效。');
      const previous = this.sendRequests.get(requestId);
      if (previous) {
        if (previous.digest ? previous.digest !== digest : previous.fingerprint !== fingerprint) throw new Error('发送标识已使用，请重新发送。');
        return previous.promise;
      }
    } catch (error) {
      this.post({ type: 'sendResult', requestId, success: false, phase: 'rejected', error: this.errText(error) });
      this.postError(this.errText(error));
      return false;
    }
    const epoch = this.queueEpoch;
    const record = { fingerprint, digest };
    // The active queue item also owns its baseline preparation and final change
    // capture. Follow-up messages may queue during those phases; an independent
    // capture still blocks new messages.
    const recordingBlocksSend = () => this.workflow?.recording && (!this.queue.active || !this.queueBindingMatches(this.queue.active));
    record.promise = (async () => {
      try {
        if (this.queue.recoveryBlocked) throw new Error(this.queue.reason);
        if (this.historyReadonly) throw new Error('当前是只读历史，请先返回当前对话或接回该会话。');
        if (!this.view) throw new Error('请先打开面板再发送。');
        if (this.newSessionPending || this.configPending || this.reconnectPending) throw new Error('会话、设置或连接正在调整，请稍后发送。');
        if (this.workflow?.activeTest || this.workflow?.undoing || recordingBlocksSend()) throw new Error('请等测试、撤销或改动整理完成后再发送消息。');
        const cwd = this.workdir();
        await this.draftStore.flush(cwd);
        const session = await this.ensureConnection();
        if (!session?.sessionId) throw new Error('对话未连接，请检查连接后重试。');
        if (session.cwd && session.cwd !== cwd) throw new Error('当前工作目录与对话目录不同，请新建对话后发送。');
        if (epoch !== this.queueEpoch || this.historyReadonly || !this.view || cwd !== this.workdir() || session !== this.session) throw new Error('对话已变化，请确认当前对话后重新发送。');
        if (input.attachments.length && vscode.workspace.isTrusted === false) throw new Error('请信任当前工作区后再发送附件。');
        if (input.attachments.some(item => item?.kind === 'file' && typeof item.text !== 'string')) throw new Error('旧文件附件没有正文快照，请移除后重新添加，再确认预览后发送。');
        const draft = snapshotMessage(input.text, input.attachments);
        if (epoch !== this.queueEpoch || this.historyReadonly || !this.view || cwd !== this.workdir() || session !== this.session || draft.attachments.length && vscode.workspace.isTrusted === false) throw new Error('对话或工作区已变化，请重新发送。');
        if (this.workflow?.activeTest || this.workflow?.undoing || recordingBlocksSend()) throw new Error('请等测试、撤销或改动整理完成后再发送消息。');
        if (this.queue.paused && !this.queue.items.length && !this.queue.active) this.queue.resume();
        const queued = Boolean(this.queue.active || this.queue.items.length || this.queue.paused || session.busy || this.workflow?.recording || this.workflow?.activeTest || this.workflow?.undoing);
        const sessionId = session.sessionId, instanceId = this.connections.snapshot?.().instanceId;
        const entry = await this.changeQueue(async () => {
          if (epoch !== this.queueEpoch || this.historyReadonly || !this.view || cwd !== this.workdir() || session !== this.session || session.sessionId !== sessionId || instanceId !== this.connections.snapshot?.().instanceId ||
            this.newSessionPending || this.configPending || this.reconnectPending || draft.attachments.length && vscode.workspace.isTrusted === false) throw new Error('对话或工作区已变化，请重新发送。');
          if (this.workflow?.activeTest || this.workflow?.undoing || recordingBlocksSend()) throw new Error('请等测试、撤销或改动整理完成后再发送消息。');
          const accepted = this.queue.add(draft, { cwd, sessionId, instanceId, requestDigest: digest }, requestId);
          try { await this.persistQueue(); return accepted; }
          catch (error) { this.queue.remove(accepted.id); throw error; }
        });
        this.post({ type: 'sendResult', requestId, success: true, phase: 'accepted', queued, id: entry.id });
        void this.drainQueue();
        return true;
      } catch (error) {
        this.sendRequests.delete(requestId);
        this.post({ type: 'sendResult', requestId, success: false, phase: 'rejected', error: this.errText(error) });
        this.postError(this.errText(error));
        return false;
      }
    })();
    this.sendRequests.set(requestId, record);
    void record.promise.then(accepted => { if (!accepted && this.sendRequests.get(requestId) === record) this.sendRequests.delete(requestId); });
    if (this.sendRequests.size > 64) for (const [key, value] of this.sendRequests) { if (value.completed) { this.sendRequests.delete(key); break; } }
    return record.promise;
  }

  async queueAction({ action, id, token, draft: editedDraft }) {
    if (action === 'discardRecovery') {
      if (!this.queue.recoveryBlocked) return;
      await this.queuePersistence.discard(); this.queue.recoveryBlocked = false; this.queue.resume(); return;
    }
    if (action === 'remove' || action === 'edit' || action === 'confirmEdit') {
      try {
        if (action === 'edit' && !this.view) throw new Error('请先打开面板再取回消息。');
        const entry = await this.changeQueue(async () => {
          // Resolve inside the serialized change: an earlier removal may have
          // completed while this request waited for durable storage.
          const index = this.queue.items.findIndex(item => item.id === id);
          if (index < 0) throw new Error('此消息已不在队列中');
          const entry = this.queue.items[index];
          if (action === 'edit') {
            if (!this.view) throw new Error('请先打开面板再取回消息。');
            const existing = this.pendingQueueEdits.get(id);
            if (existing?.entry === entry && existing.view === this.view) {
              this.post({ type: 'queueEdit', phase: 'prepared', id, token: existing.token, cwd: entry.cwd, text: entry.text, attachments: entry.attachments });
              return;
            }
            this.queue.pause('正在取回消息，队列已暂停。');
            const pending = { entry, view: this.view, token: require('node:crypto').randomUUID() };
            this.pendingQueueEdits.set(id, pending);
            this.post({ type: 'queueEdit', phase: 'prepared', id, token: pending.token, cwd: entry.cwd, text: entry.text, attachments: entry.attachments });
            return;
          }
          if (action === 'confirmEdit') {
            const pending = this.pendingQueueEdits.get(id);
            const current = () => pending && pending.token === token && pending.entry === entry && this.pendingQueueEdits.get(id) === pending && this.view && this.view === pending.view;
            if (!current()) throw new Error('取回请求已变化，原消息仍保留在队列中。');
            if (draftKey(entry.cwd) !== draftKey(this.workdir()) && (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(entry.cwd)))) throw new Error('原消息目录已不在受信任工作区。');
            const draft = normalizeDraft(editedDraft, { cwd: entry.cwd, trusted: vscode.workspace.isTrusted });
            const contains = value => value && [value, ...(value.recoveries || []), ...(value.recovery ? [value.recovery] : [])].some(item => {
              try { return JSON.stringify(snapshotMessage(item.text, item.attachments)) === JSON.stringify({ text: entry.text, attachments: entry.attachments }); }
              catch { return false; }
            });
            if (!contains(draft)) throw new Error('取回内容未能完整保存为草稿，原消息仍保留在队列中。');
            await Promise.all([this.draftStore.set(draft), this.draftStore.flush(entry.cwd)]);
            if (!current()) throw new Error('面板已变化，原消息仍保留在队列中。');
            if (!contains(normalizeDraft(this.workspaceState?.get(draftKey(entry.cwd)), { cwd: entry.cwd, trusted: vscode.workspace.isTrusted }))) throw new Error('取回内容尚未保存，原消息仍保留在队列中。');
          }
          this.queue.remove(id);
          try { await this.persistQueue(); }
          catch (error) { this.queue.items.splice(index, 0, entry); this.queue.onChange(); throw error; }
          this.pendingQueueEdits.delete(id);
          return entry;
        });
        if (!entry) return;
        const record = this.sendRequests.get(entry.requestId); if (record) record.completed = true;
        if (action === 'confirmEdit') this.post({ type: 'queueEdit', phase: 'completed', id, token });
        if (!this.queue.active && !this.queue.items.length) this.queue.resume();
      } catch (error) {
        if (action === 'edit' || action === 'confirmEdit') {
          if (!token || this.pendingQueueEdits.get(id)?.token === token) this.pendingQueueEdits.delete(id);
          this.post({ type: 'queueEdit', ...(action === 'confirmEdit' ? { phase: 'completed', token } : {}), id, error: this.errText(error) });
        }
        else throw error;
      }
      return;
    }
    if (action !== 'continue') return;
    if (this.pendingQueueEdits.size) throw new Error('请等取回消息完成后再继续队列。');
    if (this.configPending || this.reconnectPending) throw new Error('请等设置或连接恢复完成后再继续队列。');
    if (this.historyReadonly || !this.view) throw new Error('请先返回当前对话再继续排队消息。');
    const first = this.queue.items[0];
    if (this.queue.recoveryBlocked) throw new Error(this.queue.reason);
    if (first?.uncertain) throw new Error('执行结果待确认，请核对历史后取回编辑；不能直接重发。');
    if (first?.restored && (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(first.cwd)) || !require('node:fs').existsSync(first.cwd))) throw new Error('恢复消息的目录不可用或工作区尚未受信任，请取回编辑。');
    if (first && !this.queueBindingMatches(first)) throw new Error('排队消息属于原会话或目录，请取回编辑后重新发送。');
    this.queue.resume();
    await this.persistQueue();
    await this.drainQueue();
  }

  queueBindingMatches(entry) {
    return Boolean(this.session?.sessionId === entry.sessionId && this.workdir() === entry.cwd &&
      (!entry.instanceId || this.connections.snapshot?.().instanceId === entry.instanceId));
  }

  async drainQueue() {
    if (this.queue.active || this.queue.paused || !this.queue.items.length) return;
    if (!this.view || this.historyReadonly) { this.pauseQueue('请返回当前对话后显式继续。'); return; }
    if (this.session?.busy || this.newSessionPending || this.configPending || this.reconnectPending || this.workflow?.recording || this.workflow?.activeTest || this.workflow?.undoing || this.connections.turns?.has(this.session?.sessionId)) return;
    const first = this.queue.items[0];
    if (first.restored && (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(first.cwd)) || !require('node:fs').existsSync(first.cwd))) { this.pauseQueue('恢复消息的目录不可用或工作区尚未受信任，请取回编辑。'); return; }
    if (first.uncertain || this.queue.recoveryBlocked) { this.pauseQueue('执行结果待确认，请先核对历史后取回编辑。'); return; }
    if (!this.queueBindingMatches(first) || !this.client?.isConnected) { this.pauseQueue('会话或连接已变化，请确认后显式继续。'); return; }
    const epoch = this.queueEpoch;
    let entry;
    try {
      entry = await this.changeQueue(async () => {
        const taken = this.queue.take(); if (!taken) return;
        try { await this.persistQueue(); return taken; }
        catch (error) { this.queue.finish('启动前保存失败，未执行'); this.queue.pause('队列保存失败，消息尚未执行，请修复存储后重试。'); throw error; }
      });
    } catch (error) { this.postError(this.errText(error)); return; }
    if (!entry) return;
    if (epoch !== this.queueEpoch || this.queue.paused || !this.queueBindingMatches(entry) || !this.view || this.historyReadonly) {
      await this.changeQueue(async () => {
        this.queue.active = undefined; this.queue.items.unshift(entry);
        this.queue.pause(this.queue.reason || '发送前会话或目录已变化，请确认后显式继续。');
        try { await this.persistQueue(); }
        catch (error) { this.postError(this.errText(error)); }
      });
      return;
    }
    let result, error;
    try {
      if (entry.restored && !vscode.workspace.isTrusted) throw new Error('恢复消息需要受信任工作区。');
      result = await this.send(entry.text, entry.attachments, { entry, epoch });
    }
    catch (failure) { error = failure; this.postError(this.errText(failure)); }
    const success = !error && result !== false && (!result?.stopReason || result.stopReason === 'end_turn');
    const uncertain = Boolean(error && (!this.client?.isConnected || error.code === 'ACP_REQUEST_TIMEOUT' || /ECONNRESET|EPIPE|ETIMEDOUT|connection.*closed|连接已断开|连接已关闭/i.test(`${error.code || ''} ${error.message || ''}`)));
    if (uncertain && this.queue.active) this.queue.active = Object.freeze({ ...this.queue.active, uncertain: true, phase: 'uncertain' });
    if (!success) this.pauseQueue(uncertain ? '执行结果待确认；请核对历史后取回编辑。' : result?.stopReason === 'cancelled' ? '当前回合已取消，请确认后显式继续。' : '当前回合未完成，请处理后显式继续。');
    const record = this.sendRequests.get(entry.requestId); if (record) record.completed = success;
    await this.changeQueue(async () => {
      this.queue.finish(success ? undefined : uncertain ? '执行结果待确认，请先核对历史记录。' : error ? this.errText(error) : '回合未完成');
      try { await this.persistQueue(); } catch (failure) { this.queue.pause('回合结果的保存失败，重新加载后请核对历史记录。'); this.postError(this.errText(failure)); }
    });
    this.post({ type: 'sendCompleted', requestId: entry.requestId, id: entry.id, cwd: entry.cwd, success, retained: !success, stopReason: result?.stopReason || (error ? 'error' : 'end_turn'), text: entry.text, attachments: entry.attachments });
    if (success && epoch === this.queueEpoch) await this.drainQueue();
  }

  returnToConversation() {
    this.historyReplayEpoch = (this.historyReplayEpoch || 0) + 1;
    this.historyReadonly = false; this.historyId = undefined;
    this.post({ type: 'historyState', readonly: false });
    this.postConversationSnapshot();
    this.pushSnapshot();
  }

  // ── 操作 ────────────────────────────────────────────

  async send(text, attachments = [], queued) {
    if (this.configPending || this.reconnectPending) throw new Error('请等设置或连接恢复完成后再发送消息。');
    if (this.workflow?.activeTest || this.workflow?.undoing) throw new Error('请等测试或撤销完成后再发送消息。');
    const items = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    if (items.length > 20 || items.reduce((size, item) => size + (typeof item.text === 'string' ? Buffer.byteLength(item.text) : 0), 0) > 256 * 1024) throw new Error('最多附加 20 项，正文总量不超过 256 KiB；请移除附件或选择较小选区。');
    if (items.length && vscode.workspace.isTrusted === false) throw new Error('请信任当前工作区后再发送附件');
    if ((!text || !text.trim()) && items.length === 0) return;
    // 新建会话会先关闭旧会话、再等待 session/new。此窗口内若直接发送，旧实现会把消息
    // 发给已关闭且尚未取得新 id 的会话。等待切换落定；失败时再由 ensureConnection 重连。
    if (this.newSessionPending) await this.newSessionPending;
    if (this.historyReadonly) throw new Error('当前是只读历史，请先返回当前对话或接回该会话。');
    const session = await this.ensureConnection();
    if (!session) return false;
    // 自此该会话已「发送过消息」：更换预设时不能再静默重新开启该会话。
    this.turnSent = true;
    const execute = async () => {
      if (this.historyReadonly || queued && (queued.epoch !== this.queueEpoch || !this.queueBindingMatches(queued.entry))) throw new Error('消息所属会话已变化，请取回编辑后重新发送。');
      if (this.workflow?.activeTest || this.workflow?.undoing) throw new Error('请等测试或撤销完成后再发送消息。');
      const turn = await this.workflow?.begin();
      let outcome = 'failed';
      try {
        if (this.historyReadonly || session !== this.session || session.busy || this.workflow?.activeTest || this.workflow?.undoing || queued &&
          (queued.epoch !== this.queueEpoch || !this.view || !this.queueBindingMatches(queued.entry))) throw new Error('消息所属会话或任务已变化，请确认后重新发送。');
        const result = await session.send(text, { attachments: items }); outcome = result?.stopReason === 'cancelled' ? 'cancelled' : result?.stopReason === 'end_turn' || !result?.stopReason ? 'completed' : 'failed'; return result;
      }
      finally { await this.workflow?.finish(turn, outcome); }
    };
    if (typeof this.connections.runSession === 'function') return this.connections.runSession(session, execute);
    return execute();
  }

  async executeComposerCommand(id, scope = this.contextRequestScope()) {
    if (!this.contextRequestCurrent(scope)) throw new Error('对话或工作区已变化，请重新选择命令。');
    const { COMMANDS } = require('../workflow/commands');
    const command = COMMANDS.find(item => item.id === id);
    if (!command) throw new Error('未知命令，请重新选择。');
    const busy = this.session?.busy || this.queue.active || this.newSessionPending || this.workflow?.recording || this.workflow?.activeTest || this.workflow?.undoing;
    if (busy && ['new', 'model', 'changes', 'test'].includes(command.name)) throw new Error('请等当前任务结束后再执行此命令。');
    switch (command.name) {
      case 'new': return this.newSession();
      case 'review': return vscode.commands.executeCommand('dshPanel.bridge.review');
      case 'status': return vscode.commands.executeCommand('dshPanel.bridge.diagnoseConfig');
      case 'changes': return this.workflow.showChanges();
      case 'test': return this.tests.run({ current: () => this.contextRequestCurrent(scope) });
      case 'help': return vscode.window.showInformationMessage('@ 搜索文件，# 引用当前文件或选区，/ 选择命令或技能。命令直接执行；技能附加后随消息发送。改动记录以本轮开始时内容为基线；/test 选择工作区测试任务。');
      case 'model': {
        const session = this.session, sessionId = session?.sessionId;
        const option = session?.configOptions.find(item => item.id === 'model');
        const choices = (option?.options || []).flatMap(group => group.options || [group]).filter(item => typeof item.value === 'string');
        if (!choices.length) throw new Error('内核尚未提供可切换模型，请先连接。');
        const selected = await vscode.window.showQuickPick(choices.map(item => ({ label: item.name || item.value, value: item.value })), { placeHolder: '选择当前对话模型' });
        if (selected) {
          if (!this.contextRequestCurrent(scope) || this.session !== session || session.sessionId !== sessionId || session.busy || this.queue.active || this.newSessionPending || this.workflow?.recording || this.workflow?.activeTest || this.workflow?.undoing) throw new Error('会话或当前任务已变化，请重新选择模型。');
          const applied = await this.configureSession({ cwd: scope.cwd, sessionId, requestId: `model-command-${++this.recoverySequence}` }, () => this.setModel(selected.value), 'model');
          if (!applied) throw new Error('模型设置未确认，请查看实际设置后重试。');
        }
        break;
      }
    }
  }

  /** Test evidence is returned to the requesting draft without sending it. */
  async onWorkflowAction(message) {
    if (this.configPending || this.reconnectPending) {
      this.post({ type: 'workflowResult', action: message.action, requestId: message.requestId, turnId: message.turnId, testId: message.testId, cwd: this.workdir(), sessionId: this.session?.sessionId, error: '请等设置或连接恢复完成后再操作测试或改动。' });
      return;
    }
    if (message.action === 'preview') return this.workflow?.preview(message.id);
    if (message.action === 'undo') return this.workflow?.undo(message.id);
    const actions = ['test', 'cancelTest', 'previewTest', 'attachTest', 'prepareTest', 'logTest', 'taskTerminals'];
    if (!actions.includes(message.action)) return;
    const scope = this.contextRequestScope(message);
    if (!this.contextRequestCurrent(scope)) return;
    const reply = { type: 'workflowResult', action: message.action, requestId: message.requestId,
      turnId: message.turnId, testId: message.testId, cwd: scope.cwd, sessionId: scope.sessionId };
    try {
      if (!this.tests) throw new Error('测试任务尚未就绪，请重新打开面板。');
      if (message.requestId === undefined || message.requestId === null || !['string', 'number'].includes(typeof message.requestId)) throw new Error('操作标识缺失，请重新选择测试结果。');
      if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，再操作测试结果。');
      const identity = { turnId: message.turnId, testId: message.testId, requestId: message.requestId,
        cwd: scope.cwd, sessionId: scope.sessionId, current: () => this.contextRequestCurrent(scope) };
      let result;
      if (message.action === 'test') result = await this.tests.run(identity);
      else if (message.action === 'cancelTest') result = await this.tests.cancel(identity);
      else if (message.action === 'previewTest') result = await this.tests.preview(identity);
      else if (message.action === 'attachTest') result = await this.tests.attach(identity);
      else if (message.action === 'prepareTest') result = await this.tests.prepare(identity);
      else if (message.action === 'logTest') result = await this.tests.supplement(identity, message.logText);
      else if (message.action === 'taskTerminals') result = await this.tests.openTerminal(identity);
      if (!this.contextRequestCurrent(scope)) return;
      // The browser checks the aggregate attachment and draft budgets before
      // applying this bundle atomically to its current, possibly newer input.
      const items = result?.items ? snapshotMessage('', result.items).attachments : undefined;
      this.post({ ...reply, ...(items ? { items } : {}), ...(typeof result?.text === 'string' ? { text: result.text } : {}), ...(typeof result?.note === 'string' ? { note: result.note } : {}) });
    } catch (error) {
      if (this.contextRequestCurrent(scope)) this.post({ ...reply, error: this.errText(error) });
    }
  }

  // ── 历史会话 ──────────────────────────────────────────
  //
  // 数据位于本机 `$DSH_HOME/sessions`。两条读取途径：
  //   1. ACP 接入点插件（dsh-acp-door）0.0.8+ 的旁路方法 `dsh-door/sessions/list|get`；
  //   2. 面板自行读取本机磁盘。
  //
  // 第 2 条途径必要的原因：接入点插件安装在用户配置集中，而**该配置集由 DSH 桌面端自行
  // 管理**，接入点过旧或旁路方法不可用时仍需提供本地读取路径。
  // 面板与内核位于同一台机器，历史读取无需启动或修改另一套内核配置。

  /**
   * 读取一次历史会话。
   *
   * @param {'list'|'get'} kind
   * @param {string} [id] kind==='get' 时使用的会话 id。
   * @returns {Promise<{result: object, via: 'door'|'local'}>}
   */
  async readHistory(kind, id, options = {}) {
    const localRoot = localSessions.resolveSessionsRoot();
    const client = this.client;
    this.historyCache ||= new HistorySummaryCache(this.workspaceState);
    const config = this.config(), source = JSON.stringify([localRoot, config.host, config.port]);
    let remoteError;

    // 能够向该插件查询时即通过该插件查询：这是本机 DSH 返回的正式数据来源。
    // `historyVia === 'local'` 表示本轮连接中已确认该插件没有此方法，
    // 因此不再在每次打开历史会话时发起一次注定失败的往返。
    if (this.historyVia !== 'local' && client && client.isConnected) {
      try {
        const result = kind === 'list'
          ? await client.listHistory(options)
          : await client.getHistory(String(id || ''));
        options.signal?.throwIfAborted();
        this.historyVia = 'door';
        if (kind === 'list') {
          try { await this.historyCache.put(source, options, result); }
          catch (error) { this.log('warn', `缓存历史摘要失败：${error.message}`); }
        }
        return { result, via: 'door' };
      } catch (error) {
        options.signal?.throwIfAborted();
        const text = this.errText(error);
        if (!isMissingMethod(error, text) && client.isConnected && !/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|connection.*closed|连接已关闭|连接已断开/i.test(`${error.code || ''} ${text}`)) throw error;
        remoteError = error;
        if (isMissingMethod(error, text)) {
          this.historyVia = 'local';
          this.log('info', '历史会话旁路方法不可用，改为只读本地旧格式历史');
        }
      }
    }
    if (kind === 'list') {
      const cached = this.historyCache.get(source, options);
      if (cached) return { result: cached, via: 'cache' };
    }
    if (!localSessions.hasZstdSupport()) {
      throw new Error('本机 Node 不支持 zstd 压缩格式，无法解析会话文件');
    }
    const result = kind === 'list'
      ? await localSessions.listSessionsAsync(localRoot, options)
      : await localSessions.getSessionAsync(localRoot, String(id || ''), options);
    if (kind === 'list') {
      result.offline = !client?.isConnected || Boolean(remoteError);
      if (!result.limitation) result.limitation = '当前只显示可本地读取的旧格式会话；新版完整历史需要连接 DSH 内核。';
      if (result.unsupported && !result.sessions.length) result.emptyReason = 'unsupported-format';
      else if (!result.sessions.length) result.emptyReason = 'local-empty';
    }
    return { result, via: 'local' };
  }

  /**
   * 把历史会话清单发送给界面。
   *
   * 接入点插件版本过低时，上述本机读取途径会自动补上，不要求用户修改桌面端配置集。
   */
  async sendHistoryList(request = {}) {
    this.historySearchController?.abort();
    const controller = this.historySearchController = new AbortController();
    const requestId = Number.isInteger(request.requestId) ? request.requestId : undefined;
    try {
      const options = historyOptions({ ...request, cwd: request.projectOnly === true ? this.workdir() : '' });
      const { result, via } = await this.readHistory('list', undefined, { ...options, signal: controller.signal });
      if (controller.signal.aborted) return;
      const sessions = Array.isArray(result && result.sessions) ? result.sessions : [];
      // 本地读取失败时（目录不可读等）原因会写入 error 字段，不应将其视为「没有历史会话」。
      if (sessions.length === 0 && result && result.error) throw new Error(result.error);
      this.post({ type: 'history', via, sessions, requestId, skipped: result?.skipped || 0, total: result?.total, offset: result?.offset || 0, nextOffset: result?.nextOffset,
        cachedAt: result?.cachedAt, cacheScope: result?.cacheScope, limited: result?.limited, limitation: result?.limitation, offline: result?.offline, unsupported: result?.unsupported, emptyReason: result?.emptyReason,
        queryUnsupported: (options.query || options.cwd || options.offset) && result?.offset === undefined });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.post({ type: 'history', requestId, error: this.historyErrorText(error) });
    }
  }

  async exportHistory(id) {
    try {
      const { result } = await this.readHistory('get', String(id || ''));
      const uri = await vscode.window.showSaveDialog({ saveLabel: '导出对话', defaultUri: vscode.Uri.file(path.join(this.workdir(), 'dsh-conversation.md')), filters: { Markdown: ['md'] } });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(historyMarkdown(result), 'utf8'));
      void vscode.window.showInformationMessage('对话已导出。');
    } catch (error) { this.postError(this.historyErrorText(error)); }
  }

  /** 把一段历史会话的回放发送给界面。 */
  async sendHistoryReplay(id, { readonly = true } = {}) {
    const epoch = this.historyReplayEpoch = (this.historyReplayEpoch || 0) + 1;
    this.historyReplayFailed = false;
    if (readonly) {
      this.pauseQueue('正在查看只读历史，请返回当前对话后显式继续。');
      this.historyReadonly = true; this.historyId = id;
      this.post({ type: 'historyState', readonly: true, id });
    }
    try {
      const { result, via } = await this.readHistory('get', id);
      if (epoch !== this.historyReplayEpoch) return;
      const replay = {
        type: 'replay',
        readonly,
        via,
        card: result && result.card ? result.card : {},
        entries: Array.isArray(result && result.entries) ? result.entries : [],
        truncated: Boolean(result && result.truncated),
      };
      if (readonly) this.lastHistoricalReplay = replay;
      this.post(replay);
      return replay;
    } catch (error) {
      if (epoch !== this.historyReplayEpoch) return;
      this.historyReplayFailed = true;
      this.postError(this.historyErrorText(error), undefined, { historical: readonly });
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
  resumeHistory(id, options = {}) {
    return this.changeSession(() => this.resumeHistoryInternal(id, options), JSON.stringify(['resume', id, options.cwd, options.preset]));
  }

  async resumeHistoryInternal(id, options = {}) {
    if (this.workflow?.activeTest || this.workflow?.recording || this.workflow?.undoing) {
      this.post({ type: 'notice', text: '请等测试、撤销或改动整理完成后再恢复会话。' });
      return false;
    }
    const session = this.session || await this.ensureConnection();
    if (!session) return;
    if (session.busy || this.connections.turns?.has(session.sessionId)) {
      this.post({ type: 'notice', text: '当前正在工作，结束后再进行恢复。' });
      return;
    }
    if (options.cwd && (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(options.cwd)))) throw new Error('恢复目录不在受信任工作区');
    // 忙碌判断必须早于回放：回放会清空当前转录。若先回放再拒绝恢复，
    // 用户正在进行的回答会被历史内容覆盖，随后到达的增量又混进回放中。
    const previousId = session.sessionId;
    this.historyReadonly = true; this.historyId = id;
    this.post({ type: 'historyState', readonly: true, id });
    const replayPromise = this.sendHistoryReplay(id);
    const replayEpoch = this.historyReplayEpoch;
    const replay = await replayPromise;
    if (replayEpoch !== this.historyReplayEpoch || this.historyReplayFailed || !this.historyReadonly || this.historyId !== id || this.session !== session || !this.client?.isConnected) return false;
    try {
      const historyPreset = typeof replay?.card?.preset === 'string' && replay.card.preset.trim() ? replay.card.preset.trim() : undefined;
      await this.restoreSession(session, String(id || ''), options.cwd || this.workdir(), options.preset || historyPreset);
      if (this.session !== session || this.client !== session.client || !this.client?.isConnected) return false;
      this.workflow?.reset();
      if (previousId && previousId !== session.sessionId) await session.client.closeSession(previousId).catch(error => this.log('warn', `关闭旧会话失败：${this.errText(error)}`));
      if (this.session !== session || this.client !== session.client || !this.client?.isConnected) return false;
      if (options.cwd) { this.sessionCwd = options.cwd; this.postWorkspaceMeta(options.cwd); }
      this.turnSent = true;
      this.resumeTarget = undefined;
      // Resume has already changed the kernel session. Always keep its actual
      // transcript, even if the reader navigated while the request was pending.
      // A subsequently opened history must retain its read-only state.
      if (replay) this.setLiveTranscript([{ ...replay, readonly: false }]);
      if (replayEpoch === this.historyReplayEpoch && this.historyReadonly && this.historyId === id) {
        this.historyReadonly = false; this.historyId = undefined;
        this.post({ type: 'historyState', readonly: false });
      } else if (!this.historyReadonly) this.postConversationSnapshot();
      this.post({ type: 'notice', text: '已恢复该历史会话。' });
      this.post({ type: 'status', state: 'ready', detail: '就绪' });
    } catch (error) {
      // 面板自身的说明放在第一行（简短），内核原文另起一行附上（原文较长不影响 ——
      // 它属于"原始信息"，而非面板附加的说明）。见 §文案要短 那条测试。
      this.log('warn', `恢复历史会话失败：${this.errText(error)}`);
      this.post({
        type: 'notice',
        historical: true,
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
    const scope = this.contextRequestScope();
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，再添加上下文。');
    const snapshot = snapshotMessage('', list);
    // 面板可能尚未展开（该命令可直接从命令面板调用），先使其显示。
    await this.reveal();
    // Opening the panel may establish its first view, but must not move the
    // snapshot to another directory or session while reveal is pending.
    if (!scope.view) {
      // The first editor command opens the panel and can create its initial
      // connection. Explicit switches and disconnects invalidate queueEpoch;
      // a second session event also disqualifies this narrowly allowed start.
      if (!scope.session && !scope.resumeTarget && !this.resumeTarget && this.contextSessionSerial <= scope.sessionSerial + 1 &&
          (!this.session?.cwd || draftKey(this.session.cwd) === draftKey(scope.cwd))) {
        scope.session = this.session; scope.sessionId = this.session?.sessionId; scope.sessionSerial = this.contextSessionSerial;
      }
      scope.view = this.view;
    }
    if (!this.view || !this.contextRequestCurrent(scope)) throw new Error('对话或工作区已变化，请重新添加上下文。');
    this.post({ type: 'attach', items: snapshot.attachments, cwd: scope.cwd, sessionId: scope.sessionId });
  }

  async addEditorContext(editor, wanted) {
    const scope = this.contextRequestScope();
    const controller = new AbortController();
    this.editorContextReads.add(controller);
    try {
      const item = await this.composer.fromEditor(editor, wanted, controller.signal);
      if (controller.signal.aborted || !this.contextRequestCurrent(scope)) throw new Error('对话或工作区已变化，请重新添加上下文。');
      await this.attach([item]);
    } finally { this.editorContextReads.delete(controller); }
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
  static attachmentFromEditor(editor, workdir, wanted = 'file') {
    if (!editor || !editor.document) return undefined;
    const document = editor.document;
    const uri = document.uri;
    const absolute = uri && uri.fsPath ? uri.fsPath : document.fileName;
    if (!absolute) return undefined;
    const scheme = uri && typeof uri.scheme === 'string' ? uri.scheme : '';
    const isFile = !scheme || scheme === 'file';
    // 名称使用相对于工作目录的路径：模型与用户查看时都更短、更明确。
    let name = absolute;
    if (workdir && pathIsInside(absolute, workdir)) {
      name = path.relative(workdir, absolute).split('\\').join('/');
    }
    const base = {
      name,
      mimeType: 'text/plain',
      sourcePath: absolute,
      sourceUri: uri?.toString?.(),
      isDirty: Boolean(document.isDirty),
      isUntitled: Boolean(document.isUntitled || scheme === 'untitled'),
      snapshotAt: new Date().toISOString(),
      documentVersion: document.version,
    };
    if (isFile && !document.isDirty && !document.isUntitled) {
      base.uri = uri && typeof uri.toString === 'function' ? uri.toString() : `file://${absolute}`;
    }

    const selection = editor.selection;
    if (wanted === 'selection') {
      if (!selection || selection.isEmpty) return undefined;
      const selected = document.getText(selection);
      const endLine = selection.end.line + (selection.end.character === 0 && selection.end.line > selection.start.line ? 0 : 1);
      return {
        ...base,
        kind: 'selection',
        text: selected,
        language: document.languageId,
        scope: 'selection',
        startLine: selection.start.line + 1, endLine,
        startCharacter: selection.start.character || 0, endCharacter: selection.end.character || 0,
        byteLength: Buffer.byteLength(selected),
        detail: `选区 ${selection.start.line + 1}–${endLine} 行`,
        id: `${name}:${selection.start.line}:${selection.start.character || 0}-${selection.end.line}:${selection.end.character || 0}`,
      };
    }
    const text = document.getText();
    return { ...base, kind: 'content', scope: 'file', text, byteLength: Buffer.byteLength(text), language: document.languageId,
      detail: base.isUntitled ? '未保存文件' : document.isDirty ? '全文件（含未保存修改）' : '全文件快照', id: name };
  }

  /** 下一段新对话使用的预设：面板中选择的值优先，其次是配置项中的默认值。 */
  wantedPreset(cfg = this.config()) {
    return this.preset || cfg.preset || undefined;
  }

  newSession() {
    return this.changeSession(() => this.newSessionInternal(), 'new');
  }

  changeSession(action, key) {
    if (this.configPending || this.reconnectPending || this.permissionPending) return Promise.reject(new Error('请等设置或连接恢复完成后再切换会话。'));
    if (this.newSessionPending && this.sessionChangeKey === key) return this.newSessionPending;
    this.pauseQueue('会话正在切换，原会话的排队消息需取回编辑或显式继续。');
    const previous = this.newSessionPending;
    let operation;
    operation = (async () => {
      try {
        if (previous) await previous.catch(() => {});
        return await action();
      } finally {
        if (this.newSessionPending === operation) this.newSessionPending = null;
      }
    })();
    this.newSessionPending = operation; this.sessionChangeKey = key;
    return operation;
  }

  async newSessionInternal() {
    if (this.workflow?.activeTest || this.workflow?.recording || this.workflow?.undoing) return false;
    const session = this.session || await this.ensureConnection();
    if (!session) return false;
    if (session.busy || this.connections.turns?.has(session.sessionId)) {
      this.post({ type: 'notice', text: '当前正在工作，结束后再新建对话。' });
      return false;
    }
    const client = this.client;
    if (!client) return false;
    const cfg = this.config();
    // 快速切换模式时 this.preset 可能在 closeSession 的等待期间再次改变；本次新建必须
    // 使用发起时的明确值，后续最新选择会在本次完成后顺序再建一段。
    const desiredPreset = this.wantedPreset(cfg);
    const old = session.sessionId;
    this.workflow?.reset();
    this.historyReplayEpoch = (this.historyReplayEpoch || 0) + 1;
    this.historyReadonly = false; this.historyId = undefined;
    this.post({ type: 'historyState', readonly: false });
    this.post({ type: 'reset' });
    // 用户主动请求新对话时，不再尝试恢复上一段会话。
    this.resumeTarget = undefined;
    this.turnSent = false;
    // 新建会话前需要先关闭旧会话，避免内核中累积大量空会话。
    if (old) {
      try {
        await client.closeSession(old);
        this.log('info', `已关闭旧会话 ${old}`);
      } catch (error) {
        this.log('warn', `关闭旧会话失败（不影响后续操作）：${this.errText(error)}`);
      }
    }
    // 关闭旧会话期间连接可能同时断开；此时 close 处理已经说明原因并清空引用，
    // 不得继续拿旧的 session 对象发起 session/new。
    if (this.session !== session || this.client !== client) return false;
    try {
      await session.start({
        cwd: this.workdir(),
        provider: cfg.provider,
        model: cfg.model,
        preset: desiredPreset,
      });
      this.post({ type: 'status', state: 'ready', detail: '就绪' });
      return true;
    } catch (error) {
      // 等待 session/new 时若连接已断，wire() 已经展示断线说明并清空引用；
      // 不再叠加第二张错误卡片。业务错误则主动拆除半成品，下一次操作重新连接。
      const alreadyClosed = this.session !== session || this.client !== client;
      if (alreadyClosed) return false;
      this.postError(`新建对话失败：${this.errText(error)}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      this.teardown();
      return false;
    }
  }

  async setModel(value) {
    if (!this.session) throw new Error('还没有会话，请等待连接完成。');
    if (this.historyReadonly) throw new Error('当前是只读历史，请返回当前对话后修改模型。');
    await this.session.setModel(value);
  }

  controlBusy() {
    return Boolean(this.session?.busy || this.queue.active || this.newSessionPending || this.workflow?.activeTest ||
      this.workflow?.recording || this.workflow?.undoing || this.connections.turns?.has(this.session?.sessionId));
  }

  /** Queue rapid changes, then report only the kernel's confirmed selection. */
  configureSession(message, apply, optionId) {
    const scope = this.contextRequestScope(message);
    const reply = { type: 'settingResult', requestId: message.requestId, setting: optionId, cwd: scope.cwd, sessionId: scope.sessionId };
    this.configPending++;
    this.post({ ...reply, phase: 'pending', text: '正在等待内核确认设置…' });
    const operation = this.configRequests.catch(() => {}).then(async () => {
      try {
        if (!this.contextRequestCurrent(scope) || !scope.sessionId || this.reconnectPending) throw new Error('当前界面只读或对话已变化，请返回当前对话后重新设置。');
        if (this.controlBusy()) throw new Error('当前任务仍在运行，请结束后调整模型或思考强度。');
        await apply();
        if (!this.contextRequestCurrent(scope)) throw new Error('设置请求结束时对话已变化，请查看当前对话的实际设置。');
        const option = scope.session.configOptions.find(item => item?.id === optionId);
        if (typeof option?.currentValue !== 'string') throw new Error('内核未返回当前设置，无法确认已生效。');
        const choices = (option.options || []).flatMap(group => group.options || [group]);
        const label = choices.find(item => item.value === option.currentValue)?.name || option.currentValue;
        this.post({ ...reply, phase: 'completed', success: true, currentValue: option.currentValue,
          text: `${optionId === 'model' ? '当前模型' : '当前思考设置'}：${label}（内核已确认）。` });
        return true;
      } catch (error) {
        this.post({ ...reply, phase: 'completed', success: false, error: this.errText(error), text: this.errText(error) });
        return false;
      } finally {
        this.configPending--;
        this.post({ type: 'config', configOptions: this.session?.configOptions || [] });
        if (!this.configPending) void this.drainQueue();
      }
    });
    this.configRequests = operation;
    return operation;
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
    if (this.historyReadonly || this.reconnectPending || this.configPending || this.permissionPending) throw new Error('请返回当前对话，并等待设置或恢复完成后修改模式。');
    const preset = typeof value === 'string' ? value.trim() : '';
    if (!preset) return;
    this.preset = preset;
    this.postPresets();
    // 若前一次新建尚未结束，先等待它完成。等待期间又有更新的选择时，本次已被取代，
    // 直接退出；只有最后一次选择负责顺序重建，避免并发 session/new 与错误成功提示。
    const pending = this.newSessionPending;
    if (pending) await pending;
    if (this.preset !== preset) return;
    if (this.session && !this.turnSent) {
      this.log('info', `预设已改为 ${preset}；当前会话尚未发送过消息，直接重新开启一段`);
      const restarted = await this.newSession();
      if (restarted && this.preset === preset) {
        this.post({ type: 'notice', text: `已按「${this.labelOf(preset)}」重新开启。` });
      }
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
    const session = this.session, sessionId = session?.sessionId;
    if (!client || !sessionId || typeof client.permissionGet !== 'function') return;
    const serial = this.permissionReadSerial = (this.permissionReadSerial || 0) + 1;
    const current = () => client === this.client && session === this.session && sessionId === this.session?.sessionId && serial === this.permissionReadSerial;
    try {
      const payload = await client.permissionGet(sessionId);
      if (!current()) return;
      this.permission = payload;
      this.permissionUnavailable = undefined;
      this.postPermissionState(payload);
      // 原生验收通过该日志核对权限清单来自内核回读。
      this.log('info', `当前权限：${currentLabel(payload.currentValue, payload.options)}（${payload.currentValue}）`);
    } catch (error) {
      if (!current()) return;
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
     * 仅识别面板自身的端口，避免自启等待过程重新接入原端口的旧内核。
     */
    this.ownPortOnly = true;
    this.log(
      'info',
      `接入的 ${cfg.host}:${cfg.port} 无法切换权限（${shaped.state}），` +
        `改用面板自己启动的（${cfg.host}:${cfg.selfStartPort}，配置集：自启配置集）`,
    );
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
  async setPermission(value, message = {}) {
    const scope = this.contextRequestScope(message);
    if (!this.contextRequestCurrent(scope) || this.reconnectPending || this.newSessionPending) throw new Error('当前界面只读或对话已变化，请返回当前对话后修改权限。');
    if (this.permissionPending) throw new Error('权限设置正在等待确认，请稍后再试。');
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
    this.permissionPending = scope;
    this.permissionReadSerial = (this.permissionReadSerial || 0) + 1;
    const reply = { type: 'settingResult', setting: 'permission', requestId: message.requestId, cwd: scope.cwd, sessionId: scope.sessionId };
    let completion, confirmed = false;
    this.post({ ...reply, phase: 'pending', text: '正在等待内核确认权限…' });
    try {
      const payload = await client.permissionSet(sessionId, wanted);
      if (client !== this.client || scope.session !== this.session || sessionId !== this.session?.sessionId) throw new Error('权限请求结束时对话已变化，请查看当前对话的实际权限。');
      if (typeof payload?.currentValue !== 'string') throw new Error('内核未返回当前权限，无法确认已生效。');
      this.permissionReadSerial = (this.permissionReadSerial || 0) + 1;
      this.permission = payload;
      this.permissionUnavailable = undefined;
      confirmed = true;
      this.postPermissionState(payload);
      if (!this.contextRequestCurrent(scope)) throw new Error('权限请求已返回当前权限；界面或任务状态已变化，请查看当前值。');
      const text = `当前权限为「${currentLabel(payload.currentValue, payload.options)}」（内核已确认）。`;
      this.post({ type: 'notice', text });
      completion = { ...reply, phase: 'completed', success: true, currentValue: payload.currentValue, text };
      this.log('info', `权限已切换到 ${wanted}（内核回读 ${payload.currentValue}）`);
    } catch (error) {
      completion = { ...reply, phase: 'completed', success: false, error: this.errText(error), text: this.errText(error) };
      if (!this.contextRequestCurrent(scope)) {
        if (!confirmed && client === this.client && scope.session === this.session && sessionId === this.session?.sessionId) await this.refreshPermission();
        return;
      }
      // 失败时需要说明失败类型（接入点插件版本过低 / 名称不正确 / 会话不存在），并把界面
      // 恢复为真实状态 —— 否则用户会误认为切换已经生效。
      const shaped = explainPermissionFailure({ code: error && error.code, message: this.errText(error) });
      this.postError(`${shaped.text}${shaped.detail ? `\n${shaped.detail}` : ''}`);
      // 本次由用户主动触发，说明一次即可：预先记录去重标记，
      // 避免后续重新读取时把同一句说明作为「notice」再次输出。
      this.permissionNotice = shaped.state;
      if (!confirmed) await this.refreshPermission();
    } finally {
      if (this.permissionPending === scope) this.permissionPending = null;
      // A completed frame unlocks the controls, so publish it after readback and backend cleanup.
      if (completion) this.post(completion);
    }
  }

  async reconnect(message = {}) {
    const reply = { type: 'recoveryResult', requestId: message.requestId, action: 'reconnect' };
    try {
      if (this.reconnectPending) {
        this.post({ ...reply, phase: 'pending', text: '正在恢复连接，请等待确认…' });
        const success = await this.reconnectPending;
        this.post({ ...reply, phase: 'completed', success, text: success ? '连接已恢复；排队消息需显式继续。' : '连接未恢复，请查看错误或日志后重试。' });
        return success;
      }
      if (this.controlBusy() || this.connections.turns?.size || this.configPending || this.permissionPending || this.connecting || this.connections.pending) throw new Error('当前任务仍在运行，请先停止或等待结束后重新连接。');
      if (message.type === 'errorAction') {
        const source = this.recoveryScopes.get(message.recoveryScope);
        const sameSession = source && source.session === this.session && source.client === this.client && source.sessionId === this.session?.sessionId && source.resumeTarget === this.resumeTarget;
        const disconnectedSource = source && !this.session && !this.client && (source.sessionId ? source.sessionId === this.resumeTarget : source.resumeTarget === this.resumeTarget);
        if (!source || source.cwd !== draftKey(this.workdir()) || source.generation !== this.recoveryGeneration || source.serial !== this.contextSessionSerial || !sameSession && !disconnectedSource)
          throw new Error('这张错误卡对应的连接或会话已变化，请查看当前状态后使用重新连接命令。');
      }
      this.post({ ...reply, phase: 'pending', text: '正在恢复连接，请等待确认…' });
      let operation;
      operation = Promise.resolve().then(async () => {
        this.log('info', '用户请求重新连接');
        if (this.session?.sessionId) this.resumeTarget = this.session.sessionId;
        this.teardown();
        // The history view and drafts remain visible until the user explicitly leaves them.
        const session = await this.ensureConnection();
        this.post({ type: 'historyState', readonly: this.historyReadonly, id: this.historyId });
        return Boolean(session?.sessionId && this.client?.isConnected);
      }).finally(() => { if (this.reconnectPending === operation) this.reconnectPending = null; });
      this.reconnectPending = operation;
      const success = await operation;
      this.post({ ...reply, phase: 'completed', success, text: success ? '连接已恢复；排队消息需显式继续。' : '连接未恢复，请查看错误或日志后重试。' });
      return success;
    } catch (error) {
      this.post({ ...reply, phase: 'completed', success: false, error: this.errText(error), text: this.errText(error) });
      this.postError(this.errText(error), undefined, { historical: this.historyReadonly });
      return false;
    }
  }

  errText(error) {
    return error && error.message ? error.message : String(error);
  }

  /**
   * 把一段可能很长的原文截短（仅用于**附加在**面板说明之后的引用）。
   *
   * 需要截短的原因：内核报错常达上百字，直接放入提示会形成大段文本 ——
   * 完整原文另有记录位置（日志，以及错误卡片的折叠区），
   * 此处只需足以判断属于哪一类问题。
   */
  clip(text, max = 70) {
    return clip(text, max);
  }

  /** 回答仍在等待的权限请求；未知或已回答的 id 不得写回当前连接。 */
  answerPendingPermission(requestId, optionId) {
    const pending = this.pendingPermissionRequests.get(requestId);
    if (
      !pending
      || pending.session !== this.session
      || this.visiblePermissionRequestId !== requestId
    ) {
      this.log('warn', `忽略不存在或已经结束的权限请求 #${requestId}`);
      return false;
    }
    this.pendingPermissionRequests.delete(requestId);
    this.visiblePermissionRequestId = undefined;
    try {
      pending.session.answerPermission(requestId, optionId);
    } finally {
      this.showNextPendingPermissionRequest();
    }
    return true;
  }

  /** 按到达顺序只展示一个权限请求；其余请求保留在 Map 中等待。 */
  showNextPendingPermissionRequest() {
    if (this.visiblePermissionRequestId !== undefined) {
      if (this.pendingPermissionRequests.has(this.visiblePermissionRequestId)) return;
      this.visiblePermissionRequestId = undefined;
    }
    for (const [requestId, pending] of this.pendingPermissionRequests) {
      if (pending.session !== this.session) continue;
      this.visiblePermissionRequestId = requestId;
      this.post({ type: 'permission', requestId, params: pending.params });
      return;
    }
    this.post({ type: 'permissionClear' });
  }

  /**
   * 取消指定客户端（或全部客户端）尚未回答的权限请求。
   * 删除记录先于写回，确保连接恰在此刻断开时也不会重复作答。
   */
  cancelPendingPermissionRequests(client, reason) {
    let visibleRemoved = false;
    for (const [requestId, pending] of [...this.pendingPermissionRequests]) {
      if (client && pending.client !== client) continue;
      this.pendingPermissionRequests.delete(requestId);
      if (requestId === this.visiblePermissionRequestId) visibleRemoved = true;
      try {
        pending.session.answerPermission(requestId, undefined);
        this.log('info', `${reason || '连接结束'}，已取消权限请求 #${requestId}`);
      } catch (error) {
        this.log('warn', `取消权限请求 #${requestId} 失败：${this.errText(error)}`);
      }
    }
    if (visibleRemoved) this.visiblePermissionRequestId = undefined;
    if (visibleRemoved || !client) this.showNextPendingPermissionRequest();
  }

  /** 连接已经关闭时只清理本地记录，不再向失效 socket 写回复。 */
  dropPendingPermissionRequests(client) {
    let visibleRemoved = false;
    for (const [requestId, pending] of [...this.pendingPermissionRequests]) {
      if (pending.client !== client) continue;
      this.pendingPermissionRequests.delete(requestId);
      if (requestId === this.visiblePermissionRequestId) visibleRemoved = true;
    }
    if (visibleRemoved) {
      this.visiblePermissionRequestId = undefined;
      this.showNextPendingPermissionRequest();
    }
  }

  teardown() {
    this.pauseQueue('连接正在关闭，请确认原对话后显式继续。');
    this.cancelPendingPermissionRequests(undefined, '连接正在关闭');
    if (this.session) {
      this.unwire(this.session);
      this.session.dispose();
      this.session = undefined;
    }
    if (this.client) {
      const client = this.client;
      const onClose = this.clientCloseHandlers.get(client);
      if (onClose) client.off('close', onClose);
      this.clientCloseHandlers.delete(client);
      if (client === this.connections.client) this.connections.disconnect();
      else client.close();
      this.client = undefined;
    }
    this.doorStatus = undefined;
    // 下一轮连接重新判定历史会话的读取来源（用户可能在此期间升级了接入点插件）。
    this.historyVia = undefined;
    // 权限相关说明也重新输出一次（接入点插件可能已升级）。
    this.permissionNotice = undefined;
    this.permissionUnavailable = undefined;
    this.workflow?.publish();
  }

  dispose() {
    this.pendingQueueEdits.clear();
    void this.draftStore.flush().catch(error => this.log('warn', `保存草稿失败：${error.message}`));
    this.composerQuery?.abort();
    this.composerSelection?.abort();
    for (const controller of this.editorContextReads) controller.abort();
    this.contextTrustWatcher?.dispose();
    this.composer.dispose?.();
    this.historySearchController?.abort();
    this.teardown();
    this.connections.release('panel');
    if (this.ownsConnections) this.connections.dispose();
    /*
     * 释放视图引用，由 manager 在宽限期后回收自有内核。
     * 期间重新打开面板可继续使用同一内核。
     */
    this.kernels.release(this.kernelConsumer);
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
 * 所有启动方式均失败后，按实际原因给出建议。错误卡片使用通用表述；
 * 命令、配置项等细节留在折叠诊断中。
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
