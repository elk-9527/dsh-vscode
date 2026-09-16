/*
 * DSH Panel 的界面逻辑（跑在 webview 里）。
 *
 * 三条自我约束：
 * 1. 零依赖 —— 包括 Markdown 渲染，自己写一个够用的小子集，不引第三方库；
 * 2. 只做增量更新 —— 流式吐字时只改当前那条消息，绝不整体重绘；
 * 3. 用户滚上去看历史时，**不要**把他拽回底部（很多聊天界面在这里很烦人）。
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const el = {
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    configRow: document.getElementById('config-row'),
    modelSelect: document.getElementById('model-select'),
    presetField: document.getElementById('preset-field'),
    presetSelect: document.getElementById('preset-select'),
    newSession: document.getElementById('new-session'),
    messages: document.getElementById('messages'),
    empty: document.getElementById('empty'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    attachments: document.getElementById('attachments'),
    hint: document.getElementById('hint'),
    usageInline: document.getElementById('usage-inline'),
    meter: document.getElementById('meter'),
    meterFill: document.getElementById('meter-fill'),
    meterText: document.getElementById('meter-text'),
    permission: document.getElementById('permission'),
    permissionTitle: document.getElementById('permission-title'),
    permissionBody: document.getElementById('permission-body'),
    permissionActions: document.getElementById('permission-actions'),
  };

  const state = {
    /** @type {Map<string, object>} */
    messages: new Map(),
    busy: false,
    /** 用户是否贴在底部（决定要不要自动滚动）。 */
    pinned: true,
    configOptions: [],
    /** 门报过来的预设清单有没有内容（决定配置行要不要露出来）。 */
    hasPresets: false,
    /**
     * 挂着的编辑器上下文（当前文件 / 选中的代码），随下一条消息一起发出去。
     *
     * 这份清单由界面自己管：扩展只负责把编辑器里的东西送进来（`attach`），
     * 摘掉、清空都在本地完成 —— 不需要为这种事来回通信。
     * @type {Array<object>}
     */
    attachments: [],
  };

  /** entry → 'body' | 'think'，攒着待渲染的内容。 */
  const pendingRenders = new Map();
  let flushScheduled = false;

  // ── 与扩展通信 ──────────────────────────────────────

  function post(message) {
    vscode.postMessage(message);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    try {
      handle(message);
    } catch (error) {
      // 界面出错绝不能让消息循环停掉，否则后面全静默。
      showHint(`界面出错：${error && error.message ? error.message : error}`, true);
    }
  });

  function handle(message) {
    switch (message.type) {
      case 'status':
        setStatus(message.state, message.detail);
        break;
      case 'user':
        addUser(message.text, message.attachments);
        break;
      case 'assistant':
        addAssistant(message.id);
        break;
      case 'text':
        appendText(message.id, message.delta);
        break;
      case 'thinking':
        appendThinking(message.id, message.delta);
        break;
      case 'tool':
        upsertTool(message.id, message.tool);
        break;
      case 'done':
        finishAssistant(message.id, message.status);
        break;
      case 'usage':
        setUsage(message.used, message.size);
        break;
      case 'busy':
        setBusy(message.busy);
        break;
      case 'config':
        setConfig(message.configOptions || []);
        break;
      case 'presets':
        setPresets(message);
        break;
      case 'permission':
        showPermission(message);
        break;
      case 'error':
        addError(message.message);
        break;
      case 'notice':
        addNotice(message.text);
        break;
      case 'reset':
        resetTranscript();
        break;
      case 'attach':
        addAttachments(message.items);
        break;
      case 'hint':
        showHint(message.text, Boolean(message.error));
        break;
      default:
        break;
    }
  }

  // ── 顶部状态 ────────────────────────────────────────

  function setStatus(kind, detail) {
    const text = detail || '';
    el.statusDot.className = 'dot';
    if (kind === 'ready') {
      el.statusDot.classList.add('ok');
      el.statusText.textContent = text || '已连接';
    } else if (kind === 'busy') {
      el.statusDot.classList.add('busy');
      el.statusText.textContent = text || '工作中…';
    } else if (kind === 'error') {
      el.statusDot.classList.add('err');
      el.statusText.textContent = text || '出错了';
    } else {
      el.statusText.textContent = text || '正在连接…';
    }
    el.statusText.title = text;
    if (kind === 'ready' || kind === 'busy') syncConfigRow();
  }

  /** 配置行只在真有东西可调时才露出来（有模型下拉，或有模式下拉）。 */
  function syncConfigRow() {
    el.configRow.hidden = state.configOptions.length === 0 && !state.hasPresets;
  }

  function showHint(text, isError) {
    el.hint.textContent = text || '';
    el.hint.className = isError ? 'hint error' : 'hint';
  }

  function setBusy(busy) {
    state.busy = busy;
    el.send.hidden = busy;
    el.stop.hidden = !busy;
    el.input.disabled = false;
    if (!busy) el.input.focus();
  }

  // ── 转录区 ──────────────────────────────────────────

  function resetTranscript() {
    state.messages.clear();
    state.attachments = [];
    renderAttachments();
    el.messages.textContent = '';
    el.messages.appendChild(el.empty);
    el.empty.hidden = false;
    el.permission.hidden = true;
    el.meter.hidden = true;
    el.usageInline.textContent = '';
    state.pinned = true;
  }

  function atBottom() {
    const node = el.messages;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  }

  function scrollIfPinned() {
    if (state.pinned) el.messages.scrollTop = el.messages.scrollHeight;
  }

  el.messages.addEventListener('scroll', () => {
    state.pinned = atBottom();
  });

  function appendNode(node) {
    el.empty.hidden = true;
    el.messages.appendChild(node);
    scrollIfPinned();
  }

  function addUser(text, attachments) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // 这条消息带了哪些上下文，气泡里也要看得出 —— 否则回头看对话记录会莫名其妙。
    const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    if (list.length > 0) bubble.appendChild(chipRow(list, { removable: false }));
    if (text && text.trim()) {
      const body = document.createElement('div');
      body.className = 'bubble-text';
      body.textContent = text;
      bubble.appendChild(body);
    }
    wrap.appendChild(bubble);
    appendNode(wrap);
  }

  // ── 编辑器上下文（附件）──────────────────────────────

  /**
   * 挂上一批附件（扩展从编辑器那边送过来的）。
   *
   * 同名的（同一个文件/同一段选区）只留一个：连按两次"把当前文件带进来"，
   * 用户想要的是一个，不是两个。
   */
  function addAttachments(items) {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (list.length === 0) return;
    let added = 0;
    for (const item of list) {
      const id = item.id || item.uri || item.name;
      if (!id || state.attachments.some((held) => (held.id || held.uri || held.name) === id)) continue;
      state.attachments.push({ ...item, id });
      added += 1;
    }
    renderAttachments();
    if (added > 0) {
      el.input.focus();
      const last = state.attachments[state.attachments.length - 1];
      showHint(`已带上：${last.detail || last.name}`, false);
    }
  }

  function removeAttachment(id) {
    state.attachments = state.attachments.filter((item) => item.id !== id);
    renderAttachments();
  }

  function renderAttachments() {
    el.attachments.textContent = '';
    const list = state.attachments;
    // 用 hidden 属性控制显示，同时靠 CSS 里的 [hidden] 规则压住 display:flex ——
    // 这个坑踩过一次（空用量条常显），别再踩。
    el.attachments.hidden = list.length === 0;
    if (list.length === 0) return;
    el.attachments.appendChild(chipRow(list, { removable: true }));
  }

  /**
   * 做一排"上下文小块"。
   *
   * @param {Array<object>} list
   * @param {{removable: boolean}} options
   */
  function chipRow(list, options) {
    const row = document.createElement('div');
    row.className = 'chips';
    for (const item of list) {
      const chip = document.createElement('span');
      chip.className = `chip chip-${item.kind === 'selection' ? 'sel' : 'file'}`;
      chip.title = `${item.name || ''}${item.detail ? ` · ${item.detail}` : ''}`;

      const icon = document.createElement('span');
      icon.className = 'chip-icon';
      // 选区用一个"选中"的方块，文件用文件图标，一眼能分出这两类。
      icon.textContent = item.kind === 'selection' ? '❯' : '📄';
      icon.setAttribute('aria-hidden', 'true');
      chip.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = item.name || item.uri || '（未知）';
      chip.appendChild(label);

      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'chip-detail';
        detail.textContent = item.detail;
        chip.appendChild(detail);
      }

      if (options.removable) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'chip-close';
        close.title = '拿掉';
        close.setAttribute('aria-label', `拿掉 ${item.name || ''}`);
        close.textContent = '×';
        close.addEventListener('click', () => removeAttachment(item.id));
        chip.appendChild(close);
      }
      row.appendChild(chip);
    }
    return row;
  }

  function addAssistant(id) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.dataset.id = id;

    const thinking = document.createElement('details');
    thinking.className = 'thinking';
    thinking.hidden = true;
    const summary = document.createElement('summary');
    summary.textContent = '思考过程';
    const thinkBody = document.createElement('div');
    thinkBody.className = 'think-body';
    thinking.appendChild(summary);
    thinking.appendChild(thinkBody);

    const body = document.createElement('div');
    body.className = 'body';

    const tools = document.createElement('div');
    tools.className = 'tools';

    wrap.appendChild(thinking);
    wrap.appendChild(tools);
    wrap.appendChild(body);
    appendNode(wrap);

    state.messages.set(id, { node: wrap, body, thinking, thinkBody, tools, text: '', thinkText: '' });
  }

  function textMessage(id) {
    const entry = state.messages.get(id);
    if (entry) return entry;
    // 内核有可能在我们建好消息之前就吐字（极短的回合），兜一下。
    addAssistant(id);
    return state.messages.get(id);
  }

  function appendText(id, delta) {
    const entry = textMessage(id);
    entry.text += delta;
    scheduleRender(entry, 'body');
  }

  function appendThinking(id, delta) {
    const entry = textMessage(id);
    entry.thinkText += delta;
    entry.thinking.hidden = false;
    scheduleRender(entry, 'think');
  }

  /**
   * 攒到下一帧统一渲染：流式吐字时每个 chunk 都改 DOM 会卡。
   *
   * 这里必须**双重兜底**：正常情况用 requestAnimationFrame（跟屏幕刷新对齐，
   * 看着最顺滑），但面板被折叠或隐藏时浏览器会把 rAF 完全停掉 —— 只靠 rAF
   * 的话，后台跑完的回合会一直不显示，要等用户切回来看才补上。定时器兜住它。
   */
  function scheduleRender(entry, which) {
    pendingRenders.set(entry, which);
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flushRenders);
    setTimeout(flushRenders, 120);
  }

  function flushRenders() {
    if (pendingRenders.size === 0) {
      flushScheduled = false;
      return;
    }
    flushScheduled = false;
    for (const [entry, which] of pendingRenders) {
      // 已经收尾的条目不再补渲染，否则会把光标又画回去。
      if (entry.finished) continue;
      if (which === 'body') entry.body.innerHTML = renderMarkdown(entry.text) + caret();
      else if (which === 'think') entry.thinkBody.textContent = entry.thinkText;
    }
    pendingRenders.clear();
    scrollIfPinned();
  }

  function caret() {
    return '<span class="caret"></span>';
  }

  function finishAssistant(id, status) {
    const entry = state.messages.get(id);
    if (!entry) return;
    entry.finished = true;
    entry.body.innerHTML = renderMarkdown(entry.text);
    if (status === 'cancelled') {
      entry.node.appendChild(note('（已中断）'));
    } else if (status === 'error') {
      entry.node.appendChild(note('（回合失败）'));
    }
    scrollIfPinned();
  }

  function note(text) {
    const div = document.createElement('div');
    div.className = 'msg-note';
    div.textContent = text;
    return div;
  }

  function addError(text) {
    const div = document.createElement('div');
    div.className = 'msg msg-error';
    div.textContent = text;
    appendNode(div);
  }

  /**
   * 一条居中的系统提示。
   *
   * 用在「有事发生了但不算错误」的地方，最要紧的一处是：断线后上下文
   * 没能接回来时，必须让用户看见「上面那段它不记得了」—— 否则他会以为
   * 它还记着，然后为它的「失忆」困惑半天。
   */
  function addNotice(text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-system';
    wrapper.appendChild(note(text));
    appendNode(wrapper);
  }

  // ── 工具卡片 ────────────────────────────────────────

  function upsertTool(messageId, tool) {
    if (!tool || !tool.toolCallId) return;
    const entry = messageId ? state.messages.get(messageId) : null;
    const host = entry ? entry.tools : el.messages;

    let card = host.querySelector
      ? host.querySelector(`[data-tool="${cssEscape(tool.toolCallId)}"]`)
      : null;
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool';
      card.dataset.tool = tool.toolCallId;
      const head = document.createElement('div');
      head.className = 'tool-head';
      const name = document.createElement('span');
      name.className = 'tool-name';
      const title = document.createElement('span');
      title.className = 'tool-title';
      const status = document.createElement('span');
      status.className = 'tool-status';
      head.appendChild(name);
      head.appendChild(title);
      head.appendChild(status);
      const body = document.createElement('div');
      body.className = 'tool-body';
      body.hidden = true;
      head.addEventListener('click', () => {
        body.hidden = !body.hidden;
      });
      card.appendChild(head);
      card.appendChild(body);
      host.appendChild(card);
    }

    const name = card.querySelector('.tool-name');
    const title = card.querySelector('.tool-title');
    const statusEl = card.querySelector('.tool-status');
    const bodyEl = card.querySelector('.tool-body');

    name.textContent = toolName(tool);
    title.textContent = describeTool(tool);
    const statusInfo = statusOf(tool.status);
    statusEl.textContent = statusInfo.text;
    statusEl.className = `tool-status ${statusInfo.cls}`;
    bodyEl.innerHTML = renderToolBody(tool);

    // 工具跑完就自动展开一次，方便直接看到结果；用户手动收起来后就不再动它。
    if (!card.dataset.touched) {
      if (tool.status === 'completed' || tool.status === 'failed') bodyEl.hidden = false;
      card.querySelector('.tool-head').addEventListener('click', () => {
        card.dataset.touched = '1';
      });
    }
    scrollIfPinned();
  }

  function toolName(tool) {
    const input = tool.rawInput || {};
    if (typeof input.tool === 'string') return input.tool;
    if (typeof input.name === 'string') return input.name;
    if (typeof input.command === 'string') return 'shell';
    return tool.kind && tool.kind !== 'other' ? tool.kind : 'tool';
  }

  function describeTool(tool) {
    const input = tool.rawInput || {};
    const path = input.file_path || input.path || input.filePath;
    if (typeof path === 'string') {
      const short = path.length > 60 ? `…${path.slice(-58)}` : path;
      const extra = [];
      if (input.old_string !== undefined) extra.push('改动');
      if (input.command) extra.push(input.command.slice(0, 40));
      return extra.length ? `${short} · ${extra.join(' ')}` : short;
    }
    if (typeof input.command === 'string') return input.command.slice(0, 80);
    if (typeof input.pattern === 'string') return input.pattern;
    if (tool.title) return tool.title;
    return '';
  }

  function statusOf(status) {
    switch (status) {
      case 'completed':
        return { text: '完成', cls: 'completed' };
      case 'failed':
        return { text: '失败', cls: 'failed' };
      case 'in_progress':
        return { text: '进行中', cls: 'in_progress' };
      default:
        return { text: '等待中', cls: 'pending' };
    }
  }

  /** 把工具的输出（ACP 的 content 数组）拍成纯文本。 */
  function contentToText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) {
      if (typeof content.text === 'string') return content.text;
      return JSON.stringify(content, null, 2);
    }
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (typeof block.text === 'string') parts.push(block.text);
      else if (block.content && typeof block.content.text === 'string') parts.push(block.content.text);
      else if (block.type === 'diff') parts.push(typeof block.path === 'string' ? `--- ${block.path}` : '');
      else parts.push(JSON.stringify(block, null, 2));
    }
    return parts.filter(Boolean).join('\n');
  }

  function renderToolBody(tool) {
    const input = tool.rawInput || {};
    const chunks = [];

    // 编辑类工具：把 old/new 渲染成一个紧凑的差异视图。
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      chunks.push(renderDiff(input.old_string || '', input.new_string || ''));
    } else if (input && Object.keys(input).length) {
      chunks.push(`<div class="tool-args">${escapeHtml(JSON.stringify(input, null, 2))}</div>`);
    }

    const text = contentToText(tool.content);
    if (text) chunks.push(`<div class="tool-out">${escapeHtml(text)}</div>`);
    return chunks.join('') || '<span class="msg-note">（暂无输出）</span>';
  }

  /** 逐行差异：只标出「删掉的行」和「加上的行」，不做行内对齐（够用且快）。 */
  function renderDiff(oldText, newText) {
    const oldLines = oldText ? oldText.split('\n') : [];
    const newLines = newText ? newText.split('\n') : [];
    const rows = [];
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i += 1) {
      const before = oldLines[i];
      const after = newLines[i];
      if (before === after) {
        if (before !== undefined) rows.push(`<div class="diff-same">  ${escapeHtml(before)}</div>`);
        continue;
      }
      if (before !== undefined) rows.push(`<div class="diff-del">- ${escapeHtml(before)}</div>`);
      if (after !== undefined) rows.push(`<div class="diff-add">+ ${escapeHtml(after)}</div>`);
    }
    const body = rows.join('') || '<div class="diff-same">（空改动）</div>';
    return `<div class="tool-diff">${body}</div>`;
  }

  // ── 用量与配置 ──────────────────────────────────────

  function setUsage(used, size) {
    if (typeof used !== 'number' || typeof size !== 'number' || size <= 0) return;
    const pct = Math.max(0, Math.min(100, (used / size) * 100));
    el.meter.hidden = false;
    el.meterFill.style.width = `${pct.toFixed(1)}%`;
    el.meterText.textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
    el.meter.title = `上下文用量：${fmt(used)} / ${fmt(size)} tokens`;
    el.usageInline.textContent = `${fmt(used)} / ${fmt(size)}`;
  }

  function fmt(value) {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
    return String(value);
  }

  function setConfig(configOptions) {
    state.configOptions = configOptions;
    const model = configOptions.find((option) => option && option.id === 'model');
    if (!model) {
      syncConfigRow();
      return;
    }

    el.modelSelect.textContent = '';
    let matched = false;
    for (const group of model.options || []) {
      if (group && Array.isArray(group.options)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.name || group.group || '';
        for (const choice of group.options) {
          optgroup.appendChild(optionNode(choice, model.currentValue, () => (matched = true)));
        }
        el.modelSelect.appendChild(optgroup);
      } else if (group && typeof group.value === 'string') {
        el.modelSelect.appendChild(optionNode(group, model.currentValue, () => (matched = true)));
      }
    }
    if (!matched && model.currentValue) {
      const opt = document.createElement('option');
      opt.value = model.currentValue;
      opt.textContent = model.currentValue;
      opt.selected = true;
      el.modelSelect.appendChild(opt);
    }
    syncConfigRow();
  }

  /**
   * 渲染「模式」下拉（agent preset）。
   *
   * 这份清单不是扩展里写死的，是门问内核要来的（`agentPresets.list()`），
   * 所以你在 $DSH_HOME/.agent-presets/ 里自己写的预设也会出现在这里。
   * 换它的语义是「下一段新对话用哪个模式」—— 内核不允许一段对话中途换预设。
   */
  function setPresets(message) {
    const presets = Array.isArray(message.presets) ? message.presets : [];
    state.hasPresets = presets.length > 0;
    el.presetField.hidden = !state.hasPresets;
    if (state.hasPresets) {
      el.presetSelect.textContent = '';
      const current = message.current;
      let matched = false;
      for (const preset of presets) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.name || preset.id;
        if (preset.description) opt.title = preset.description;
        if (preset.id === current) {
          opt.selected = true;
          matched = true;
        }
        el.presetSelect.appendChild(opt);
      }
      // 当前用的那个不在清单里（比如清单刚被改过）也要显示出来，不能显示成别的。
      if (!matched && current) {
        const opt = document.createElement('option');
        opt.value = current;
        opt.textContent = current;
        opt.selected = true;
        el.presetSelect.appendChild(opt);
      }
    }
    syncConfigRow();
  }

  function optionNode(choice, current, onMatch) {
    const opt = document.createElement('option');
    opt.value = choice.value;
    opt.textContent = choice.name || choice.value;
    if (choice.description) opt.title = choice.description;
    if (choice.value === current) {
      opt.selected = true;
      onMatch();
    }
    return opt;
  }

  el.modelSelect.addEventListener('change', () => {
    post({ type: 'setModel', value: el.modelSelect.value });
  });

  el.presetSelect.addEventListener('change', () => {
    post({ type: 'setPreset', value: el.presetSelect.value });
  });

  // ── 权限询问 ────────────────────────────────────────

  function showPermission(message) {
    const params = message.params || {};
    const tool = params.toolCall || {};
    el.permissionTitle.textContent = tool.title || 'DSH 需要你的许可';
    el.permissionBody.textContent = tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : '';
    el.permissionActions.textContent = '';
    const options = Array.isArray(params.options) ? params.options : [];
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.name || option.optionId;
      button.addEventListener('click', () => {
        el.permission.hidden = true;
        post({ type: 'permission', requestId: message.requestId, optionId: option.optionId });
      });
      el.permissionActions.appendChild(button);
    }
    if (options.length === 0) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '拒绝';
      button.addEventListener('click', () => {
        el.permission.hidden = true;
        post({ type: 'permission', requestId: message.requestId, optionId: null });
      });
      el.permissionActions.appendChild(button);
    }
    el.permission.hidden = false;
  }

  // ── 输入 ────────────────────────────────────────────

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
  }

  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  function submit() {
    const text = el.input.value;
    const attachments = state.attachments.slice();
    // 只有上下文、没有文字也允许发：用户可能就是想说"看看这个"。
    if ((!text.trim() && attachments.length === 0) || state.busy) return;
    el.input.value = '';
    state.attachments = [];
    renderAttachments();
    autoGrow();
    showHint('');
    post({ type: 'send', text, attachments });
  }

  el.send.addEventListener('click', submit);
  el.stop.addEventListener('click', () => post({ type: 'stop' }));
  el.newSession.addEventListener('click', () => post({ type: 'newSession' }));

  // 点击链接交给扩展去开外部浏览器（webview 里点链接默认没反应）。
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[data-href]') : null;
    if (!anchor) return;
    event.preventDefault();
    post({ type: 'openLink', href: anchor.dataset.href });
  });

  // ── Markdown ────────────────────────────────────────
  //
  // 渲染器在 media/markdown.js 里，是纯函数、不碰 DOM —— 这样它能在 Node 里
  // 被单测（正确性、注入安全、真实耗时）。无头浏览器里按帧计时受虚拟时钟影响，
  // 量出来恒为 0，会掩盖真实的性能问题，所以那部分测试必须在 Node 里做。

  const markdown = window.DshMarkdown;
  if (!markdown) {
    // 脚本没加载上时要说人话，而不是让整个面板静默失效。
    document.getElementById('status-text').textContent = '界面脚本缺失：markdown.js 没加载';
  }
  const escapeHtml = markdown ? markdown.escapeHtml : (text) => String(text);
  const renderMarkdown = markdown ? markdown.renderMarkdown : (text) => escapeHtml(text);

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  // ── 启动 ────────────────────────────────────────────

  setBusy(false);
  autoGrow();
  post({ type: 'ready' });
})();
