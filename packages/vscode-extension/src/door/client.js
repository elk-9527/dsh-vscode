'use strict';

/**
 * 面向 ACP 接入点插件（`dsh-acp-door`）的 ACP 客户端。
 *
 * 不使用 @agentclientprotocol/sdk 而自行实现的原因：
 * 1. 扩展保持零运行时依赖 —— 无需打包器，也无需将 node_modules 放入 vsix，
 *    出现问题时可以直接查阅协议原文；
 * 2. ACP 本身结构简单：每行一个 JSON（JSON-RPC 2.0），
 *    本文件用到的方法即为下列若干方法，全部有实测抓包作为依据。
 *
 * 协议流量走 TCP，日志走回调 —— 协议与日志分离。
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

const { buildPromptBlocks } = require('../dsh/blocks');
const { requireLoopbackHost } = require('./endpoint');

/** ACP 协议版本（第 0 步实测：内核返回的值为 1）。 */
const PROTOCOL_VERSION = 1;

/** 普通 ACP 短请求的最长等待时间。模型回合另行使用可取消的长请求。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** 建立 / 恢复会话可能需要组装 agent，允许比普通查询更长的时间。 */
const SESSION_REQUEST_TIMEOUT_MS = 30000;

/** 用户中断长请求后，若对端始终不回取消结果，最多再等待该时长。 */
const CANCEL_GRACE_MS = 10000;

/** JSON-RPC 标准错误码。 */
const PARSE_ERROR = -32700;

/**
 * 接入点插件使用的 `_meta` 键名 —— 与 `packages/dsh-door/lib/frames.js` 中的
 * `DOOR_META_KEY` 保持一致（test/static.js 会核对，仅修改一侧会被检测到）。
 *
 * 采用 `_meta` 而不新增一个 ACP 方法的原因：`_meta` 是 ACP 官方预留的
 * 扩展点（schema 中定义为 `z.record(z.string(), z.unknown())`），
 * 不识别该字段的实现会将其原样忽略，不会因为多出一个字段而导致通信失败。
 */
const PRESET_META_KEY = 'dsh-door';

/**
 * 读取该插件在 `session/new` 回复中附加的预设信息。
 *
 * @param {object} result 内核的回复对象
 * @returns {{presets?: object[], current?: string, requested?: string, fallback?: boolean}|undefined}
 *   缺少该信息时（例如对端不是 DSH 的接入点插件）返回 undefined。
 */
function readDoorMeta(result) {
  const meta = result && typeof result === 'object' ? result._meta : undefined;
  if (!meta || typeof meta !== 'object') return undefined;
  const info = meta[PRESET_META_KEY];
  return info && typeof info === 'object' ? info : undefined;
}

/**
 * 内核返回的业务错误（例如 `agent-preset/locked`）。
 * `code` 是 JSON-RPC 数字码；`message` 中可能包含内核自身的语义码。
 */
class DoorRequestError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'DoorRequestError';
    this.code = code;
    this.data = data;
  }
}

