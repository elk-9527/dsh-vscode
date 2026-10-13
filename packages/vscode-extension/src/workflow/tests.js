'use strict';
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { inside, MAX_HISTORY_BYTES } = require('./turns');
const digest = value => createHash('sha256').update(value).digest('hex');
const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const signature = state => state === undefined ? 'missing' : state === null ? undefined : `${digest(state.text)}:${state.disk}`;
const MAX_LOG_BYTES = 128 * 1024;
const labels = { running: '正在运行', cancelling: '正在取消', passed: '通过', failed: '失败', cancelled: '已取消', unknown: '结束状态未知', error: '启动失败' };
const cleanText = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '�');
function cleanLog(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请明确提供此次执行的日志文本。');
  if (Buffer.byteLength(text, 'utf8') > MAX_LOG_BYTES) throw new Error('日志超过 128 KiB，请选择较小的片段。');
  const result = cleanText(text);
  if (Buffer.byteLength(result, 'utf8') > MAX_LOG_BYTES) throw new Error('清理后的日志超过 128 KiB，请选择较小的片段。');
  return result;
}

/** 只运行用户在 VS Code 中配置为 test 的工作区任务，不猜测测试命令。 */
class WorkspaceTests {
  constructor({ vscode, workflow }) {
    this.vscode = vscode; this.workflow = workflow; this.exits = new WeakMap(); this.ended = new WeakSet(); this.snapshots = new Map(); this.origins = new WeakMap();
    this.retentionChanged = () => this.pruneSnapshots(); workflow.onTestRetentionChange = this.retentionChanged;
    this.sourceCurrent = result => this.freshnessCurrent(result); workflow.testSourceCurrent = this.sourceCurrent;
    this.subscriptions = [
      vscode.tasks.onDidStartTaskProcess(event => { if (this.execution === event.execution && this.cancelled) event.execution.terminate(); }),
      vscode.tasks.onDidEndTaskProcess(event => { this.exits.set(event.execution, event.exitCode); if (this.execution === event.execution) this.finish(event.exitCode); }),
      vscode.tasks.onDidEndTask(event => {
        this.ended.add(event.execution);
        if (this.execution === event.execution) this.scheduleUnknown();
      }),
    ];
    const workspace = vscode.workspace;
    if (workspace.onDidChangeTextDocument) this.subscriptions.push(workspace.onDidChangeTextDocument(event => this.changed(event.document?.uri, event.document)));
    if (workspace.onDidSaveTextDocument) this.subscriptions.push(workspace.onDidSaveTextDocument(document => this.changed(document.uri)));
    for (const method of ['onDidCreateFiles', 'onDidDeleteFiles']) if (workspace[method]) this.subscriptions.push(workspace[method](event => event.files.forEach(uri => this.changed(uri))));
    if (workspace.onDidRenameFiles) this.subscriptions.push(workspace.onDidRenameFiles(event => event.files.forEach(file => { this.changed(file.oldUri); this.changed(file.newUri); })));
    if (workspace.createFileSystemWatcher) {
      const watcher = workspace.createFileSystemWatcher('**/*'); this.subscriptions.push(watcher,
        watcher.onDidChange(uri => this.changed(uri)), watcher.onDidCreate(uri => this.changed(uri)), watcher.onDidDelete(uri => this.changed(uri)));
    }
  }
  busy() { return this.workflow.panel.session?.busy || this.workflow.panel.queue?.active || this.workflow.panel.newSessionPending || this.workflow.recording || this.workflow.undoing || this.workflow.activeTest; }
  scope(message = {}) {
    const panel = this.workflow.panel;
    return { panelScope: panel.contextRequestScope?.(message), cwd: panel.workdir(), session: panel.session, sessionId: panel.session?.sessionId,
      epoch: panel.queueEpoch, trustEpoch: panel.contextTrustEpoch, sessionSerial: panel.contextSessionSerial, trusted: this.vscode.workspace.isTrusted,
      latest: this.workflow.latest, current: message.current,
      matches: (!message.cwd || identity(message.cwd) === identity(panel.workdir())) && (!message.sessionId || message.sessionId === panel.session?.sessionId) };
  }
  checkScope(scope, latest = false) {
    const panel = this.workflow.panel;
    this.workflow.guard(scope.cwd);
    if (this.disposed || !scope.matches || scope.current?.() === false || scope.session !== panel.session || scope.sessionId !== panel.session?.sessionId ||
        scope.epoch !== panel.queueEpoch || scope.trustEpoch !== panel.contextTrustEpoch || scope.sessionSerial !== panel.contextSessionSerial ||
        scope.trusted !== this.vscode.workspace.isTrusted || panel.newSessionPending || panel.historyReadonly ||
        scope.panelScope && !panel.contextRequestCurrent(scope.panelScope) || latest && scope.latest !== this.workflow.latest) {
      throw new Error('当前任务、对话、工作区或回合已变化，请重新查看此次测试。');
    }
  }
  checkRun(scope, result) {
    this.checkScope(scope, true);
    const panel = this.workflow.panel;
    if (panel.session?.busy || panel.queue?.active || this.workflow.recording || this.workflow.undoing ||
        (result ? this.result !== result || this.workflow.testResult !== result : this.workflow.activeTest)) throw new Error('当前任务已变化，请结束后重试。');
  }
  origin(scope) {
    // Retained results outlive a view and queue pause. Only the initiating
    // request uses view/epoch/current; each later action captures a new scope.
    return { cwd: scope.cwd, session: scope.session, sessionId: scope.sessionId,
      trustEpoch: scope.trustEpoch, sessionSerial: scope.sessionSerial, trusted: scope.trusted };
  }
  checkOrigin(result) {
    const origin = this.origins.get(result), panel = this.workflow.panel;
    this.workflow.guard(result.cwd);
    if (this.disposed || !this.retained(result) || origin && (
      identity(origin.cwd) !== identity(panel.workdir()) || origin.session !== panel.session || origin.sessionId !== panel.session?.sessionId ||
      origin.trustEpoch !== panel.contextTrustEpoch || origin.sessionSerial !== panel.contextSessionSerial || origin.trusted !== this.vscode.workspace.isTrusted)) {
      throw new Error('测试所属对话、工作区或信任状态已变化，请重新查看此次测试。');
    }
  }
  async run(message = {}) {
    if (this.selecting || this.busy()) throw new Error('请等当前任务结束后再运行测试。');
    const vscode = this.vscode, workflow = this.workflow, scope = this.scope(message), cwd = scope.cwd; this.checkRun(scope);
    if (Object.hasOwn(message, 'turnId') && message.turnId !== (scope.latest?.id || '')) throw new Error('测试所属回合已变化，请查看当前一轮。');
    this.selecting = true;
    try {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
      const available = await vscode.tasks.fetchTasks(); this.checkRun(scope);
      const tasks = available.filter(task => {
        const scope = task.scope;
        return task.group?.id === 'test' && (scope?.uri?.toString() === folder.uri.toString() || scope === vscode.TaskScope.Workspace && vscode.workspace.workspaceFolders?.length === 1);
      });
      if (!tasks.length) { await vscode.window.showInformationMessage('当前工作区没有测试任务。请在 VS Code“配置默认测试任务”中添加 group: test 的任务。'); this.checkRun(scope); return; }
      const selected = await vscode.window.showQuickPick(tasks.map(task => ({ label: task.name, description: task.source, task })), { placeHolder: '选择要实际运行的工作区测试任务' });
      this.checkRun(scope);
      if (!selected) return;
      if (!tasks.includes(selected.task)) throw new Error('所选测试任务已失效，请重新选择。');
      const result = this.result = { id: randomUUID(), cwd, label: selected.task.name, status: 'running', started: Date.now(), turnId: scope.latest?.id || '',
        outputSource: 'unavailable', outputNote: '本次未自动取得终端输出。',
        stale: false, freshness: 'unknown', freshnessNote: '正在记录本轮变化文件；测试结果仅代表所选任务。', trackedFilesCount: 0 };
      this.cancelled = false;
      this.origins.set(result, this.origin(scope));
      if (scope.latest) scope.latest.test = result;
      workflow.activeTest = true; workflow.testResult = this.result; workflow.compact(); workflow.publish();
      try {
        await this.captureFreshness(result, scope.latest, () => this.checkRun(scope, result));
        this.checkRun(scope, result);
        if (this.cancelled) {
          this.result.status = 'cancelled'; this.result.duration = Date.now() - this.result.started;
          this.cancelled = false; workflow.activeTest = false; workflow.publish(); return;
        }
        const execution = await vscode.tasks.executeTask(selected.task);
        this.execution = execution;
        try { this.checkRun(scope, result); } catch (error) { execution.terminate(); throw error; }
        if (this.cancelled) this.execution.terminate();
        if (this.exits.has(this.execution)) this.finish(this.exits.get(this.execution));
        else if (this.ended.has(this.execution)) this.scheduleUnknown();
      } catch (error) {
        result.status = 'error'; result.message = error.message; result.duration = Date.now() - result.started;
        this.execution = undefined; this.cancelled = false;
        workflow.activeTest = false; workflow.publish(); throw error;
      }
    } finally { this.selecting = false; }
  }
  scheduleUnknown() { const execution = this.execution; clearTimeout(this.timer); this.timer = setTimeout(() => { if (this.execution === execution) this.finish(undefined); }, 100); }
  finish(exitCode) {
    if (!this.execution || !this.result || this.disposed) return;
    clearTimeout(this.timer);
    const result = this.result;
    result.status = this.cancelled ? 'cancelled' : exitCode === 0 ? 'passed' : Number.isInteger(exitCode) ? 'failed' : 'unknown';
    result.exitCode = exitCode; result.duration = Date.now() - result.started;
    result.diagnostics = [];
    for (const [uri, diagnostics] of this.vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file' || !inside(uri.fsPath, result.cwd)) continue;
      for (const diagnostic of diagnostics.filter(item => item.severity === this.vscode.DiagnosticSeverity.Error)) {
        if (result.diagnostics.length >= 20) break;
        result.diagnostics.push({ file: path.relative(result.cwd, uri.fsPath).split(path.sep).join('/'), line: diagnostic.range.start.line + 1, message: diagnostic.message.slice(0, 2000) });
      }
    }
    this.execution = undefined; this.cancelled = false; this.workflow.activeTest = false; this.workflow.publish();
    void this.refreshFreshness(result).catch(() => {});
  }
  pruneSnapshots() {
    const kept = new Set((this.workflow.records || []).map(turn => turn.test?.id)); kept.add(this.workflow.testResult?.id);
    for (const id of this.snapshots.keys()) if (!kept.has(id)) this.snapshots.delete(id);
  }
  async captureFreshness(result, turn, current = () => {}) {
    this.pruneSnapshots();
    const snapshot = { result, files: new Map(), incomplete: Boolean(turn?.captureError || turn?.before?.skipped || turn?.after?.skipped), unsaved: false };
    this.snapshots.set(result.id, snapshot);
    for (const file of turn?.files || []) {
      const absolute = path.join(result.cwd, file.name);
      try {
        const state = await this.workflow.state(absolute, result.cwd); current(); const value = signature(state);
        if (value === undefined) { snapshot.incomplete = true; continue; }
        snapshot.unsaved ||= Boolean(state?.dirty);
        snapshot.files.set(identity(absolute), { absolute, signature: value, text: state ? digest(state.text) : undefined });
      } catch (error) { current(); snapshot.incomplete = true; }
    }
    result.trackedFilesCount = snapshot.files.size;
    if (!result.stale) result.freshnessNote = snapshot.unsaved ? '本轮文件有未保存内容，任务不一定验证了编辑器中的内容。'
      : snapshot.incomplete ? '部分本轮变化文件无法核对；结果仅代表所选任务。'
        : snapshot.files.size ? '核对范围仅为本轮变化文件；结果仅代表所选测试任务。' : '没有可跟踪的本轮变化文件；仅记录所选任务的退出状态。';
    // 校验只追踪当前已记录的变化，不能据此声称整个工作区已验证。
    this.workflow.publish();
  }
  markStale(result) {
    if (this.disposed || result.stale || !this.freshnessCurrent(result)) return;
    result.stale = true; result.freshness = 'stale'; result.freshnessNote = '测试开始后，本轮变化文件已再次修改；此结果不能验证当前内容，请重新测试。';
    this.workflow.publish();
  }
  changed(uri, document) {
    if (uri?.scheme !== 'file' || this.disposed) return;
    this.pruneSnapshots();
    for (const snapshot of this.snapshots.values()) {
      const file = snapshot.files.get(identity(uri.fsPath)); if (!file) continue;
      if (document && file.text !== digest(document.getText())) this.markStale(snapshot.result);
      void this.refreshFreshness(snapshot.result).catch(() => {});
    }
  }
  freshnessCurrent(result) {
    if (!this.retained(result) || this.disposed) return false;
    try { this.checkOrigin(result); return true; } catch { return false; }
  }
  async refreshFreshness(result = this.workflow.testResult, current) {
    const snapshot = result && this.snapshots.get(result.id);
    if (!snapshot || !this.freshnessCurrent(result) || result.stale) return result;
    if (snapshot.checking) { snapshot.recheck = true; const refreshed = await snapshot.checking; current?.(); return refreshed; }
    snapshot.checking = (async () => {
      do {
        snapshot.recheck = false;
        let unknown = snapshot.incomplete || snapshot.unsaved || !snapshot.files.size, currentDirty = false;
        for (const file of snapshot.files.values()) {
          if (!this.freshnessCurrent(result) || result.stale) break;
          try {
            const state = await this.workflow.state(file.absolute, result.cwd), value = signature(state);
            current?.(); if (!this.freshnessCurrent(result)) return result;
            currentDirty ||= Boolean(state?.dirty); unknown ||= Boolean(state?.dirty);
            if (value === undefined) unknown = true;
            else if (value !== file.signature) this.markStale(result);
          } catch { current?.(); if (!this.freshnessCurrent(result)) return result; unknown = true; }
        }
        if (this.freshnessCurrent(result) && !result.stale) {
          result.freshness = unknown ? 'unknown' : 'current';
          result.freshnessNote = unknown ? snapshot.unsaved ? '测试开始时有未保存内容；无法确认任务验证了编辑器内容。'
            : currentDirty ? '本轮变化文件当前有未保存内容；无法确认任务验证了编辑器内容。'
            : '无法完整核对本轮变化文件；结果仅代表所选任务。'
            : '本轮已记录的变化文件未检测到后续修改；结果仅代表所选任务。';
          this.workflow.publish();
        }
      } while (snapshot.recheck && !result.stale && this.freshnessCurrent(result));
      return result;
    })();
    try { return await snapshot.checking; } finally { snapshot.checking = undefined; }
  }
  retained(result) { return result && (result.turnId ? this.workflow.records.some(turn => turn.id === result.turnId && turn.test === result) : this.workflow.testResult === result); }
  resolve(message, completed = true) {
    if (!message || typeof message.testId !== 'string' || !message.testId || typeof message.turnId !== 'string' ||
        !(typeof message.requestId === 'string' && message.requestId.length > 0 && message.requestId.length <= 128 || Number.isSafeInteger(message.requestId) && message.requestId >= 0)) throw new Error('此次测试操作缺少执行身份，请重新查看结果。');
    const result = message.turnId ? this.workflow.records.find(turn => turn.id === message.turnId)?.test : this.workflow.testResult;
    if (!result || result.id !== message.testId || result.turnId !== message.turnId || !this.retained(result)) throw new Error('测试结果已被覆盖或淘汰，请重新选择仍保留的结果。');
    const scope = this.scope(message);
    this.checkScope(scope);
    this.checkOrigin(result);
    if (completed && ['running', 'cancelling'].includes(result.status)) throw new Error('测试尚未结束。');
    return { result, scope };
  }
  checkResult(result, scope) {
    this.checkScope(scope);
    this.checkOrigin(result);
    if (!this.retained(result)) throw new Error('测试结果已被覆盖或淘汰，请重新选择仍保留的结果。');
  }
  cancel(message) {
    const { result } = this.resolve(message, false);
    if (result !== this.result || !this.workflow.activeTest || !['running', 'cancelling'].includes(result.status)) throw new Error('此测试已结束，未取消其他执行。');
    this.cancelled = true; this.result.status = 'cancelling'; this.workflow.publish(); this.execution?.terminate();
  }
  summary(result) {
    return [`测试任务：${result.label}`, `目录：${result.cwd}`, `执行 ID：${result.id}`, `关联回合：${result.turnId || '无'}`,
      `开始时间：${new Date(result.started).toISOString()}`, `结果：${labels[result.status] || '未知'}`, `退出码：${result.exitCode ?? '未提供'}`,
      `耗时：${((result.duration || 0) / 1000).toFixed(1)} 秒`, result.message || '',
      `变化文件核对：${result.trackedFilesCount || 0} 个；${result.freshnessNote}`,
      '保留范围：每轮只保留最后一次测试结果；已覆盖或淘汰的执行不能再操作。',
      '输出来源：本次未自动取得终端输出。本摘要不包含任务终端输出。',
      ...(result.userLog ? ['用户明确提供的日志（未自动核实属于此次执行）：', result.userLog.text] : []),
      ...(result.diagnostics?.length ? ['结束时的编辑器错误诊断（不是此次执行日志，可能与此任务无关）：', ...result.diagnostics.map(item => `${item.file}:${item.line} ${item.message}`)] : [])].filter(Boolean).join('\n');
  }
  bundle(result) {
    const text = cleanText(this.summary(result));
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new Error('测试证据超过附件 256 KiB 限制，请提供较小的日志片段。');
    return { items: [{ id: `test:${result.id}`, kind: 'content', source: 'test', scope: 'test', turnId: result.turnId, testId: result.id,
      sourcePath: result.cwd, snapshotAt: new Date().toISOString(), name: `测试结果：${result.label}`,
      text, byteLength: Buffer.byteLength(text, 'utf8'), detail: '真实任务退出结果；用户日志未核实归属；发送后才带入对话' }] };
  }
  async preview(message) {
    const { result, scope } = this.resolve(message);
    await this.refreshFreshness(result, () => this.checkResult(result, scope));
    this.checkResult(result, scope); return this.bundle(result);
  }
  async attach(message) { return this.preview(message); }
  async prepare(message) {
    const bundle = await this.preview(message), { result } = this.resolve(message);
    const failed = result.status === 'failed';
    return { ...bundle, text: failed ? `请根据附加的测试结果和明确提供的证据，检查并修复测试任务“${result.label}”此次失败的原因。未取得或未核实的日志不能当作确定证据。完成后提醒我重新运行此测试任务验证。`
      : `请根据附加的测试结果，排查测试任务“${result.label}”的${labels[result.status]}状态。先说明证据和缺少的信息，再处理有依据的问题，完成后提醒我重新运行此测试任务验证。` };
  }
  async supplement(message, logText) {
    const text = cleanLog(logText), { result, scope } = this.resolve(message);
    await this.refreshFreshness(result, () => this.checkResult(result, scope)); this.checkResult(result, scope);
    const turn = this.workflow.records.find(turn => turn.test === result);
    if (turn && turn.files.reduce((bytes, file) => bytes + (file.before?.bytes || 0) + (file.after?.bytes || 0), Buffer.byteLength(text, 'utf8')) > MAX_HISTORY_BYTES) {
      throw new Error('此回合的文件和日志超过本机历史总量限制，请提供较小的日志片段。');
    }
    const prior = result.userLog;
    result.userLog = { source: 'user-provided', verified: false, text, byteLength: Buffer.byteLength(text, 'utf8'), providedAt: Date.now() };
    try { const bundle = this.bundle(result); this.workflow.compact(); this.checkResult(result, scope); this.workflow.publish(); return bundle; }
    catch (error) { result.userLog = prior; this.workflow.compact(); throw error; }
  }
  async provideLog(message) { return this.supplement(message, message.logText); }
  async openTerminal(message) {
    const { result, scope } = this.resolve(message, false);
    await this.vscode.commands.executeCommand('workbench.action.terminal.focus'); this.checkResult(result, scope);
    return { note: '已打开通用终端视图；未自动定位或核实此次测试的专属终端。' };
  }
  async showTerminal(message) { return this.openTerminal(message); }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.snapshots.clear(); if (this.workflow.onTestRetentionChange === this.retentionChanged) delete this.workflow.onTestRetentionChange; if (this.workflow.testSourceCurrent === this.sourceCurrent) delete this.workflow.testSourceCurrent; for (const subscription of this.subscriptions) subscription.dispose(); }
}
module.exports = { WorkspaceTests, MAX_LOG_BYTES, cleanLog };
