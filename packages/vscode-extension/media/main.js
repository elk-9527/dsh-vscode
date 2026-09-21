/*
 * DSH Panel 的界面逻辑（运行于 webview 中）。
 *
 * 三条约束：
 * 1. 零依赖：包括 Markdown 渲染在内，只实现满足需要的小型子集，不引入第三方库；
 * 2. 只做增量更新：流式输出时只修改当前消息，不整体重绘；
 * 3. 用户向上滚动查看历史时，不得将其拉回底部。
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const el = {
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    barCwd: document.getElementById('bar-cwd'),
    barClock: document.getElementById('bar-clock'),
    historyBtn: document.getElementById('history-btn'),
    historyPanel: document.getElementById('history'),
    historyList: document.getElementById('history-list'),
    historyMeta: document.getElementById('history-meta'),
    historyClose: document.getElementById('history-close'),
    configRow: document.getElementById('config-row'),
    modelSelect: document.getElementById('model-select'),
    presetField: document.getElementById('preset-field'),
    presetSelect: document.getElementById('preset-select'),
    accessField: document.getElementById('access-field'),
    accessBtn: document.getElementById('access-btn'),
    accessPop: document.getElementById('access-pop'),
    accessPopNote: document.getElementById('access-pop-note'),
    accessList: document.getElementById('access-list'),
    accessConfirm: document.getElementById('access-confirm'),
    accessConfirmTitle: document.getElementById('access-confirm-title'),
    accessConfirmBody: document.getElementById('access-confirm-body'),
    accessConfirmAccept: document.getElementById('access-confirm-accept'),
    accessConfirmCancel: document.getElementById('access-confirm-cancel'),
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
    /** 用户是否停留在底部（决定是否自动滚动）。 */
    pinned: true,
    configOptions: [],
    /** 该插件提供的预设清单是否有内容（决定配置行是否显示）。 */
    hasPresets: false,
    /**
     * 权限相关数据是否有内容可显示（清单，或一句「为什么无法切换」）。
     *
     * 与 hasPresets 相同，仅用于决定配置行是否显示：无权限信息时不应在顶栏
     * 显示空的「权限」按钮。
     */
    hasPermission: false,
    /**
     * 当前权限与可选项（扩展侧已完成中文标签转换，见 src/dsh/permission.js）。
     * @type {{currentValue: string, options: Array<object>}|undefined}
     */
    permission: undefined,
    /**
     * 等待用户确认的选项（「完全权限」需先经过一次确认）。
     * @type {object|undefined}
     */
    pendingAccess: undefined,
    /**
     * 已挂载的编辑器上下文（当前文件 / 选中的代码），随下一条消息一并发送。
     *
     * 该清单由界面自身维护：扩展只负责将编辑器中的内容送入（`attach`），
     * 移除与清空均在本地完成，无需为此往返通信。
     * @type {Array<object>}
     */
    attachments: [],
  };

  /** entry → 'body' | 'think'，暂存待渲染的内容。 */
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
      // 界面出错不得中断消息循环，否则后续处理将全部静默失败。
      showHint(`界面出错：${error && error.message ? error.message : error}`, true);
    }
  });

  function handle(message) {
    switch (message.type) {
      case 'status':
        setStatus(message.state, message.detail);
        break;
      case 'meta':
        setWorkdir(message.cwd);
        break;
      case 'history':
        renderHistory(message);
        break;
      case 'replay':
        renderReplay(message);
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
      case 'permissionState':
        setPermissionState(message);
        break;
      case 'permission':
        showPermission(message);
        break;
      case 'permissionClear':
        hidePermission();
        break;
      case 'error':
        addError(message.message, message.human);
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

  /**
   * 顶栏状态只承载**短状态**：该行很窄，多出的字符会挤占其他内容。
   *
   * 此处设有防护：若有长文案进入 status（报错、多行诊断），
   * 也只显示第一行并截断至 24 个字符；完整内容保留在悬浮提示中，不丢失任何字符。
   * 报错本身应通过 `error` 消息进入对话流（对话流才是可阅读长文本的位置）。
   */
  function shortStatus(text) {
    const first = String(text || '').split('\n')[0].trim();
    if (first.length <= 24) return first;
    return first.slice(0, 23) + '…';
  }

  function setStatus(kind, detail) {
    const text = detail || '';
    el.statusDot.className = 'dot';
    if (kind === 'ready') {
      el.statusDot.classList.add('ok');
      el.statusText.textContent = shortStatus(text) || '就绪';
    } else if (kind === 'busy') {
      el.statusDot.classList.add('busy');
      el.statusText.textContent = shortStatus(text) || '正在处理…';
    } else if (kind === 'error') {
      el.statusDot.classList.add('err');
      el.statusText.textContent = shortStatus(text) || '未连接';
    } else {
      el.statusText.textContent = shortStatus(text) || '正在连接…';
    }
    el.statusText.title = text;
    if (kind === 'ready' || kind === 'busy') syncConfigRow();
  }

  /** 配置行仅在存在可调项（模型下拉，或模式/权限）时显示。 */
  function syncConfigRow() {
    el.configRow.hidden =
      state.configOptions.length === 0 && !state.hasPresets && !state.hasPermission;
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
    // 回合开始与结束驱动顶栏的时间戳与耗时显示。
    if (busy) startTurnClock();
    else stopTurnClock();
  }

  // ── 顶栏元信息：工作目录、回合时间戳/耗时 ─────────────

  /** 工作目录只显示末尾两段（过长的路径顶栏放不下），完整路径置于悬浮提示中。 */
  function setWorkdir(cwd) {
    if (!cwd || typeof cwd !== 'string') return;
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    const short = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd;
    el.barCwd.textContent = short;
    el.barCwd.title = cwd;
    el.barCwd.hidden = false;
  }

  let turnClockTimer = 0;

  /** 回合开始：记录起始时间，顶栏显示「开始时刻 · 已耗时」，每 200ms 刷新一次。 */
  function startTurnClock() {
    stopTurnClock();
    const started = Date.now();
    const tick = () => {
      el.barClock.textContent = `${hhmm(started)} · ${fmtDuration((Date.now() - started) / 1000)}`;
      el.barClock.title = `本回合开始于 ${hhmm(started)}，已耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`;
      el.barClock.hidden = false;
    };
    tick();
    turnClockTimer = setInterval(tick, 200);
  }

  /**
   * 停止计时。
   *
   * 回合正常结束时**保留**最后的显示内容：「本回合何时开始、耗时多久」
   * 在回看记录时有用；只有新建对话（reset）才清除该显示。
   */
  function stopTurnClock() {
    if (turnClockTimer) {
      clearInterval(turnClockTimer);
      turnClockTimer = 0;
    }
  }

  function hhmm(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDuration(seconds) {
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}分${String(Math.round(seconds % 60)).padStart(2, '0')}秒`;
  }

  // ── 历史会话 ────────────────────────────────────────

  /**
   * 打开/关闭历史浮层。打开时始终重新获取清单：会话记录随时变化，
   * 缓存会导致显示旧数据。
   *
   * 焦点需要随之移动：浮层覆盖整个面板，若打开后焦点仍停留在其下方**不可见**的
   * 控件上，使用键盘的用户按 Tab 会在不可见区域之间移动。因此打开时将焦点交给
   * 关闭按钮（浮层中第一个可操作元素），关闭时交回历史按钮；否则焦点会落到
   * body 上，用户将失去当前位置。
   */
  function toggleHistory(open) {
    const show = open === undefined ? el.historyPanel.hidden : open;
    // 隐藏前先记录焦点是否位于浮层内：元素一旦 hidden，焦点会自动落到 body，
    // 届时再查询将始终为 false。
    const focusWasInside = el.historyPanel.contains(document.activeElement);
    el.historyPanel.hidden = !show;
    el.historyBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      el.historyList.textContent = '';
      const loading = document.createElement('div');
      loading.className = 'history-empty';
      loading.textContent = '正在读取历史会话…';
      el.historyList.appendChild(loading);
      el.historyMeta.textContent = '';
      el.historyClose.focus();
      post({ type: 'historyList' });
      return;
    }
    if (focusWasInside) el.historyBtn.focus();
  }

  /** 会话时间显示：当年的仅显示「月-日 时:分」，非当年的附带年份。 */
  function fmtSessionTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const hm = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.getFullYear() === now.getFullYear() ? hm : `${d.getFullYear()}-${hm}`;
  }

  /** 工作目录只保留末尾一段，在列表中足以辨认。 */
  function tailPath(cwd) {
    if (typeof cwd !== 'string' || !cwd) return '';
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cwd;
  }

  /**
   * 渲染历史清单（或错误 —— 插件版本过低、读盘失败均需在此层说明）。
   */
  function renderHistory(message) {
    if (el.historyPanel.hidden) return; // 用户已关闭，不再重新展开浮层
    el.historyList.textContent = '';
    if (message.error) {
      // 读取失败**不使用** .history-empty：该套居中灰字表达「此处无内容」，
      // 用于报错会被理解为「没有历史会话」，而这两种情况的处理方式完全不同。
      const box = document.createElement('div');
      box.className = 'history-error';
      box.setAttribute('role', 'alert');
      box.textContent = message.error;
      el.historyList.appendChild(box);
      return;
    }
    const sessions = Array.isArray(message.sessions) ? message.sessions : [];
    if (message.skipped > 0) {
      el.historyMeta.textContent = `最近 ${sessions.length} 段（更早的 ${message.skipped} 段未列出）`;
    } else {
      el.historyMeta.textContent = sessions.length ? `共 ${sessions.length} 段` : '';
    }
    if (sessions.length === 0) {
      const box = document.createElement('div');
      box.className = 'history-empty';
      box.textContent = '暂无历史会话。';
      el.historyList.appendChild(box);
      return;
    }
    for (const card of sessions) {
      el.historyList.appendChild(historyItem(card));
    }
  }

  function historyItem(card) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const main = document.createElement('div');
    main.className = 'history-item-main';
    const title = document.createElement('p');
    title.className = 'history-item-title';
    title.textContent = card.title || card.fallbackTitle || '（无标题）';
    title.title = title.textContent;
    const sub = document.createElement('p');
    sub.className = 'history-item-sub';
    const when = fmtSessionTime(card.lastTime || card.mtime);
    const bits = [
      when,
      `${card.turns || 0} 回合`,
      tailPath(card.cwd),
      card.preset && card.preset !== 'standard' ? card.preset : '',
    ].filter(Boolean);
    sub.textContent = bits.join(' · ');
    if (card.decodeError) sub.title = card.decodeError;
    main.appendChild(title);
    main.appendChild(sub);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'history-item-actions';
    const replayBtn = document.createElement('button');
    replayBtn.type = 'button';
    replayBtn.textContent = '回放';
    replayBtn.title = '查看这段对话的内容（不接回上下文）';
    replayBtn.addEventListener('click', () => {
      post({ type: 'historyOpen', id: card.id });
    });
    actions.appendChild(replayBtn);
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.textContent = '接回';
    resumeBtn.title = '回放这段对话，并尝试接回上下文继续对话';
    resumeBtn.addEventListener('click', () => {
      post({ type: 'historyResume', id: card.id });
    });
    actions.appendChild(resumeBtn);
    row.appendChild(actions);
    return row;
  }

  /**
   * 渲染回放：按当时的内容重建转录（用户消息、助手回答、工具卡片）。
   *
   * 工具卡片复用 upsertTool：默认折叠、展开后显示详情，与实时对话一致。
   * 回放为静态内容：没有流式光标，也没有动画，可直接识别为历史内容。
   *
   * 两处有意设定的顺序：
   * - **「这是回放」一句置于开头**，而非结尾。它用于防止一种实际会发生的情况：
   *   用户直接对历史内容输入，误以为在与该段上下文对话。置于结尾则需要先滚动
   *   到底部才能看到，而该提示越早出现越好；它同时也是这份转录的标题。
   * - **停留在开头**，不滚动到底部。回放用于阅读，阅读顺序自第一句开始；
   *   停在底部等同于从最后一句倒序阅读。只有实时对话才需要跟随到底部。
   */
  function renderReplay(message) {
    toggleHistory(false);
    state.messages.clear();
    el.messages.textContent = '';
    el.permission.hidden = true;
    el.empty.hidden = true;
    // 不复用 scrollToBottom：该函数会将 pinned 设为 true 并滚动到底部。
    state.pinned = false;

    const card = message.card || {};
    const when = fmtSessionTime(card.lastTime || card.mtime);
    const head = `历史回放：${card.title || card.fallbackTitle || '（无标题）'}${when ? `（${when}）` : ''}`;
    addNotice(truncatedReplayNote(head, message.truncated === true));

    const entries = Array.isArray(message.entries) ? message.entries : [];
    let lastAssistantId;
    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i];
      if (item.kind === 'user') {
        addUser(item.text);
        continue;
      }
      if (item.kind === 'assistant') {
        lastAssistantId = `replay-a${i}`;
        addAssistant(lastAssistantId);
        const entry = state.messages.get(lastAssistantId);
        entry.text = item.text || '';
        if (item.thinking) {
          entry.thinking.hidden = false;
          entry.thinkBody.textContent = item.thinking;
        }
        finishAssistant(lastAssistantId);
        continue;
      }
      if (item.kind === 'tool') {
        // 挂到最近一条助手消息内（与实时对话结构一致：工具是回答的一部分），
        // 而非平铺在消息区顶层，否则消息间距会大小不一。
        if (state.messages.has(lastAssistantId)) {
          upsertTool(lastAssistantId, {
            toolCallId: `replay-t${i}`,
            kind: 'other',
            // 工具名在该插件提供的条目中是独立字段（不在 args 内），
            // 而 toolName 只识别 rawInput.tool / rawInput.name，因此在此合并。
            rawInput: { tool: item.name, ...(item.args && typeof item.args === 'object' ? item.args : {}) },
            content: item.output ? [{ type: 'text', text: item.output }] : [],
            status: 'completed',
          });
        }
      }
    }

    el.messages.scrollTop = 0;
    // 焦点移至转录区（该元素 tabindex=0）：后续按 Tab 从第一段内容开始，
    // 而非从面板顶栏的历史按钮开始。preventScroll 用于保持上述「停留在开头」。
    try {
      el.messages.focus({ preventScroll: true });
      el.messages.scrollTop = 0;
    } catch {
      el.messages.focus();
    }
  }

  function truncatedReplayNote(head, truncated) {
    return truncated
      ? `${head}。该转录过长，仅回放了靠前的部分 —— 以下为回放内容，非实时对话。`
      : `${head}。以下为回放内容，非实时对话；在此输入不会接入该段上下文。`;
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
    // 新建对话即新的开始，上一回合的「开始时刻 · 耗时」不再具有意义。
    stopTurnClock();
    el.barClock.hidden = true;
    state.pinned = true;
  }

  function atBottom() {
    const node = el.messages;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  }

  function scrollIfPinned() {
    if (state.pinned) el.messages.scrollTop = el.messages.scrollHeight;
  }

  /**
   * 无条件滚动到底部 —— 仅用于「用户刚刚执行了操作」的位置。
   *
   * 需要该函数的原因：若用户正在向上翻阅记录，然后自行发送一条消息，
   * 仅靠 scrollIfPinned **不会**跟随到底部（此时 pinned 已为 false），
   * 结果是既看不到刚发送的消息，也看不到回答的开始，需要再次手动滚动到底部。
   * 这是用户自身的操作，因此需要跟随。助手自身的输出仍遵守「不将用户拉回底部」。
   */
  function scrollToBottom() {
    state.pinned = true;
    el.messages.scrollTop = el.messages.scrollHeight;
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
    // 该消息携带了哪些上下文需在气泡中可见，否则回看对话记录时无法判断。
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
    // 用户自身发送的消息，视图一定跟随到底部（见上文 scrollToBottom 的说明）。
    scrollToBottom();
  }

  // ── 编辑器上下文（附件）──────────────────────────────

  /**
   * 挂载一批附件（由扩展从编辑器侧送入）。
   *
   * 同名项（同一文件/同一段选区）只保留一个；再次挂载时用新内容替换旧内容。
   * 后者对未保存文件很重要：用户修改后再次执行「把当前文件带进来」，发送的必须是
   * 最新编辑器快照，而不是第一次挂载时的旧正文。
   */
  function addAttachments(items) {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (list.length === 0) return;
    let changed = 0;
    let lastChanged;
    for (const item of list) {
      const id = item.id || item.uri || item.name;
      if (!id) continue;
      const next = { ...item, id };
      const at = state.attachments.findIndex((held) => (held.id || held.uri || held.name) === id);
      if (at >= 0) state.attachments[at] = next;
      else state.attachments.push(next);
      changed += 1;
      lastChanged = next;
    }
    renderAttachments();
    if (changed > 0) {
      el.input.focus();
      showHint(`已附加：${lastChanged.detail || lastChanged.name}`, false);
    }
  }

  function removeAttachment(id) {
    state.attachments = state.attachments.filter((item) => item.id !== id);
    renderAttachments();
  }

  function renderAttachments() {
    el.attachments.textContent = '';
    const list = state.attachments;
    // 使用 hidden 属性控制显示，并依靠 CSS 中的 [hidden] 规则覆盖 display:flex：
    // 该问题曾出现过一次（空的用量条常显），不应重复。
    el.attachments.hidden = list.length === 0;
    if (list.length === 0) return;
    el.attachments.appendChild(chipRow(list, { removable: true }));
  }

  /**
   * 生成一排「上下文小块」。
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
      // 选区使用「选中」方块，文件使用文件图标，可直接区分这两类。
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
        close.title = '移除';
        close.setAttribute('aria-label', `移除 ${item.name || ''}`);
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
    // 内核可能在消息建立之前就开始输出（极短回合），因此在此回退。
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
   * 累积到下一帧统一渲染：流式输出时逐个 chunk 修改 DOM 会造成卡顿。
   *
   * 此处需要**双重后备**：正常情况下使用 requestAnimationFrame（与屏幕刷新对齐，
   * 显示最平滑），但面板被折叠或隐藏时浏览器会完全停止 rAF；
   * 仅依赖 rAF 时，后台完成的回合将一直不显示，直到用户切回才补上。
   * 因此由定时器作为后备。
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
      // 已结束的条目不再补充渲染，否则会重新绘制光标。
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

  /**
   * 显示一条错误。
   *
   * `human` 是扩展侧生成的用户可读说明（`src/dsh/errors.js`）：一句说明发生了什么，
   * 一句说明可以做什么。**内核原文始终跟随其后显示**，不删除任何字符：
   * 说明用于让用户直接理解，而非让信息消失；无法识别的错误更只能依靠原文。
   *
   * `human` 缺失时（例如消息来自其他来源）退回为只显示原文，行为与之前一致。
   */
  function addError(text, human) {
    const div = document.createElement('div');
    div.className = 'msg msg-error';
    if (!human || !human.title) {
      // 无法识别的错误：原文即为全部信息，直接展开显示，不放入折叠区。
      div.textContent = text;
      appendNode(div);
      return;
    }
    const title = document.createElement('p');
    title.className = 'err-title';
    title.textContent = human.title;
    div.appendChild(title);
    if (human.advice) {
      const advice = document.createElement('p');
      advice.className = 'err-advice';
      advice.textContent = human.advice;
      div.appendChild(advice);
    }
    const rawText = text || human.raw || '';
    const raw = document.createElement('pre');
    raw.className = 'err-raw';
    raw.textContent = rawText;
    // 说明已包含「发生了什么 + 如何处理」时，内核原文收进折叠区：
    // 它通常是数十行 JSON，展开会使对话框等同于日志窗口。
    // **未删除任何字符** —— 展开即为原文，复制也使用它。
    if (rawText && rawText.length > 120) {
      const fold = document.createElement('details');
      fold.className = 'err-raw-fold';
      const summary = document.createElement('summary');
      summary.textContent = '原始报错（展开）';
      fold.appendChild(summary);
      fold.appendChild(raw);
      div.appendChild(fold);
    } else if (rawText) {
      div.appendChild(raw);
    }
    appendNode(div);
  }

  /**
   * 一条居中的系统提示。
   *
   * 用于「发生了事件但不属于错误」的场景，其中最重要的一处是：断线后上下文未能
   * 接回时，必须让用户看到「上文内容已不被记住」的提示，否则用户会认为上下文
   * 仍然保留，并对后续行为产生困惑。
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
      head.setAttribute('aria-expanded', 'false');
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
      // 折叠动画外包裹一层 grid（见 main.css 中 .tool-fold 的说明）。
      const fold = document.createElement('div');
      fold.className = 'tool-fold';
      fold.appendChild(body);
      head.addEventListener('click', () => {
        const open = card.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      card.appendChild(head);
      card.appendChild(fold);
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

  /** 将工具输出（ACP 的 content 数组）转换为纯文本。 */
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

    // 编辑类工具：将 old/new 渲染为紧凑的差异视图。
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      chunks.push(renderDiff(input.old_string || '', input.new_string || ''));
    } else if (input && Object.keys(input).length) {
      chunks.push(`<div class="tool-args">${escapeHtml(JSON.stringify(input, null, 2))}</div>`);
    }

    const text = contentToText(tool.content);
    if (text) chunks.push(`<div class="tool-out">${escapeHtml(text)}</div>`);
    return chunks.join('') || '<span class="msg-note">（暂无输出）</span>';
  }

  /** 逐行差异：只标注「删除的行」与「新增的行」，不做行内对齐（满足需要且开销低）。 */
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
   * 渲染「模式」下拉框（agent preset）。
   *
   * 该清单并非在扩展中写死，而是由该插件向内核获取（`agentPresets.list()`），
   * 因此用户在 $DSH_HOME/.agent-presets/ 中自行编写的预设也会出现在此处。
   * 该项的语义是「下一段新对话使用哪个模式」：内核不允许在对话进行中更换预设。
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
      // 当前使用的项不在清单中时（例如清单刚被修改）也需显示，不得显示为其他项。
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

  // ── 权限选择器 ──────────────────────────────────────

  /**
   * 权限相关的新状态（清单 + 当前值，或一句「为什么无法切换」）。
   *
   * 关键一条：**清单并非写死**，而是由内核提供（该插件 0.0.12 转出）。
   * 因此用户安装 Auto Approval 等插件，或在档中添加预设后，此处会随之增加，
   * 与桌面端使用同一数据源。
   */
  function setPermissionState(message) {
    if (message.unavailable) {
      state.permission = undefined;
      state.permissionUnavailable = message.unavailable;
      state.hasPermission = true;
      closeAccessPop();
      const why = shortAccessReason(message.unavailable.state);
      // 顶栏该区域较窄（相邻还有模型、模式、用量），早期的「不可切换（门过旧）」
      // 会被截断，因此只写入「不可切换」：原因置于悬浮提示与对话流中（内容完整）。
      el.accessBtn.textContent = '不可切换';
      el.accessBtn.dataset.why = why;
      el.accessBtn.title = accessTitle(message.unavailable);
      el.accessBtn.disabled = true;
      el.accessField.hidden = false;
      syncConfigRow();
      return;
    }
    const options = Array.isArray(message.options) ? message.options : [];
    if (!message.currentValue && options.length === 0) {
      // 内核未提供任何权限信息（例如该插件没有该服务）：不显示空按钮。
      state.permission = undefined;
      state.permissionUnavailable = undefined;
      state.hasPermission = false;
      closeAccessPop();
      el.accessField.hidden = true;
      syncConfigRow();
      return;
    }
    state.permission = {
      currentValue: message.currentValue,
      options,
      defaultPreset: message.defaultPreset,
    };
    state.permissionUnavailable = undefined;
    state.hasPermission = true;
    el.accessField.hidden = false;
    el.accessBtn.disabled = false;
    el.accessBtn.textContent = message.label || message.currentValue || '权限';
    el.accessBtn.title = `当前权限：${message.label || message.currentValue}`;
    if (!el.accessPop.hidden) renderAccessList();
    syncConfigRow();
  }

  /**
   * 无法切换的原因，压缩为几个字。
   *
   * 注意：**不再写在按钮上**（该处仅容得下约 4 个字，写入即被截断），
   * 而是记录在 `data-why` 上供测试读取；用户通过悬浮提示与对话流查看完整说明。
   * 这几个字同样不得出现「门」「档」等内部词（用户曾提出意见）。
   */
  function shortAccessReason(kind) {
    if (kind === 'old-door') return '版本过低';
    if (kind === 'no-service') return '缺少权限设置';
    // 会话本身已不存在（例如位于其他内核上，或已被关闭）：更换选项无效，
    // 需要重新开启一段；因此该项不得与「无法读取」合并为同一句。
    if (kind === 'no-session') return '会话不存在';
    return '无法读取';
  }

  function accessTitle(info) {
    return info && info.detail ? `${info.text}\n${info.detail}` : (info && info.text) || '';
  }

  /** 渲染可选项（每项包含名称与一行说明，当前项带勾选标记）。 */
  function renderAccessList() {
    const permission = state.permission;
    el.accessList.textContent = '';
    el.accessConfirm.hidden = true;
    state.pendingAccess = undefined;
    if (!permission) return;
    const options = permission.options;
    // 「共 N 种」只统计**可切换的项**：内核会把 custom（当前沙箱与批准设置
    // 不匹配任何预设）作为展示项附在清单末尾，计入后会显示「共 4 种」，
    // 而实际仅有 3 种可点。
    const selectable = options.filter((option) => option.selectable !== false);
    el.accessPopNote.textContent = selectable.length > 1 ? `共 ${selectable.length} 种` : '';
    let active = undefined;
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = option.active ? 'access-item active' : 'access-item';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', option.active ? 'true' : 'false');
      button.dataset.value = option.value;
      const name = document.createElement('span');
      name.className = 'access-item-name';
      name.textContent = option.label;
      button.appendChild(name);
      if (option.description) {
        const desc = document.createElement('span');
        desc.className = 'access-item-desc';
        desc.textContent = option.description;
        button.appendChild(desc);
      }
      /*
       * 展示项（由扩展给出 selectable === false，目前仅内核的 custom）：
       * 可用于显示「当前不在任何预设上」，但它**不是可切换的目标**：内核的
       * resolve() 对它直接抛出异常。因此不为其绑定点击处理，并置为禁用状态。
       *
       * 判据是「明确为 false」而非「未标记为 true」：旧版扩展不发送该字段，
       * 此时必须仍按可选项处理。
       */
      if (option.selectable === false) {
        button.disabled = true;
        button.dataset.displayOnly = 'true';
        button.title = '当前不匹配任何预设，无法切换到该项';
      } else {
        button.addEventListener('click', () => chooseAccess(option));
      }
      el.accessList.appendChild(button);
      if (option.active) active = button;
    }
    // 无法匹配的当前值（例如清单被修改）也需显示，不得让用户误认为未选择。
    if (!active && permission.currentValue) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'access-item active';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'true');
      const name = document.createElement('span');
      name.className = 'access-item-name';
      name.textContent = permission.currentValue;
      button.appendChild(name);
      button.disabled = true;
      el.accessList.appendChild(button);
    }
  }

  /**
   * 选中一项。
   *
   * 「完全权限」需要经过确认（文案由扩展提供，见 src/dsh/permission.js 的 CONFIRM）：
   * 该档位会使智能体不再逐条请求确认，误操作代价较大，因此增加一步确认。
   */
  function chooseAccess(option) {
    /*
     * 展示项一律不得发送。渲染层已不为其绑定监听，此处防范其他入口：
     * 键盘激活、使用陈旧的 DOM 节点再次点击，以及后续新增展示项时遗漏渲染分支。
     *
     * 此处**无法阻止**「扩展为新版本、webview 仍为旧 bundle」的混搭
     * （两份产物来自同一版本，混搭需通过重载窗口消除）；反方向是安全的：
     * 旧扩展不发送 selectable，新 webview 仍按可选项处理，行为与之前一致。
     */
    if (!option || option.selectable === false) return;
    if (option.needsConfirm && option.confirm) {
      state.pendingAccess = option;
      el.accessList.hidden = true;
      el.accessConfirm.hidden = false;
      el.accessConfirmTitle.textContent = option.confirm.title;
      el.accessConfirmBody.textContent = option.confirm.body;
      el.accessConfirmAccept.textContent = option.confirm.accept;
      el.accessConfirmCancel.textContent = option.confirm.cancel || '取消';
      el.accessConfirmAccept.focus();
      positionAccessPop();
      return;
    }
    post({ type: 'setPermission', value: option.value });
    closeAccessPop();
  }

  function openAccessPop() {
    if (el.accessBtn.disabled) return;
    renderAccessList();
    el.accessList.hidden = false;
    el.accessPop.hidden = false;
    el.accessBtn.setAttribute('aria-expanded', 'true');
    positionAccessPop();
    const first = el.accessList.querySelector('button');
    if (first) first.focus();
  }

  function closeAccessPop() {
    if (el.accessPop.hidden) return;
    el.accessPop.hidden = true;
    el.accessList.hidden = false;
    el.accessConfirm.hidden = true;
    state.pendingAccess = undefined;
    el.accessBtn.setAttribute('aria-expanded', 'false');
  }

  /** 小卡片紧邻该按钮定位；下方空间不足时翻转到上方（侧边栏高度紧张）。 */
  function positionAccessPop() {
    const rect = el.accessBtn.getBoundingClientRect();
    const width = el.accessPop.offsetWidth;
    const gap = 4;
    const left = Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap));
    el.accessPop.style.left = `${left}px`;
    const height = el.accessPop.offsetHeight;
    const below = rect.bottom + gap;
    if (below + height > window.innerHeight - gap && rect.top - gap - height > gap) {
      el.accessPop.style.top = `${rect.top - gap - height}px`;
    } else {
      el.accessPop.style.top = `${below}px`;
    }
  }

  el.accessBtn.addEventListener('click', () => {
    if (el.accessPop.hidden) openAccessPop();
    else closeAccessPop();
  });

  el.accessConfirmAccept.addEventListener('click', () => {
    const option = state.pendingAccess;
    if (!option) return;
    post({ type: 'setPermission', value: option.value });
    closeAccessPop();
  });

  el.accessConfirmCancel.addEventListener('click', () => {
    el.accessConfirm.hidden = true;
    el.accessList.hidden = false;
    state.pendingAccess = undefined;
    positionAccessPop();
    const first = el.accessList.querySelector('button');
    if (first) first.focus();
  });

  // 点击其他位置 / Esc 关闭：这两种方式已被普遍使用，不能只支持点击按钮关闭。
  document.addEventListener('mousedown', (event) => {
    if (el.accessPop.hidden) return;
    if (el.accessPop.contains(event.target) || el.accessBtn.contains(event.target)) return;
    closeAccessPop();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.accessPop.hidden) closeAccessPop();
  });

  window.addEventListener('resize', () => {
    if (!el.accessPop.hidden) positionAccessPop();
  });

  el.modelSelect.addEventListener('change', () => {
    post({ type: 'setModel', value: el.modelSelect.value });
  });

  el.presetSelect.addEventListener('change', () => {
    post({ type: 'setPreset', value: el.presetSelect.value });
  });

  // ── 权限询问 ────────────────────────────────────────

  function hidePermission() {
    el.permission.hidden = true;
    el.permissionActions.textContent = '';
    el.permissionBody.textContent = '';
  }

  function showPermission(message) {
    const params = message.params || {};
    const tool = params.toolCall || {};
    el.permissionTitle.textContent = tool.title || 'DSH 需要许可';
    el.permissionBody.textContent = tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : '';
    el.permissionActions.textContent = '';
    const options = Array.isArray(params.options) ? params.options : [];
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.name || option.optionId;
      button.addEventListener('click', () => {
        hidePermission();
        post({ type: 'permission', requestId: message.requestId, optionId: option.optionId });
      });
      el.permissionActions.appendChild(button);
    }
    if (options.length === 0) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '拒绝';
      button.addEventListener('click', () => {
        hidePermission();
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
    // 只有上下文、没有文字时也允许发送：用户可能希望直接提供内容供查看。
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
  el.historyBtn.addEventListener('click', () => toggleHistory());
  el.historyClose.addEventListener('click', () => toggleHistory(false));

  // Esc 关闭历史浮层。该浮层覆盖整个面板，而「按 Esc 退出」是浮层的通用约定；
  // 缺少该处理时，使用键盘的用户只能通过 Tab 定位到右上角关闭按钮才能退出。
  // 仅在浮层打开时处理，不拦截其他位置的 Esc（例如输入框内），
  // 避免占用 VS Code 的默认行为。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || el.historyPanel.hidden) return;
    event.preventDefault();
    toggleHistory(false);
  });

  // 链接点击交由扩展打开外部浏览器（webview 内点击链接默认无响应）。
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[data-href]') : null;
    if (!anchor) return;
    event.preventDefault();
    post({ type: 'openLink', href: anchor.dataset.href });
  });

  // ── Markdown ────────────────────────────────────────
  //
  // 渲染器位于 media/markdown.js，为纯函数、不访问 DOM，因此可在 Node 中
  // 进行单元测试（正确性、注入安全、真实耗时）。无头浏览器中按帧计时受虚拟时钟影响，
  // 测量结果恒为 0，会掩盖真实性能问题，因此该部分测试必须在 Node 中执行。

  const markdown = window.DshMarkdown;
  if (!markdown) {
    // 脚本未加载时需给出可读提示，而不是让整个面板静默失效。
    document.getElementById('status-text').textContent = '界面脚本缺失：markdown.js 未加载';
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
