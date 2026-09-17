'use strict';

/**
 * DSH「门」的 ACP 客户端。
 *
 * 为什么自己写而不用 @agentclientprotocol/sdk：
 * 1. 扩展零运行时依赖 —— 不用打包器、不用往 vsix 里塞 node_modules，
 *    出问题时能一路读到协议原文；
 * 2. ACP 本身很简单：一行一个 JSON（JSON-RPC 2.0），
 *    这里用到的方法就下面那几个，全部有实测抓包佐证。
 *
 * 协议流量走 TCP，日志走回调 —— 协议和日志绝不混在一起。
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');

const { buildPromptBlocks } = require('../dsh/blocks');

/** ACP 协议版本（第 0 步实测：内核回的就是 1）。 */
const PROTOCOL_VERSION = 1;

/** JSON-RPC 标准错误码。 */
const PARSE_ERROR = -32700;

/**
 * 门用的 `_meta` 键名 —— 与 `packages/dsh-door/lib/frames.js` 里的
 * `DOOR_META_KEY` 必须一致（test/static.js 会核对，改一边忘一边会被测出来）。
 *
 * 为什么用 `_meta` 而不是自己加一个 ACP 方法：`_meta` 是 ACP 官方预留的
 * 扩展点（schema 里就是 `z.record(z.string(), z.unknown())`），
 * 不认识它的实现会原样忽略，不会因为多了个字段就谈崩。
 */
const PRESET_META_KEY = 'dsh-door';

/**
 * 读出门在 `session/new` 回复里补的那份信息。
 *
 * @param {object} result 内核的回复对象
 * @returns {{presets?: object[], current?: string, requested?: string, fallback?: boolean}|undefined}
 *   没有这份信息（比如对面不是 DSH 的门）就返回 undefined。
 */
function readDoorMeta(result) {
  const meta = result && typeof result === 'object' ? result._meta : undefined;
  if (!meta || typeof meta !== 'object') return undefined;
  const info = meta[PRESET_META_KEY];
  return info && typeof info === 'object' ? info : undefined;
}

/**
 * 内核回的业务错误（例如 `agent-preset/locked`）。
 * `code` 是 JSON-RPC 数字码；`message` 里可能带内核自己的语义码。
 */
class DoorRequestError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'DoorRequestError';
    this.code = code;
    this.data = data;
  }
}

