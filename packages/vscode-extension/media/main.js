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
    /** 用户是否贴在底部（决定要不要自动滚动）。 */
    pinned: true,
    configOptions: [],
    /** 门报过来的预设清单有没有内容（决定配置行要不要露出来）。 */
    hasPresets: false,
    /**
     * 权限那一路有没有东西可显示（清单，或者一句「为什么切不了」）。
     *
     * 跟 hasPresets 一样只用来决定配置行露不露 —— 没权限信息时别在顶栏
     * 挂一个空的「权限」按钮。
     */
    hasPermission: false,
    /**
     * 当前权限与可选项（扩展那边已经翻好中文标签，见 src/dsh/permission.js）。
     * @type {{currentValue: string, options: Array<object>}|undefined}
     */
    permission: undefined,
    /**
     * 正在等用户确认的那一项（「完全权限」要先过一道确认门）。
     * @type {object|undefined}
     */
    pendingAccess: undefined,
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
   * 顶栏状态只放**短状态**：它是一条很窄的行，塞进去的每个字都会挤掉别的东西。
   *
   * 这里做一道防守：万一哪天又有一条长文案走到 status（报错、多行诊断），
   * 也只显示第一行、并截到 24 个字 —— 完整内容挂在悬浮提示上，一个字都没丢。
   * 报错本身应该走 `error` 消息进对话流（那才是能读长文的地方）。
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
      el.statusText.textContent = shortStatus(text) || '工作中…';
    } else if (kind === 'error') {
      el.statusDot.classList.add('err');
      el.statusText.textContent = shortStatus(text) || '未连接';
    } else {
      el.statusText.textContent = shortStatus(text) || '正在连接…';
    }
    el.statusText.title = text;
    if (kind === 'ready' || kind === 'busy') syncConfigRow();
  }

  /** 配置行只在真有东西可调时才露出来（有模型下拉，或有模式/权限）。 */
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
    // 回合开始/结束驱动顶栏的时间戳和耗时。
    if (busy) startTurnClock();
    else stopTurnClock();
  }

  // ── 顶栏元信息：工作目录、回合时间戳/耗时 ─────────────

  /** 工作目录只显示尾部两段（太长的路径顶栏放不下），完整路径放在悬浮提示里。 */
  function setWorkdir(cwd) {
    if (!cwd || typeof cwd !== 'string') return;
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    const short = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd;
    el.barCwd.textContent = short;
    el.barCwd.title = cwd;
    el.barCwd.hidden = false;
  }

  let turnClockTimer = 0;

  /** 回合开始：记下起始时间，顶栏显示「开始时刻 · 已耗时」，每 200ms 刷新。 */
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
   * 停掉计时。
   *
   * 回合正常结束时**保留**最后的显示 —— 「这个回合是什么时候开始、花了多久」
   * 是回头看记录时有用的信息；只有新建对话（reset）才把显示清掉。
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
   * 打开/关闭历史浮层。打开时总是重新拉清单 —— 会话记录随时在变，
   * 缓存一份只会让人看到旧数据。
   *
   * 焦点要跟着走：浮层盖住整个面板，打开后焦点若还留在底下那些**看不见**的
   * 控件上，键盘用户按 Tab 就会在空气里游走。所以打开时把焦点交给关闭按钮
   * （浮层里第一个能操作的东西），关掉时还回那个历史按钮 —— 不还的话焦点会
   * 掉到 body 上，用户就"丢"了位置。
   */
  function toggleHistory(open) {
    const show = open === undefined ? el.historyPanel.hidden : open;
    // 藏之前先记住焦点在不在浮层里：元素一旦 hidden，焦点会自动掉到 body，
    // 那时再查就永远是 false 了。
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

  /** 会话时间显示：当年的只显示「月-日 时:分」，往年的带上年份。 */
  function fmtSessionTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const hm = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.getFullYear() === now.getFullYear() ? hm : `${d.getFullYear()}-${hm}`;
  }

  /** 工作目录只留尾部一段，列表里够认就行。 */
  function tailPath(cwd) {
    if (typeof cwd !== 'string' || !cwd) return '';
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cwd;
  }

  /**
   * 渲染历史清单（或错误 —— 门太旧、读盘失败都要在这一层说清楚）。
   */
  function renderHistory(message) {
    if (el.historyPanel.hidden) return; // 用户已经关掉了，别又把浮层撑开
    el.historyList.textContent = '';
    if (message.error) {
      // 读失败**不用** .history-empty：那套居中灰字是"这里什么都没有"的语气，
      // 拿它报错会被当成"没有历史会话"，而这两种情况的出路完全不一样。
      const box = document.createElement('div');
      box.className = 'history-error';
      box.setAttribute('role', 'alert');
      box.textContent = message.error;
      el.historyList.appendChild(box);
      return;
    }
    const sessions = Array.isArray(message.sessions) ? message.sessions : [];
    if (message.skipped > 0) {
      el.historyMeta.textContent = `最近 ${sessions.length} 段（更早的 ${message.skipped} 段没列出）`;
    } else {
      el.historyMeta.textContent = sessions.length ? `共 ${sessions.length} 段` : '';
    }
    if (sessions.length === 0) {
      const box = document.createElement('div');
      box.className = 'history-empty';
      box.textContent = '还没有历史会话。';
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
    replayBtn.title = '看这段对话的内容（不接回上下文）';
    replayBtn.addEventListener('click', () => {
      post({ type: 'historyOpen', id: card.id });
    });
    actions.appendChild(replayBtn);
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.textContent = '接回';
    resumeBtn.title = '回放这段对话，并试着把上下文接回来继续聊';
    resumeBtn.addEventListener('click', () => {
      post({ type: 'historyResume', id: card.id });
    });
    actions.appendChild(resumeBtn);
    row.appendChild(actions);
    return row;
  }

  /**
   * 渲染回放：按当年发生的样子重建转录（用户消息、它的回答、工具卡）。
   *
   * 工具卡复用 upsertTool：它默认折叠、点开看详情，跟实时对话里一模一样。
   * 回放是静态的 —— 没有流式光标，也不动画，一眼能看出「这是历史」。
   *
   * 两处刻意的顺序选择：
   * - **「这是回放」那句话放在开头**，不放结尾。它要防的是一件真会出事的事：
   *   用户对着历史内容直接打字，以为在跟那段上下文说话。放在结尾意味着要先
   *   滚到底才看得见 —— 而这句提示越早出现越好。它同时也是这份转录的标题。
   * - **停在开头**，不滚到底。回放是拿来读的，读的顺序就是从第一句开始；
   *   落在底部等于让人从最后一句倒着看。实时对话才需要跟到底部。
   */
  function renderReplay(message) {
    toggleHistory(false);
    state.messages.clear();
    el.messages.textContent = '';
    el.permission.hidden = true;
    el.empty.hidden = true;
    // 不复用 scrollToBottom：那个会把 pinned 设成 true 并拽到底部。
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
        // 挂到最近一条助手消息里（跟实时对话同构：工具是回答的一部分），
        // 而不是平铺在消息区顶层 —— 那样消息间距会被撑得忽大忽小。
        if (state.messages.has(lastAssistantId)) {
          upsertTool(lastAssistantId, {
            toolCallId: `replay-t${i}`,
            kind: 'other',
            // 工具名在门给的条目里是单独一个字段（不在 args 里），
            // 而 toolName 只认 rawInput.tool / rawInput.name —— 拼进去。
            rawInput: { tool: item.name, ...(item.args && typeof item.args === 'object' ? item.args : {}) },
            content: item.output ? [{ type: 'text', text: item.output }] : [],
            status: 'completed',
          });
        }
      }
    }

    el.messages.scrollTop = 0;
    // 焦点移到转录区（它本身 tabindex=0）：接着按 Tab 就从第一段内容开始，
    // 而不是从面板顶栏的那个历史按钮开始。preventScroll 保住上面的"停在开头"。
    try {
      el.messages.focus({ preventScroll: true });
      el.messages.scrollTop = 0;
    } catch {
      el.messages.focus();
    }
  }

  function truncatedReplayNote(head, truncated) {
    return truncated
      ? `${head}。这份转录太长，只回放了靠前的部分 —— 以下是回放，不是实时对话。`
      : `${head}。以下是回放，不是实时对话；对着它打字不会回到那段上下文里。`;
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
    // 新对话是新的开始，上一回合的「开始时刻 · 耗时」不再有意义。
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
   * 无条件滚到底部 —— 只用在"用户自己刚做了动作"的地方。
   *
   * 为什么需要它：如果你正在往回翻记录，然后自己发了一句，光靠 scrollIfPinned
   * 是**不会**跟下去的（那时 pinned 已经是 false），结果你既看不见自己刚发的话、
   * 也看不见它开始回答 —— 得自己再滚到底。别的聊天界面在这种情况下都会跟着走，
   * 因为这是你自己的动作。它自己的输出则继续守"别把人拽回去"的规矩。
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
    // 你自己发的消息，视图一定跟到底部（见上面 scrollToBottom 的说明）。
    scrollToBottom();
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

  /**
   * 显示一条错误。
   *
   * `human` 是扩展那边翻好的「人话」（`src/dsh/errors.js`）：一句话说清
   * 发生了什么、一句话说你能做什么。**内核原文永远跟在后面显示**，一个字
   * 都不删 —— 人话是为了让人一眼看懂，不是为了让信息消失；认不出来的错误
   * 更是只能靠原文。
   *
   * `human` 缺失时（例如消息来自别处）退回只显示原文，行为跟以前一样。
   */
  function addError(text, human) {
    const div = document.createElement('div');
    div.className = 'msg msg-error';
    if (!human || !human.title) {
      // 认不出来的错误：原文就是全部信息，直接摊开，不能藏在折叠里。
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
    // 人话已经说清了「发生了什么 + 怎么办」时，内核原文收进折叠里：
    // 它常常是几十行 JSON，摊开就把对话框变成日志窗口了。
    // **一个字都没删** —— 点开就是原文，复制也用它。
    if (rawText && rawText.length > 120) {
      const fold = document.createElement('details');
      fold.className = 'err-raw-fold';
      const summary = document.createElement('summary');
      summary.textContent = '原始报错（点开）';
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
      // 折叠动画包一层 grid（见 main.css 里 .tool-fold 的说明）。
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

  // ── 权限选择器 ──────────────────────────────────────

  /**
   * 权限那一路的新状态（清单 + 当前值，或一句「为什么切不了」）。
   *
   * 关键的一条：**清单不是我写死的**，是内核给的（门 0.0.12 转出来）。
   * 所以用户装了 Auto Approval 那种插件、或者自己在档里加了预设，
   * 这里会跟着多出来 —— 跟桌面端那份是同一个真源。
   */
  function setPermissionState(message) {
    if (message.unavailable) {
      state.permission = undefined;
      state.permissionUnavailable = message.unavailable;
      state.hasPermission = true;
      closeAccessPop();
      const why = shortAccessReason(message.unavailable.state);
      el.accessBtn.textContent = `切不了（${why}）`;
      el.accessBtn.title = accessTitle(message.unavailable);
      el.accessBtn.disabled = true;
      el.accessField.hidden = false;
      syncConfigRow();
      return;
    }
    const options = Array.isArray(message.options) ? message.options : [];
    if (!message.currentValue && options.length === 0) {
      // 内核没给任何权限信息（比如门干脆没这个服务）：别挂一个空按钮。
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

  /** 切不了的原因，压缩成几个字（完整说明在悬浮提示与对话流里）。 */
  function shortAccessReason(kind) {
    if (kind === 'old-door') return '门太旧';
    if (kind === 'no-service') return '内核没装';
    return '读不到';
  }

  function accessTitle(info) {
    return info && info.detail ? `${info.text}\n${info.detail}` : (info && info.text) || '';
  }

  /** 渲染可选项（每项：名字 + 一行说明，当前那项打勾）。 */
  function renderAccessList() {
    const permission = state.permission;
    el.accessList.textContent = '';
    el.accessConfirm.hidden = true;
    state.pendingAccess = undefined;
    if (!permission) return;
    const options = permission.options;
    el.accessPopNote.textContent = options.length > 1 ? `${options.length} 档` : '';
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
      button.addEventListener('click', () => chooseAccess(option));
      el.accessList.appendChild(button);
      if (option.active) active = button;
    }
    // 选不中的当前值（清单被改过之类）也要显示出来，不能让用户以为没选。
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
   * 「完全权限」要过确认门（文案是扩展给的，见 src/dsh/permission.js 的 CONFIRM）：
   * 那一档会让智能体不再逐条问你，点错的代价太大，所以多一步。
   */
  function chooseAccess(option) {
    if (option.needsConfirm && option.confirm) {
      state.pendingAccess = option;
      el.accessList.hidden = true;
      el.accessConfirm.hidden = false;
      el.accessConfirmTitle.textContent = option.confirm.title;
      el.accessConfirmBody.textContent = option.confirm.body;
      el.accessConfirmAccept.textContent = option.confirm.accept;
      el.accessConfirmCancel.textContent = option.confirm.cancel || '算了';
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

  /** 小卡片贴着那个按钮放；下面放不下就翻到上面（侧边栏里高度很紧）。 */
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

  // 点别处 / Esc 关掉：这两种是所有人的肌肉记忆，不能只有点按钮才关得上。
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
  el.historyBtn.addEventListener('click', () => toggleHistory());
  el.historyClose.addEventListener('click', () => toggleHistory(false));

  // Esc 关掉历史浮层。它是盖住整个面板的浮层，而"按 Esc 退出"是浮层的通用约定 ——
  // 少了它，键盘用户只能一路 Tab 找到右上角那个关闭按钮才能出去。
  // 只处理浮层开着的情况，Esc 在别处（比如输入框里）不拦，免得抢掉 VS Code 的默认行为。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || el.historyPanel.hidden) return;
    event.preventDefault();
    toggleHistory(false);
  });

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
