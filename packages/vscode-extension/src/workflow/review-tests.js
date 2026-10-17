'use strict';
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { readFileState, inside } = require('./file-state');
const { cleanLog } = require('./tests');
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const signature = state => state === undefined ? 'missing' : state === null ? undefined : `${hash(state.text)}:${state.disk}`;

/** Review verification owns its case and execution, independently of chat turns. */
class ReviewTests {
  constructor({ vscode, views, workflow }) {
    this.vscode = vscode; this.views = views; this.workflow = workflow;
    this.exits = new WeakMap(); this.ended = new WeakSet(); this.snapshots = new Map(); this.drafts = new Map(); this.cleanupTimers = new Set();
    this.subscriptions = [
      vscode.tasks.onDidStartTaskProcess(event => { if (this.execution === event.execution && this.current?.cancelled) event.execution.terminate(); }),
      vscode.tasks.onDidEndTaskProcess(event => { this.exits.set(event.execution, event.exitCode); if (this.execution === event.execution) void this.finish(this.current, event.exitCode); }),
      vscode.tasks.onDidEndTask(event => { this.ended.add(event.execution); if (this.execution === event.execution) this.scheduleUnknown(event.execution); }),
    ];
    const workspace = vscode.workspace;
    for (const method of ['onDidChangeTextDocument', 'onDidSaveTextDocument']) if (workspace[method]) this.subscriptions.push(workspace[method](event => this.changed((event.document || event).uri)));
    for (const method of ['onDidCreateFiles', 'onDidDeleteFiles']) if (workspace[method]) this.subscriptions.push(workspace[method](event => event.files.forEach(uri => this.changed(uri))));
    if (workspace.onDidRenameFiles) this.subscriptions.push(workspace.onDidRenameFiles(event => event.files.forEach(file => { this.changed(file.oldUri); this.changed(file.newUri); })));
    if (workspace.createFileSystemWatcher) {
      const watcher = workspace.createFileSystemWatcher('**/*'); this.subscriptions.push(watcher,
        watcher.onDidChange(uri => this.changed(uri)), watcher.onDidCreate(uri => this.changed(uri)), watcher.onDidDelete(uri => this.changed(uri)));
    }
    this.subscriptions.push(workspace.onDidCloseTextDocument(document => this.drafts.delete(document.uri.toString())));
  }
  guard(cwd) {
    if (this.disposed || !this.vscode.workspace.isTrusted || !this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(cwd))) throw new Error('验证需要原审查对应的受信任工作区。');
  }
  busy() {
    const panel = this.workflow.panel;
    return this.selecting || this.current || this.workflow.activeTest || this.workflow.recording || this.workflow.undoing || panel.session?.busy || panel.queue?.active || panel.newSessionPending;
  }
  async run(op) {
    this.guard(op.cwd);
    if (this.busy()) throw new Error('请等当前任务结束后再运行验证。');
    await this.views.saveReport(op);
    const caseKey = op.caseKey || op.savedKey;
    if (!caseKey) throw new Error('请先保存审查报告和实际修复记录。');
    const record = await this.views.reportStore.read(caseKey);
    if (identity(record.operation.cwd) !== identity(op.cwd) || record.operation.input?.mode !== 'worktree') throw new Error('关联验证当前支持原仓库的未提交变更审查。');
    this.selecting = true;
    try {
      const fixEvents = (await this.views.reportStore.events(caseKey)).filter(event => event.payload.kind === 'fix');
      const baseline = !fixEvents.length;
      const scopeFiles = baseline ? (record.report.findings || []).map(finding => finding.file) : fixEvents.map(event => event.payload.file);
      if (!scopeFiles.length) throw new Error('该报告尚无可关联的修复或发现文件。');
      const folder = this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(op.cwd));
      const available = await this.vscode.tasks.fetchTasks(); this.guard(op.cwd);
      const tasks = available.filter(task => task.group?.id === 'test' && (task.scope?.uri?.toString() === folder.uri.toString() || task.scope === this.vscode.TaskScope.Workspace && this.vscode.workspace.workspaceFolders?.length === 1));
      if (!tasks.length) { void this.vscode.window.showInformationMessage('原工作区尚无测试任务。请配置 group: test 的 VS Code 任务。'); return; }
      const selected = await this.vscode.window.showQuickPick(tasks.map(task => ({ label: task.name, description: task.source, task })), { placeHolder: '选择验证本次修复的工作区测试任务' });
      this.guard(op.cwd); if (!selected) return;
      if (!tasks.includes(selected.task) || this.current || this.workflow.activeTest || this.workflow.panel.session?.busy || this.workflow.panel.queue?.active) throw new Error('当前任务已变化，请稍后再试。');
      const executionId = randomUUID();
      const run = { executionId, caseKey, operationId: op.id, cwd: op.cwd, label: selected.task.name, status: 'running', startedAt: new Date().toISOString(),
        outputSource: 'unavailable', stale: false, scopeNote: `${baseline ? '修复前基线，范围为审查发现文件' : '范围为实际修复文件'}与可读取的任务配置；任务可能另有依赖，未宣称覆盖全部运行输入。`, files: [] };
      const declared = selected.task.execution?.options?.cwd;
      if (typeof declared === 'string' && path.isAbsolute(declared) && !declared.includes('${') && inside(declared, op.cwd)) run.executionCwd = path.resolve(declared);
      let resolve; run.finished = new Promise(done => { resolve = done; }); run.resolve = resolve;
      this.current = run; this.workflow.activeTest = true; this.workflow.publish();
      const names = [...new Set(scopeFiles)];
      const snapshot = { run, files: new Map() }; this.snapshots.set(executionId, snapshot);
      while (this.snapshots.size > 100) this.snapshots.delete(this.snapshots.keys().next().value);
      try {
        await this.views.reportStore.pin(caseKey, executionId);
        for (const name of [...names.slice(0, 64), '.vscode/tasks.json', 'package.json', 'pnpm-lock.yaml']) {
          if (typeof name !== 'string' || !inside(path.resolve(op.cwd, name), op.cwd)) throw new Error('修复记录包含无效文件位置。');
          const file = path.resolve(op.cwd, name);
          const state = await readFileState(this.vscode, file, op.cwd, () => this.guard(op.cwd));
          if (state?.dirty) throw new Error('请先保存修复文件和任务配置，再运行验证。');
          const value = signature(state);
          if (value === undefined || state === undefined && names.includes(name)) throw new Error('验证文件无法完整核对，请检查修复文件。');
          snapshot.files.set(identity(file), { file, signature: value });
          run.files.push(state === undefined ? { name, missing: true } : { name, digest: hash(state.text), diskDigest: state.disk });
        }
        if (names.length > 64) run.scopeNote += '修复文件超过 64 个，范围不完整。';
        this.guard(op.cwd);
        await this.save(run);
        if (run.cancelled) { await this.finish(run); return run; }
        const execution = await this.vscode.tasks.executeTask(selected.task);
        this.execution = execution;
        try { this.guard(op.cwd); } catch (error) { execution.terminate(); throw error; }
        if (run.cancelled) execution.terminate();
        if (this.exits.has(execution)) await this.finish(run, this.exits.get(execution));
        else if (this.ended.has(execution)) this.scheduleUnknown(execution);
        return run;
      } catch (error) { await this.finish(run, undefined, error); throw error; }
    } finally { this.selecting = false; }
  }
  evidence(run) {
    return { kind: 'test', executionId: run.executionId, label: run.label, status: run.status, cwd: run.cwd,
      startedAt: run.startedAt, finishedAt: run.finishedAt, exitCode: run.exitCode, outputSource: run.outputSource,
      stale: run.stale, scopeNote: run.scopeNote, executionCwd: run.executionCwd, files: run.files };
  }
  async save(run) {
    try { await this.views.recordEvidence(run.caseKey, this.evidence(run)); }
    catch { run.unsaved = true; void this.vscode.window.showInformationMessage('测试执行状态已取得，本地验证记录未保存。'); }
  }
  scheduleUnknown(execution) {
    clearTimeout(this.timer); this.timer = setTimeout(() => { if (this.execution === execution) void this.finish(this.current); }, 100);
  }
  async finish(run, exitCode, error) {
    if (!run || run.finishing || this.current !== run) return;
    run.finishing = true; clearTimeout(this.timer); this.execution = undefined;
    run.status = run.cancelled ? 'cancelled' : error ? 'error' : exitCode === 0 ? 'passed' : Number.isInteger(exitCode) ? 'failed' : 'unknown';
    run.exitCode = exitCode; run.finishedAt = new Date().toISOString();
    try {
      for (const value of this.snapshots.get(run.executionId)?.files.values() || []) {
        try { if (signature(await readFileState(this.vscode, value.file, run.cwd, () => this.guard(run.cwd))) !== value.signature) run.stale = true; }
        catch { run.scopeNote += '结束时未能完整核对记录范围。'; break; }
      }
      await this.save(run);
    } finally {
      try { await this.views.reportStore.unpin(run.caseKey, run.executionId); }
      catch { run.cleanupPending = true; this.retryUnpin(run); void this.vscode.window.showInformationMessage('验证已结束，本地空间保护清理未完成。'); }
      finally {
        if (this.current === run) { this.current = undefined; this.workflow.activeTest = false; this.workflow.publish(); }
        run.resolve(run);
      }
    }
  }
  retryUnpin(run, attempt = 1) {
    if (this.disposed || attempt > 3) return;
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      void this.views.reportStore.unpin(run.caseKey, run.executionId).then(() => { run.cleanupPending = false; }, () => this.retryUnpin(run, attempt + 1));
    }, 250 * attempt);
    this.cleanupTimers.add(timer);
  }
  cancel(id) {
    const run = this.current;
    if (!run || id && id !== run.operationId && id !== run.executionId) return;
    run.cancelled = true; this.execution?.terminate();
  }
  changed(uri) {
    if (uri?.scheme !== 'file') return;
    for (const { run, files } of this.snapshots.values()) if (!run.stale && files.has(identity(uri.fsPath))) {
      run.stale = true; if (run.status !== 'running') void this.save(run);
    }
  }
  async provideLog(item) {
    const editor = this.vscode.window.activeTextEditor?.document;
    const draft = editor && this.drafts.get(editor.uri.toString());
    if (draft) {
      this.guard(draft.cwd); const text = cleanLog(editor.getText());
      await this.views.recordEvidence(draft.caseKey, { kind: 'log', executionId: draft.executionId, source: 'user-unverified', text });
      this.drafts.delete(editor.uri.toString()); void this.vscode.window.showInformationMessage('日志已保存，来源标为用户提供，归属未经核实。'); return;
    }
    const op = await this.views.selectReview(item); if (!op?.savedKey) return;
    this.guard(op.cwd); const caseKey = op.caseKey || op.savedKey;
    const runs = new Map(); for (const event of await this.views.reportStore.events(caseKey)) if (event.payload.kind === 'test' && event.payload.status !== 'running') runs.set(event.payload.executionId, event.payload);
    const choice = await this.vscode.window.showQuickPick([...runs.values()].reverse().map(run => ({ label: run.label, description: `${run.status} · ${run.executionId}`, run })), { placeHolder: '选择日志所属的测试执行' });
    if (!choice) return; this.guard(op.cwd);
    const document = await this.vscode.workspace.openTextDocument({ language: 'plaintext', content: '' });
    this.drafts.set(document.uri.toString(), { caseKey, cwd: op.cwd, executionId: choice.run.executionId });
    await this.vscode.window.showTextDocument(document, { preview: false });
    void this.vscode.window.showInformationMessage('粘贴本次执行的日志片段，再执行“DSH：保存或补充验证日志”。最多 128 KiB。');
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer); for (const timer of this.cleanupTimers) clearTimeout(timer); this.cleanupTimers.clear(); this.current && this.cancel(this.current.executionId);
    if (this.current) void this.finish(this.current);
    this.subscriptions.forEach(item => item.dispose()); this.drafts.clear();
  }
}
module.exports = { ReviewTests };
