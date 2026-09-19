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
// 权限预设：中文标签与失败说明（纯函数，见那个文件开头为什么清单不写死）。
const { decorateOptions, currentLabel, explainPermissionFailure } = require('../dsh/permission');
const {
  probePort,
  dshCommandCandidates,
  explainKernelFailure,
  panelProfileCandidates,
} = require('../door/locate');
const { renderHtml, makeNonce } = require('../panel/html');
const localSessions = require('../dsh/sessions');
const { kernelManager } = require('../panel/kernel-manager');

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
   * @param {string[]} [options.spawnArgs] **只给测试用**：自启内核时额外加的参数。
   *   生产路径永远是空数组 —— 正常启动不需要任何额外参数。测试拿它挂一个
   *   `--patch`，把门指到别的端口上，这样测「从零拉起」时不必去抢 47821
   *   （桌面端开着的时候那上面已经有门了，否则这个测试只能跳过）。
   */
  constructor({ extensionUri, log, spawnArgs = [], kernels }) {
    this.extensionUri = extensionUri;
    this.log = log;
    this.spawnArgs = spawnArgs;
    /**
     * 后台内核归谁管 —— 归**扩展**，不归这个视图（见 kernel-manager.js 开头）。
     *
     * 这一条是 2026-09-19 那次"聊两句就断"的结构性修复：原来视图一销毁
     * 就把内核杀掉，而视图太容易没了（折叠侧边栏、拖动面板、重载窗口）。
     * 现在视图只是内核的一个"使用者"：销毁 = 释放引用，归零后还有宽限，
     * 这期间重新打开面板会继续用同一个内核。
     */
    this.kernels = kernels || kernelManager(log);
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
     * 最近一次读到的权限预设（门给的原始载荷：`{currentValue, options}`）。
     *
     * 为什么面板只缓存、不当真源：权限是**内核**的状态，面板是它的一个视图。
     * 缓存只为两件事：界面重新加载时先把上一次的补上（不闪空白），
     * 以及查中文标签。真值每次会话定下来都重新读一遍。
     * @type {{currentValue: string, options: Array<object>}|undefined}
     */
    this.permission = undefined;
    /**
     * 权限读不到时的说明（门太旧 / 档里没挂权限服务 / 其它错误）。
     *
     * 这三种都**不是面板坏了**，所以不进对话流当报错，而是让选择器变成
     * 一句解释 —— 用户看到的是「这里为什么切不了」，不是一屏红字。
     * @type {{state: string, text: string, detail?: string}|undefined}
     */
    this.permissionUnavailable = undefined;
    /**
     * 已经在对话流里说过一次的那种「读不到」原因（'old-door' / 'no-service' / …）。
     *
     * 只说一次：接桌面端那个内核（门 0.0.7）时每次建会话都会读失败，
     * 每次都播一遍就成了噪音。断开重连时清掉（用户可能刚好升了门）。
     * @type {string|undefined}
     */
    this.permissionNotice = undefined;
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
        case 'setPermission':
          await this.setPermission(message.value);
          break;
        case 'refreshPermission':
          await this.refreshPermission();
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
    const minutes = Number(cfg.get('kernelIdleMinutes'));
    // 面板自己拉起的那个内核，在"没有面板用它"之后还能活多久（默认 10 分钟）。
    // 设成 0 = 面板一关就收（老行为）。视图只是个使用者，内核归扩展管 ——
    // 见 src/panel/kernel-manager.js。
    this.kernels.setIdleMs(
      Number.isFinite(minutes) && minutes >= 0 ? minutes * 60000 : 10 * 60000,
    );
    return {
      host: cfg.get('host') || '127.0.0.1',
      port: cfg.get('port') || 47821,
      /**
       * 面板**自己**起的那个内核，门开在哪个端口。
       *
       * 为什么和 port 分开：`port` 是"我去连谁"（默认 47821，桌面端那个门也在
       * 那儿，有门就接）。而面板自启的内核一律用自己的端口 —— 以前它也去抢
       * 47821，两个内核抢一个口，抢输的门干脆不开，用户对着"正在启动…"干等。
       */
      selfStartPort: cfg.get('selfStartPort') || 47831,
      autoStart: cfg.get('autoStart') !== false,
      fallbackProfile: cfg.get('fallbackProfile') || 'vscode-panel',
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
   * 兜底拉起要试的候选档（同理：测试可以只留设置里那一个）。
   *
   * 为什么要试多个档：`desktop` 这个档被桌面端独占，命令行根本起不来
   * （2026-09-19 实测：`error: profile "desktop" is managed exclusively by the
   * Electron application`）。用户没改过设置时用的就是这个默认值，于是面板
   * 在"桌面端没开"时必然起不来 —— 而"桌面端没开"恰恰是最需要它自己起来的
   * 时候。所以：先按设置试，不行就在 `$DSH_HOME/profiles` 里找一个装了门、
   * 而且是网页档的接着试。
   */
  profilesFor(cfg) {
    return panelProfileCandidates({ configured: cfg.fallbackProfile, homedir: os.homedir() });
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
    // 顶栏只留短状态；"为什么要启动""用哪个档"这类话进对话流。
    this.post({ type: 'status', state: 'connecting', detail: '正在启动…' });
    /*
     * 先问一句：本扩展是不是已经在"面板自己的端口"上起过一个还活着的内核？
     *
     * 这一段是"视图销毁不等于内核死亡"的落地点：面板关掉又打开、或者
     * 另一个 VS Code 窗口已经起过一个，都该**接着用**同一个进程，
     * 而不是又拉起一个（多拉的那一个还会跟这一个抢端口）。
     *
     * 注意两点：
     * ① 查的是 selfStartPort —— 面板起的内核门就钉在那儿（不是 cfg.port，
     *    那是桌面端那个内核的端口）。
     * ② 先等门真的开出来再交差：内核活着但门没开（正在启动 / 门起崩了）
     *    时直接返回"成功"，用户接下来看到的会是莫名其妙的握手失败。
     *    门要是等不出来，就把它收掉重起一个。
     */
    const reusable = this.kernels.live(cfg.host, cfg.selfStartPort);
    if (reusable) {
      const door = await this.waitForFallbackDoor(
        reusable.background && reusable.background.child,
        cfg.host,
        [cfg.selfStartPort, cfg.port],
        15000,
      );
      if (door.ok) {
        this.background = reusable.background;
        this.kernels.acquire(this, reusable);
        this.log('info', `面板自己那个内核还在（${cfg.host}:${door.port}），接着用它，不重启`);
        this.post({ type: 'notice', text: '面板自己那个内核还在，直接接着用。' });
        return { ok: true, command: reusable.command, profile: reusable.profile, port: door.port };
      }
      this.log('warn', '本扩展起的那个内核还活着，但它的门一直没开 —— 收掉它，重起一个');
      this.kernels.stop(reusable.key, '内核活着但门不开，重起');
    }

    const profiles = this.profilesFor(cfg);
    this.post({
      type: 'notice',
      text: `没有现成的内核，正在启动一个（档：${profiles[0]}）。第一次会慢一点，之后就快了。`,
    });
    this.log('info', `端口上没有门，按设置自己拉起一个 DSH 内核（门钉在 ${cfg.host}:${cfg.selfStartPort}）`);

    const candidates = this.candidatesFor(cfg);
    if (candidates.length === 0) {
      return {
        ok: false,
        human: {
          title: '找不到 dsh 命令，没法自己启动内核',
          advice:
            '装好 DSH 后，在设置里把 dshPanel.dshCommand 填成完整启动命令；' +
            '或者先打开 DSH 桌面端 —— 面板会直接连它，不用自己启动。',
          raw:
            '不知道怎么启动 DSH：设置 dshPanel.dshCommand 是空的，' +
            '默认安装位置（~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js）也没找到。',
        },
      };
    }

    // 先按档、再按命令：同一个档换个命令写法是"最后一招"，而换个档往往
    // 才是真正的原因（设置里那个档起不来）。
    const plans = [];
    for (const profile of profiles) {
      for (const command of candidates) plans.push({ profile, command });
    }

    const failures = [];
    const kinds = new Set();
    for (let i = 0; i < plans.length; i += 1) {
      const { profile, command } = plans[i];
      const hasMore = i + 1 < plans.length;
      // 候选逐个试是给日志看的，顶栏没必要跟着跳字。
      this.log('info', `试着启动：${command}（档：${profile}）`);
      let entry;
      try {
        // 交给 manager 起并登记：这样"视图销毁"不会把它带走，另一个窗口也能复用。
        // 门钉在面板自己的端口上（门那边读 DSH_ACP_DOOR_PORT，见 dsh-door/lib/port.js）。
        // 档里那个 port 是**默认值**，不是命令；谁起的内核谁定端口。
        entry = this.kernels.spawn({
          host: cfg.host,
          port: cfg.selfStartPort,
          command,
          profile,
          log: this.log,
          extraArgs: this.spawnArgs,
        });
      } catch (error) {
        failures.push(`「${command}」起不来：${this.errText(error)}`);
        continue;
      }
      const background = entry.background;
      this.background = background;
      const outcome = await this.waitForFallbackDoor(
        background.child,
        cfg.host,
        [cfg.selfStartPort, cfg.port],
        hasMore ? 30000 : 120000,
      );
      if (outcome.ok) {
        // 成了：这个内核归本视图用（引用计数 +1）。
        // 门实际开在哪个口上就接哪个（旧版门只认档里那个端口）。
        this.kernels.acquire(this, entry);
        if (outcome.port !== cfg.selfStartPort) {
          this.log('warn', `这个档里的门没认端口设置，开在了 ${outcome.port}（档里的门插件是旧版？）`);
        }
        return { ok: true, command, profile, port: outcome.port };
      }
      // 没成：收掉这个进程再试下一条（killTree 连子孙一起杀，不留孤儿）。
      // 收之前先把它自己打的最后几句话取出来 —— 原因就在里面。
      const stderr = typeof background.stderrTail === 'function' ? background.stderrTail() : '';
      const explained = explainKernelFailure({ profile, stderr });
      this.kernels.stop(entry.key, '自启失败，换个档再试');
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
        title: '没能启动 DSH 内核',
        advice: fallbackAdvice(kinds),
        raw:
          `启动 DSH 内核没成功（试了 ${plans.length} 种起法）：\n` +
          failures.join('\n\n'),
      },
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
   * `port` 可以是一个端口，也可以是一串：面板把门钉在 `selfStartPort` 上
   * （环境变量），但**用户档里的门可能还是旧版**（不认那个环境变量），那就
   * 只会开在档里配的端口上。只看一个端口的话，这种情况会变成"内核明明起来了，
   * 却等满两分钟说没门"，而门其实开在另一个口上。所以：谁先开就用谁，
   * 返回值里的 `port` 就是实际接上去的那个。
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
    const ports = Array.isArray(port) ? port : [port];
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const candidate of ports) {
          if (candidate && (await probePort(host, candidate))) return { ok: true, port: candidate };
        }
        if (exit) {
          // 刚退出时端口可能还在收尾，再确认一次才判失败。
          for (const candidate of ports) {
            if (candidate && (await probePort(host, candidate))) {
              return { ok: true, port: candidate };
            }
          }
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
    this.post({ type: 'status', state: 'connecting', detail: '正在连接…' });

    /*
     * 连哪个端口，按这个顺序定（2026-09-19 改）：
     *
     * 1. `dshPanel.port`（默认 47821）上有门 → **接上去**。这是桌面端那个内核，
     *    也是"一个进程一个大脑"的情形 —— 面板不自起、也不去动它。
     * 2. `dshPanel.selfStartPort`（默认 47831）上有门 → 接上去，这个门后面的内核
     *    一般是**另一个 VS Code 窗口**起的，或者本窗口刚才起的那个（面板关掉又
     *    打开）：复用它，别再拉一个（多拉的那个还会跟它抢端口）。
     *    **是本扩展起的**才记成"我在用"（关面板时它才会进宽限回收）；
     *    别人起的什么都不记 —— 绝不收别人的内核。
     * 3. 都没有 → 自己起一个，**门钉在 selfStartPort 上**（环境变量
     *    DSH_ACP_DOOR_PORT，见 dsh-door/lib/port.js）。
     *
     * 为什么要分两个端口：面板自启的内核以前也用 47821 —— 那正是桌面端那个
     * 内核的端口。两个内核抢同一个端口没有任何好处，抢输的那个门干脆不开，
     * 用户对着"正在启动…"干等。现在自启的一律用自己的端口，谁也不碰谁。
     */
    let target = cfg.port;
    let reachable = false;
    if (await probePort(cfg.host, cfg.port)) {
      reachable = true;
      this.log('info', `端口 ${cfg.host}:${cfg.port} 上有现成的门，接上去（不自启内核）`);
    } else if (await probePort(cfg.host, cfg.selfStartPort)) {
      target = cfg.selfStartPort;
      reachable = true;
      const mine = this.kernels.live(cfg.host, cfg.selfStartPort);
      if (mine) {
        // 本扩展起的：记成"我在用"，关面板后它才会进宽限回收（不然会一直留着）。
        this.kernels.acquire(this, mine);
        this.background = mine.background;
      }
      this.log(
        'info',
        `面板自己的端口 ${cfg.host}:${cfg.selfStartPort} 上已经有门了，接上去` +
          (mine ? '（是本扩展起的那个内核，接着用，不重启）' : '（不是本扩展起的，我不负责收它）'),
      );
      this.post({ type: 'notice', text: '面板内核已经在了，直接接上去。' });
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
      this.postError(
        `连不上 ${cfg.host}:${cfg.port}：端口上什么都没有，而 dshPanel.autoStart 是关着的，` +
          '所以面板没有自己启动内核。可执行「DSH：重新连接」重试。',
      );
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      return undefined;
    }
    // 后面每一处"连哪儿/说哪儿"都用 target，不要再回头用 cfg.port。
    this.targetPort = target;

    const client = new DoorClient({ host: cfg.host, port: target, log: this.log });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      const text = error && error.message ? error.message : String(error);
      this.postError(`连上了 ${cfg.host}:${target}，但握手失败：${text}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
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
          this.post({ type: 'notice', text: '已重连，上面那段对话的上下文接回来了。' });
          this.post({ type: 'status', state: 'ready', detail: '就绪' });
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
      this.postError(`建会话失败：${text}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      return undefined;
    }

    this.post({ type: 'status', state: 'ready', detail: '就绪' });
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
        detail: payload.busy ? '工作中…' : '就绪',
      });
    });
    session.on('error', (payload) => this.postError(payload.message));
    session.on('session', (payload) => {
      this.log('info', `当前会话 ${payload.sessionId}`);
      // 会话一定下来（新建/恢复/换内核）就读一次权限：权限是内核的状态，
      // 换一个内核或换一段会话都可能不一样，不能拿上一次的接着显示。
      void this.refreshPermission();
    });

    client.on('permission', (requestId, params) =>
      this.post({ type: 'permission', requestId, params }),
    );
    client.on('close', (reason) => {
      // 断开的原因可能很长（内核原文），进对话流；顶栏只说"未连接"。
      this.postError(this.disconnectText(reason));
      this.post({ type: 'status', state: 'error', detail: '未连接' });
      this.post({ type: 'busy', busy: false });
      // 记住这个会话，下次连接时先试着接回来（session/resume 实测有效）。
      if (session.sessionId) this.resumeTarget = session.sessionId;
      // 让它下次「发送」时自动重连，而不是把面板卡死。
      if (this.session === session) this.session = undefined;
      if (this.client === client) this.client = undefined;
    });
  }

  /**
   * 连接断了，往对话流里说人话。
   *
   * 2026-09-19 用户报"聊两句就 read ECONNRESET"，翻日志才发现面板自己
   * 拉起的那个内核是**退出 code=1** 死的，而面板只回了一句通用的
   * "连接断开：read ECONNRESET" —— 用户完全没法判断该不该怪自己。
   * 现在分两种情形说清楚：
   *
   * - **我们自己拉的内核死了** → 报退出码 + 内核最后说的话（原文在输出面板里）；
   * - **连的是别人正在跑的内核（多半是桌面端）** → 直说那是它退了或重启了，
   *   面板会自己换一个，别去查配置。
   *
   * @param {string} reason 客户端给的断开原因。
   */
  disconnectText(reason) {
    const background = this.background;
    const child = background && background.child;
    const died = child && typeof child.exitCode === 'number' && child.exitCode !== null;
    if (died) {
      const tail =
        typeof background.stderrTail === 'function' ? background.stderrTail() : '';
      const lastLine = tail ? tail.split(/\r?\n/).filter((line) => line.trim()).pop() : '';
      const why = lastLine
        ? `它最后说：${lastLine}`
        : '它一个字都没说就退了 —— 这种情况通常是外面把它杀了，不是它自己崩的';
      return (
        `给你干活的那个内核自己退出了（code=${child.exitCode}）。${why}\n` +
        '完整输出在「输出 → DSH Panel」里。直接发消息就行，我会重新拉起一个并接着上面的对话。'
      );
    }
    if (!background) {
      return (
        `连接断开了：${reason}\n` +
        '刚才连的是别处正在跑的 DSH（多半是你桌面端那个）—— 它退出或重启了。' +
        '直接发消息就行，面板会自己拉起一个内核，并把上面那段对话接回来。'
      );
    }
    return `连接断开：${reason}`;
  }

  /** 界面刚加载完时，把当前状态补一遍。 */
  pushSnapshot() {
    const session = this.session;
    if (!session) return;
    this.post({ type: 'status', state: session.busy ? 'busy' : 'ready', detail: session.busy ? '工作中…' : '就绪' });
    this.post({ type: 'config', configOptions: session.configOptions });
    if (this.lastPresets) this.post({ type: 'presets', ...this.lastPresets });
    // 权限：上一次读到的先补上（不闪空白）；从没读到过就问一次。
    if (this.permission) this.postPermissionState(this.permission);
    else if (this.permissionUnavailable) this.post({ type: 'permissionState', unavailable: this.permissionUnavailable });
    else void this.refreshPermission();
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
      this.post({ type: 'notice', text: '已接回这段历史会话，它记得上面说过的内容。' });
      this.post({ type: 'status', state: 'ready', detail: '就绪' });
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
      this.post({ type: 'status', state: 'ready', detail: '就绪' });
    } catch (error) {
      this.postError(`新建会话失败：${this.errText(error)}`);
      this.post({ type: 'status', state: 'error', detail: '未连接' });
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

  /**
   * 读一次当前会话的权限预设（门 ≥0.0.12 的 `dsh-door/permission/get`）。
   *
   * 为什么每次都问内核、而不是面板自己记着：权限是**内核**的状态
   * （会话的 `permissions` 投影）。桌面端切了、用户改了档里的默认值、
   * 某个插件（比如 Auto Approval）动了旋钮，面板都该照实显示 ——
   * 这也就是「跟桌面端同步」的落实方式：同一份清单、同一个真源。
   *
   * 读不到**不算错误**：门太旧（0.0.11 及以下）或这个档没挂权限服务都是常态。
   * 这时选择器变成一句解释（见 dsh/permission.js），别的功能一点不受影响。
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
      // 记一行日志：真窗口自检（tools/vscode-check.js）就是靠它证明
      // 「面板真的从内核读到了权限清单」，而不是靠界面看起来像。
      this.log('info', `当前权限：${currentLabel(payload.currentValue, payload.options)}（${payload.currentValue}）`);
    } catch (error) {
      const shaped = explainPermissionFailure({ code: error && error.code, message: this.errText(error) });
      this.permission = undefined;
      this.permissionUnavailable = shaped;
      this.post({ type: 'permissionState', unavailable: shaped });
      this.log('info', `权限预设读不到（${shaped.state}）：${this.errText(error)}`);
      // 顶栏那个按钮只有几个字（「切不了（门太旧）」），说清楚为什么得靠这里。
      // 每种原因只说一次：接的是桌面端那个内核时，每次建会话都会走到这儿。
      if (this.permissionNotice !== shaped.state) {
        this.permissionNotice = shaped.state;
        this.post({
          type: 'notice',
          text: `${shaped.text}${shaped.detail ? `\n${shaped.detail}` : ''}`,
        });
      }
    }
  }

  /** 把一份权限载荷发给界面（统一在这儿加中文标签）。 */
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
   * 用户在面板里换了权限预设。
   *
   * 跟 agent preset（`setPreset`）**不是一回事**：那个换不了当前这段（内核
   * 报 `agent-preset/locked`），而权限是**随时可换**的 —— 内核就是为此设计的
   * （`/permission`、桌面端那个选择器都是中途可点）。所以这里直接切，
   * 不重开会话，也不编「下一段生效」那种话。
   *
   * 切完以**内核回读的**为准（不乐观更新）：万一某个旋钮被别的机制按住，
   * 界面显示的仍然是真实状态，而不是用户以为的那一个。
   */
  async setPermission(value) {
    const client = this.client;
    const sessionId = this.session && this.session.sessionId;
    const wanted = typeof value === 'string' ? value.trim() : '';
    if (!client || !sessionId || !wanted) return;
    if (typeof client.permissionSet !== 'function') return;
    const label = currentLabel(wanted, this.permission && this.permission.options);
    try {
      const payload = await client.permissionSet(sessionId, wanted);
      this.permission = payload;
      this.permissionUnavailable = undefined;
      this.postPermissionState(payload);
      this.post({ type: 'notice', text: `权限已切到「${label}」。` });
      this.log('info', `权限切到 ${wanted}（内核回读 ${payload.currentValue}）`);
    } catch (error) {
      // 失败要说清楚是什么失败（旧门 / 名字不对 / 会话没了），并且把界面
      // 拉回真实状态 —— 否则用户会以为自己已经切过去了。
      const shaped = explainPermissionFailure({ code: error && error.code, message: this.errText(error) });
      this.postError(`${shaped.text}${shaped.detail ? `\n${shaped.detail}` : ''}`);
      // 这一次是用户自己点的，说一遍就够：把去重标记先记上，
      // 免得下面那次重读又把同一句话当「notice」再播一遍。
      this.permissionNotice = shaped.state;
      await this.refreshPermission();
    }
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
    // 权限那条说明也重新说一遍（可能刚升完门）。
    this.permissionNotice = undefined;
    this.permissionUnavailable = undefined;
  }

  dispose() {
    this.teardown();
    /*
     * 关键的一行（2026-09-19 改）：**不杀内核，只释放引用**。
     *
     * 原来这里是 `this.background.dispose()` —— 视图一销毁就把内核杀掉，
     * 而视图太容易没了（折叠侧边栏、拖动面板、Reload Window、另一个窗口关掉）。
     * 现在交给 manager：引用归零后还有宽限（默认 10 分钟），这期间重新打开
     * 面板会继续用同一个内核 —— 不重启、也不用 resume。
     */
    this.kernels.release(this);
    this.background = undefined;
  }
}

