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
const path = require('node:path');
const os = require('node:os');
const { DoorClient } = require('../door/client');
const { DshSession } = require('../dsh/session');
const { describeError } = require('../dsh/errors');
const { probePort, spawnBackgroundDsh, dshCommandCandidates } = require('../door/locate');
const { renderHtml, makeNonce } = require('../panel/html');
const localSessions = require('../dsh/sessions');

const VIEW_ID = 'dshPanel.chat';

/** target 在 base 这个目录里面吗（Windows 上大小写不敏感，path.relative 会处理）。 */
function pathIsInside(target, base) {
  const rel = path.relative(base, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 这个地址是「本机」吗？
 *
 * 为什么关心：历史会话的数据在**内核那台机器**的磁盘上。连的是本机时，
 * 面板自己就能读（所以不依赖门的新旧）；连的是别的机器时，只能问那台机器上的
 * 门 —— 本地读出来的会是**这台机器**的会话，完全是另一回事，绝不能当兜底。
 */
function isLoopbackHost(host) {
  const text = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return text === '' || text === 'localhost' || text === '::1' || text === '0:0:0:0:0:0:0:1'
    || text.startsWith('127.');
}

/** 这个错是不是「对面没有这个方法」（门 0.0.8 之前的历史旁路方法）。 */
function isMissingMethod(error, text) {
  return Boolean(error && (error.code === -32601 || /-32601/.test(text)))
    || /method not found|不支持.*dsh-door\/sessions/i.test(String(text || ''));
}

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
    /**
     * 下一段新对话要用哪个 agent preset（用户在面板里选的，或设置里的默认值）。
     *
     * 为什么是「下一段」而不是「当前这段」：内核不允许会话开始之后再换预设
     * （实测报 `agent-preset/locked`），这是内核的设计，不是本扩展的偷懒。
     * 所以面板里换预设的语义就是：**下一段新对话**用它。
     * @type {string|undefined}
     */
    this.preset = undefined;
    /**
     * 当前这段会话有没有发过消息。
     *
     * 只用来决定「换预设时能不能直接重开一段」：一段还没说过话的会话重开
     * 是零代价的，用户不用自己再点一次新建。
     */
    this.turnSent = false;
    /** 门最近一次报的预设清单，界面重新加载时补发用。 */
    this.lastPresets = undefined;
    /**
     * 历史会话这一轮连接是从哪儿读的：'door' | 'local' | undefined（还没定）。
     *
     * 缓存它是为了别每次点历史都多打一次注定失败的往返：门太旧是**常态**
     * （用户档里的门会被桌面端重写回旧版），第一次问到 -32601 之后就改走本地，
     * 这一轮连接里不再问门。重连时清掉，好让升级过门的人有机会用回门。
     * @type {'door'|'local'|undefined}
     */
    this.historyVia = undefined;
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

  /**
   * 报一个错误给界面，**顺便把它翻成人话**。
   *
   * 为什么不能直接把 `error.message` 发过去：内核的报错是原样穿过 ACP 的，
   * 用户看到的就是一段英文 JSON（最典型的是 429 额度限制）。面板存在的意义
   * 就是别让他去读那种东西。分类的活交给 `dsh/errors.js`（纯函数，好测），
   * 这里只负责把「人话 + 原文」一起发出去 —— 原文一个字都不删。
   */
  postError(message) {
    const human = describeError(message);
    this.post({ type: 'error', message: human.raw, human });
  }

  // ── 界面发来的消息 ──────────────────────────────────

  async onWebviewMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    try {
      switch (message.type) {
        case 'ready': {
          // 界面可能是刚打开，也可能是被重新加载（会话还活着）——
          // 后一种情况要把当前状态补一遍，否则界面上是空的。
          // 顶栏的工作目录不依赖连接，先发。
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
        case 'permission':
          if (this.session) this.session.answerPermission(message.requestId, message.optionId);
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
          this.log('warn', `界面发来未知消息：${message.type}`);
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      this.log('error', `处理界面消息出错（${message.type}）：${text}`);
      this.postError(text);
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
      preset: cfg.get('preset') || '',
      cwd: cfg.get('cwd') || '',
    };
  }

  workdir() {
    // 用 trim 过的值：内核会拒绝空 cwd（"cwd must be an absolute path: "），
    // 而设置项里填了几个空格是很容易发生的事 —— 那种情况应该退回工作区/主目录，
    // 而不是把一串空格当成路径发过去。
    const configured = String(this.config().cwd || '').trim();
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

  /**
   * 兜底拉起要试的候选命令（单独成方法：测试里可以隔离掉自动候选，
   * 只测「命令坏了」这条路径）。
   */
  candidatesFor(cfg) {
    return dshCommandCandidates({ dshCommand: cfg.dshCommand, homedir: os.homedir() });
  }

  /**
   * 后台拉起 DSH：按候选命令逐个试，谁先开出门就用谁。
   *
   * 为什么是「逐个试」而不是只信设置里的那一条：默认值是裸的 `dsh`，
   * 本机多半没把它放进 VS Code 看得见的 PATH（用户的面板就是这么挂的），
   * 只试一条等于逼用户「先开桌面端才能用面板」。候选清单见
   * {@link dshCommandCandidates}：设置里填的优先，然后是默认安装位置的
   * `node …/@deepseek-ai/dsh/lib/bin.js`。
   *
   * 等待时间：还有下一个候选时只等 30 秒（起不来的命令几乎都是秒退，
   * 不值得为它耗两分钟）；最后一个候选等满 120 秒 —— 真内核冷启动也可能慢。
   *
   * @returns {Promise<{ok: boolean, command?: string, detail?: string}>}
   */
  async spawnFallback(cfg) {
    this.post({
      type: 'status',
      state: 'connecting',
      detail: `桌面端没在跑，正在后台启动 DSH（档：${cfg.fallbackProfile}）…`,
    });
    this.log('info', '门连不上，按设置自动拉起后台 DSH');
    if (this.background) this.background.dispose();

    const candidates = this.candidatesFor(cfg);
    if (candidates.length === 0) {
      return {
        ok: false,
        detail:
          '不知道怎么启动 DSH：设置 dshPanel.dshCommand 是空的，' +
          '默认安装位置（~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js）也没找到。' +
          '装好 DSH 后在设置里把 dshPanel.dshCommand 填成完整启动命令。',
      };
    }

    const failures = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const command = candidates[i];
      const hasMore = i + 1 < candidates.length;
      this.post({
        type: 'status',
        state: 'connecting',
        detail: `正在后台启动 DSH（命令：${command}）…`,
      });
      let background;
      try {
        background = spawnBackgroundDsh({ command, profile: cfg.fallbackProfile, log: this.log });
      } catch (error) {
        failures.push(`「${command}」起不来：${this.errText(error)}`);
        continue;
      }
      this.background = background;
      const outcome = await this.waitForFallbackDoor(
        background.child,
        cfg.host,
        cfg.port,
        hasMore ? 30000 : 120000,
      );
      if (outcome.ok) return { ok: true, command };
      // 没成：收掉这个进程再试下一条（killTree 连子孙一起杀，不留孤儿）。
      background.dispose();
      this.background = undefined;
      failures.push(
        fallbackFailureText({
          command,
          profile: cfg.fallbackProfile,
          host: cfg.host,
          port: cfg.port,
          exitedEarly: outcome.exitedEarly,
        }),
      );
      if (!hasMore) break;
    }

    return {
      ok: false,
      detail:
        `后台启动 DSH 没成功（试了 ${candidates.length} 条命令）：\n` +
        failures.join('\n\n') +
        '\n\n出路：在设置里把 dshPanel.dshCommand 填成能用的完整启动命令' +
        '（例如：node C:\\Users\\你\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js）。',
    };
  }

  /**
   * 等兜底拉起的那个内核把门开起来；它**刚启动就退出**的话早点说清楚。
   *
   * 为什么不能只等 waitForPort：命令写错（最典型的是 dsh 不在 PATH 里、
   * 或者 dshPanel.dshCommand 填了个不存在的路径）时，进程会立刻退出，
   * 而 waitForPort 会老老实实等满 120 秒 —— 用户对着"正在后台启动 DSH…"
   * 干等两分钟，最后只换来一句"没开门"，还得自己猜为什么。
   * 既然进程都已经退出了，就没有必要再等。
   *
   * `timeoutMs` 只是为了让测试能在几秒内跑到"等超时"那条分支 ——
   * 生产路径不传它，就是两分钟。
   */
  async waitForFallbackDoor(child, host, port, timeoutMs = 120000) {
    let exit = null;
    const onExit = (code, signal) => {
      exit = { code, signal };
    };
    if (child && typeof child.once === 'function') child.once('exit', onExit);
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await probePort(host, port)) return { ok: true };
        if (exit) {
          // 刚退出时端口可能还在收尾，再确认一次才判失败。
          if (await probePort(host, port)) return { ok: true };
          this.log('warn', `兜底内核退出了（code=${exit.code} signal=${exit.signal}），不再干等`);
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
    this.post({ type: 'status', state: 'connecting', detail: `连接 ${cfg.host}:${cfg.port}…` });

    let reachable = await probePort(cfg.host, cfg.port);
    if (!reachable && cfg.autoStart) {
      const spawned = await this.spawnFallback(cfg);
      if (!spawned.ok) {
        this.post({ type: 'status', state: 'error', detail: spawned.detail });
        return undefined;
      }
      reachable = true;
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
          // 把当前预设一起告诉门：内核不会把走门建的会话的预设记进会话记录，
          // 门得靠这个点名（或它自己记得的）去补挂 —— 不补，接回来的会话就没有工具。
          await session.resume(target, this.workdir(), { preset: this.wantedPreset() });
          this.resumeTarget = undefined;
          // 接回来的是「已经说过话的」会话：别让换预设把它悄悄重开掉。
          this.turnSent = true;
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
      this.turnSent = false;
      await session.start({
        cwd: this.workdir(),
        provider: cfg.provider,
        model: cfg.model,
        preset: this.wantedPreset(cfg),
      });
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
    session.on('presets', (payload) => this.onPresets(payload));
    session.on('busy', (payload) => {
      this.post({ type: 'busy', busy: payload.busy });
      this.post({
        type: 'status',
        state: payload.busy ? 'busy' : 'ready',
        detail: payload.busy ? 'DSH 正在工作…' : '已连上',
      });
    });
    session.on('error', (payload) => this.postError(payload.message));
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
    if (this.lastPresets) this.post({ type: 'presets', ...this.lastPresets });
    if (session.usage) this.post({ type: 'usage', used: session.usage.used, size: session.usage.size });
  }

  /**
   * 门报了可用预设清单。
   *
   * 这份清单是**门问内核要的**（`agentPresets.list()`，每次调用重新扫盘），
   * 所以用户在 `$DSH_HOME/.agent-presets/` 里自己写的预设也会出现在面板里。
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
        text: `门里没有「${payload.requested}」这个预设，这次用的是「${this.labelOf(current)}」。`,
      });
    }
  }

  /** 预设的中文名（门/内核给了名字就用名字，没有就退回 id）。 */
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
    // 从这一刻起这段会话「说过话」了：换预设时就不能再悄悄重开它。
    this.turnSent = true;
    await session.send(text, { attachments: items });
  }

  // ── 历史会话 ──────────────────────────────────────────
  //
  // 数据在 `$DSH_HOME/sessions` 里（内核那台机器的磁盘上）。两条来路：
  //   1. 门 0.0.8+ 的旁路方法 `dsh-door/sessions/list|get`（对「门在别的机器上」也对）；
  //   2. 面板自己读盘 —— 只在连的是本机时成立。
  //
  // 为什么必须有第 2 条：门是装在用户档里的插件，而**那个档由 DSH 桌面端自己
  // 管理**（实测 2026-09-19：那个档里装的门还是 0.0.7，而 `dsh plugin --profile
  // desktop` 的增删会被拒），所以「门太旧、没有旁路方法」是常态而不是异常。
  // 以前只有第 1 条时，历史会话在**最常用的那种模式**（接着桌面端那一个内核）下
  // 直接不可用，还让用户去「重启桌面端」—— 重启一次回来还是同样一句，等于把
  // 扩展自己的依赖问题转嫁给用户。面板本来就和内核同机，没有理由不自己读。

  /**
   * 读一次历史会话。
   *
   * @param {'list'|'get'} kind
   * @param {string} [id] kind==='get' 时的会话 id。
   * @returns {Promise<{result: object, via: 'door'|'local'}>}
   */
  async readHistory(kind, id) {
    const localRoot = isLoopbackHost(this.config().host) ? localSessions.resolveSessionsRoot() : undefined;
    const client = this.client;

    // 门能问就问门：它对远程门也对，而且是这份数据的「官方」来路。
    // `historyVia === 'local'` 说明这一轮连接里已经确认门没有这个方法，
    // 就别每次点历史都多打一次注定失败的往返。
    if (this.historyVia !== 'local' && client && client.isConnected) {
      try {
        const result = kind === 'list'
          ? await client.listHistory()
          : await client.getHistory(String(id || ''));
        this.historyVia = 'door';
        return { result, via: 'door' };
      } catch (error) {
        const text = this.errText(error);
        if (!isMissingMethod(error, text) || !localRoot) throw error;
        this.historyVia = 'local';
        this.log('info', '门没有历史会话的旁路方法（需要 0.0.8+），改成面板自己读 $DSH_HOME/sessions');
      }
    }

    if (!localRoot) {
      throw new Error('面板没有连上 DSH，而设置里的门在别的机器上（dshPanel.host），读不了那台机器的历史会话');
    }
    if (!localSessions.hasZstdSupport()) {
      throw new Error('本机的 Node 没有 zstd 支持（zlib.zstdDecompressSync），解不了会话文件；或者把门升到 0.0.8+ 由门来解');
    }
    const result = kind === 'list'
      ? localSessions.listSessions(localRoot)
      : localSessions.getSession(localRoot, String(id || ''));
    return { result, via: 'local' };
  }

  /**
   * 把历史会话清单送给界面。
   *
   * 「门太旧」这件事只在**门在别的机器上**时才需要用户出手（那时本地读是错的，
   * 只能去升级那台机器上的门）；连本机时上面已经自己读盘兜住了，用户什么都不用做。
   */
  async sendHistoryList() {
    try {
      const { result, via } = await this.readHistory('list');
      const sessions = Array.isArray(result && result.sessions) ? result.sessions : [];
      // 本地读失败时（目录不可读等）会把原因写在 error 上，别当成「一段都没有」。
      if (sessions.length === 0 && result && result.error) throw new Error(result.error);
      this.post({ type: 'history', via, sessions, skipped: (result && result.skipped) || 0 });
    } catch (error) {
      this.post({ type: 'history', error: this.historyErrorText(error) });
    }
  }

  /** 把一段历史会话的回放送给界面。 */
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

  /** 读历史失败时给用户的那句话（纯函数，好测）。 */
  historyErrorText(error) {
    const text = this.errText(error);
    if (isMissingMethod(error, text)) {
      return (
        '连着的门插件太旧了（需要 dsh-acp-door 0.0.8 以上），而它装在别的机器上，' +
        '面板没法替你读那台机器的会话记录。在那台机器上升级门插件后再试。'
      );
    }
    return `读历史会话失败：${text}`;
  }

  /**
   * 从历史里接回一段会话：先回放，再试 `session/resume` 把上下文接回来。
   *
   * 为什么两件事一起做：用户点「接回」要的是「接着上次聊」，只有上下文
   * 没有记录（或只有记录没有上下文）都是残缺的。resume 失败（内核重启过、
   * 内存里没有这段）时明确说明「上面只是回放」，绝不假装接上了。
   */
  async resumeHistory(id) {
    const session = await this.ensureConnection();
    if (!session) return;
    await this.sendHistoryReplay(id);
    if (session.busy) {
      this.post({ type: 'notice', text: '它正在工作，等这回合结束后再接回历史。' });
      return;
    }
    try {
      await session.resume(String(id || ''), this.workdir(), { preset: this.wantedPreset() });
      this.turnSent = true;
      this.resumeTarget = undefined;
      this.post({
        type: 'status',
        state: 'ready',
        detail: '已接回这段历史会话，它记得上面说过的内容',
      });
    } catch (error) {
      this.post({
        type: 'notice',
        text:
          `这段历史没能接回上下文（${this.errText(error)}）。` +
          '上面只是回放；你可以继续在这里发新消息。',
      });
    }
  }

  // ── 编辑器上下文（当前文件 / 选中的代码）────────────────

  /**
   * 把编辑器里的东西送进面板，变成输入框上面的一个「附件」。
   *
   * 为什么是送进面板、而不是直接替用户发出去：用户按那个命令，多半是想
   * 「就这段代码问点什么」——所以把上下文挂上、把光标留给输入框，
   * 让他接着打字。这也是 VS Code 里其它 AI 扩展的做法。
   *
   * @param {Array<object>} items
   */
  async attach(items) {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (list.length === 0) return;
    // 面板可能还没展开（命令可以从命令面板直接调），先让它出来。
    await this.reveal();
    this.post({ type: 'attach', items: list });
  }

  /**
   * 让面板显出来。
   *
   * 展开一个视图只能通过 VS Code 自己的命令 `<viewId>.focus`，
   * 所以这里只能走 executeCommand —— 在测试的假 vscode 里它不存在，
   * 那就记一条日志、当作没事发生（附件本身照挂）。
   */
  async reveal() {
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } catch (error) {
      this.log('warn', `展开面板失败（不影响把内容挂上去）：${this.errText(error)}`);
    }
  }

  /** 把命令面板/右键菜单拿来的编辑器信息整理成附件形状。 */
  static attachmentFromEditor(editor, workdir) {
    if (!editor || !editor.document) return undefined;
    const document = editor.document;
    const uri = document.uri;
    const absolute = uri && uri.fsPath ? uri.fsPath : document.fileName;
    if (!absolute) return undefined;
    // 名字用相对于工作目录的路径：模型和自己看都更短、更清楚。
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

  /** 下一段新对话要用哪个预设：面板里选过的优先，其次是设置里的默认值。 */
  wantedPreset(cfg = this.config()) {
    return this.preset || cfg.preset || undefined;
  }

  async newSession() {
    const session = await this.ensureConnection();
    if (!session) return;
    const cfg = this.config();
    const old = session.sessionId;
    this.post({ type: 'reset' });
    // 用户主动要新对话，就别再想着把上一段接回来了。
    this.resumeTarget = undefined;
    this.turnSent = false;
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
      await session.start({
        cwd: this.workdir(),
        provider: cfg.provider,
        model: cfg.model,
        preset: this.wantedPreset(cfg),
      });
      this.post({ type: 'status', state: 'ready', detail: '已连上（新对话）' });
    } catch (error) {
      this.post({ type: 'status', state: 'error', detail: `新建会话失败：${this.errText(error)}` });
    }
  }

  async setModel(value) {
    if (!this.session) return;
    await this.session.setModel(value);
  }

  /**
   * 用户在面板里换了 agent preset。
   *
   * 内核不允许一段会话中途换预设（`agent-preset/locked`，实测），
   * 所以这里只有两条路：
   *   - 这段还没说过话 → 直接按新预设重开一段（零代价，用户不用自己再点新建）；
   *   - 已经说过了 → 记下来，明确告诉他下一段新对话用它，绝不假装换成功了。
   */
  async setPreset(value) {
    const preset = typeof value === 'string' ? value.trim() : '';
    if (!preset) return;
    this.preset = preset;
    if (this.session && !this.turnSent) {
      this.log('info', `预设改成 ${preset}；当前这段还没说过话，直接重开一段`);
      await this.newSession();
      this.post({ type: 'notice', text: `已按「${this.labelOf(preset)}」重开一段新对话。` });
      return;
    }
    this.log('info', `预设改成 ${preset}（下一段新对话生效）`);
    this.post({
      type: 'notice',
      text: `已选「${this.labelOf(preset)}」：下一段新对话用它（内核不允许一段对话中途换预设）。`,
    });
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
    // 下一轮连接重新判断历史会话从哪儿读（用户可能刚好升级了门）。
    this.historyVia = undefined;
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

/**
 * 兜底拉起失败时给用户看的那句话（纯函数，好测）。
 *
 * 两种失败要说成两件不同的事，因为**出路不一样**：
 * - 进程刚启动就退出 → 命令不对（dsh 不在 PATH、dshCommand 指错）；
 * - 进程活着但端口没开 → 这个档里可能没装门插件，或者门被指到了别的端口。
 * 把它们混成一句"没开门"，用户就只能自己猜。
 */
function fallbackFailureText({ command, profile, host, port, exitedEarly }) {
  if (exitedEarly) {
    return (
      `后台 DSH 刚启动就退出了（命令：「${command}」，profile=${profile}）。` +
      '多半是 dsh 不在 PATH 里，或者 dshPanel.dshCommand 指错了 —— ' +
      '先开个终端跑一次 dsh --version 确认，再把它的完整路径填进设置。'
    );
  }
  return (
    `后台 DSH 起来了，但 ${host}:${port} 上一直没开门（profile=${profile}）。` +
    `两种可能：这个档里没装门插件（用 dsh plugin --profile ${profile} list 看一眼，` +
    '应当有 dsh-acp-door）；或者你改过端口，门插件里的 port 也要跟着改。'
  );
}

module.exports = {
  DshPanelView,
  VIEW_ID,
  fallbackFailureText,
  isLoopbackHost,
  isMissingMethod,
};