/** 对端已经接通，但在规定时间内没有回复某条 ACP 请求。 */
class DoorTimeoutError extends Error {
  constructor(method, timeoutMs, phase = '请求') {
    super(`${phase}超时：${method} 在 ${timeoutMs}ms 内没有收到 DSH 回复`);
    this.name = 'DoorTimeoutError';
    this.code = 'ACP_REQUEST_TIMEOUT';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

class DoorClient extends EventEmitter {
  #socket = null;
  #buffer = '';
  #decoder = new StringDecoder('utf8');
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #closeReason = '';

  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor({ host, port, log }) {
    super();
    // 连接目标在客户端层再次收紧：即使未来有其它调用方绕过面板配置，
    // 也不会把 ACP 请求发送到非本机地址。
    this.host = requireLoopbackHost(host);
    this.port = port;
    this.log = log || (() => {});
    /** 内核在 initialize 中返回的自身信息。 */
    this.agentInfo = null;
    /** 内核声明的能力。 */
    this.capabilities = null;
  }

  get isConnected() {
    return Boolean(this.#socket) && !this.#closed && !this.#socket.destroyed;
  }

  /**
   * 建立连接并完成 ACP 握手。
   *
   * @param {object} [options]
   * @param {number} [options.timeoutMs] 建连超时。
   * @returns {Promise<object>} initialize 的返回值。
   */
  async connect({ timeoutMs = 5000, initializeTimeoutMs = 8000 } = {}) {
    if (this.#socket) throw new Error('连接已建立，不能重复连接');
    this.#closed = false;
    this.#closeReason = '';
    // TCP 数据块边界与 UTF-8 字符边界无关。每次新连接使用新的有状态解码器，
    // 既保留跨 chunk 的多字节字符，也丢弃上一次断线留下的半帧/半字符。
    this.#buffer = '';
    this.#decoder = new StringDecoder('utf8');

    const socket = net.connect({ host: this.host, port: this.port });
    this.#socket = socket;
    socket.setNoDelay(true);

    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('connect', onConnect);
          socket.off('error', onError);
        };
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`连接 ${this.host}:${this.port} 超时`));
        }, timeoutMs);
        socket.once('connect', onConnect);
        socket.once('error', onError);
      });
    } catch (error) {
      this.#socket = null;
      socket.destroy();
      throw error;
    }

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('连接被对方关闭')));

    let result;
    try {
      result = await this.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        },
        { timeoutMs: initializeTimeoutMs, timeoutPhase: 'ACP 握手' },
      );
    } catch (error) {
      // TCP 已连通但握手失败时同样要关掉 socket；否则一个“只占端口、不说 ACP”的
      // 本机程序会留下一条无用连接，面板也无法干净地重试其它内核。
      this.close();
      throw error;
    }
    this.agentInfo = result && result.agentInfo ? result.agentInfo : null;
    this.capabilities = result && result.agentCapabilities ? result.agentCapabilities : null;
    if (result && result.protocolVersion !== PROTOCOL_VERSION) {
      this.log('warn', `协议版本不一致：内核 ${result.protocolVersion}，本扩展 ${PROTOCOL_VERSION}`);
    }
    this.log('info', `握手完成：${JSON.stringify(this.agentInfo)}`);
    return result;
  }

  /**
   * 发送一个请求。
   *
   * @param {string} method
   * @param {unknown} params
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] 中止时发送 `$/cancel_request`；
   *   注意**不**使该 promise 进入 rejected 状态 —— 内核会返回正常的 `stopReason: cancelled`。
   * @returns {Promise<any>}
   */
  request(
    method,
    params,
    {
      signal,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      abortTimeoutMs = CANCEL_GRACE_MS,
      timeoutPhase = 'ACP 请求',
    } = {},
  ) {
    const id = this.#nextId++;
    if (signal && signal.aborted) {
      return Promise.reject(new DoorRequestError(-32800, `请求已取消：${method}`));
    }
    return new Promise((resolve, reject) => {
      let timeoutTimer;
      let abortTimer;
      const failPending = (error) => {
        const current = this.#pending.get(id);
        if (!current) return;
        this.#pending.delete(id);
        current.cleanup();
        reject(error);
      };
      const onAbort = () => {
        this.cancel(id);
        if (Number.isFinite(abortTimeoutMs) && abortTimeoutMs > 0) {
          clearTimeout(abortTimer);
          abortTimer = setTimeout(() => {
            failPending(new DoorTimeoutError(method, abortTimeoutMs, '取消请求'));
          }, abortTimeoutMs);
          if (typeof abortTimer.unref === 'function') abortTimer.unref();
        }
      };
      const entry = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeoutTimer);
          clearTimeout(abortTimer);
          if (signal) signal.removeEventListener('abort', onAbort);
        },
      };
      this.#pending.set(id, entry);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        entry.cleanup();
        reject(error);
        return;
      }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          this.log('warn', `${timeoutPhase}超时：${method}（${timeoutMs}ms）`);
          failPending(new DoorTimeoutError(method, timeoutMs, timeoutPhase));
        }, timeoutMs);
        if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
      }
    });
  }

  /** 发送一个通知（不需要回复）。 */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** 请求中断某个正在进行的请求（实测：`$/cancel_request` + `{ requestId }`）。 */
  cancel(requestId) {
    if (!this.isConnected) return;
    this.notify('$/cancel_request', { requestId });
    this.log('info', `已请求中断 #${requestId}`);
  }

  /** 回应内核发来的请求（目前仅有 `session/request_permission`）。 */
  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  /** 以失败结果回应内核发来的请求。 */
  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  close() {
    const socket = this.#socket;
    this.#socket = null;
    this.#fail(new Error('客户端主动断开'), { silent: true });
    if (socket) socket.destroy();
  }

  // ── ACP 具体方法（均经过实测抓包核对）────────────────────────────

  /**
   * 新建会话。
   *
   * @param {string} cwd 会话的工作目录。
   * @param {object} [options]
   * @param {string} [options.preset] 指定使用的 agent preset（standard / ptc / minimal / cordis）。
   *   通过 ACP 官方的 `_meta` 扩展点传递给该插件（键名与 dsh-acp-door 的
   *   lib/frames.js 一致，test/static.js 会核对两侧是否一致）。
   *   注意：**预设仅在新建会话时可选** —— 内核不允许在会话开始之后更换
   *   （`agent-preset/locked`，实测），因此面板中更换预设的语义是「下一段新对话使用哪一个」。
   * @returns {Promise<object>} 内核的回复（`sessionId`、`configOptions`），
   *   该插件还会在 `_meta['dsh-door']` 中附加可用预设清单与实际使用的那一项。
   */
  newSession(cwd, { preset } = {}) {
    const params = { cwd, mcpServers: [] };
    if (typeof preset === 'string' && preset) {
      params._meta = { [PRESET_META_KEY]: { preset } };
    }
    return this.request('session/new', params, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
  }

  /**
   * 恢复一个已有会话。返回值中包含 `configOptions`。
   *
   * @param {object} [options]
   * @param {string} [options.preset] 该会话原先使用的预设。
   *   需要携带该参数的原因：内核仅在「桌面端那种建会话方式」下将预设写入会话记录，
   *   经由 ACP 接入点创建的会话记录中没有 agentPreset（实测）。若未告知该插件，
   *   恢复后的 agent 将**不具备任何工具** —— 模型只能把工具调用写成文本
   *   （该症状已实测复现，见 test/presets.js 第 8 节）。
   *   该插件会按此处指定的预设（或它自身记录的预设）补挂。
   * @returns {Promise<object>} 内核的回复；该插件同样会在 `_meta['dsh-door']`
   *   中附加可用预设清单与当前使用的那一项。
   */
  resumeSession(sessionId, cwd, { preset } = {}) {
    const params = { sessionId, cwd, mcpServers: [] };
    if (typeof preset === 'string' && preset) {
      params._meta = { [PRESET_META_KEY]: { preset } };
    }
    return this.request('session/resume', params, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
  }

  /**
   * 内核自身的会话清单（ACP 的 `session/list`）。
   *
   * 数据形状为 `{sessionId, cwd}`，仅包含**已写入磁盘**的会话，且**不含**标题与时间
   * —— 因此无法用它实现「历史会话列表」界面（该界面需要标题、时间与回放）。
   * 历史会话应使用 {@link listHistory}。
   *
   * ⚠️ 该方法曾经名为 `listSessions()`，后来改为经由该插件的旁路方法，
   * 导致 `test/smoke.js` 中「验证 ACP session/list 形状」的断言实际验证的是另一件事
   * （注释未同步修改），插件版本较低时该断言即失败。当前两个方法名称已分离，各自独立，不应再合并。
   *
   * @returns {Promise<{sessions: Array<{sessionId: string, cwd?: string}>}>}
   */
  listKernelSessions() {
    return this.request('session/list', {});
  }

  /**
   * 列出历史会话（**该插件的旁路方法**，不是内核的 ACP 接口）。
   *
   * `dsh-door/sessions/list`：内核没有公开的「列历史」方法，会话文件位于磁盘上，
   * 由该插件读盘应答（需要该插件 0.0.8 及以上版本；较低版本会返回 -32601，
   * 上层应按「插件版本过低」翻译，或由上层自行读盘，见 `src/dsh/sessions.js`）。
   *
   * @returns {Promise<{sessions: object[], skipped: number}>}
   */
  listHistory() {
    return this.request('dsh-door/sessions/list', {});
  }

  /**
   * 读取一段历史会话的名片与回放（该插件的旁路方法）。
   *
   * @param {string} id 会话 id。
   * @returns {Promise<{card: object, entries: object[], truncated: boolean}>}
   */
  getHistory(id) {
    return this.request('dsh-door/sessions/get', { id });
  }

  /**
   * 读取接入点自身的版本、初始模型来源与可选能力（0.0.14+）。
   *
   * 这是只读诊断方法，不返回凭据。旧版接入点会按 JSON-RPC 规范返回 -32601，
   * 上层据此继续走兼容路径，不能把“没有这个方法”当成连接失败。
   */
  doorStatus() {
    return this.request('dsh-door/status', {});
  }

  /**
   * 读取当前会话的权限预设（**该插件的旁路方法**，需要该插件 0.0.12 及以上版本）。
   *
   * 经由该插件而不使用 ACP 的原因：ACP 只暴露「模型」「推理强度」两个 config option
   * （`session/set_config_option`），官方说明中写明它「刻意不提供 DSH 专用呈现
   * 数据与交互式 UI 功能」—— 权限预设选择器正属于该类功能。因此该插件将内核
   * `@deepseek-ai/dsh-permission-presets` 的清单与切换能力原样透出。
   * 较低版本的该插件（0.0.11 及以下）会返回 -32601，上层按「插件版本过低」翻译后展示给用户。
   *
   * @param {string} sessionId
   * @returns {Promise<{currentValue: string, options: Array<{value: string, name: string, description?: string}>, defaultPreset?: string}>}
   */
  permissionGet(sessionId) {
    return this.request('dsh-door/permission/get', { id: sessionId });
  }

  /**
   * 切换当前会话的权限预设（该插件的旁路方法）。
   *
   * @param {string} sessionId
   * @param {string} value 预设名（`read-only` / `workspace-write` / `auto-approval` /
   *   `danger-full-access` / …，清单以内核提供的为准）。
   * @returns {Promise<{currentValue: string, options: Array<object>}>} 切换后的实际状态。
   */
  permissionSet(sessionId, value) {
    return this.request('dsh-door/permission/set', { id: sessionId, value });
  }

  /** 关闭会话。 */
  closeSession(sessionId) {
    return this.request('session/close', { sessionId });
  }

  /**
   * 发送一条消息并执行完该回合。
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {object} [options]
   * @param {Array<object>} [options.attachments] 一并携带的编辑器上下文（当前文件/选中的代码）。
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{stopReason?: string}>}
   */
  prompt(sessionId, text, { attachments = [], signal } = {}) {
    return this.request(
      'session/prompt',
      { sessionId, prompt: buildPromptBlocks(text, attachments) },
      // 模型回合本身不设固定总时长；长任务可以正常运行。用户点击停止后，
      // 取消请求仍有 CANCEL_GRACE_MS 的收尾上限，防止对端不回取消结果时永久卡住。
      { signal, timeoutMs: 0, abortTimeoutMs: CANCEL_GRACE_MS },
    );
  }

  /** 按会话修改内核配置项（例如模型）。 */
  setConfigOption(sessionId, configId, value) {
    return this.request('session/set_config_option', { sessionId, configId, value });
  }

  // ── 内部 ────────────────────────────────────────────────────────

  #write(message) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error('尚未连接到 DSH。');
    socket.write(JSON.stringify(message) + '\n');
  }

  #onData(chunk) {
    this.#buffer += this.#decoder.write(chunk);
    // JSON 中不会出现未转义的换行（stringify 会转义），因此按行切分是安全的。
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.log('error', `收到无法解析的帧：${trimmed.slice(0, 400)}`);
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    // 1) 内核发来的请求（同时带 id 与 method）—— 需要回复，否则该请求会一直等待。
    if (message.method && message.id !== undefined) {
      this.#onAgentRequest(message);
      return;
    }
    // 2) 本客户端发出请求的响应。
    if (message.id !== undefined && !message.method) {
      const entry = this.#pending.get(message.id);
      if (!entry) {
        this.log('warn', `收到无对应请求的响应 id=${message.id}`);
        return;
      }
      this.#pending.delete(message.id);
      entry.cleanup();
      if (message.error) {
        entry.reject(
          new DoorRequestError(
            message.error.code,
            message.error.message || '内核返回错误',
            message.error.data,
          ),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // 3) 通知。
    if (message.method) {
      if (message.method === 'session/update') {
        const params = message.params || {};
        this.emit('update', params.sessionId, params.update);
      }
      this.emit('notification', message.method, message.params);
      return;
    }
    this.log('warn', `收到无法归类的一帧：${JSON.stringify(message).slice(0, 300)}`);
  }

  #onAgentRequest(message) {
    if (message.method === 'session/request_permission') {
      // 交由上层（面板）询问用户；上层需要最终调用 respond/respondError，
      // 否则该回合会一直阻塞。
      const listeners = this.listenerCount('permission');
      if (listeners === 0) {
        this.respond(message.id, { outcome: { outcome: 'cancelled' } });
        this.log('warn', '内核请求权限，但无处理者，已按「拒绝」回复');
        return;
      }
      this.emit('permission', message.id, message.params);
      return;
    }
    this.respondError(message.id, -32601, `本扩展尚不支持内核请求：${message.method}`);
    this.log('warn', `内核发来未支持的反向请求：${message.method}`);
  }

  #fail(error, { silent = false } = {}) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = error && error.message ? error.message : String(error);
    for (const entry of this.#pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.#pending.clear();
    if (!silent) this.log('warn', `连接结束：${this.#closeReason}`);
    this.emit('close', this.#closeReason);
  }
}

module.exports = {
  DoorClient,
  DoorRequestError,
  DoorTimeoutError,
  PROTOCOL_VERSION,
  PARSE_ERROR,
  PRESET_META_KEY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SESSION_REQUEST_TIMEOUT_MS,
  CANCEL_GRACE_MS,
  readDoorMeta,
};