/**
 * 自己启动内核失败时给用户看的那段原文（纯函数，好测）。
 *
 * 两种失败要说成两件不同的事，因为**出路不一样**：
 * - 进程刚启动就退出 → 命令不对（dsh 不在 PATH、dshCommand 指错）；
 * - 进程活着但端口没开 → 这个档里可能没装门插件，或者门被指到了别的端口。
 * 把它们混成一句"没开门"，用户就只能自己猜。
 */
function fallbackFailureText({ command, profile, host, port, exitedEarly, stderr, explained }) {
  // 内核自己说了原因就照实转述 —— 别让面板的猜测盖过它自己的话。
  const said = explained && explained.kind !== 'unknown' ? explained : null;
  const raw = String(stderr || '').trim();
  const tail = raw ? `\n内核原话：${raw}` : '';

  if (exitedEarly) {
    if (said) {
      return (
        `用「${command}」启动内核（profile=${profile}）时，它一启动就退出了：` +
        `${said.reason}。${said.advice}${tail}`
      );
    }
    return (
      `用「${command}」启动内核（profile=${profile}）时，它一启动就退出了。` +
      '多半是 dsh 不在 PATH 里，或者 dshPanel.dshCommand 指错了 —— ' +
      '先开个终端跑一次 dsh --version 确认，再把它的完整路径填进设置。' +
      tail
    );
  }
  return (
    `内核起来了，但 ${host}:${port} 上一直没开门（profile=${profile}）。` +
    `两种可能：这个档里没装门插件（用 dsh plugin --profile ${profile} list 看一眼，` +
    '应当有 dsh-acp-door）；或者你改过端口，门插件里的 port 也要跟着改。' +
    tail
  );
}

