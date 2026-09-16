'use strict';

/**
 * 侧边栏面板。
 *
 * 职责就三件：
 * 1. 保证有一条活着的连接 —— 先连桌面端的门，连不上就按用户批准的策略
 *    在后台拉起一个 DSH（共用同一份 $DSH_HOME）；
 * 2. 把 {@link DshSession} 的事件翻译成 webview 消息；
 * 3. 把 webview 的消息变成对会话的操作。
 *
 * 这个文件是**唯一**碰 vscode API 的地方之一（另一个是 extension.js），
 * 所以会话逻辑能在命令行里被单独测试。
 */

const vscode = require('vscode');
const { DoorClient } = require('../door/client');
const { DshSession } = require('../dsh/session');
const { probePort, waitForPort, spawnBackgroundDsh } = require('../door/locate');
const { renderHtml, makeNonce } = require('../panel/html');

const VIEW_ID = 'dshPanel.chat';

class DshPanelView {
  /**
   * @param {object} options
   * @param {vscode.Uri} options.extensionUri
   * @param {(level: string, message: string) => void} options.log
   */
  constructor({ extensionUri, log }) {
    this.extensionUri = extensionUri;
    this.log = log;
    /** @type {vscode.WebviewView|undefined} */
    this.view = undefined;
    /** @type {DoorClient|undefined} */
    this.client = undefined;
    /** @type {DshSession|undefined} */
    this.session = undefined;
    /** @type {{dispose: () => void}|undefined} 本扩展拉起的后台 DSH。 */
    this.background = undefined;
    /** 防止并发重复连接。 */
    this.connecting = null;
    /**
     * 断线后要接回的会话 id。
     *
     * 为什么需要它：ACP 的 `session/resume` 实测**真的能把上下文接回来**
     * （见 test/resume.js：断线后新连接 resume，它还记得断线前让它记的数字，
     * 而新开的会话答不出来）。所以断线不该悄悄换成一个没记忆的新会话 ——
     * 那会让用户以为它还记着上面那段对话，其实已经忘了。
     * @type {string|undefined}
     */
    this.resumeTarget = undefined;
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
      if (this.view === webviewView) this.view = undefined;
    });
    this.log('info', '面板已打开');
  }

  /** 把一个消息发给界面（界面没开就丢掉，不报错）。 */
  post(message) {
    const view = this.view;
    if (!view) return;
    view.webview.postMessage(message).then(undefined, (error) => {
      this.log('warn', `发给界面的消息失败：${error && error.message ? error.message : error}`);
    });
  }

  // ── 界面发来的消息 ──────────────────────────────────

  async onWebviewMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    try {
      switch (message.type) {
        case 'ready': {
          // 界面可能是刚打开，也可能是被重新加载（会话还活着）——
          // 后一种情况要把当前状态补一遍，否则界面上是空的。
          const existing = this.session;
          await this.ensureConnection();
          if (existing) this.pushSnapshot();
          break;
        }
        case 'send':
          await this.send(message.text);
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
        case 'permission':
          if (this.session) this.session.answerPermission(message.requestId, message.optionId);
          break;
        case 'openLink':
          this.openLink(message.href);
          break;
        default:
          this.log('warn', `界面发来未知消息：${message.type}`);
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      this.log('error', `处理界面消息出错（${message.type}）：${text}`);
      this.post({ type: 'error', message: text });
      this.post({ type: 'busy', busy: false });
    }
  }

  openLink(href) {
    // 只放行 http/https，别的协议（file:、command: …）不从这里走。
    if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) {
      this.log('warn', `拒绝打开非 http(s) 链接：${href}`);
      return;
    }
    vscode.env.openExternal(vscode.Uri.parse(href));
  }

  // ── 连接 ────────────────────────────────────────────

  config() {
    const cfg = vscode.workspace.getConfiguration('dshPanel');
    return {
      host: cfg.get('host') || '127.0.0.1',
      port: cfg.get('port') || 47821,
      autoStart: cfg.get('autoStart') !== false,
      fallbackProfile: cfg.get('fallbackProfile') || 'desktop',
      dshCommand: cfg.get('dshCommand') || 'dsh',
      provider: cfg.get('provider') || '',
      model: cfg.get('model') || '',
      cwd: cfg.get('cwd') || '',
    };
  }

  workdir() {
    const configured = this.config().cwd;
    if (configured) return configured;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return require('node:os').homedir();
  }

  /** 确保有一条可用连接（多次调用安全）。 */
  ensureConnection() {
    if (this.session) return Promise.resolve(this.session);
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInternal().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async connectInternal() {
    const cfg = this.config();
    this.post({ type: 'status', state: 'connecting', detail: `连接 ${cfg.host}:${cfg.port}…` });

    let reachable = await probePort(cfg.host, cfg.port);
    if (!reachable && cfg.autoStart) {
      this.post({
        type: 'status',
        state: 'connecting',
        detail: `桌面端没在跑，正在后台启动 DSH（档：${cfg.fallbackProfile}）…`,
      });
      this.log('info', '门连不上，按设置自动拉起后台 DSH');
      if (this.background) this.background.dispose();
      this.background = spawnBackgroundDsh({
        command: cfg.dshCommand,
        profile: cfg.fallbackProfile,
        log: this.log,
      });
      reachable = await waitForPort(cfg.host, cfg.port, { totalMs: 120000 });
      if (!reachable) {
        this.post({
          type: 'status',
          state: 'error',
          detail:
            `后台 DSH 起来了，但 ${cfg.host}:${cfg.port} 上没开门（profile=${cfg.fallbackProfile}）。` +
            `如果你改过端口，门插件里的 port 也要一起改。`,
        });
        return undefined;
      }
      this.post({ type: 'status', state: 'connecting', detail: '后台 DSH 就绪，正在握手…' });
    }

    if (!reachable) {
      this.post({
        type: 'status',
        state: 'error',
        detail: `连不上 ${cfg.host}:${cfg.port}（可执行「DSH：重新连接」重试）`,
      });
      return undefined;
    }

    const client = new DoorClient({ host: cfg.host, port: cfg.port, log: this.log });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      const text = error && error.message ? error.message : String(error);
      this.post({ type: 'status', state: 'error', detail: `握手失败：${text}` });
      return undefined;
    }

    this.client = client;
    const session = new DshSession({ client, log: this.log });
    this.session = session;
    this.wire(session, client);

    try {
      if (this.resumeTarget) {
        // 断线重连：先试把刚才那个会话接回来，接不回来才开新的。
        const target = this.resumeTarget;
        try {
          await session.resume(target, this.workdir());
          this.resumeTarget = undefined;
          this.post({
            type: 'status',
            state: 'ready',
            detail: '已重连，上面那段对话的上下文接回来了',
          });
          return session;
        } catch (error) {
          this.log('warn', `接回旧会话失败，改成新会话：${this.errText(error)}`);
          this.resumeTarget = undefined;
          this.post({
            type: 'notice',
            text: '刚才那段对话没能接回来（内核里已经没有了），下面是一段新的对话。',
          });
        }
      }
      await session.start({ cwd: this.workdir(), provider: cfg.provider, model: cfg.model });
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      this.post({ type: 'status', state: 'error', detail: `建会话失败：${text}` });
      return undefined;
    }

    const where = this.background ? '后台 DSH' : '正在运行的 DSH';
    this.post({ type: 'status', state: 'ready', detail: `已连上${where}` });
    return session;
  }

  /** 把会话/客户端的事件桥到界面。 */
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
    session.on('busy', (payload) => {
      this.post({ type: 'busy', busy: payload.busy });
      this.post({
        type: 'status',
        state: payload.busy ? 'busy' : 'ready',
        detail: payload.busy ? 'DSH 正在工作…' : '已连上',
      });
    });
    session.on('error', (payload) => this.post({ type: 'error', message: payload.message }));
    session.on('session', (payload) => this.log('info', `当前会话 ${payload.sessionId}`));

    client.on('permission', (requestId, params) =>
      this.post({ type: 'permission', requestId, params }),
    );
    client.on('close', (reason) => {
      this.post({ type: 'status', state: 'error', detail: `连接断开：${reason}` });
      this.post({ type: 'busy', busy: false });
      // 记住这个会话，下次连接时先试着接回来（session/resume 实测有效）。
      if (session.sessionId) this.resumeTarget = session.sessionId;
      // 让它下次「发送」时自动重连，而不是把面板卡死。
      if (this.session === session) this.session = undefined;
      if (this.client === client) this.client = undefined;
    });
  }

  /** 界面刚加载完时，把当前状态补一遍。 */
  pushSnapshot() {
    const session = this.session;
    if (!session) return;
    this.post({ type: 'status', state: session.busy ? 'busy' : 'ready', detail: '已连上' });
    this.post({ type: 'config', configOptions: session.configOptions });
    if (session.usage) this.post({ type: 'usage', used: session.usage.used, size: session.usage.size });
  }

  // ── 操作 ────────────────────────────────────────────

  async send(text) {
    if (!text || !text.trim()) return;
    const session = await this.ensureConnection();
    if (!session) return;
    await session.send(text);
  }

  async newSession() {
    const session = await this.ensureConnection();
    if (!session) return;
    const cfg = this.config();
    const old = session.sessionId;
    this.post({ type: 'reset' });
    // 用户主动要新对话，就别再想着把上一段接回来了。
    this.resumeTarget = undefined;
    // 新会话要先把旧的放掉，免得内核里堆一堆空会话。
    if (old) {
      try {
        await this.client.closeSession(old);
        this.log('info', `已关闭旧会话 ${old}`);
      } catch (error) {
        this.log('warn', `关闭旧会话失败（不影响继续）：${this.errText(error)}`);
      }
    }
    try {
      await session.start({ cwd: this.workdir(), provider: cfg.provider, model: cfg.model });
      this.post({ type: 'status', state: 'ready', detail: '已连上（新对话）' });
    } catch (error) {
      this.post({ type: 'status', state: 'error', detail: `新建会话失败：${this.errText(error)}` });
    }
  }

  async setModel(value) {
    if (!this.session) return;
    await this.session.setModel(value);
  }

  async reconnect() {
    this.log('info', '用户要求重新连接');
    this.teardown();
    this.post({ type: 'reset' });
    await this.ensureConnection();
  }

  errText(error) {
    return error && error.message ? error.message : String(error);
  }

  teardown() {
    if (this.session) {
      this.session.dispose();
      this.session = undefined;
    }
    if (this.client) {
      this.client.close();
      this.client = undefined;
    }
  }

  dispose() {
    this.teardown();
    // 只停「本扩展自己拉起来的」那个后台 DSH，绝不碰用户桌面端那个。
    if (this.background) {
      this.background.dispose();
      this.background = undefined;
    }
  }
}

module.exports = { DshPanelView, VIEW_ID };
