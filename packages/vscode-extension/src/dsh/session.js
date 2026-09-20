'use strict';

/**
 * 单个会话的完整状态机：连接内核、建立会话、执行回合、接收流、修改配置。
 *
 * 本文件**刻意不依赖 vscode** —— 因此可以在命令行中直接运行测试，
 * 不需要启动编辑器。面板仅负责将此处的事件转换为 webview 消息。
 *
 * 事件（均通过 emit 向外发送，面板按需转发）：
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

/** 会话 id 缺失时使用的稳定哨兵，便于在日志中直接识别问题。 */
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
    /** @type {any[]} session/new 返回的配置项（模型清单位于此处）。 */
    this.configOptions = [];
    /**
     * 该插件附加的预设信息：`{presets, current, requested, fallback}`。
     *
     * 存在该字段的原因：预设不是 ACP 的概念，而是由 ACP 接入点插件（dsh-acp-door）替内核
     * 接出的 —— 桌面端已将工具改为「按会话挂载预设」，而 ACP 创建 agent 时不指定
     * 预设，若不补充则得到一个没有工具的 agent。见 dsh-acp-door 的 frames.js。
     * @type {{presets?: object[], current?: string, requested?: string, fallback?: boolean}|undefined}
     */
    this.doorMeta = undefined;
    /** @type {{used: number, size: number}|null} */
    this.usage = null;
    this.busy = false;
    /** @type {Map<string, object>} 本回合中的工具卡片，按 toolCallId 合并。 */
    this.tools = new Map();
    /** @type {Map<string, object>} 助手消息，按 id 索引。 */
    this.messages = new Map();

    this._onUpdate = (sessionId, update) => this._handleUpdate(sessionId, update);
    this.client.on('update', this._onUpdate);
    this._onClose = (reason) => this.emit('error', { message: `与 DSH 的连接断了：${reason}` });
    this.client.on('close', this._onClose);
  }

  /** 当前回合的中断控制器（私有字段无法在外部访问，供面板读取）。 */
  get currentAbort() {
    return this.#current;
  }

  /**
   * 建立一个新的会话。
   *
   * @param {object} options
   * @param {string} options.cwd 工作目录。
   * @param {string} [options.provider] 指定的模型服务商（可为空）。
   * @param {string} [options.model] 指定的模型名（可为空）。
   * @returns {Promise<string>} sessionId
   */
  async start({ cwd, provider, model, preset }) {
    const result = await this.client.newSession(cwd, { preset });
    if (!result || !result.sessionId) {
      throw new Error(`session/new 未返回 sessionId：${JSON.stringify(result)}`);
    }
    this.sessionId = result.sessionId;
    this.configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    this.emit('session', { sessionId: this.sessionId });
    this.emit('config', { configOptions: this.configOptions });

    // 该插件会在回复中附加「可用预设清单与本次使用的预设」（ACP 的 _meta 扩展点）。
    // 内核本身不提供该信息 —— 预设不是 ACP 的概念，而是由该插件替内核接出的。
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
   * @param {string} [options.preset] 该会话原先使用的预设。
   *   需要携带：内核不会将经由接入点创建的会话的预设写入会话记录，该插件只能依据客户端
   *   指定（或自身记录的）值补挂 —— 不补充时，恢复后的会话不具备工具。
   */
  async resume(sessionId, cwd, { preset } = {}) {
    const result = await this.client.resumeSession(sessionId, cwd, { preset });
    this.sessionId = sessionId;
    this.configOptions = Array.isArray(result && result.configOptions) ? result.configOptions : [];
    // 该插件在 resume 的回复中同样会附加预设清单，处理方式与 session/new 一致，
    // 以避免重连后面板上的「模式」下拉框为空。
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
   * 发送一条消息并执行完整个回合。
   *
   * @param {string} text
   * @param {object} [options]
   * @param {Array<object>} [options.attachments] 一并携带的编辑器上下文
   *   （当前文件 / 选中的代码），由 door/client.js 组装为 ACP 内容块。
   * @returns {Promise<{stopReason?: string}>}
   */
  async send(text, { attachments = [] } = {}) {
    if (!this.sessionId) throw new Error('还没有会话');
    if (this.busy) throw new Error('上一个回合尚未结束');
    if ((!text || !text.trim()) && attachments.length === 0) return { stopReason: 'empty' };

    const id = `m${nextId++}`;
    const entry = { id, role: 'assistant', text: '', thinking: '', tools: [], status: 'running' };
    this.messages.set(id, entry);
    this.tools = new Map();

    // 界面需要显示该消息携带的上下文 —— 附带清单，渲染时显示为附件。
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
      this.log('info', '当前没有正在执行的回合，忽略中断请求');
      return false;
    }
    controller.abort();
    return true;
  }

  /**
   * 按会话切换模型。
   *
   * @param {string} value `configOptions` 中的 value 原样回传（该值为 JSON 字符串）。
   */
  async setModel(value) {
    if (!this.sessionId) throw new Error('还没有会话');
    const reply = await this.client.setConfigOption(this.sessionId, 'model', value);
    // 内核（dsh-acp 的 setSessionConfigOption）明确返回
    // `{configOptions: [...]}`，这是权威值 —— 内核可能将请求归一化为其他值，
    // 也可能同时修改其他项。此处原先的实现是将本地副本改为请求的值，
    // 相当于在内核未采纳时向用户展示错误状态（已发生过：注释中写明"不要自行推测"，
    // 而代码实际在推测）。当前以内核回复为准，仅在旧版内核不返回该字段时才退回本地修改。
    const options = reply && Array.isArray(reply.configOptions) ? reply.configOptions : null;
    if (options) {
      this.configOptions = options;
      const current = modelCurrentValue(this.configOptions);
      if (current && current !== value) {
        this.log('warn', `请求的模型为 ${value}，内核确定为 ${current}（以内核为准）`);
      }
    } else {
      this.configOptions = this.configOptions.map((option) =>
        option && option.id === 'model' ? { ...option, currentValue: value } : option,
      );
    }
    this.emit('config', { configOptions: this.configOptions });
    this.log('info', `模型已切换为 ${modelCurrentValue(this.configOptions) || value}`);
  }

  /** 内核请求权限时，代替用户作答。 */
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
      this.log('warn', '内核未提供 model 配置项，跳过模型设置');
      return;
    }
    const wanted = JSON.stringify([provider, model]);
    if (option.currentValue === wanted) return;
    const choices = flattenChoices(option);
    if (!choices.some((choice) => choice.value === wanted)) {
      this.log('warn', `模型 ${wanted} 不在内核提供的可选清单中，保持原样`);
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
      // 内核会重复发送相同的帧，因此此处采用幂等合并：仅覆盖「有值」的字段。
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

    // 其余类型先记录日志，不静默丢弃——以便后续扩展功能时了解可用类型。
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

/** 从 ACP 的 content block 中提取纯文本。 */
function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

/** 将 configOptions 中可能为「分组」或「平铺」的选项展开为一维列表。 */
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

/** 从（可能按嵌套分组的）configOptions 中读出 model 当前的 value。 */
function modelCurrentValue(options) {
  if (!Array.isArray(options)) return null;
  const found = options.find((option) => option && option.id === 'model');
  return found && typeof found.currentValue === 'string' ? found.currentValue : null;
}

function numberOr(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

module.exports = { DshSession, flattenChoices };
