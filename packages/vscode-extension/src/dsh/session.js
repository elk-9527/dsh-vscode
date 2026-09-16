'use strict';

/**
 * 一个会话的完整状态机：连内核、建会话、跑回合、收流、改配置。
 *
 * 这个文件**刻意不依赖 vscode** —— 于是它能在命令行里被直接跑起来测试，
 * 不必开编辑器。面板只负责把这里的事件翻译成 webview 消息。
 *
 * 事件（都用 emit 往外发，面板按需转发）：
 *   'user'             {text}
 *   'assistant'        {id, ...}        助手消息开始
 *   'text'             {id, delta}      正文增量
 *   'thinking'         {id, delta}      思考增量
 *   'tool'             {id, tool}       工具卡片新增或更新（按 toolCallId 合并）
 *   'done'             {id, status}     助手消息结束
 *   'usage'            {used, size}
 *   'busy'             {busy}
 *   'config'           {configOptions}
 *   'permission'       {requestId, params}
 *   'error'            {message}
 *   'session'          {sessionId}
 */

const { EventEmitter } = require('node:events');
const { readDoorMeta } = require('../door/client');

/** 没有 sessionId 的会话——用一个稳定的哨兵，方便日志里一眼看出问题。 */
let nextId = 1;

class DshSession extends EventEmitter {
  /** @type {AbortController|null} 当前回合的中断控制器。 */
  #current = null;

  /**
   * @param {object} options
   * @param {import('../door/client').DoorClient} options.client 已握手的客户端。
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor({ client, log }) {
    super();
    this.client = client;
    this.log = log || (() => {});
    /** @type {string|null} */
    this.sessionId = null;
    /** @type {any[]} session/new 返回的配置项（模型清单在这里）。 */
    this.configOptions = [];
    /**
     * 门补的那份预设信息：`{presets, current, requested, fallback}`。
     *
     * 为什么会有这个东西：预设不是 ACP 的概念，是门（dsh-acp-door）替内核
     * 接出来的 —— 桌面端把工具改成「按会话挂预设」，而 ACP 建 agent 时从不点名
     * 预设，不补就是一个没有工具的 agent。见 dsh-acp-door 的 frames.js。
     * @type {{presets?: object[], current?: string, requested?: string, fallback?: boolean}|undefined}
     */
    this.doorMeta = undefined;
    /** @type {{used: number, size: number}|null} */
    this.usage = null;
    this.busy = false;
    /** @type {Map<string, object>} 本回合里的工具卡片，按 toolCallId 合并。 */
    this.tools = new Map();
    /** @type {Map<string, object>} 助手消息，按 id 索引。 */
    this.messages = new Map();