class DoorClient extends EventEmitter {
  #socket = null;
  #buffer = '';
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
    this.host = host;
    this.port = port;
    this.log = log || (() => {});
    /** 内核自报家门（initialize 的返回值）。 */
    this.agentInfo = null;
    /** 内核声明的能力。 */
    this.capabilities = null;
  }

  get isConnected() {
    return Boolean(this.#socket) && !this.#closed && !this.#socket.destroyed;
  }

  /**
   * 连上并完成 ACP 握手。
   *
   * @param {object} [options]
   * @param {number} [options.timeoutMs] 建连超时。
   * @returns {Promise<object>} initialize 的返回值。
   */
  async connect({ timeoutMs = 5000 } = {}) {
    if (this.#socket) throw new Error('已经连上了，不要重复连接');
    this.#closed = false;
    this.#closeReason = '';

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

    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    this.agentInfo = result && result.agentInfo ? result.agentInfo : null;
    this.capabilities = result && result.agentCapabilities ? result.agentCapabilities : null;
    if (result && result.protocolVersion !== PROTOCOL_VERSION) {
      this.log('warn', `协议版本不一致：内核 ${result.protocolVersion}，本扩展 ${PROTOCOL_VERSION}`);
    }
    this.log('info', `握手完成：${JSON.stringify(this.agentInfo)}`);
    return result;
  }

  /**
   * 发一个请求。
   *
   * @param {string} method
   * @param {unknown} params
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] 中止时发 `$/cancel_request`；
   *   注意**不**拒绝这个 promise —— 内核会回一个正常的 `stopReason: cancelled`。
   * @returns {Promise<any>}
   */
  request(method, params, { signal } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => this.cancel(id);
      const entry = {
        resolve,
        reject,
        cleanup: () => {
          if (signal) signal.removeEventListener('abort', onAbort);
        },
      };
      this.#pending.set(id, entry);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        entry.cleanup();
        reject(error);
      }
    });
  }

  /** 发一个通知（不需要回复）。 */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** 请求中断某个正在进行的请求（实测：`$/cancel_request` + `{ requestId }`）。 */
  cancel(requestId) {
    if (!this.isConnected) return;
    this.notify('$/cancel_request', { requestId });
    this.log('info', `已请求中断 #${requestId}`);
  }

  /** 回复一个内核发来的请求（目前只有 `session/request_permission`）。 */
  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  /** 回复一个内核发来的请求：失败。 */
  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  close() {
    const socket = this.#socket;
    this.#socket = null;
    this.#fail(new Error('客户端主动断开'), { silent: true });
    if (socket) socket.destroy();
  }

  // ── ACP 具体方法（都经过实测抓包核对）────────────────────────────

  /**
   * 新建会话。
   *
   * @param {string} cwd 会话的工作目录。
   * @param {object} [options]
   * @param {string} [options.preset] 想用的 agent preset（standard / ptc / minimal / cordis）。
   *   走 ACP 官方的 `_meta` 扩展点传给门（键名与 dsh-acp-door 的 lib/frames.js
   *   一致，test/static.js 会核对两边没跑偏）。
   *   注意：**预设只在新建会话时能选** —— 内核不允许会话开始之后再换
   *   （`agent-preset/locked`，实测），所以面板里换预设的语义是「下一段新对话用哪个」。
   * @returns {Promise<object>} 内核的回复（`sessionId`、`configOptions`），
   *   门还会在 `_meta['dsh-door']` 里补一份可用预设清单与实际用的那个。
   */
  newSession(cwd, { preset } = {}) {
    const params = { cwd, mcpServers: [] };
    if (typeof preset === 'string' && preset) {
      params._meta = { [PRESET_META_KEY]: { preset } };
    }
    return this.request('session/new', params);
  }

  /**
   * 恢复一个已有会话。返回值里有 `configOptions`。
   *
   * @param {object} [options]
   * @param {string} [options.preset] 这段会话本来用哪个预设。
   *   为什么要带上：内核只在「桌面端那种建会话方式」下把预设写进会话记录，
   *   走 ACP 门建的会话记录里没有 agentPreset（实测）。不告诉门一声，接回
   *   来的 agent 就是个**没有工具的空壳** —— 模型只能把工具调用当文本写出来
   *   （这个症状实测抓到过，见 test/presets.js 第 8 节）。
   *   门会按这里点名（或它自己记得的）补挂预设。
   * @returns {Promise<object>} 内核的回复；门同样会在 `_meta['dsh-door']`
   *   里补上可用预设清单与当前用的那个。
   */
  resumeSession(sessionId, cwd, { preset } = {}) {
    const params = { sessionId, cwd, mcpServers: [] };
    if (typeof preset === 'string' && preset) {
      params._meta = { [PRESET_META_KEY]: { preset } };
    }
    return this.request('session/resume', params);
  }

  /**
   * 列出历史会话。
   *
   * 走门的自定义方法（`dsh-door/sessions/list`）：内核没有公开的「列历史」
   * 方法，会话文件在本机磁盘上，门读盘应答（需要门 0.0.8+；旧门会回
   * -32601，上层要按「门太旧」翻译）。
   *
   * @returns {Promise<{sessions: object[], skipped: number}>}
   */
  listSessions() {
    return this.request('dsh-door/sessions/list', {});
  }

  /**
   * 取一段历史会话的名片与回放。
   *
   * @param {string} id 会话 id。
   * @returns {Promise<{card: object, entries: object[], truncated: boolean}>}
   */
  getHistorySession(id) {
    return this.request('dsh-door/sessions/get', { id });
  }

  /** 关闭会话。 */
  closeSession(sessionId) {
    return this.request('session/close', { sessionId });
  }

  /**
   * 发一条消息并跑完这个回合。
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {object} [options]
   * @param {Array<object>} [options.attachments] 一起带上的编辑器上下文（当前文件/选中的代码）。
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{stopReason?: string}>}
   */
  prompt(sessionId, text, { attachments = [], signal } = {}) {
    return this.request(
      'session/prompt',
      { sessionId, prompt: buildPromptBlocks(text, attachments) },
      { signal },
    );
  }

  /** 按会话改内核配置项（例如模型）。 */
  setConfigOption(sessionId, configId, value) {
    return this.request('session/set_config_option', { sessionId, configId, value });
  }

  // ── 内部 ────────────────────────────────────────────────────────

  #write(message) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error('还没有连上 DSH 的门');
    socket.write(JSON.stringify(message) + '\n');
  }

  #onData(chunk) {
    this.#buffer += chunk.toString('utf8');
    // JSON 里不会出现裸换行（stringify 会转义），所以按行切是安全的。
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
    // 1) 内核发来的请求（带 id 也有 method）—— 必须回复，否则它会一直等。
    if (message.method && message.id !== undefined) {
      this.#onAgentRequest(message);
      return;
    }
    // 2) 我们发出的请求的回应。
    if (message.id !== undefined && !message.method) {
      const entry = this.#pending.get(message.id);
      if (!entry) {
        this.log('warn', `收到无人认领的回应 id=${message.id}`);
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
      // 交给上层（面板）去问用户；上层必须最终调用 respond/respondError，
      // 否则这个回合会一直卡着。
      const listeners = this.listenerCount('permission');
      if (listeners === 0) {
        this.respond(message.id, { outcome: { outcome: 'cancelled' } });
        this.log('warn', '内核请求权限，但没人处理，已按「拒绝」回复');
        return;
      }
      this.emit('permission', message.id, message.params);
      return;
    }
    this.respondError(message.id, -32601, `本扩展还不支持内核请求：${message.method}`);
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

module.exports = { DoorClient, DoorRequestError, PROTOCOL_VERSION, PARSE_ERROR, PRESET_META_KEY, readDoorMeta };
