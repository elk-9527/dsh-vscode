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
    historySearch: document.getElementById('history-search'),
    historyProject: document.getElementById('history-project'),
    historyPrev: document.getElementById('history-prev'),
    historyNext: document.getElementById('history-next'),
    historyPage: document.getElementById('history-page'),
    historyContext: document.getElementById('history-context'),
    historyContextText: document.getElementById('history-context-text'),
    historyResume: document.getElementById('history-resume'),
    historyBack: document.getElementById('history-back'),
    queue: document.getElementById('queue'),
    queueSummary: document.getElementById('queue-summary'),
    queueList: document.getElementById('queue-list'),
    queueContinue: document.getElementById('queue-continue'),
    configRow: document.getElementById('config-row'),
    modelSelect: document.getElementById('model-select'),
    modelField: document.getElementById('model-field'),
    reasoningField: document.getElementById('reasoning-field'),
    reasoningSelect: document.getElementById('reasoning-select'),
    recoverDraft: document.getElementById('recover-draft'),
    workflow: document.getElementById('workflow'),
    workflowSummary: document.getElementById('workflow-summary'),
    workflowNote: document.getElementById('workflow-note'),
    workflowFiles: document.getElementById('workflow-files'),
    workflowTest: document.getElementById('workflow-test'),
    workflowRunTest: document.getElementById('workflow-run-test'),
    workflowStopTest: document.getElementById('workflow-stop-test'),
    workflowAttachTest: document.getElementById('workflow-attach-test'),
    workflowViewTest: document.getElementById('workflow-view-test'),
    workflowPrepareTest: document.getElementById('workflow-prepare-test'),
    workflowLogTest: document.getElementById('workflow-log-test'),
    workflowTerminal: document.getElementById('workflow-terminal'),
    testLog: document.getElementById('test-log-panel'),
    testLogBody: document.getElementById('test-log-body'),
    testLogNote: document.getElementById('test-log-note'),
    testLogClose: document.getElementById('test-log-close'),
    testLogAccept: document.getElementById('test-log-accept'),
    presetField: document.getElementById('preset-field'),
    presetSelect: document.getElementById('preset-select'),
    presetNote: document.getElementById('preset-note'),
    presetNoteText: document.getElementById('preset-note-text'),
    presetNew: document.getElementById('preset-new'),
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
    composerMenu: document.getElementById('composer-menu'),
    composerTitle: document.getElementById('composer-title'),
    composerOptions: document.getElementById('composer-options'),
    composerNote: document.getElementById('composer-note'),
    contextOpen: document.getElementById('context-open'),
    contextPanel: document.getElementById('context-panel'),
    contextClose: document.getElementById('context-close'),
    contextSearch: document.getElementById('context-search'),
    contextSearchLabel: document.getElementById('context-search-label'),
    contextOptions: document.getElementById('context-options'),
    contextNote: document.getElementById('context-note'),
    preview: document.getElementById('attachment-preview'),
    previewTitle: document.getElementById('preview-title'),
    previewClose: document.getElementById('preview-close'),
    previewMeta: document.getElementById('preview-meta'),
    previewNote: document.getElementById('preview-note'),
    previewBody: document.getElementById('preview-body'),
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
    historyReadonly: false,
    queue: { items: [], paused: false },
  };

  /** entry → bit mask（正文 1，思考 2），同一帧可以同时更新两部分。 */
  const pendingRenders = new Map();
  let flushScheduled = false;
  let renderFrame, renderTimer;
  const layers = [];
  const inerted = new Map();
  function activeLayer() { return layers[layers.length - 1]; }
  function layerTargets(node) {
    return [...node.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')]
      .filter(target => target.getClientRects().length && getComputedStyle(target).visibility !== 'hidden' && !target.closest('[inert]'));
  }
  function focusLayer(layer) {
    const target = layer.initial?.isConnected && !layer.initial.disabled && layer.initial.getClientRects().length ? layer.initial : layerTargets(layer.node)[0];
    if (target) target.focus();
    else { layer.node.tabIndex = -1; layer.node.focus(); }
  }
  function syncLayers() {
    for (const [node, previous] of inerted) node.inert = previous;
    inerted.clear();
    const top = activeLayer();
    if (!top) return;
    // 沿祖先链隔离兄弟节点，避免把浮层自身放进 inert 容器。
    for (let node = top.node; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.tagName === 'SCRIPT' || sibling.tagName === 'LINK') continue;
        inerted.set(sibling, sibling.inert); sibling.inert = true;
      }
    }
  }
  function openLayer(node, initial, dismiss, returnFocus = document.activeElement) {
    let layer = layers.find(item => item.node === node);
    if (!layer) { layer = { node, returnFocus }; layers.push(layer); }
    layer.initial = initial; layer.dismiss = dismiss;
    node.hidden = false; syncLayers();
    if (activeLayer() === layer) focusLayer(layer);
  }
  function closeLayer(node, restoreFocus = true) {
    const index = layers.findIndex(item => item.node === node);
    const layer = layers[index], wasTop = layer === activeLayer();
    if (index >= 0) layers.splice(index, 1);
    node.hidden = true; syncLayers();
    if (!restoreFocus || !layer || !wasTop) return;
    const target = layer.returnFocus;
    if (target?.isConnected && !target.disabled && !target.closest('[hidden], [inert]')) target.focus();
    else if (activeLayer()) focusLayer(activeLayer());
    else if (!state.historyReadonly) el.input.focus();
  }
  document.addEventListener('focusin', () => {
    const top = activeLayer();
    if (top && !top.node.contains(document.activeElement)) focusLayer(top);
  });
  document.addEventListener('keydown', event => {
    const top = activeLayer();
    if (!top || event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === 'Tab') {
      const targets = layerTargets(top.node), index = targets.indexOf(document.activeElement);
      if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === targets.length - 1) {
        event.preventDefault(); (event.shiftKey ? targets.at(-1) : targets[0])?.focus();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); top.dismiss?.();
    }
  }, true);
  let draftCwd = '', draftTrusted = true, draftEdited = false, draftSequence = 0, pendingSend;
  const settingRequests = new Map();
  let pendingRecovery;
  let recoveryDrafts = [];
  const draftsByCwd = new Map();
  let pendingQueueEdit;
  const sentDrafts = new Map();
  const sendGlyph = el.send.querySelector('svg').cloneNode(true);
  const savedDraft = typeof vscode.getState === 'function' ? vscode.getState() : undefined;
  const draftSession = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()) + Math.random();
  const sameDraft = (left, right) => left && right && left.text === right.text && JSON.stringify(left.attachments || []) === JSON.stringify(right.attachments || []);
  function updateRecoveryButton() {
    el.recoverDraft.hidden = recoveryDrafts.length === 0;
    el.recoverDraft.disabled = Boolean(pendingSend || pendingQueueEdit || pendingChoice);
    el.recoverDraft.textContent = recoveryDrafts.length > 1 ? `切换保留草稿（${recoveryDrafts.length} 份）` : '恢复保留草稿';
  }
  function currentDraft() {
    const active = { text: el.input.value, attachments: state.attachments.slice() };
    const recoveries = [];
    for (const content of [pendingSend?.cwd === draftCwd ? pendingSend.draft : undefined, ...recoveryDrafts].filter(Boolean)) {
      const held = draftTrusted ? content : { text: content.text, attachments: [] };
      if (!sameDraft(held, active) && !recoveries.some(item => sameDraft(item, held))) recoveries.push(held);
    }
    return { version: 1, cwd: draftCwd, savedAt: Date.now(), ...active, recoveries };
  }
  function persistDraft(draft) {
    if (new TextEncoder().encode(JSON.stringify(draft)).length > 512 * 1024 || [draft, ...(draft.recoveries || [])].some(item => item.text.length > 128 * 1024)) { showHint('草稿超过保存限制，内容仍保留在当前窗口。', true); return; }
    if (draft.cwd !== draftCwd) { post({ type: 'draft', draft }); return; }
    if (typeof vscode.setState === 'function') vscode.setState(draft);
    post({ type: 'draft', draft });
  }
  function saveDraft() {
    draftEdited = true;
    updateRecoveryButton(); renderQueue();
    if (!draftCwd) return;
    const draft = currentDraft();
    draftsByCwd.set(draftCwd, { draft, edited: draftEdited });
    persistDraft(draft);
  }
  function switchDraftCwd(cwd, trusted) {
    if (draftCwd && draftCwd !== cwd) {
      const draft = currentDraft();
      draftsByCwd.set(draftCwd, { draft, edited: draftEdited });
      persistDraft(draft);
      cancelContext(); closePreview(); closeCompletion(); pendingChoice = undefined;
    }
    const changed = draftCwd !== cwd;
    draftCwd = cwd; draftTrusted = trusted !== false;
    if (!changed) {
      if (!draftTrusted) { cancelContext(); closePreview(); closeCompletion(); pendingChoice = undefined; applyDraft(currentDraft()); saveDraft(); }
      return;
    }
    const cached = draftsByCwd.get(cwd);
    draftEdited = false;
    el.input.value = ''; state.attachments = []; recoveryDrafts = [];
    if (cached) { applyDraft(cached.draft); draftEdited = cached.edited; }
    updateRecoveryButton(); renderAttachments(); autoGrow(); syncComposer();
  }
  function restoreDraft(draft) {
    if (!draft || draft.version !== 1 || draft.cwd !== draftCwd || !Number.isFinite(draft.savedAt) || Date.now() - draft.savedAt > 7 * 86400000 || draft.savedAt > Date.now() + 60000 || draftEdited) return;
    if (new TextEncoder().encode(JSON.stringify(draft)).length > 512 * 1024) return;
    if ([draft, ...(Array.isArray(draft.recoveries) ? draft.recoveries : draft.recovery ? [draft.recovery] : [])].some(item => typeof item?.text !== 'string' || item.text.length > 128 * 1024)) return;
    applyDraft(draft);
  }
  function applyDraft(draft) {
    cancelContext(); closePreview(); closeCompletion(); pendingChoice = undefined;
    el.input.value = typeof draft.text === 'string' ? draft.text : '';
    state.attachments = draftTrusted && Array.isArray(draft.attachments) ? draft.attachments : [];
    recoveryDrafts = (Array.isArray(draft.recoveries) ? draft.recoveries : draft.recovery ? [draft.recovery] : []).filter(held => held && typeof held.text === 'string').map(held => ({ text: held.text, attachments: draftTrusted && Array.isArray(held.attachments) ? held.attachments : [] }));
    if (!el.input.value && !state.attachments.length && recoveryDrafts.length) {
      const recovered = recoveryDrafts.shift(); el.input.value = recovered.text; state.attachments = recovered.attachments;
    }
    updateRecoveryButton();
    renderAttachments(); autoGrow();
    draftsByCwd.set(draftCwd, { draft: currentDraft(), edited: draftEdited });
  }

  function keepDraft(draft, cwd = draftCwd) {
    if (!draft || !draft.text && !draft.attachments?.length) return;
    if (cwd !== draftCwd) {
      const cached = draftsByCwd.get(cwd);
      const target = cached?.draft || { version: 1, cwd, text: '', attachments: [], recoveries: [] };
      if (!sameDraft(target, draft)) {
        if (!target.text && !target.attachments.length) { target.text = draft.text || ''; target.attachments = draft.attachments || []; }
        else if (!target.recoveries.some(item => sameDraft(item, draft))) target.recoveries.unshift(draft);
      }
      target.savedAt = Date.now(); draftsByCwd.set(cwd, { draft: target, edited: true }); persistDraft(target); return;
    }
    if (!draftTrusted) draft = { text: draft.text, attachments: [] };
    if (el.input.value === draft.text && JSON.stringify(state.attachments) === JSON.stringify(draft.attachments || [])) return;
    if (!el.input.value && !state.attachments.length) {
      el.input.value = draft.text || ''; state.attachments = draft.attachments || []; renderAttachments(); autoGrow();
    } else if (!recoveryDrafts.some(item => sameDraft(item, draft))) recoveryDrafts.unshift(draft);
    updateRecoveryButton(); saveDraft();
  }

  function syncComposer() {
    const readonly = state.historyReadonly;
    const processing = state.busy || Boolean(state.queue.active);
    const queueMode = processing || state.queue.paused && state.queue.items?.length;
    // Permissions can change during a turn; only model/thinking settings block sending.
    // Every pending setting blocks switching the session or recovering the connection.
    const sendSettingsPending = Array.from(settingRequests.values()).some(request => request.setting !== 'permission');
    const sessionSettingsPending = settingRequests.size > 0;
    el.input.readOnly = readonly;
    el.input.placeholder = readonly ? '继续此对话或返回当前对话后发送' : queueMode ? '输入下一条消息，Enter 加入队列' : '描述你要完成的任务…';
    el.send.hidden = false;
    el.send.disabled = Boolean(readonly || sendSettingsPending || pendingRecovery || pendingSend || pendingQueueEdit || pendingChoice || (state.queue.items || []).length + (state.queue.active ? 1 : 0) >= 5);
    el.send.classList.toggle('queue-send', Boolean(queueMode));
    el.send.replaceChildren(queueMode ? document.createTextNode('排队') : sendGlyph.cloneNode(true));
    el.send.title = queueMode ? state.queue.paused ? '加入已暂停队列：需点击继续才会发送' : '排队下一条：当前任务结束后发送' : '发送';
    el.send.setAttribute('aria-label', queueMode ? '排队下一条' : '发送');
    el.modelSelect.disabled = Boolean(processing || readonly || sendSettingsPending || pendingRecovery);
    el.reasoningSelect.disabled = Boolean(processing || readonly || sendSettingsPending || pendingRecovery);
    el.presetSelect.disabled = Boolean(readonly || sessionSettingsPending || pendingRecovery);
    el.accessBtn.disabled = Boolean(readonly || pendingRecovery || state.permissionUnavailable || !state.permission || Array.from(settingRequests.values()).some(request => request.setting === 'permission'));
    if (readonly) closeAccessPop();
    document.querySelectorAll('[data-recovery-action]').forEach(button => { button.disabled = Boolean(pendingRecovery || sessionSettingsPending || processing); });
    el.stop.hidden = !processing || readonly;
    el.historyResume.disabled = Boolean(!state.historyId || processing || sessionSettingsPending || pendingRecovery);
    el.historyList.querySelectorAll('[data-history-resume]').forEach(button => { button.disabled = Boolean(processing || sessionSettingsPending || pendingRecovery); });
    el.presetNew.disabled = Boolean(processing || readonly || pendingSend || sessionSettingsPending || pendingRecovery);
    document.querySelectorAll('[data-context-add], #context-open').forEach(button => { button.disabled = Boolean(readonly || pendingChoice || !draftTrusted); });
    updateRecoveryButton();
    document.querySelectorAll('[data-composer]').forEach(button => { button.disabled = readonly; });
    renderQueue();
  }

  function renderQueue() {
    const queue = state.queue, items = Array.isArray(queue.items) ? queue.items : [];
    el.queue.hidden = items.length === 0 && !queue.recoveryBlocked;
    el.queueSummary.textContent = queue.paused ? `队列已暂停 · ${items.length} 条${queue.reason ? ' · ' + queue.reason : ''}` : `待发送 ${items.length} 条 · 按顺序发送`;
    el.queueContinue.hidden = !queue.paused;
    el.queueContinue.textContent = items.some(item => item.failed) ? '重试并继续' : '继续队列';
    el.queueContinue.disabled = Boolean(state.busy || queue.active || queue.recoveryBlocked || items.some(item => item.uncertain) || state.historyReadonly || pendingRecovery || pendingQueueEdit || Array.from(settingRequests.values()).some(request => request.setting !== 'permission'));
    el.queueList.textContent = '';
    if (queue.recoveryBlocked) {
      const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = '放弃旧恢复记录';
      discard.disabled = state.historyReadonly;
      discard.addEventListener('click', () => post({ type: 'queueAction', action: 'discardRecovery' }));
      el.queueList.appendChild(discard);
    }
    items.forEach((item, index) => {
      const row = document.createElement('div'); row.className = 'queue-item';
      const label = document.createElement('span'); label.className = 'queue-text';
      label.textContent = `${index + 1}. ${item.uncertain ? '执行结果待确认 · ' : item.failed ? '未完成 · ' : item.restored ? '已恢复 · ' : ''}${item.text?.trim() || '仅附件'}${item.attachmentCount ? ` · ${item.attachmentCount} 个附件` : ''}`;
      label.title = item.text || '仅附件'; row.appendChild(label);
      for (const [action, text] of [['edit', '取回编辑'], ['remove', '移除']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
        button.dataset.action = action; button.dataset.id = item.id;
        button.disabled = state.historyReadonly || action === 'edit' && Boolean(recoveryDrafts.length || pendingQueueEdit || pendingChoice);
        button.addEventListener('click', () => {
          if (action === 'edit') { if (recoveryDrafts.length || pendingQueueEdit || pendingChoice) return; cancelContext(); closePreview(); closeCompletion(); pendingQueueEdit = { id: item.id, cwd: item.cwd || draftCwd }; syncComposer(); }
          post({ type: 'queueAction', action, id: item.id });
        }); row.appendChild(button);
      }
      el.queueList.appendChild(row);
    });
  }
  el.queueContinue.addEventListener('click', () => { if (!state.queue.recoveryBlocked && !(state.queue.items || []).some(item => item.uncertain)) post({ type: 'queueAction', action: 'continue' }); });
  el.historyBack.addEventListener('click', () => post({ type: 'historyBack' }));
  el.historyResume.addEventListener('click', () => { if (state.historyId) post({ type: 'historyResume', id: state.historyId }); });
  el.presetNew.addEventListener('click', () => post({ type: 'newSession' }));

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
    } finally {
      const top = activeLayer();
      if (top && (!top.node.contains(document.activeElement) || document.activeElement.disabled)) focusLayer(top);
    }
  });

  function handle(message) {
    switch (message.type) {
      case 'status':
        setStatus(message.state, message.detail);
        break;
      case 'meta':
        if (state.sessionId !== message.sessionId || draftCwd !== message.cwd || message.trusted === false) invalidateTestRequests();
        if (state.sessionId !== message.sessionId) { cancelContext(); closePreview(); closeCompletion(); if (pendingChoice) showHint('对话已变化，请重新添加上下文。', true); pendingChoice = undefined; }
        state.sessionId = message.sessionId;
        setWorkdir(message.cwd);
        switchDraftCwd(message.cwd, message.trusted);
        syncComposer();
        break;
      case 'draftRestore':
        if ((message.cwd || message.draft?.cwd) !== draftCwd) break;
        restoreDraft(savedDraft?.cwd === draftCwd && savedDraft.savedAt > (message.draft?.savedAt || 0) ? savedDraft : message.draft);
        break;
      case 'sendResult':
        if (!pendingSend || pendingSend.id !== message.requestId) break;
        const responseCwd = pendingSend.cwd;
        if (message.success) {
          if (message.phase === 'accepted') {
            sentDrafts.set(message.requestId, { ...pendingSend.draft, cwd: pendingSend.cwd });
            while (sentDrafts.size > 5) sentDrafts.delete(sentDrafts.keys().next().value);
          }
          // 用户可能在接收确认到达前继续编辑，确认只清空仍与提交一致的草稿。
          if (pendingSend.cwd === draftCwd && sameDraft({ text: el.input.value, attachments: state.attachments }, pendingSend.draft)) {
            el.input.value = ''; state.attachments = []; renderAttachments(); autoGrow();
          } else if (pendingSend.cwd !== draftCwd) {
            const cached = draftsByCwd.get(pendingSend.cwd);
            if (cached) {
              if (sameDraft(cached.draft, pendingSend.draft)) { cached.draft.text = ''; cached.draft.attachments = []; }
              cached.draft.recoveries = (cached.draft.recoveries || []).filter(item => !sameDraft(item, pendingSend.draft));
              cached.draft.savedAt = Date.now(); persistDraft(cached.draft);
            }
          }
          showHint(message.queued ? '已加入队列，将在前一条成功结束后发送。' : '已接收。');
        } else {
          showHint('消息未被接收，内容已保留。', true);
          keepDraft(pendingSend.draft, pendingSend.cwd);
        }
        pendingSend = undefined; updateRecoveryButton(); if (responseCwd === draftCwd) saveDraft(); syncComposer();
        break;
      case 'sendCompleted': {
        const draft = sentDrafts.get(message.requestId) || { text: message.text || '', attachments: message.attachments || [] };
        sentDrafts.delete(message.requestId);
        if (!message.success) { showHint('任务未完成，消息已保留；队列已暂停。', true); if (!message.retained) keepDraft(draft, draft.cwd || message.cwd || draftCwd); }
        break;
      }
      case 'queueState':
        state.queue = message;
        const liveRequests = new Set([message.active, ...(message.items || [])].filter(Boolean).map(item => item.requestId));
        for (const requestId of sentDrafts.keys()) if (!liveRequests.has(requestId) && pendingSend?.id !== requestId) sentDrafts.delete(requestId);
        if (message.active?.requestId) sentDrafts.set(message.active.requestId, { text: message.active.text, attachments: message.active.attachments || [], cwd: message.active.cwd || draftCwd });
        renderQueue(); syncComposer();
        if (workflowState) renderWorkflow(workflowState);
        break;
      case 'queueEdit': {
        if (message.token && pendingQueueEdit?.token && message.token !== pendingQueueEdit.token) break;
        if (message.phase === 'prepared' && pendingQueueEdit?.token === message.token) break;
        if (message.phase === 'completed') {
          if (pendingQueueEdit?.token !== message.token) break;
          pendingQueueEdit = undefined;
          showHint(message.error || '已取回待发送消息，编辑后再发送。', Boolean(message.error));
          syncComposer(); break;
        }
        const cwd = message.cwd || pendingQueueEdit?.cwd || draftCwd;
        if (message.phase === 'prepared' && pendingQueueEdit && message.id !== pendingQueueEdit.id) break;
        if (message.phase === 'prepared') {
          pendingQueueEdit = { id: message.id, cwd, token: message.token };
          keepDraft({ text: message.text || '', attachments: message.attachments || [] }, cwd);
          const draft = cwd === draftCwd ? currentDraft() : draftsByCwd.get(cwd)?.draft;
          showHint('正在保存取回的消息…');
          post({ type: 'queueAction', action: 'confirmEdit', id: message.id, token: message.token, draft });
          syncComposer(); break;
        }
        pendingQueueEdit = undefined;
        if (message.error) showHint(message.error, true);
        else { showHint('已取回待发送消息，编辑后再发送。'); keepDraft({ text: message.text || '', attachments: message.attachments || [] }, cwd); }
        syncComposer();
        break;
      }
      case 'historyState':
        invalidateTestRequests();
        state.historyReadonly = Boolean(message.readonly); state.historyId = message.id;
        el.historyContext.hidden = !state.historyReadonly;
        el.historyContextText.textContent = message.reason || '正在查看历史，输入已暂停。';
        el.historyResume.disabled = !message.id || state.busy;
        cancelContext(); closePreview(); closeCompletion(); pendingChoice = undefined; syncComposer();
        if (workflowState) renderWorkflow(workflowState);
        break;
      case 'conversationSnapshot':
        resetTranscript();
        for (const event of Array.isArray(message.events) ? message.events : []) {
          if (['user', 'assistant', 'text', 'thinking', 'tool', 'done', 'notice', 'error', 'replay'].includes(event.type)) handle(event);
        }
        if (workflowState) renderWorkflow(workflowState);
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
      case 'settingResult': {
        if (message.phase === 'pending' && !settingRequests.has(message.requestId) && message.cwd === draftCwd && message.sessionId === state.sessionId)
          settingRequests.set(message.requestId, { setting: message.setting, cwd: message.cwd, sessionId: message.sessionId });
        const request = settingRequests.get(message.requestId);
        if (message.phase === 'completed') settingRequests.delete(message.requestId);
        syncComposer();
        if (request && request.cwd === draftCwd && request.sessionId === state.sessionId)
          showHint(message.phase === 'pending' ? message.text : message.success ? message.text : `设置未确认：${message.error || message.text}`, message.phase === 'completed' && !message.success);
        break;
      }
      case 'recoveryResult':
        if (!pendingRecovery && message.phase === 'pending') pendingRecovery = message.requestId || 'command-recovery';
        if (message.requestId !== pendingRecovery && !(message.requestId === undefined && pendingRecovery === 'command-recovery')) break;
        if (message.phase === 'completed') pendingRecovery = undefined;
        syncComposer(); showHint(message.text || message.error, message.phase === 'completed' && !message.success);
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
        if (message.cwd && message.cwd !== draftCwd || message.sessionId && message.sessionId !== state.sessionId || !draftTrusted || state.historyReadonly) break;
        addAttachments(message.items);
        break;
      case 'composerSuggestions':
        if (message.origin === 'context') {
          if (!contextRequest || contextRequest.requestId !== message.requestId || contextRequest.cwd !== draftCwd || contextRequest.sessionId !== state.sessionId || message.source !== contextSource) break;
          contextRequest.items = (Array.isArray(message.items) ? message.items : []).filter(item => item.kind !== 'command');
          contextRequest.index = 0; contextRequest.loading = false; renderContext(message.note); break;
        }
        if (!completion || completion.requestId !== message.requestId) break;
        const selectedId = completion.items[completion.index]?.id;
        completion.items = Array.isArray(message.items) ? message.items : [];
        completion.index = Math.max(0, completion.items.findIndex(item => item.id === selectedId && !item.disabled));
        if (completion.items[completion.index]?.disabled) completion.index = Math.max(0, completion.items.findIndex(item => !item.disabled));
        completion.loading = false;
        renderCompletion(message.note);
        break;
      case 'composerSelected': {
        if (!pendingChoice || pendingChoice.requestId !== message.requestId) break;
        const choice = pendingChoice; pendingChoice = undefined;
        syncComposer();
        if (choice.cwd !== draftCwd || choice.sessionId !== state.sessionId || message.cwd && message.cwd !== draftCwd || message.origin && message.origin !== choice.origin || message.item && !draftTrusted || state.historyReadonly) break;
        if (message.error) { showHint(message.error, true); break; }
        if (!message.item && !message.command) break;
        const others = state.attachments.filter(item => item.id !== message.item?.id);
        if (message.item && (others.length >= 20 || others.reduce((size, item) => size + new TextEncoder().encode(item.text || '').length, new TextEncoder().encode(message.item.text || '').length) > 256 * 1024)) {
          showHint('最多附加 20 项，正文总量不超过 256 KiB；请移除附件或选择较小选区。', true); break;
        }
        if (choice.origin === 'syntax' && choice.token && el.input.value.slice(0, choice.token.end) === choice.text.slice(0, choice.token.end)) {
          const caret = el.input.selectionStart;
          el.input.value = el.input.value.slice(0, choice.token.start) + el.input.value.slice(choice.token.end);
          const nextCaret = caret >= choice.token.end ? caret - (choice.token.end - choice.token.start) : Math.min(caret, choice.token.start);
          el.input.setSelectionRange(nextCaret, nextCaret); autoGrow();
        }
        if (message.item) addAttachments([message.item]);
        else { saveDraft(); showHint('命令已处理。'); }
        break;
      }
      case 'workflow':
        renderWorkflow(message);
        break;
      case 'workflowResult':
        receiveTestResult(message);
        break;
      case 'workflowFocus':
        const latestCard = turnCards.get(workflowState?.turnId);
        if (latestCard && !state.historyReadonly) { latestCard.open = true; latestCard.scrollIntoView({ block: 'nearest' }); latestCard.querySelector('summary').focus(); }
        else if (!state.historyReadonly) { el.workflow.hidden = false; el.workflow.open = true; el.workflowSummary.focus(); }
        break;
      case 'hint':
        showHint(message.text, Boolean(message.error));
        break;
      default:
        break;
    }
  }

  let workflowState;
  const testRequests = new Map();
  let testRequestSequence = 0, testLogTarget;
  const turnCards = new Map();
  function findTest(turnId, testId) {
    const test = (workflowState?.turns || []).find(turn => (turn.id || turn.turnId) === turnId)?.test
      || ((workflowState?.turnId || '') === turnId ? workflowState?.test : undefined);
    return test?.id === testId ? test : undefined;
  }
  function invalidateTestRequests() { testRequests.clear(); closeTestLog(); }
  function requestTest(action, turnId, test, trigger, extra = {}) {
    if (state.historyReadonly || !draftTrusted || pendingRecovery || Array.from(settingRequests.values()).some(request => request.setting !== 'permission') || test?.sourceCurrent === false && action !== 'test') return;
    const requestId = `${draftSession}:test:${++testRequestSequence}`;
    const request = { type: 'workflowAction', action, turnId: turnId || '', testId: test?.id || '', requestId, cwd: draftCwd, sessionId: state.sessionId, ...extra };
    if (testRequests.size >= 20) { showHint('请等已有测试操作返回后再试。', true); return; }
    testRequests.set(requestId, { ...request, trigger }); post(request);
  }
  function logTest(turnId, test, trigger) {
    closePreview(); closeContext(false); closeCompletion();
    testLogTarget = { turnId: turnId || '', test, trigger, cwd: draftCwd, sessionId: state.sessionId };
    el.testLogBody.value = ''; el.testLogNote.textContent = `任务：${test.label} · 执行 ${test.id}`;
    openLayer(el.testLog, el.testLogBody, closeTestLog, trigger);
  }
  function closeTestLog() {
    if (!el.testLog || el.testLog.hidden) { testLogTarget = undefined; return; }
    testLogTarget = undefined; el.testLogBody.value = '';
    closeLayer(el.testLog);
  }
  el.testLogClose.addEventListener('click', closeTestLog);
  el.testLogAccept.addEventListener('click', () => {
    const target = testLogTarget, logText = el.testLogBody.value;
    if (!target || target.cwd !== draftCwd || target.sessionId !== state.sessionId || !findTest(target.turnId, target.test.id)) { closeTestLog(); showHint('此次测试结果已失效，请重新查看。', true); return; }
    if (!logText.trim() || new TextEncoder().encode(logText).length > 128 * 1024) { el.testLogNote.textContent = '请提供非空日志，正文最多 128 KiB（UTF-8）。'; return; }
    closeTestLog(); requestTest('logTest', target.turnId, target.test, target.trigger, { logText });
  });
  function receiveTestResult(message) {
    const request = testRequests.get(message.requestId); if (!request) return;
    testRequests.delete(message.requestId);
    if (request.cwd !== draftCwd || request.sessionId !== state.sessionId || message.cwd !== draftCwd || message.sessionId !== state.sessionId || request.action !== message.action || request.turnId !== message.turnId || request.testId !== message.testId || !draftTrusted || state.historyReadonly) return;
    if (message.error) { showHint(message.error, true); return; }
    if (request.testId && !findTest(request.turnId, request.testId)) { showHint('此次结果已被覆盖或移除，请重新查看。', true); return; }
    const items = Array.isArray(message.items) ? message.items : [];
    if (request.action === 'attachTest') {
      if (testDraftFits(items, false)) addAttachments(items);
    } else if (request.action === 'prepareTest') {
      if (typeof message.text !== 'string' || !testDraftFits(items, true, message.text)) return;
      const held = { text: el.input.value, attachments: state.attachments.slice() };
      if ((held.text || held.attachments.length) && !sameDraft(held, { text: message.text, attachments: items }) && !recoveryDrafts.some(draft => sameDraft(draft, held))) recoveryDrafts.unshift(held);
      closePreview(); closeCompletion(); cancelContext();
      el.input.value = message.text; state.attachments = items; renderAttachments(); autoGrow(); saveDraft(); syncComposer(); el.input.focus();
      showHint('已准备草稿，原正文和附件已保留。请检查后发送；修复完成后重新运行测试。');
    } else if (['previewTest', 'logTest'].includes(request.action) && items.length) {
      openPreview({ ...items[0], text: items.map(item => item.text || '').join('\n\n'), previewNote: '只读测试证据。未自动取得终端输出；补充日志由用户提供，未自动核实执行归属。准备草稿后仍需你发送，修复完成后重新验证。' }, request.trigger);
    } else if (message.note) showHint(message.note);
  }
  function testDraftFits(items, preparing, text = el.input.value) {
    if (!items.length || items.some(item => !item || typeof item.text !== 'string' || item.text.includes('\0'))) { showHint('此次证据没有有效正文，请重新查看。', true); return false; }
    const attachments = preparing ? items : [...state.attachments.filter(held => !items.some(item => item.id === held.id)), ...items];
    if (attachments.length > 20 || attachments.reduce((size, item) => size + new TextEncoder().encode(item.text || '').length, 0) > 256 * 1024) { showHint('最多附加 20 项，正文总量不超过 256 KiB；原草稿已保留。', true); return false; }
    const draft = currentDraft();
    const held = { text: el.input.value, attachments: state.attachments.slice() };
    const recoveries = draft.recoveries.slice();
    if (preparing && (held.text || held.attachments.length) && !sameDraft(held, { text, attachments }) && !recoveries.some(item => sameDraft(item, held))) recoveries.unshift(held);
    const next = { ...draft, text, attachments, recoveries };
    if (text.length > 128 * 1024 || new TextEncoder().encode(JSON.stringify(next)).length > 512 * 1024) { showHint('加入证据会超过 512 KiB 草稿保存限制；原正文和附件已保留，请先处理保留草稿。', true); return false; }
    return true;
  }
  function testDescription(test) {
    if (!test) return '未记录工作区测试结果。';
    const labels = { running: '运行中', cancelling: '取消中', passed: '通过', failed: '失败', cancelled: '已取消', unknown: '结束状态未知', error: '启动失败' };
    return `${test.label}：${labels[test.status] || test.status}${Number.isFinite(test.duration) ? ` · ${(test.duration / 1000).toFixed(1)} 秒` : ''}${Number.isInteger(test.exitCode) ? ` · 退出码 ${test.exitCode}` : ''}${test.message ? '\n' + test.message : ''}${test.sourceNote ? '\n' + test.sourceNote : ''}\n${test.stale ? '代码已变化，需要重新测试。' : test.freshnessNote || '内容核对未确认；结果仅代表所选任务。'}\n未自动取得终端输出。${test.userLog ? '已有用户补充日志，执行归属未自动核实。' : '可打开任务终端视图，明确复制并补充日志。'}`;
  }
  function resultFiles(host, files, { recording, test, turnId, allowUndo = true } = {}) {
    host.textContent = '';
    const running = ['running', 'cancelling'].includes(test?.status);
    files.forEach(file => {
      const row = document.createElement('div'); row.className = 'workflow-file';
      const name = document.createElement('span'); name.className = 'workflow-name';
      name.textContent = `${({ added: '新增', deleted: '删除', modified: '修改' })[file.kind] || '变化'} ${file.name}${Number.isInteger(file.added) ? ` +${file.added} −${file.removed}` : ''}${file.restored ? '（已撤销）' : ''}`;
      row.appendChild(name);
      for (const [label, action] of [['差异', 'preview'], ['撤销', 'undo']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.disabled = state.historyReadonly || action === 'undo' && (!allowUndo || !file.canUndo || state.busy || state.queue.active || running || recording);
        button.addEventListener('click', () => post({ type: 'workflowAction', action, id: file.id, turnId })); row.appendChild(button);
      }
      host.appendChild(row);
    });
  }
  function renderTurnCards(message) {
    const turns = Array.isArray(message.turns) ? message.turns : [];
    const retained = new Set(turns.map(turn => turn.id || turn.turnId));
    for (const [id, card] of turnCards) if (!retained.has(id)) { card.remove(); turnCards.delete(id); }
    for (const turn of turns.slice().reverse()) {
      const id = turn.id || turn.turnId, latest = id === message.turnId;
      if (!id) continue;
      let card = turnCards.get(id);
      if (!card) {
        card = document.createElement('details'); card.className = 'turn-result workflow'; card.dataset.turn = id;
        const summary = document.createElement('summary'); summary.tabIndex = 0; card.appendChild(summary);
        const body = document.createElement('div'); body.className = 'workflow-body'; card.appendChild(body);
        turnCards.set(id, card);
      }
      const host = state.messages.get(turn.messageId)?.node || el.messages;
      if (card.parentNode !== host) host.appendChild(card);
      const status = turn.finished ? ({ completed: '本轮结束', failed: '本轮失败', cancelled: '已停止' })[turn.status] || '本轮结束' : '正在处理';
      const test = turn.test, running = ['running', 'cancelling'].includes(test?.status);
      card.querySelector('summary').textContent = `${status} · 改动 ${(turn.files || []).length} 个文件${test ? ` · 测试${({ passed: '通过', failed: '失败', running: '运行中', cancelling: '取消中', cancelled: '已取消', unknown: '状态未知', error: '启动失败' })[test.status] || ''}${test.stale ? ' · 代码已变化需重跑' : ''}` : ' · 未记录工作区测试'}`;
      if (test?.freshness === 'unknown' && !running) card.querySelector('summary').textContent += ' · 内容核对未确认';
      if (test?.sourceNote) card.querySelector('summary').textContent += ` · ${test.sourceNote}`;
      card.dataset.status = turn.status || '';
      const signature = JSON.stringify([turn, state.busy, Boolean(state.queue.active), draftTrusted, message.recording, latest, state.historyReadonly, settingRequests.size, Boolean(pendingRecovery)]);
      if (card._signature === signature) continue;
      card._signature = signature;
      const body = card.querySelector('.workflow-body'); body.textContent = '';
      const note = document.createElement('p'); note.className = 'workflow-note'; note.textContent = turn.note || ''; body.appendChild(note);
      const files = document.createElement('div'); files.className = 'workflow-files'; resultFiles(files, turn.files || [], { recording: latest && message.recording, test, turnId: id, allowUndo: latest }); body.appendChild(files);
      const result = document.createElement('div'); result.className = 'workflow-test'; result.textContent = testDescription(test); body.appendChild(result);
      if (latest || test) {
        const actions = document.createElement('div'); actions.className = 'workflow-actions';
        for (const [label, action, hidden] of [['运行测试', 'test', !latest], ['停止测试', 'cancelTest', !latest || !running], ['查看此次结果', 'previewTest', !test || running], ['附加测试结果', 'attachTest', !test || running], [test?.status === 'failed' ? '准备修复草稿' : '准备排查草稿', 'prepareTest', !test || running], ['补充日志', 'logTest', !test || running], ['打开任务终端视图', 'taskTerminals', !test || running]]) {
          if (hidden) continue;
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
          button.disabled = Boolean(!draftTrusted || pendingRecovery || settingRequests.size || action !== 'test' && test?.sourceCurrent === false || action === 'test' && (state.busy || state.queue.active || running || message.recording) || action === 'cancelTest' && test?.status === 'cancelling');
          button.addEventListener('click', () => action === 'logTest' ? logTest(id, test, button) : requestTest(action, id, action === 'test' ? undefined : test, button)); actions.appendChild(button);
        }
        body.appendChild(actions);
      }
      if (turn.finished && !card._finished) { card._finished = true; card.open = Boolean(turn.files?.length || test); }
    }
    scrollIfPinned();
    return turns.length > 0;
  }
  function renderWorkflow(message) {
    workflowState = message;
    for (const [id, request] of testRequests) if (request.testId && !findTest(request.turnId, request.testId)) { testRequests.delete(id); showHint('此次结果已被覆盖或移除，请重新查看。', true); }
    if (testLogTarget && !findTest(testLogTarget.turnId, testLogTarget.test.id)) { closeTestLog(); showHint('此次结果已被覆盖或移除，请重新查看。', true); }
    if (state.historyReadonly) {
      el.workflow.hidden = true;
      for (const card of turnCards.values()) { card.querySelectorAll('button').forEach(button => { button.disabled = true; }); card._signature = undefined; }
      return;
    }
    const hasCards = renderTurnCards(message);
    el.workflow.hidden = hasCards || !message.turnId && !message.test && !message.recording;
    const files = message.files || [], running = ['running', 'cancelling'].includes(message.test?.status);
    el.workflowSummary.textContent = message.recording ? '正在整理本轮改动…' : `本轮改动 ${files.length} 个文件${message.test ? ' · 测试' : ''}`;
    el.workflowNote.textContent = message.note || '';
    resultFiles(el.workflowFiles, files, message);
    const test = message.test;
    el.workflowTest.textContent = testDescription(test);
    el.workflowRunTest.disabled = Boolean(state.busy || state.queue.active || running || message.recording || !draftTrusted);
    el.workflowStopTest.hidden = !running; el.workflowStopTest.disabled = test?.status === 'cancelling' || test?.sourceCurrent === false;
    el.workflowAttachTest.hidden = !test || running;
    for (const button of [el.workflowAttachTest, el.workflowViewTest, el.workflowPrepareTest, el.workflowLogTest, el.workflowTerminal]) { button.hidden = !test || running; button.disabled = !draftTrusted || test?.sourceCurrent === false; }
    el.workflowPrepareTest.textContent = test?.status === 'failed' ? '准备修复草稿' : '准备排查草稿';
  }
  for (const [button, action] of [[el.workflowRunTest, 'test'], [el.workflowStopTest, 'cancelTest'], [el.workflowAttachTest, 'attachTest'], [el.workflowViewTest, 'previewTest'], [el.workflowPrepareTest, 'prepareTest'], [el.workflowTerminal, 'taskTerminals']]) button.addEventListener('click', () => requestTest(action, workflowState?.turnId, action === 'test' ? undefined : workflowState?.test, button));
  el.workflowLogTest.addEventListener('click', () => logTest(workflowState?.turnId, workflowState?.test, el.workflowLogTest));

  // ── 顶部状态 ────────────────────────────────────────

  /** 正常连接只显示圆点；准备、错误等必要反馈仍完整显示。 */
  function setStatus(kind, detail) {
    const text = detail || '';
    state.connectionStage = { kind, detail: text };
    updateOnboarding();
    el.statusDot.className = 'dot';
    if (kind === 'ready') {
      el.statusDot.classList.add('ok');
      el.statusText.textContent = '';
    } else if (kind === 'busy') {
      el.statusDot.classList.add('busy');
      el.statusText.textContent = text || '正在处理…';
    } else if (kind === 'error') {
      el.statusDot.classList.add('err');
      el.statusText.textContent = text || '未连接';
    } else {
      el.statusText.textContent = text || '正在连接…';
    }
    el.statusText.title = kind === 'ready'
      ? '会话已建立；模型请求与凭据将在实际任务运行时验证。'
      : text;
    el.statusText.setAttribute('aria-label', kind === 'ready' ? '会话已连接' : el.statusText.textContent);
    el.statusDot.title = el.statusText.title;
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
    el.modelSelect.disabled = busy;
    el.reasoningSelect.disabled = busy;
    el.input.disabled = false;
    syncComposer();
    if (!busy && !state.historyReadonly && !activeLayer() && (document.activeElement === document.body || document.activeElement === el.stop)) el.input.focus();
    // 回合开始与结束驱动顶栏的时间戳与耗时显示。
    if (busy) startTurnClock();
    else stopTurnClock();
    if (workflowState) renderWorkflow(workflowState);
  }

  // ── 顶栏元信息：工作目录、回合时间戳/耗时 ─────────────

  /** 顶栏显示目录名，完整路径保留在悬浮提示与可访问名称中。 */
  function setWorkdir(cwd) {
    if (!cwd || typeof cwd !== 'string') return;
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    const short = parts.at(-1) || cwd;
    el.barCwd.textContent = short;
    el.barCwd.title = cwd;
    el.barCwd.setAttribute('aria-label', `当前目录：${cwd}`);
    el.barCwd.hidden = false;
    state.projectCwd = cwd;
    updateOnboarding();
  }

  function updateOnboarding() {
    const stage = document.getElementById('onboarding-stage'), next = document.getElementById('onboarding-next');
    const status = state.connectionStage || {};
    if (stage) stage.textContent = status.kind === 'ready' ? '开始新任务'
      : status.kind === 'error' ? '连接暂不可用' : status.kind === 'busy' ? '任务进行中' : '连接 DSH';
    if (next) next.hidden = status.kind === 'ready';
    if (next) next.textContent = status.kind === 'ready' ? ''
      : status.kind === 'error' ? '查看错误提示，修复后重新连接。'
        : status.kind === 'busy' ? '可以在下方准备下一条消息。'
          : /同步|准备/.test(status.detail || '') ? '请稍候，准备完成后即可开始。'
            : '连接完成后即可开始。';
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
  let historyOffset = 0, historyNextOffset, historyRequestId = 0, historySearchTimer;
  function requestHistory(offset = 0) {
    historyOffset = offset;
    el.historyPrev.disabled = true; el.historyNext.disabled = true;
    post({ type: 'historyList', offset, limit: 100, query: el.historySearch.value, projectOnly: el.historyProject.checked, requestId: ++historyRequestId });
  }
  function toggleHistory(open) {
    const show = open === undefined ? el.historyPanel.hidden : open;
    el.historyBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      el.historyList.textContent = '';
      const loading = document.createElement('div');
      loading.className = 'history-empty';
      loading.textContent = '正在读取历史会话…';
      el.historyList.appendChild(loading);
      el.historyMeta.textContent = '';
      openLayer(el.historyPanel, el.historyClose, () => toggleHistory(false));
      requestHistory();
      return;
    }
    closeLayer(el.historyPanel);
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
    if (message.requestId !== undefined && message.requestId !== historyRequestId) return;
    el.historyList.textContent = '';
    if (message.error) {
      el.historyPrev.disabled = true; el.historyNext.disabled = true;
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
    historyOffset = message.offset || 0; historyNextOffset = message.nextOffset;
    el.historyPrev.disabled = historyOffset === 0;
    el.historyNext.disabled = !Number.isInteger(historyNextOffset);
    el.historyPage.textContent = sessions.length ? `${historyOffset + 1}–${historyOffset + sessions.length}${Number.isInteger(message.total) ? ' / ' + message.total : ''}` : '';
    if (message.queryUnsupported) {
      el.historyMeta.textContent = '当前接入点需更新才能搜索和翻页';
    } else if (Number.isInteger(message.total)) {
      el.historyMeta.textContent = `共 ${message.total} 段`;
    } else if (message.skipped > 0) {
      el.historyMeta.textContent = `最近 ${sessions.length} 段（更早的 ${message.skipped} 段未列出）`;
    } else {
      el.historyMeta.textContent = sessions.length ? `共 ${sessions.length} 段` : '';
    }
    const limitations = [];
    if (message.limitation) limitations.push(message.limitation);
    if (message.via === 'cache' && Number.isFinite(message.cachedAt)) limitations.push(`只读摘要缓存 · ${new Date(message.cachedAt).toLocaleString()} · 当前筛选与分页`);
    if (limitations.length) el.historyMeta.textContent = [el.historyMeta.textContent, ...limitations].filter(Boolean).join(' · ');
    if (sessions.length === 0) {
      const box = document.createElement('div');
      box.className = 'history-empty';
      box.textContent = message.emptyReason === 'unsupported-format' || message.unsupported > 0 ? '本地降级无法读取新版会话；连接内核后可查看历史。' : '暂无历史会话。';
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
      card.summaryPartial ? '' : `${card.turns || 0} 回合`,
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
    resumeBtn.dataset.historyResume = 'true';
    resumeBtn.disabled = Boolean(state.busy || state.queue.active || pendingRecovery || settingRequests.size);
    resumeBtn.textContent = '接回';
    resumeBtn.title = '回放这段对话，并尝试接回上下文继续对话';
    resumeBtn.addEventListener('click', () => {
      post({ type: 'historyResume', id: card.id });
    });
    actions.appendChild(resumeBtn);
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button'; exportBtn.textContent = '导出'; exportBtn.title = '导出这段对话为 Markdown';
    exportBtn.addEventListener('click', () => post({ type: 'historyExport', id: card.id }));
    actions.appendChild(exportBtn);
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
    clearPendingRenders();
    state.messages.clear();
    turnCards.clear();
    el.messages.textContent = '';
    hidePermission(true);
    el.empty.hidden = true;
    // 不复用 scrollToBottom：该函数会将 pinned 设为 true 并滚动到底部。
    state.pinned = false;

    const card = message.card || {};
    const when = fmtSessionTime(card.lastTime || card.mtime);
    const live = message.readonly === false;
    const head = `${live ? '已恢复的对话' : '历史回放'}：${card.title || card.fallbackTitle || '（无标题）'}${when ? `（${when}）` : ''}`;
    addNotice(live ? `${head}。可在下方继续对话。${message.truncated ? '部分记录已省略，可从历史中查看。' : ''}` : truncatedReplayNote(head, message.truncated === true));

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
          entry.thinkText = item.thinking;
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
      : `${head}。选择“继续此对话”恢复上下文，或返回当前对话。`;
  }

  // ── 转录区 ──────────────────────────────────────────

  function resetTranscript() {
    clearPendingRenders();
    state.messages.clear();
    turnCards.clear();
    renderAttachments();
    el.messages.textContent = '';
    el.messages.appendChild(el.empty);
    el.empty.hidden = false;
    hidePermission(true);
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
    if (node.classList.contains('msg-user') || node.classList.contains('msg-assistant')) el.empty.hidden = true;
    el.messages.appendChild(node);
    if (el.empty.hidden) scrollIfPinned();
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
    let updated = false;
    const nextList = state.attachments.slice();
    for (const item of list) {
      const id = item.id || item.uri || item.name;
      if (!id) continue;
      const next = { ...item, id };
      const at = nextList.findIndex((held) => (held.id || held.uri || held.name) === id);
      if (at >= 0) { nextList[at] = next; updated = true; }
      else nextList.push(next);
      changed += 1;
      lastChanged = next;
    }
    if (nextList.length > 20 || nextList.reduce((size, item) => size + new TextEncoder().encode(item.text || '').length, 0) > 256 * 1024) {
      showHint('最多附加 20 项，正文总量不超过 256 KiB；现有内容已保留。', true); return;
    }
    state.attachments = nextList;
    if (!el.preview.hidden && list.some(item => (item.id || item.uri || item.name) === previewItemId)) closePreview();
    renderAttachments();
    saveDraft();
    if (changed > 0) {
      el.input.focus();
      showHint(`${updated ? '已更新快照' : '已附加快照'}：${lastChanged.name || lastChanged.detail}。发送前可点击附件预览。`, false);
    }
  }

  function removeAttachment(id) {
    if (previewItemId === id) closePreview();
    state.attachments = state.attachments.filter((item) => item.id !== id);
    renderAttachments();
    saveDraft();
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
      chip.title = item.kind === 'review' ? `${item.name || ''}${item.detail ? ` · ${item.detail}` : ''}\n${item.text || ''}` : `${item.name || ''}${item.detail ? ` · ${item.detail}` : ''}`;

      const icon = document.createElement('span');
      icon.className = 'chip-icon';
      // 选区使用「选中」方块，文件使用文件图标，可直接区分这两类。
      icon.textContent = item.kind === 'selection' ? '❯' : '📄';
      icon.setAttribute('aria-hidden', 'true');
      chip.appendChild(icon);

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'chip-label';
      label.textContent = item.name || item.uri || '（未知）';
      label.title = '预览已附加的正文快照';
      label.addEventListener('click', () => openPreview(item, label));
      chip.appendChild(label);

      const chipDetail = item.scope === 'selection' ? `选区 ${item.startLine || '?'}–${item.endLine || '?'} 行` : item.scope === 'file' ? `全文件${item.isDirty || item.isUntitled ? ' · 未保存' : ''}` : item.scope === 'skill' ? '技能' : item.detail;
      if (chipDetail) {
        const detail = document.createElement('span');
        detail.className = 'chip-detail';
        detail.textContent = chipDetail;
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

  let previewReturnFocus, previewItemId;
  function openPreview(item, trigger) {
    closeContext(false); closeCompletion();
    previewReturnFocus = trigger;
    previewItemId = item.id || item.uri || item.name;
    el.previewTitle.textContent = item.name || '附件正文预览';
    el.previewMeta.textContent = '';
    const scope = item.scope || item.kind;
    const range = scope === 'selection' ? `${item.startLine || '?'}–${item.endLine || '?'} 行（起点列 ${(item.startCharacter ?? 0) + 1}，末端 ${item.rangeEndLine || item.endLine || '?'}:${(item.endCharacter ?? 0) + 1}，末端不含）` : scope === 'skill' ? '技能正文' : scope === 'file' ? '全文件' : scope === 'test' ? '此次任务退出摘要与补充证据' : item.detail || '附加正文';
    const fields = [
      ['来源', item.sourcePath || item.sourceUri || item.uri || '未记录来源'],
      ['范围', range],
      ['保存状态', scope === 'git-diff' ? 'Git 输出快照' : scope === 'diagnostics' ? '诊断快照' : scope === 'test' ? '任务结果快照' : item.isUntitled ? '未命名 · 未保存' : item.isDirty === true ? '包含未保存编辑' : item.isDirty === false ? '加入时已保存' : '未记录'],
      ['快照时间', item.snapshotAt ? new Date(item.snapshotAt).toLocaleString() : '未记录'],
      ['正文大小', typeof item.text === 'string' ? `${new TextEncoder().encode(item.text).length.toLocaleString()} 字节（UTF-8）` : '未读取'],
    ];
    for (const [name, value] of fields) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; el.previewMeta.append(dt, dd); }
    el.previewBody.textContent = typeof item.text === 'string' ? item.text : '';
    el.previewBody.hidden = typeof item.text !== 'string';
    el.previewNote.textContent = item.previewNote || (scope === 'git-diff' ? '只读 Git 补丁快照，不含未保存编辑和未跟踪文件；再次添加可更新，发送时附加此正文。' : scope === 'diagnostics' ? '只读诊断快照；没有运行测试或审查，诊断可能尚未更新。再次添加可更新，发送时附加此正文。' : typeof item.text === 'string' ? '只读快照；发送时附加此正文。原文件之后的修改不会改变它，再次添加可更新。' : '旧附件未保存正文，无法预览或发送。请移除后重新添加。');
    openLayer(el.preview, el.previewClose, closePreview, previewReturnFocus);
  }
  function closePreview() {
    if (el.preview.hidden) return;
    el.previewBody.textContent = '';
    previewReturnFocus = undefined; previewItemId = undefined;
    closeLayer(el.preview);
  }
  el.previewClose.addEventListener('click', closePreview);

  function addAssistant(id) {
    const existing = state.messages.get(id);
    if (existing) return existing;
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

    const entry = { node: wrap, body, thinking, thinkBody, tools, text: '', thinkText: '' };
    state.messages.set(id, entry);
    return entry;
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
    if (entry.finished) return;
    pendingRenders.set(entry, (pendingRenders.get(entry) || 0) | (which === 'body' ? 1 : 2));
    if (flushScheduled) return;
    flushScheduled = true;
    renderFrame = requestAnimationFrame(flushRenders);
    renderTimer = setTimeout(flushRenders, 120);
  }

  function cancelRenderFlush() {
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
    clearTimeout(renderTimer);
    renderFrame = renderTimer = undefined; flushScheduled = false;
  }
  function clearPendingRenders() { cancelRenderFlush(); pendingRenders.clear(); }
  function flushRenders() {
    cancelRenderFlush();
    if (pendingRenders.size === 0) {
      return;
    }
    for (const [entry, parts] of pendingRenders) {
      // 已结束的条目不再补充渲染，否则会重新绘制光标。
      if (entry.finished) continue;
      if (parts & 1) renderAssistantBody(entry, false);
      if (parts & 2) entry.thinkBody.textContent = entry.thinkText;
    }
    pendingRenders.clear();
    scrollIfPinned();
  }

  function renderAssistantBody(entry, finished) {
    if (!markdown?.createStreamingRenderer) { entry.body.textContent = entry.text; return; }
    entry.markdown ||= markdown.createStreamingRenderer();
    const patch = entry.markdown.render(entry.text);
    if (patch.reset) entry.stableNodes = 0;
    const committed = document.createElement('template'); committed.innerHTML = patch.appendHtml;
    const count = committed.content.childNodes.length;
    const tail = document.createElement('template'); tail.innerHTML = patch.tailHtml + (finished ? '' : caret());
    committed.content.appendChild(tail.content);
    let old = entry.body.childNodes[entry.stableNodes || 0], next = committed.content.firstChild;
    // Reuse equal tail blocks too, including the final render that only removes the caret.
    while (old && next && old.isEqualNode(next)) {
      const following = old.nextSibling; committed.content.removeChild(next); old = following; next = committed.content.firstChild;
    }
    while (old) { const following = old.nextSibling; entry.body.removeChild(old); old = following; }
    entry.body.appendChild(committed.content);
    entry.stableNodes = (entry.stableNodes || 0) + count;
    if (finished) { entry.markdown.clear(); entry.markdown = undefined; }
  }

  function caret() {
    return '<span class="caret"></span>';
  }

  function finishAssistant(id, status) {
    const entry = state.messages.get(id);
    if (!entry || entry.finished) return;
    entry.finished = true;
    pendingRenders.delete(entry);
    if (!pendingRenders.size) cancelRenderFlush();
    renderAssistantBody(entry, true);
    entry.thinkBody.textContent = entry.thinkText;
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
    const actions = Array.isArray(human.actions) ? human.actions : [];
    if (actions.length) {
      const bar = document.createElement('div'); bar.className = 'error-actions';
      for (const action of actions) {
        if (!['reconnect', 'settings', 'log'].includes(action.id)) continue;
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label || action.id;
        if (action.id === 'reconnect') button.dataset.recoveryAction = 'reconnect';
        button.addEventListener('click', () => {
          if (action.id !== 'reconnect') { post({ type: 'errorAction', action: action.id }); return; }
          if (pendingRecovery) return;
          pendingRecovery = `recovery-${draftSession}-${++draftSequence}`;
          showHint('正在恢复连接，请等待确认…'); syncComposer();
          post({ type: 'errorAction', action: action.id, recoveryScope: human.recoveryScope, requestId: pendingRecovery });
        }); bar.appendChild(button);
      }
      div.appendChild(bar);
      syncComposer();
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

  const toolDetails = new WeakMap();
  let toolSequence = 0;
  function renderToolDetails(card) {
    const details = toolDetails.get(card);
    if (!details?.dirty) return;
    card.querySelector('.tool-body').innerHTML = renderToolBody(details.tool);
    details.dirty = false;
  }
  function upsertTool(messageId, tool) {
    if (!tool || !tool.toolCallId) return;
    const entry = messageId ? textMessage(messageId) : null;
    const host = entry ? entry.tools : el.messages;

    let card = host.querySelector
      ? host.querySelector(`[data-tool="${cssEscape(tool.toolCallId)}"]`)
      : null;
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool';
      card.dataset.tool = tool.toolCallId;
      const head = document.createElement('button');
      head.type = 'button';
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
      body.id = `tool-body-${++toolSequence}`;
      head.setAttribute('aria-controls', body.id);
      // 折叠动画外包裹一层 grid（见 main.css 中 .tool-fold 的说明）。
      const fold = document.createElement('div');
      fold.className = 'tool-fold';
      fold.setAttribute('aria-hidden', 'true');
      fold.appendChild(body);
      head.addEventListener('click', () => {
        const open = card.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        fold.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) renderToolDetails(card);
      });
      card.appendChild(head);
      card.appendChild(fold);
      host.appendChild(card);
    }

    const name = card.querySelector('.tool-name');
    const title = card.querySelector('.tool-title');
    const statusEl = card.querySelector('.tool-status');

    name.textContent = toolName(tool);
    title.textContent = describeTool(tool);
    const statusInfo = statusOf(tool.status);
    statusEl.textContent = statusInfo.text;
    statusEl.className = `tool-status ${statusInfo.cls}`;
    // 保留原始输出，首次展开才构建详情 DOM。已展开的流式工具仍即时更新。
    toolDetails.set(card, { tool, dirty: true });
    if (card.classList.contains('open')) renderToolDetails(card);
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
    const reasoning = configOptions.find(option => option && (option.category === 'thought_level' || /reasoning|thinking|thought/i.test(option.id)) && Array.isArray(option.options));
    el.reasoningField.hidden = !reasoning;
    el.reasoningSelect.textContent = '';
    if (reasoning) {
      el.reasoningSelect.dataset.optionId = reasoning.id;
      for (const group of reasoning.options) for (const choice of group.options || [group]) el.reasoningSelect.appendChild(optionNode(choice, reasoning.currentValue, () => {}));
      if (!Array.from(el.reasoningSelect.options).some(choice => choice.value === reasoning.currentValue) && reasoning.currentValue) {
        const unknown = optionNode({ value: reasoning.currentValue, name: '当前值（请重新选择）' }, reasoning.currentValue, () => {}); unknown.disabled = true; el.reasoningSelect.appendChild(unknown);
      }
    }
    const model = configOptions.find((option) => option && option.id === 'model');
    el.modelField.hidden = !model;
    if (!model) {
      el.modelSelect.textContent = '';
      syncConfigRow();
      syncComposer();
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
    syncComposer();
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
    state.presetCurrent = message.current;
    const pending = message.pending;
    const label = id => {
      const name = presets.find(item => item.id === id)?.name;
      return name && name !== id ? name : id === 'standard' ? '标准模式' : id;
    };
    el.presetNote.hidden = !pending || pending === message.current;
    el.presetNoteText.textContent = pending ? `当前：${label(message.current) || '未确定'} · 新对话：${label(pending)}` : '';
    el.presetSelect.title = `当前模式：${label(message.current) || '未确定'}；更换后用于新对话。`;
    if (state.hasPresets) {
      el.presetSelect.textContent = '';
      const current = message.current;
      let matched = false;
      for (const preset of presets) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = label(preset.id);
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
        opt.textContent = label(current);
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
   * 因此 DSH 0.2 注册 Auto review、用户安装权限插件或添加预设后，此处会随之增加，
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
      syncComposer();
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
      syncComposer();
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
    syncComposer();
    syncConfigRow();
  }

  /**
   * 无法切换的原因，压缩为几个字。
   *
   * 注意：**不再写在按钮上**（该处仅容得下约 4 个字，写入即被截断），
   * 而是记录在 `data-why` 上供测试读取；用户通过悬浮提示与对话流查看完整说明。
   * 简短说明同样不使用内部组件术语。
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
   * 「完全权限」与实验性的 Auto review 需要经过确认（文案由扩展随选项提供）：
   * 两者都不使用沙箱，误操作代价较大，因此增加一步确认。
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
    if (!option || option.selectable === false || el.accessBtn.disabled) return;
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
    requestSetting('setPermission', 'permission', option.value);
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
    if (!option || el.accessBtn.disabled) return;
    requestSetting('setPermission', 'permission', option.value);
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
    if (event.key === 'Escape' && !el.accessPop.hidden) { event.preventDefault(); closeAccessPop(); }
  });

  window.addEventListener('resize', () => {
    if (!el.accessPop.hidden) positionAccessPop();
  });

  el.modelSelect.addEventListener('change', () => {
    requestSetting('setModel', 'model', el.modelSelect.value);
  });
  el.reasoningSelect.addEventListener('change', () => requestSetting('setOption', el.reasoningSelect.dataset.optionId, el.reasoningSelect.value));

  function requestSetting(type, setting, value) {
    const requestId = `setting-${draftSession}-${++draftSequence}`;
    if (state.historyReadonly || pendingRecovery || (setting === 'permission' ? el.accessBtn.disabled : el.modelSelect.disabled)) { setConfig(state.configOptions); return; }
    settingRequests.set(requestId, { setting, cwd: draftCwd, sessionId: state.sessionId });
    // A native select changes immediately; restore the last confirmed selection while waiting.
    setConfig(state.configOptions); showHint('正在等待内核确认设置…'); syncComposer();
    post({ type, id: setting, value, requestId, cwd: draftCwd, sessionId: state.sessionId });
  }

  el.presetSelect.addEventListener('change', () => {
    post({ type: 'setPreset', value: el.presetSelect.value, cwd: draftCwd, sessionId: state.sessionId });
    if (state.presetCurrent) el.presetSelect.value = state.presetCurrent;
  });

  // ── 权限询问 ────────────────────────────────────────

  const permissionQueue = [];
  function hidePermission(deny = false) {
    const requests = permissionQueue.splice(0);
    if (deny) for (const request of requests) post({ type: 'permission', requestId: request.requestId, optionId: null });
    closeLayer(el.permission);
    el.permissionActions.textContent = '';
    el.permissionBody.textContent = '';
  }

  function showPermission(message) {
    if (permissionQueue.some(request => request.requestId === message.requestId)) return;
    permissionQueue.push(message);
    if (permissionQueue.length === 1) renderPermission();
  }
  function answerPermission(optionId) {
    const request = permissionQueue.shift();
    if (!request) return;
    post({ type: 'permission', requestId: request.requestId, optionId });
    if (permissionQueue.length) renderPermission();
    else hidePermission();
  }
  function renderPermission() {
    const message = permissionQueue[0];
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
        if (permissionQueue[0] === message) answerPermission(option.optionId);
      });
      el.permissionActions.appendChild(button);
    }
    if (options.length === 0) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '拒绝';
      button.addEventListener('click', () => {
        if (permissionQueue[0] === message) answerPermission(null);
      });
      el.permissionActions.appendChild(button);
    }
    const buttons = [...el.permissionActions.querySelectorAll('button')];
    const rejectIndex = options.findIndex(option => /^reject/.test(option.kind || ''));
    openLayer(el.permission, buttons[rejectIndex < 0 ? 0 : rejectIndex], () => answerPermission(null));
  }

  // ── 输入 ────────────────────────────────────────────

  let completion, completionTimer, completionSequence = 0, pendingChoice, composing = false;
  let contextRequest, contextTimer, contextSource = 'search', contextReturnFocus;
  function closeContext(restoreFocus = true) {
    clearTimeout(contextTimer); contextRequest = undefined;
    const wasOpen = !el.contextPanel.hidden;
    el.contextOpen.setAttribute('aria-expanded', 'false');
    el.contextSearch.removeAttribute('aria-activedescendant');
    if (wasOpen) post({ type: 'composerCancel' });
    closeLayer(el.contextPanel, restoreFocus);
  }
  function cancelContext() { closeContext(false); }
  function openContext(trigger) {
    if (pendingChoice || state.historyReadonly || !draftTrusted) return;
    closeCompletion(); closePreview(); contextReturnFocus = trigger;
    el.contextOpen.setAttribute('aria-expanded', 'true');
    openLayer(el.contextPanel, el.contextSearch, closeContext, trigger || el.contextOpen); queryContext();
  }
  function queryContext() {
    if (el.contextPanel.hidden || pendingChoice) return;
    clearTimeout(contextTimer); post({ type: 'composerCancel' });
    const request = { requestId: ++completionSequence, cwd: draftCwd, sessionId: state.sessionId, items: [], index: 0, loading: true };
    contextRequest = request; renderContext();
    contextTimer = setTimeout(() => { if (contextRequest === request) post({ type: 'composerQuery', requestId: request.requestId, trigger: contextSource === 'skill' ? '/' : '@', query: el.contextSearch.value, origin: 'context', source: contextSource, cwd: draftCwd }); }, 120);
  }
  function renderContext(note) {
    if (!contextRequest) return;
    el.contextOptions.textContent = '';
    contextRequest.items.forEach((item, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'composer-option';
      button.id = `context-option-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === contextRequest.index)); button.disabled = Boolean(item.disabled);
      const label = document.createElement('span'); label.textContent = item.label; button.appendChild(label);
      if (item.description) { const detail = document.createElement('small'); detail.textContent = item.description; button.appendChild(detail); }
      button.addEventListener('click', () => chooseContext(index)); el.contextOptions.appendChild(button);
    });
    el.contextNote.textContent = contextRequest.loading ? '正在查找…' : `${contextRequest.items.length ? '↑↓ 选择 · Enter 添加 · Esc 关闭。' : '没有匹配项。'} ${note || ''}`;
    if (contextRequest.items.length) { el.contextSearch.setAttribute('aria-activedescendant', `context-option-${contextRequest.index}`); el.contextOptions.children[contextRequest.index]?.scrollIntoView({ block: 'nearest' }); }
    else el.contextSearch.removeAttribute('aria-activedescendant');
  }
  function chooseContext(index) {
    const item = contextRequest?.items[index];
    if (!item || item.disabled || item.kind === 'command' || pendingChoice) return;
    const queryRequestId = contextRequest.requestId;
    pendingChoice = { requestId: ++completionSequence, origin: 'context', source: contextSource, cwd: draftCwd, sessionId: state.sessionId };
    closeContext(); syncComposer(); showHint('正在读取上下文快照…');
    post({ type: 'composerSelect', requestId: pendingChoice.requestId, queryRequestId, id: item.id, origin: 'context', source: contextSource, cwd: draftCwd });
  }
  function addEditorContext(source) {
    if (pendingChoice || state.historyReadonly || !draftTrusted) return;
    closeContext(); closeCompletion();
    pendingChoice = { requestId: ++completionSequence, origin: 'context', source, cwd: draftCwd, sessionId: state.sessionId };
    syncComposer(); showHint('正在读取编辑器快照…');
    post({ type: 'contextAdd', source, origin: 'context', requestId: pendingChoice.requestId, cwd: draftCwd });
  }
  el.contextOpen.addEventListener('click', () => openContext(el.contextOpen));
  el.contextClose.addEventListener('click', () => closeContext());
  document.querySelectorAll('[data-context-add]').forEach(button => button.addEventListener('click', () => addEditorContext(button.dataset.contextAdd)));
  document.querySelectorAll('[data-context-source]').forEach(button => button.addEventListener('click', () => {
    contextSource = button.dataset.contextSource;
    document.querySelectorAll('[data-context-source]').forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
    el.contextSearchLabel.textContent = contextSource === 'skill' ? '搜索随消息使用的技能' : contextSource === 'diff' ? '按文件名筛选 Git 变更' : contextSource === 'diagnostics' ? '按文件名筛选问题诊断' : '搜索本次对话目录中的文件';
    el.contextSearch.value = ''; el.contextSearch.focus(); queryContext();
  }));
  el.contextSearch.addEventListener('input', queryContext);
  el.contextSearch.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && contextRequest?.items.length) {
      event.preventDefault(); contextRequest.index = (contextRequest.index + (event.key === 'ArrowDown' ? 1 : -1) + contextRequest.items.length) % contextRequest.items.length; renderContext();
    } else if (event.key === 'Enter') { event.preventDefault(); chooseContext(contextRequest?.index || 0); }
  });
  function completionToken() {
    if (composing || el.input.selectionStart !== el.input.selectionEnd) return;
    const end = el.input.selectionStart;
    const before = el.input.value.slice(0, end);
    const match = /(^|\s)([@/#])([^@#\r\n]*)$/.exec(before);
    if (!match || match[3].length > 128) return;
    return { trigger: match[2], query: match[3], start: end - match[3].length - 1, end };
  }
  function closeCompletion() {
    const hadCompletion = Boolean(completion);
    clearTimeout(completionTimer); completion = undefined;
    el.composerMenu.hidden = true; el.input.setAttribute('aria-expanded', 'false');
    el.input.removeAttribute('aria-activedescendant'); if (hadCompletion) post({ type: 'composerCancel' });
  }
  function updateCompletion() {
    const token = completionToken();
    if (!token || pendingChoice) { closeCompletion(); return; }
    if (completion && completion.token.start === token.start && completion.token.end === token.end && completion.token.query === token.query && completion.token.trigger === token.trigger) return;
    closeCompletion();
    completion = { token, requestId: ++completionSequence, items: [], index: 0, loading: true };
    renderCompletion();
    const request = completion;
    completionTimer = setTimeout(() => {
      if (completion === request) post({ type: 'composerQuery', requestId: request.requestId, trigger: token.trigger, query: token.query, origin: 'syntax', cwd: draftCwd, sessionId: state.sessionId });
    }, 120);
  }
  function renderCompletion(note) {
    if (!completion) return;
    el.composerMenu.hidden = false; el.input.setAttribute('aria-expanded', 'true');
    el.composerTitle.textContent = ({ '@': '引用工作区文件', '/': '执行命令或调用技能', '#': '引用编辑器上下文和文件' })[completion.token.trigger];
    el.composerOptions.textContent = '';
    completion.items.forEach((item, index) => {
      const row = document.createElement('button'); row.type = 'button'; row.tabIndex = -1;
      row.className = 'composer-option'; row.id = `composer-option-${index}`;
      row.disabled = Boolean(item.disabled);
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === completion.index));
      const label = document.createElement('span'); label.textContent = item.label; row.appendChild(label);
      if (item.description) { const detail = document.createElement('small'); detail.textContent = item.description; row.appendChild(detail); }
      row.addEventListener('mousedown', event => event.preventDefault());
      row.addEventListener('click', () => chooseCompletion(index)); el.composerOptions.appendChild(row);
    });
    el.composerNote.textContent = completion.loading ? '正在查找…' : (completion.items.length ? '↑↓ 选择 · Enter / Tab 执行或添加 · Esc 关闭' : '没有匹配项。') + (note ? ' ' + note : '');
    if (completion.items.length) {
      el.input.setAttribute('aria-activedescendant', `composer-option-${completion.index}`);
      el.composerOptions.children[completion.index]?.scrollIntoView({ block: 'nearest' });
    } else el.input.removeAttribute('aria-activedescendant');
  }
  function chooseCompletion(index) {
    if (!completion || pendingChoice) return;
    const item = completion.items[index]; if (!item || item.disabled) return;
    const queryRequestId = completion.requestId;
    pendingChoice = { requestId: ++completionSequence, origin: 'syntax', token: completion.token, text: el.input.value, cwd: draftCwd, sessionId: state.sessionId };
    syncComposer();
    closeCompletion(); showHint(item.kind === 'command' ? '正在执行命令…' : '正在附加…');
    post({ type: item.kind === 'command' ? 'composerCommand' : 'composerSelect', requestId: pendingChoice.requestId, queryRequestId, id: item.id, origin: 'syntax', cwd: draftCwd, sessionId: state.sessionId });
  }
  function openCompletion(trigger) {
    if (composing || pendingChoice || state.historyReadonly) return;
    el.input.focus();
    const start = el.input.selectionStart, prefix = start && !/\s/.test(el.input.value[start - 1]) ? ' ' : '';
    el.input.setRangeText(prefix + trigger, start, el.input.selectionEnd, 'end');
    autoGrow(); saveDraft(); updateCompletion();
  }
  document.querySelectorAll('[data-composer]').forEach(button => button.addEventListener('click', () => openCompletion(button.dataset.composer)));

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
  }

  el.input.addEventListener('input', () => { autoGrow(); saveDraft(); updateCompletion(); });
  el.input.addEventListener('compositionstart', () => { composing = true; closeCompletion(); });
  el.input.addEventListener('compositionend', () => { composing = false; updateCompletion(); });
  el.input.addEventListener('click', updateCompletion);
  el.input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateCompletion(); });
  el.input.addEventListener('blur', closeCompletion);
  el.input.addEventListener('keydown', (event) => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === ' ' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (completionToken()) updateCompletion(); else openCompletion('@'); return; }
    if (completion && !event.shiftKey) {
      if (event.key === 'Escape') { event.preventDefault(); closeCompletion(); return; }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        if (completion.items.length) {
          for (let steps = 0; steps < completion.items.length; steps++) { completion.index = (completion.index + (event.key === 'ArrowDown' ? 1 : -1) + completion.items.length) % completion.items.length; if (!completion.items[completion.index].disabled) break; }
          renderCompletion();
        }
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab' && completion.items.length) { event.preventDefault(); chooseCompletion(completion.index); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  function submit() {
    const text = el.input.value;
    const attachments = state.attachments.slice();
    // 只有上下文、没有文字时也允许发送：用户可能希望直接提供内容供查看。
    if ((!text.trim() && attachments.length === 0) || state.historyReadonly || pendingRecovery || Array.from(settingRequests.values()).some(request => request.setting !== 'permission') || pendingSend || pendingChoice || (state.queue.items || []).length + (state.queue.active ? 1 : 0) >= 5) return;
    closeCompletion();
    pendingSend = { id: `${draftSession}:${++draftSequence}`, cwd: draftCwd, draft: { text, attachments } };
    showHint('正在接收消息…');
    saveDraft();
    syncComposer();
    post({ type: 'send', text, attachments, requestId: pendingSend.id });
  }
  el.recoverDraft.addEventListener('click', () => {
    if (!recoveryDrafts.length || pendingSend || pendingQueueEdit || pendingChoice) return;
    cancelContext(); closePreview(); closeCompletion();
    const current = { text: el.input.value, attachments: state.attachments.slice() };
    const recovered = recoveryDrafts.shift();
    el.input.value = recovered.text || ''; state.attachments = recovered.attachments || [];
    if ((current.text || current.attachments.length) && !recoveryDrafts.some(item => sameDraft(item, current))) recoveryDrafts.push(current);
    updateRecoveryButton(); renderAttachments(); autoGrow(); saveDraft();
    syncComposer();
  });

  el.send.addEventListener('click', submit);
  el.stop.addEventListener('click', () => post({ type: 'stop' }));
  el.historyBtn.addEventListener('click', () => toggleHistory());
  el.historyClose.addEventListener('click', () => toggleHistory(false));
  el.historySearch.addEventListener('input', () => { clearTimeout(historySearchTimer); historySearchTimer = setTimeout(() => requestHistory(), 250); });
  el.historyProject.addEventListener('change', () => requestHistory());
  el.historyPrev.addEventListener('click', () => requestHistory(Math.max(0, historyOffset - 100)));
  el.historyNext.addEventListener('click', () => { if (Number.isInteger(historyNextOffset)) requestHistory(historyNextOffset); });

  // Esc 优先关闭浮层或候选；没有浮层时停止当前任务并保留草稿。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || composing || event.keyCode === 229) return;
    if (!el.testLog.hidden) { event.preventDefault(); event.stopPropagation(); closeTestLog(); return; }
    if (!el.preview.hidden) { event.preventDefault(); event.stopPropagation(); closePreview(); return; }
    if (!el.contextPanel.hidden) { event.preventDefault(); event.stopPropagation(); closeContext(); return; }
    if (!el.historyPanel.hidden) { event.preventDefault(); toggleHistory(false); return; }
    if ((state.busy || state.queue.active) && !state.historyReadonly) { event.preventDefault(); post({ type: 'stop' }); }
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