    this._onUpdate = (sessionId, update) => this._handleUpdate(sessionId, update);
    this.client.on('update', this._onUpdate);
    this._onClose = (reason) => this.emit('error', { message: `与 DSH 的连接断了：${reason}` });
    this.client.on('close', this._onClose);
  }

  /** 当前回合的中断控制器（私有字段拿不到，给面板读用）。 */
  get currentAbort() {
    return this.#current;
  }

  /**
   * 建立一个新会话。
   *
   * @param {object} options
   * @param {string} options.cwd 工作目录。
   * @param {string} [options.provider] 想要的模型服务商（可空）。
   * @param {string} [options.model] 想要的模型名（可空）。
   * @returns {Promise<string>} sessionId
   */
  async start({ cwd, provider, model, preset }) {
    const result = await this.client.newSession(cwd, { preset });
    if (!result || !result.sessionId) {
      throw new Error(`session/new 没有返回 sessionId：${JSON.stringify(result)}`);
    }
    this.sessionId = result.sessionId;
    this.configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    this.emit('session', { sessionId: this.sessionId });
    this.emit('config', { configOptions: this.configOptions });

    // 门会在回复里补一份「有哪些预设、这次用的哪个」（ACP 的 _meta 扩展点）。
    // 内核自己不给这份信息 —— 预设压根不是 ACP 的概念，是门替它接出来的。
    const doorMeta = readDoorMeta(result);
    if (doorMeta) {
      this.doorMeta = doorMeta;
      this.emit('presets', doorMeta);
    } else {
      this.doorMeta = undefined;
    }

    this.log(
      'info',
      `已建会话 ${this.sessionId}（cwd=${cwd}${doorMeta?.current ? `，预设=${doorMeta.current}` : ''}）`,
    );

    if (provider && model) {
      await this._applyModel(provider, model);
    }
    return this.sessionId;
  }

  /**
   * 恢复一个历史会话（内核实现了 session/resume）。
   *
   * @param {string} sessionId
   * @param {string} cwd
   * @param {object} [options]
   * @param {string} [options.preset] 这段会话本来用哪个预设。
   *   必须带上：内核不会把走门建的会话的预设记进会话记录，门只能靠客户端
   *   点名（或它自己记得的）来补挂 —— 不补，接回来的会话就没有工具。
   */
  async resume(sessionId, cwd, { preset } = {}) {
    const result = await this.client.resumeSession(sessionId, cwd, { preset });
    this.sessionId = sessionId;
    this.configOptions = Array.isArray(result && result.configOptions) ? result.configOptions : [];
    // 门在 resume 的回复里也会补一份预设清单，照 session/new 一样处理，
    // 免得重连之后面板上的「模式」下拉空着。
    const doorMeta = readDoorMeta(result);
    if (doorMeta) {
      this.doorMeta = doorMeta;
      this.emit('presets', doorMeta);
    }
    this.emit('session', { sessionId });
    this.emit('config', { configOptions: this.configOptions });
    this.log('info', `已恢复会话 ${sessionId}`);
    return sessionId;
  }

  /**
   * 发一条消息并跑完整个回合。
   *
   * @param {string} text
   * @param {object} [options]
   * @param {Array<object>} [options.attachments] 一起带上的编辑器上下文
   *   （当前文件 / 选中的代码），由 door/client.js 拼成 ACP 内容块。
   * @returns {Promise<{stopReason?: string}>}
   */
  async send(text, { attachments = [] } = {}) {
    if (!this.sessionId) throw new Error('还没有会话');
    if (this.busy) throw new Error('上一个回合还没结束');
    if ((!text || !text.trim()) && attachments.length === 0) return { stopReason: 'empty' };

    const id = `m${nextId++}`;
    const entry = { id, role: 'assistant', text: '', thinking: '', tools: [], status: 'running' };
    this.messages.set(id, entry);
    this.tools = new Map();

    // 界面上要能看出这条消息带了什么上下文 —— 带上清单，渲染时显示成附件。
    this.emit('user', { text, attachments });
    this.emit('assistant', { id });
    this.busy = true;
    this.emit('busy', { busy: true });

    const controller = new AbortController();
    this.#current = controller;

    try {
      const result = await this.client.prompt(this.sessionId, text, {
        attachments,
        signal: controller.signal,
      });
      const stopReason = result && result.stopReason ? result.stopReason : 'end_turn';
      entry.status = stopReason === 'cancelled' ? 'cancelled' : 'done';
      this.emit('done', { id, status: entry.status, stopReason });
      return { stopReason };
    } catch (error) {
      entry.status = 'error';
      const message = error && error.message ? error.message : String(error);
      this.emit('error', { message: `回合失败：${message}` });
      this.emit('done', { id, status: 'error', stopReason: 'error' });
      throw error;
    } finally {
      this.#current = null;
      this.busy = false;
      this.emit('busy', { busy: false });
    }
  }

  /** 请求中断当前回合。 */
  stop() {
    const controller = this.#current;
    if (!controller) {
      this.log('info', '当前没有正在跑的回合，忽略中断请求');
      return false;
    }
    controller.abort();
    return true;
  }

  /**
   * 按会话切换模型。
   *
   * @param {string} value `configOptions` 里那个 value 原样传回（它是 JSON 字符串）。
   */
  async setModel(value) {
    if (!this.sessionId) throw new Error('还没有会话');
    await this.client.setConfigOption(this.sessionId, 'model', value);
    // 内核回的当前值就是真值，直接记下来，别自己猜。
    this.configOptions = this.configOptions.map((option) =>
      option && option.id === 'model' ? { ...option, currentValue: value } : option,
    );
    this.emit('config', { configOptions: this.configOptions });
    this.log('info', `模型已切到 ${value}`);
  }

  /** 内核问权限时，替用户作答。 */
  answerPermission(requestId, optionId) {
    if (optionId) this.client.respond(requestId, { outcome: { outcome: 'selected', optionId } });
    else this.client.respond(requestId, { outcome: { outcome: 'cancelled' } });
  }

  dispose() {
    this.client.off('update', this._onUpdate);
    this.client.off('close', this._onClose);
    this.removeAllListeners();
  }

  // ── 内部 ────────────────────────────────────────────────────────

  async _applyModel(provider, model) {
    const option = this.configOptions.find((item) => item && item.id === 'model');
    if (!option) {
      this.log('warn', '内核没给 model 配置项，跳过模型设置');
      return;
    }
    const wanted = JSON.stringify([provider, model]);
    if (option.currentValue === wanted) return;
    const choices = flattenChoices(option);
    if (!choices.some((choice) => choice.value === wanted)) {
      this.log('warn', `模型 ${wanted} 不在内核给的可选清单里，保持原样`);
      return;
    }
    await this.setModel(wanted);
  }

  _handleUpdate(sessionId, update) {
    if (!update || sessionId !== this.sessionId) return;
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
      const delta = textOf(update.content);
      if (!delta) return;
      const entry = this._lastAssistant();
      if (!entry) return;
      entry.text += delta;
      this.emit('text', { id: entry.id, delta });
      return;
    }

    if (kind === 'agent_thought_chunk') {
      const delta = textOf(update.content);
      if (!delta) return;
      const entry = this._lastAssistant();
      if (!entry) return;
      entry.thinking += delta;
      this.emit('thinking', { id: entry.id, delta });
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const toolCallId = update.toolCallId || `anon-${this.tools.size}`;
      const existing = this.tools.get(toolCallId) || {
        toolCallId,
        title: '',
        kind: 'other',
        status: 'pending',
        rawInput: null,
        content: null,
      };
      // 内核会重复发同样的帧，所以这里必须幂等合并：只覆盖「有值」的字段。
      if (update.title) existing.title = update.title;
      if (update.kind) existing.kind = update.kind;
      if (update.status) existing.status = update.status;
      if (update.rawInput !== undefined && update.rawInput !== null) existing.rawInput = update.rawInput;
      if (update.content !== undefined && update.content !== null) existing.content = update.content;
      if (update.locations) existing.locations = update.locations;
      this.tools.set(toolCallId, existing);

      const entry = this._lastAssistant();
      if (entry && !entry.tools.includes(toolCallId)) entry.tools.push(toolCallId);
      this.emit('tool', { id: entry ? entry.id : null, tool: existing });
      return;
    }

    if (kind === 'usage_update') {
      const used = numberOr(update.used, update.tokens && update.tokens.used);
      const size = numberOr(update.size, update.contextWindow, update.tokens && update.tokens.size);
      if (used !== null || size !== null) {
        this.usage = {
          used: used === null ? (this.usage ? this.usage.used : 0) : used,
          size: size === null ? (this.usage ? this.usage.size : 0) : size,
        };
        this.emit('usage', this.usage);
      }
      return;
    }

    if (kind === 'available_commands_update') {
      this.availableCommands = Array.isArray(update.availableCommands)
        ? update.availableCommands
        : [];
      this.emit('commands', { availableCommands: this.availableCommands });
      return;
    }

    // 剩下的类型先记日志，别静默丢掉——将来加功能时知道有什么可用。
    this.log('info', `暂未处理的会话更新：${kind}`);
  }

  _lastAssistant() {
    const list = [...this.messages.values()];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'assistant') return list[i];
    }
    return null;
  }
}

/** 从 ACP 的 content block 里取纯文本。 */
function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

/** 把 configOptions 里可能是「分组」或「平铺」的选项拍平。 */
function flattenChoices(option) {
  const out = [];
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && Array.isArray(item.options)) {
        walk(item.options);
      } else if (item && typeof item.value === 'string') {
        out.push(item);
      }
    }
  };
  walk(option.options);
  return out;
}

function numberOr(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

module.exports = { DshSession, flattenChoices };