/**
 * 所有起法都失败之后，给用户一句**对得上原因**的建议。
 *
 * 原来这里是写死的一句"把 dshCommand 填成完整命令" —— 而当失败原因是
 * "这个档命令行起不来"（2026-09-19 那次）时，那句话把人往错的方向带。
 */
function fallbackAdvice(kinds) {
  if (kinds.has('app-managed-profile')) {
    return (
      '档「desktop」是桌面端独占的，命令行起不来。把 dshPanel.fallbackProfile 换成 ' +
      'vscode-panel（面板自己的档），或者先打开 DSH 桌面端 —— 面板会直接连它。'
    );
  }
  if (kinds.has('wrong-app-flags')) {
    return (
      '这个档不接受面板的启动参数：它多半是给别的入口用的（比如 ACP 那种走标准输入输出的档）。' +
      '把 dshPanel.fallbackProfile 换成 bundles 里有 @deepseek-ai/dsh-web-app 的档。'
    );
  }
  if (kinds.has('port-in-use')) {
    return '门要用的端口被占着：关掉占用它的进程再重连，或者改 dshPanel.port（门插件里的 port 也要跟着改）。';
  }
  return (
    '在设置里把 dshPanel.dshCommand 填成能用的完整启动命令（例如 ' +
    'node C:\\Users\\你\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js）；' +
    '或者先打开 DSH 桌面端 —— 面板会直接连它，不用自己启动。'
  );
}

module.exports = {
  DshPanelView,
  VIEW_ID,
  fallbackFailureText,
  fallbackAdvice,
  isLoopbackHost,
  isMissingMethod,
};
