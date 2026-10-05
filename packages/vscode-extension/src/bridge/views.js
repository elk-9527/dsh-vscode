'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { findingLocation, repositorySnapshot, validateReviewInput, reportText } = require('./results');
const { EXPECTED, capabilityState } = require('./availability');
const { OperationStore, ACTIVE, TERMINAL, LABELS } = require('./operations');
const { inspectProfile, installationPlan, profileReport } = require('../diagnostics/profiles');
const { installRegistry, runAsync } = require('../diagnostics/install');

const REVIEW = 'michengai.code-review.run';
const SKILLS = 'linxin.skill-explorer.';
/** 原生能力与运行视图；初始化不启动内核，只有展开视图或显式命令才建立连接。 */
class BridgeViews {
  constructor({ context, connections, panel, log }) {
    this.context = context; this.connections = connections; this.panel = panel; this.log = log;
    this.catalog = { capabilities: [] }; this.documents = new Map(); this.reports = new Map(); this.reportOwners = new Map(); this.skillDrafts = new Map();
    const stored = context.workspaceState.get('dshPanel.bridge.records.v2');
    this.operations = new OperationStore({ ...(stored || { records: context.workspaceState.get('dshPanel.bridge.active', []).map(op => ({ ...op, status: 'running' })) }), onRemove: op => this.cleanupReport(op) });
    this.capabilityEmitter = new vscode.EventEmitter(); this.operationEmitter = new vscode.EventEmitter();
    this.documentEmitter = new vscode.EventEmitter(); this.diagnostics = vscode.languages.createDiagnosticCollection('DSH Review');
    this.retained = new Map(); this.runningRepositories = new Set(); this.waiters = new Map(); this.timers = new Map(); this.disposed = false;
    this.connectionSignature = JSON.stringify(connections.snapshot());
    const refreshOperations = () => { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => {
      this.operationEmitter.fire();
    }, 50); };
    this.onOperation = event => {
      const wasPending = this.operations.get(event?.operationId)?.status === 'pending-restore';
      if (this.operations.event(event)) {
        const op = this.operations.get(event.operationId);
        if (ACTIVE.has(op?.status)) this.retain(op.id);
        if (TERMINAL.has(op?.status)) {
          this.release(op.id);
          if (wasPending && op.status === 'completed' && op.result && !this.waiters.has(op.id)) void this.presentReport(op.id, op.result).catch(error => this.showError(error));
        }
        refreshOperations(); void this.saveActive();
      }
    };
    this.onCatalog = () => this.refresh().catch(error => this.showError(error));
    this.onState = state => {
      if (['disconnected', 'error', 'authorization-expired'].includes(state.state)) {
        if (state.state !== 'authorization-expired') this.catalog = { capabilities: [] };
        for (const op of this.operations.values()) if (ACTIVE.has(op.status)) op.status = 'pending-restore';
        void this.saveActive();
      }
      const signature = JSON.stringify({ ...connections.snapshot(), state: state.state });
      if (signature !== this.connectionSignature) { this.connectionSignature = signature; this.capabilityEmitter.fire(); }
      refreshOperations(); if (state.state === 'ready') void this.restore().catch(() => {});
    };
    connections.on('operation', this.onOperation); connections.on('catalogChanged', this.onCatalog); connections.on('state', this.onState);
    context.subscriptions.push(this.capabilityEmitter, this.operationEmitter, this.documentEmitter, this.diagnostics,
      vscode.window.registerTreeDataProvider('dshPanel.capabilities', { onDidChangeTreeData: this.capabilityEmitter.event,
        getTreeItem: item => item, getChildren: item => this.capabilityChildren(item) }),
      vscode.window.registerTreeDataProvider('dshPanel.operations', { onDidChangeTreeData: this.operationEmitter.event,
        getTreeItem: item => item, getChildren: () => [...this.operations.values()].reverse().map(op => {
          const item = new vscode.TreeItem(op.title || '代码审查'); item.id = op.id; item.description = LABELS[op.status];
          item.contextValue = op.status === 'running' ? 'dshRunningOperation' : op.status === 'completed' && op.result ? 'dshCompletedReview' : TERMINAL.has(op.status) ? 'dshFinishedOperation' : 'dshPendingOperation';
          item.iconPath = new vscode.ThemeIcon(ACTIVE.has(op.status) ? 'clock' : op.status === 'completed' ? 'pass' : 'circle-slash');
          item.tooltip = [LABELS[op.status], op.cwd, op.startedAt && `开始：${op.startedAt}`, op.updatedAt && `更新：${op.updatedAt}`, op.finishedAt && `结束：${op.finishedAt}`, op.reason].filter(Boolean).join('\n');
          item.accessibilityInformation = { label: `${op.title || '代码审查'}，${LABELS[op.status]}` };
          item.command = { command: 'dshPanel.bridge.openReport', title: '打开运行详情', arguments: [op.id] }; return item;
        }) }),
      vscode.workspace.registerTextDocumentContentProvider('dsh-result', { onDidChange: this.documentEmitter.event,
        provideTextDocumentContent: uri => this.documents.get(uri.toString()) || '记录不存在或已经过期。' }),
      ...[
        ['refresh', () => this.refresh()], ['review', () => this.review()], ['skills', () => this.searchSkills()],
        ['readSkill', item => this.readSkill(item)], ['openReport', id => this.openReport(id)], ['attachReview', item => this.attachReview(item)],
        ['manageSkills', () => this.manageSkills()], ['applySkillDraft', () => this.applySkillDraft()],
        ['cancel', item => this.cancel(typeof item === 'string' ? item : item?.id)], ['diagnose', () => this.diagnose()],
        ['diagnoseConfig', () => this.diagnoseConfig()], ['copyDiagnostics', () => this.copyDiagnostics()],
        ['installGuide', () => this.installGuide()], ['reloadOwned', () => this.reloadOwned()],
        ['retry', item => this.retry(item)], ['remove', item => this.removeOperation(item)], ['clearFinished', () => this.clearFinished()],
      ].map(([name, fn]) => vscode.commands.registerCommand(`dshPanel.bridge.${name}`, async (...args) => {
        try { return await fn(...args); } catch (error) { this.showError(error, name); }
      })),
      vscode.workspace.onDidSaveTextDocument(document => {
        const identity = file => process.platform === 'win32' ? file.toLowerCase() : file;
        for (const [cwd, files] of this.reports) if (files.some(file => identity(file) === identity(document.uri.fsPath))) {
          for (const file of files) this.diagnostics.delete(vscode.Uri.file(file)); this.reports.delete(cwd);
        }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        this.skillDrafts.delete(document.uri.toString());
        if (document.uri.scheme === 'dsh-result' && ![...this.operations.values()].some(op => op.uri?.toString() === document.uri.toString())) this.documents.delete(document.uri.toString());
      }),
      vscode.workspace.onDidGrantWorkspaceTrust?.(() => this.capabilityEmitter.fire()) || { dispose() {} },
      { dispose: () => this.dispose() });
  }
  showError(error, action) {
    this.log('warn', `插件操作未完成（操作：${action || 'background'}，错误码：${Number.isInteger(error?.code) ? error.code : 'unknown'}）`);
    if (error?.code === -32050 && error.backup) {
      const uri = this.document('installation-failure.md', `# 安装恢复说明\n\n${error.message}\n\n备份位置：${error.backup}\n\n保存的目标清单、锁文件、配置补丁与旧包可用于恢复。先停止该目标的空闲内核，按原清单中的精确版本或原文件来源重新安装，再核对磁盘版本及能力注册。配置备份可能包含私有设置，应仅在本机使用。`);
      void vscode.window.showErrorMessage('插件安装未通过，已保留目标配置和旧包备份。', '查看恢复说明').then(async choice => {
        if (choice) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      }); return;
    }
    void vscode.window.showErrorMessage(['manageSkills', 'applySkillDraft'].includes(action) ? '技能修改未完成，请刷新列表并重新预览。原内容保留在技能或恢复目录。'
      : error?.code === -32045 ? '当前会话已有运行，请等待或取消。'
      : error?.code === -32044 ? '该操作需要受信任的工作区。'
      : error?.code === -32043 ? '当前连接没有提供此能力，请检查已安装插件。'
      : error?.code === -32047 ? '运行记录已经过期，请重新运行。'
      : error?.code === -32048 ? '插件执行失败，请查看运行记录。'
      : error?.code === -32051 ? '原审查范围、分支或提交已经失效，请重新选择审查范围。'
      : error?.code === -32052 ? '无法核对内核身份，插件执行已受限。可查看连接诊断，普通聊天仍可使用。'
      : ['skills', 'readSkill'].includes(action) ? '无法打开技能，请刷新技能列表后重试。'
      : '插件操作未完成，请检查连接和插件状态。', '查看日志').then(choice => {
        if (choice) return vscode.commands.executeCommand('dshPanel.showLog');
      });
  }
  async bridge() {
    await this.connections.ensure();
    if (!this.connections.bridge?.supported) throw new Error('当前连接尚未支持插件操作');
    return this.connections.bridge;
  }
  async refresh() {
    const catalog = await this.readCatalog();
    if (!this.disposed) this.capabilityEmitter.fire();
    return catalog;
  }
  /** 视图取数不发送树更新事件，避免加载结束后再次触发自身加载。 */
  async readCatalog() {
    if (this.refreshPending) return this.refreshPending;
    this.refreshPending = (async () => {
      this.retain('bridge-catalog');
      try { const bridge = await this.bridge(); this.catalog = await bridge.catalog();
        try { await bridge.auth?.(); } catch { this.log('warn', '连接身份尚未确认，插件执行受限'); }
        return this.catalog;
      } finally { this.release('bridge-catalog'); }
    })().finally(() => { this.refreshPending = undefined; });
    return this.refreshPending;
  }
  async capabilityChildren(parent) {
    if (parent) return [];
    try { await this.readCatalog(); } catch { this.catalog = { capabilities: [] }; }
    const connection = this.connections.snapshot();
    const installed = connection.profile ? inspectProfile(connection.profile) : undefined;
    return EXPECTED.filter(item => [REVIEW, `${SKILLS}list`].includes(item.id)).map(expected => {
      const capability = this.catalog.capabilities.find(item => item.id === expected.id) || { ...expected, missing: true };
      const state = capabilityState({ capability, connected: connection.connected, supported: connection.supported, trusted: vscode.workspace.isTrusted, authorized: connection.authorized === true, profileKnown: Boolean(connection.profile && installed?.exists), installed: expected ? Boolean(installed?.packages.find(x => x.name === expected.package)?.installed) : undefined });
      const title = capability.id === REVIEW ? '审查代码' : '浏览技能';
      const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
      item.id = capability.id; item.capability = capability;
      item.description = state.executable ? '' : state.detail;
      item.tooltip = state.executable ? capability.id === REVIEW ? '选择审查范围，查看代码问题和报告' : '选择技能，打开使用说明' : `${state.detail}\n${state.action}`;
      item.accessibilityInformation = { label: `${title}，${state.detail}` };
      item.contextValue = state.executable ? 'dshAvailableCapability' : 'dshUnavailableCapability';
      item.iconPath = new vscode.ThemeIcon(state.executable ? 'pass' : state.state === 'disconnected' ? 'plug' : 'warning');
      if (state.executable) {
        if (capability.id === REVIEW) item.command = { command: 'dshPanel.bridge.review', title: '审查代码变更' };
        if (capability.id === `${SKILLS}list`) item.command = { command: 'dshPanel.bridge.skills', title: '浏览技能' };
      } else item.command = { command: state.command, title: state.action };
      return item;
    });
  }
  async chooseWorkspace() {
    const folders = vscode.workspace.workspaceFolders || [];
    const active = vscode.window.activeTextEditor?.document?.uri;
    const matching = active && vscode.workspace.getWorkspaceFolder(active);
    if (matching) return matching.uri.fsPath;
    if (folders.length === 1) return folders[0].uri.fsPath;
    if (!folders.length) return undefined;
    const picked = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: '选择工作区' });
    return picked?.folder.uri.fsPath;
  }
  retain(id) {
    if (this.retained.has(id)) return;
    const owner = { id }; this.connections.acquire(id);
    const cfg = this.panel.config(); const entry = this.panel.kernels.live(cfg.host, cfg.selfStartPort);
    if (entry) {
      this.panel.kernels.acquire(owner, entry);
      if (ACTIVE.has(this.operations.get(id)?.status)) { entry.activeBridgeRuns.add(id); owner.entry = entry; }
    }
    this.retained.set(id, owner);
  }
  release(id) {
    const owner = this.retained.get(id);
    if (owner) {
      if (!this.disposed || !ACTIVE.has(this.operations.get(id)?.status)) owner.entry?.activeBridgeRuns.delete(id);
      this.panel.kernels.release(owner);
    }
    this.retained.delete(id); this.connections.release(id);
  }
  async invoke(id, input, { cwd, sessionId, approved = false } = {}) {
    const consumer = `bridge-request:${randomUUID()}`; this.retain(consumer);
    try {
      const bridge = await this.bridge();
      const catalog = await bridge.catalog();
      const capability = catalog.capabilities.find(item => item.id === id);
      const state = capabilityState({ capability, connected: true, supported: bridge.supported, trusted: vscode.workspace.isTrusted });
      if (!state.executable) throw Object.assign(new Error(), { code: state.state === 'restricted' ? -32044 : -32043 });
      return await bridge.request('invoke', { requestId: randomUUID(), capabilityId: id, input,
        context: { cwd: cwd || this.panel.workdir(), sessionId, workspaceTrusted: vscode.workspace.isTrusted === true, userInitiated: true, approved: approved === true } });
    } finally { this.release(consumer); }
  }
  async review() {
    if (!vscode.workspace.isTrusted) throw Object.assign(new Error(), { code: -32044 });
    const selected = await this.chooseWorkspace(); if (!selected) return;
    const scope = await vscode.window.showQuickPick([
      { label: '未提交变更', mode: 'worktree' }, { label: '与基准分支比较', mode: 'base' },
      { label: '指定提交', mode: 'commit' }, { label: '自定义审查要求', mode: 'custom' },
    ], { placeHolder: '选择审查范围' }); if (!scope) return;
    const input = { mode: scope.mode };
    if (scope.mode !== 'worktree') {
      const field = scope.mode === 'custom' ? 'instructions' : 'ref';
      const text = await vscode.window.showInputBox({ prompt: scope.mode === 'custom' ? '输入审查要求' : '输入分支或提交', ignoreFocusOut: true });
      if (!text?.trim()) return; input[field] = text.trim();
    }
    return this.reviewRequest({ cwd: selected, input });
  }
  async reviewRequest({ cwd, input, userInitiated = true, retryOf, signal }) {
    if (!vscode.workspace.isTrusted || userInitiated !== true) throw Object.assign(new Error(), { code: -32044 });
    if (signal?.aborted) throw Object.assign(new Error('审查已取消'), { code: -32800 });
    if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) throw new Error('审查目录不在工作区内');
    // 先占用选定目录，避免连续点击在异步快照阶段同时进入。
    const selectedKey = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    if (this.runningRepositories.has(selectedKey)) throw Object.assign(new Error(), { code: -32045 });
    this.runningRepositories.add(selectedKey);
    let snapshot;
    try { await validateReviewInput(cwd, input); snapshot = await repositorySnapshot(cwd); } catch (error) { this.runningRepositories.delete(selectedKey); throw error; }
    if ([...this.operations.values()].some(op => ACTIVE.has(op.status) && op.cwd === snapshot.cwd)) { this.runningRepositories.delete(selectedKey); throw Object.assign(new Error(), { code: -32045 }); }
    this.retain(`review-pending:${snapshot.cwd}`);
    try {
    if (retryOf) {
      const previous = this.operations.get(retryOf);
      const changed = previous?.fingerprint !== snapshot.fingerprint;
      const modes = { worktree: '当前未提交变更', base: '当前变更与基准分支的差异', commit: '指定提交', custom: '自定义审查要求' };
      const uri = this.document('retry-preview.md', `# 重新运行审查\n\n范围：${modes[input.mode]}${input.ref ? '（' + input.ref.replace(/[\r\n`<>\[\]]/g, '') + '）' : ''}\n\n${changed ? '代码快照已变化，本次使用当前内容重新审查。' : '代码快照与原运行一致，本次仍建立独立的新运行。'}\n\n原记录和原报告保留，新的发现仅按本次快照定位。`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    }
    await this.bridge();
    if (!vscode.workspace.isTrusted || signal?.aborted) throw Object.assign(new Error('审查无法继续'), { code: signal?.aborted ? -32800 : -32044 });
    const session = await this.connections.sessionFor(`review:${snapshot.cwd}`, snapshot.cwd, { preset: this.panel.wantedPreset(), provider: this.panel.config().provider, model: this.panel.config().model });
    const releasePermissions = this.reviewPermissions(session);
    try {
    const run = await this.invoke(REVIEW, input, { cwd: snapshot.cwd, sessionId: session.sessionId });
    if (run.mode !== 'operation') throw new Error('运行协议无效');
    const existing = this.operations.get(run.operationId);
    const connection = this.connections.snapshot();
    this.operations.set(run.operationId, { ...existing, id: run.operationId, title: '代码审查', status: existing?.status || 'running', seq: existing?.seq || 0, cwd: snapshot.cwd, fingerprint: snapshot.fingerprint, input: { ...input }, retryOf, instanceId: connection.instanceId, clientId: this.connections.clientId, startedAt: existing?.startedAt || new Date().toISOString() });
    this.retain(run.operationId); await this.saveActive(); this.operationEmitter.fire();
    const abort = () => { void this.cancel(run.operationId).catch(error => this.showError(error)); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在审查代码变更', cancellable: true }, async (_progress, token) => {
      const cancelSubscription = token.onCancellationRequested(() => this.cancel(run.operationId).catch(error => this.showError(error)));
      try {
        const result = await this.waitOperation(run.operationId);
        if (result.status === 'completed' && result.result) await this.presentReport(run.operationId, result.result);
        else if (result.status === 'failed') throw Object.assign(new Error(), { code: -32048 });
      } finally { cancelSubscription.dispose(); if (TERMINAL.has(this.operations.get(run.operationId)?.status)) this.release(run.operationId); await this.saveActive(); }
    }); } finally { signal?.removeEventListener('abort', abort); }
    return this.operations.get(run.operationId);
    } finally { releasePermissions(); }
    } finally { this.runningRepositories.delete(selectedKey); this.release(`review-pending:${snapshot.cwd}`); }
  }
  reviewPermissions(session) {
    if (!session.client?.on) return () => {};
    const token = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : undefined;
    const pending = new Set(); let closed = false;
    const receive = async (id, params) => {
      if (params?.sessionId !== session.sessionId) return;
      let decline;
      const cancellation = new Promise(resolve => { decline = () => resolve(undefined); pending.add(decline); });
      let selected;
      try { selected = await Promise.race([vscode.window.showQuickPick((params.options || []).map(option => ({ label: option.name, optionId: option.optionId })), { placeHolder: params.toolCall?.title || '审查请求执行工具', ignoreFocusOut: true }, token?.token), cancellation]); } catch {}
      pending.delete(decline);
      const answer = !closed && vscode.workspace.isTrusted && params.options?.some(option => option.optionId === selected?.optionId) ? selected.optionId : undefined;
      if (session.client.isConnected) session.answerPermission(id, answer);
    };
    session.client.on('permission', receive);
    return () => { closed = true; token?.cancel(); token?.dispose(); for (const decline of pending) decline(); session.client.off('permission', receive); };
  }
  waitOperation(id) {
    if (this.waiters.has(id)) return this.waiters.get(id);
    const pending = this.pollOperation(id).finally(() => this.waiters.delete(id));
    this.waiters.set(id, pending); return pending;
  }
  async pollOperation(id) {
    while (!this.disposed) {
      const op = this.operations.get(id); if (!op) return { status: 'removed' };
      try {
        const bridge = await this.bridge(), connection = this.connections.snapshot();
        if ((op.instanceId && op.instanceId !== connection.instanceId) || (op.clientId && op.clientId !== this.connections.clientId)) {
          this.operations.unavailable(id, '原内核或客户端身份已变化，无法恢复该运行'); break;
        }
        if (!op.cwd || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(op.cwd))) { this.operations.unavailable(id, op.cwd ? '原工作区已不在当前窗口' : '运行上下文不完整，无法确认原工作区'); break; }
        const snapshot = await bridge.request('operation/get', { operationId: id });
        this.operations.snapshot(id, snapshot); this.operationEmitter.fire(); await this.saveActive();
        if (TERMINAL.has(op.status)) return op;
      } catch (error) {
        if (error?.code === -32047) this.operations.unavailable(id, '运行记录已过期、提供方已卸载或不属于当前客户端');
        else if (error?.code === -32042) this.operations.unavailable(id, '原内核已不再支持运行查询');
        else op.status = 'pending-restore';
        this.operationEmitter.fire(); await this.saveActive(); return op;
      }
      await new Promise(resolve => { this.timers.set(id, { timer: setTimeout(() => { this.timers.delete(id); resolve(); }, 1000), resolve }); });
    }
    this.operationEmitter.fire(); await this.saveActive(); return this.operations.get(id) || { status: 'disconnected' };
  }
  async presentReport(id, report) {
    const op = this.operations.get(id); if (!op?.cwd) return;
    const current = await repositorySnapshot(op.cwd); const stale = current.fingerprint !== op.fingerprint;
    for (const file of this.reports.get(op.cwd) || []) this.diagnostics.delete(vscode.Uri.file(file));
    const mapped = new Map();
    if (!stale) for (const finding of Array.isArray(report.findings) ? report.findings : []) {
      const location = findingLocation(op.cwd, finding); if (!location) continue;
      const severity = finding.priority === 'P0' || finding.priority === 'P1' ? vscode.DiagnosticSeverity.Error
        : finding.priority === 'P2' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(location.start, 0, location.end, location.endCharacter), `${finding.title || ''}\n${finding.body || ''}`, severity);
      diagnostic.source = 'DSH'; const list = mapped.get(location.file) || []; list.push(diagnostic); mapped.set(location.file, list);
    }
    for (const [file, diagnostics] of mapped) this.diagnostics.set(vscode.Uri.file(file), diagnostics);
    this.reports.set(op.cwd, [...mapped.keys()]); this.reportOwners.set(op.cwd, id); op.result = report; op.stale = stale;
    op.uri = this.document(`review/${id}.md`, reportText(report, stale));
    await this.openReport(id);
  }
  document(key, text) { const uri = vscode.Uri.parse(`dsh-result:/${key}`); this.documents.set(uri.toString(), text); this.documentEmitter.fire(uri); return uri; }
  async openReport(id) {
    id = typeof id === 'string' ? id : id?.id;
    const op = this.operations.get(id); if (!op) return;
    if (!op.uri && op.status === 'completed' && op.result) await this.presentReport(id, op.result);
    if (!op.uri) {
      const retry = op.input ? '\n可通过运行记录的“重新运行”发起一次新的审查。' : '';
      op.uri = this.document(`operation/${id}.md`, `# 运行详情\n\n状态：${LABELS[op.status]}\n\n${op.reason || (op.status === 'completed' ? '完整报告仅在生成报告的窗口会话内保存。' : '尚无完整报告。')}\n${retry}`);
    }
    if (op.uri) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(op.uri), { preview: true });
  }
  async cancel(id) {
    const op = this.operations.get(id); if (!op || op.status !== 'running') return;
    op.status = 'cancelling'; this.operationEmitter.fire(); await this.saveActive();
    try {
      const bridge = await this.bridge(), result = await bridge.request('cancel', { operationId: id });
      if (!TERMINAL.has(op.status) && TERMINAL.has(result.status)) { op.status = result.status; op.finishedAt = new Date().toISOString(); }
      if (TERMINAL.has(op.status)) this.release(id);
    } catch (error) { if (!TERMINAL.has(op.status)) op.status = this.connections.snapshot().connected ? 'running' : 'pending-restore'; throw error; }
    finally { await this.saveActive(); this.operationEmitter.fire(); }
  }
  async attachReview(item) {
    if (!vscode.workspace.isTrusted) throw Object.assign(new Error(), { code: -32044 });
    let id = typeof item === 'string' ? item : item?.id;
    if (!id) {
      const reports = [...this.operations.values()].reverse().filter(op => op.status === 'completed' && op.result);
      if (!reports.length) { void vscode.window.showInformationMessage('当前没有可带入对话的审查报告。'); return; }
      const selected = await vscode.window.showQuickPick(reports.map(op => ({ label: '代码审查', description: op.finishedAt || op.startedAt, id: op.id })), { placeHolder: '选择审查报告' });
      if (!selected) return;
      id = selected.id;
    }
    const op = this.operations.get(id);
    if (!op || op.status !== 'completed' || !op.result) { void vscode.window.showInformationMessage('该记录没有可带入对话的完整报告。'); return; }
    if (!op.cwd || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(op.cwd))) { void vscode.window.showInformationMessage('审查报告的工作区已不在当前窗口。'); return; }
    const identity = cwd => process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    if (identity(op.cwd) !== identity(this.panel.workdir())) { void vscode.window.showInformationMessage('请在审查报告对应的工作区对话中使用此报告。'); return; }
    const current = await repositorySnapshot(op.cwd);
    if (!vscode.workspace.isTrusted) throw Object.assign(new Error(), { code: -32044 });
    if (this.operations.get(id) !== op || op.status !== 'completed') return;
    const stale = current.fingerprint !== op.fingerprint;
    const text = reportText(op.result, stale);
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) { void vscode.window.showInformationMessage('报告过大，请从完整报告中选择需要讨论的内容。'); return; }
    const count = Array.isArray(op.result.findings) ? op.result.findings.length : 0;
    await this.panel.attach([{ kind: 'review', id: `review:${op.id}`, name: '代码审查报告', mimeType: 'text/markdown', text,
      detail: `${count} 条发现${stale ? '，代码已变化' : ''}`, finishedAt: op.finishedAt || op.startedAt }]);
  }
  async skillChildren() {
    const cwd = await this.chooseWorkspace() || this.panel.workdir();
    const result = await this.invoke(`${SKILLS}list`, {}, { cwd });
    return (result.value?.groups || []).filter(group => group.skills.length).map(group => {
      const item = new vscode.TreeItem(group.title, vscode.TreeItemCollapsibleState.Collapsed); item.id = `skills:${cwd}:${group.key}`;
      item.items = group.skills.map(skill => {
        const child = new vscode.TreeItem(skill.name); child.id = `skill:${cwd}:${skill.id}`; child.skill = skill; child.cwd = cwd;
        child.description = skill.modelInvocable ? '' : '模型不可调用'; child.tooltip = skill.description;
        child.command = { command: 'dshPanel.bridge.readSkill', title: '读取技能', arguments: [{ skill, cwd }] }; return child;
      }); return item;
    });
  }
  async searchSkills() {
    const groups = await this.skillChildren(); const skills = groups.flatMap(group => group.items);
    if (!skills.length) { void vscode.window.showInformationMessage('当前没有可浏览的技能。'); return; }
    const selected = await vscode.window.showQuickPick(skills.map(item => ({ label: item.label, description: item.skill.description, item })), { placeHolder: '搜索技能', matchOnDescription: true });
    if (selected) await this.readSkill(selected.item);
  }
  async readSkill({ skill, cwd }) {
    const result = await this.invoke(`${SKILLS}read`, { skillId: skill.id }, { cwd });
    const uri = this.document(`skill/${encodeURIComponent(skill.id)}.md`, String(result.value?.content || '该技能没有可读取的正文。'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }
  async manageSkills() {
    if (!vscode.workspace.isTrusted) throw Object.assign(new Error(), { code: -32044 });
    const cwd = await this.chooseWorkspace(); if (!cwd) return;
    const action = await vscode.window.showQuickPick([
      { label: '编辑技能', action: 'update' }, { label: '启用或禁用技能', action: 'enabled' },
      { label: '新建技能', action: 'create' }, { label: '删除技能', action: 'delete' }, { label: '恢复已删除技能', action: 'restore' },
    ], { placeHolder: '管理文件技能' }); if (!action) return;
    let input = { action: action.action }, content;
    if (action.action === 'restore') {
      const result = await this.invoke(`${SKILLS}trash`, {}, { cwd });
      const entries = (result.value?.entries || []).filter(item => item.action === 'delete');
      if (!entries.length) { void vscode.window.showInformationMessage('当前没有可恢复的已删除技能。'); return; }
      const picked = await vscode.window.showQuickPick(entries.map(item => ({ label: item.name, description: `${item.scope} · ${item.time}`, item })), { placeHolder: '选择恢复记录' });
      if (!picked) return; input.trashId = picked.item.id;
    } else if (action.action === 'create') {
      const scope = await vscode.window.showQuickPick([{ label: '当前项目', scope: 'project-dsh' }, { label: '用户技能（所有项目共享）', scope: 'user-dsh' }], { placeHolder: '选择新技能的保存范围' });
      if (!scope) return;
      const name = await vscode.window.showInputBox({ prompt: '技能名称（小写字母、数字和连字符，最多 64 字符）', validateInput: value => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value) ? undefined : '请输入有效的技能名称' });
      if (!name) return;
      input = { ...input, scope: scope.scope, name };
      content = `---\nname: ${name}\ndescription: Describe when to use this skill\n---\n\nWrite the skill instructions here.\n`;
    } else {
      const result = await this.invoke(`${SKILLS}list`, {}, { cwd });
      const skills = (result.value?.groups || []).flatMap(group => group.skills.filter(skill => skill.editable).map(skill => ({ label: skill.name, description: group.title, skill })));
      if (!skills.length) { void vscode.window.showInformationMessage('当前没有可修改的文件技能。系统、运行时和链接技能为只读。'); return; }
      const picked = await vscode.window.showQuickPick(skills, { placeHolder: '选择要修改的技能' }); if (!picked) return;
      input.skillId = picked.skill.id;
      if (action.action === 'enabled') input.enabled = picked.skill.modelInvocable === false;
      if (action.action === 'update') content = (await this.invoke(`${SKILLS}read`, { skillId: input.skillId }, { cwd })).value.content;
    }
    if (content !== undefined) {
      if (this.skillDrafts.size >= 20) { void vscode.window.showInformationMessage('请先应用或关闭旧的技能草稿。'); return; }
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      this.skillDrafts.set(document.uri.toString(), { cwd, input });
      await vscode.window.showTextDocument(document, { preview: false });
      void vscode.window.showInformationMessage('修改正文后，执行“DSH：预览并应用技能修改”。草稿尚未写入技能目录。'); return;
    }
    return this.confirmSkill(input, cwd);
  }
  async applySkillDraft() {
    const document = vscode.window.activeTextEditor?.document;
    const draft = document && this.skillDrafts.get(document.uri.toString());
    if (!draft) { void vscode.window.showInformationMessage('请先通过“DSH：管理技能”打开技能草稿。'); return; }
    if (draft.applying) return;
    draft.applying = true;
    try {
      if (await this.confirmSkill({ ...draft.input, content: document.getText() }, draft.cwd)) this.skillDrafts.delete(document.uri.toString());
    } finally { draft.applying = false; }
  }
  async confirmSkill(input, cwd) {
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) throw Object.assign(new Error(), { code: -32044 });
    const result = await this.invoke(`${SKILLS}preview`, input, { cwd }), preview = result.value;
    const before = this.document(`skill-diff/${preview.planId}-before.md`, preview.before);
    const after = this.document(`skill-diff/${preview.planId}-after.md`, preview.after);
    await vscode.commands.executeCommand('vscode.diff', before, after, 'DSH 技能修改预览', { preview: false });
    const actions = { update: '保存修改', create: '新建技能', enabled: '更改启用状态', delete: '删除技能', restore: '恢复技能' };
    const choice = await vscode.window.showInformationMessage(`${actions[input.action]}：${preview.file}${preview.scope.startsWith('user') ? '（用户技能，所有项目共享）' : ''}。原内容将保留在恢复目录。`, '确认应用', '取消');
    if (choice !== '确认应用') return false;
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) throw Object.assign(new Error(), { code: -32044 });
    await this.invoke(`${SKILLS}commit`, { planId: preview.planId }, { cwd, approved: true });
    await this.refresh(); void vscode.window.showInformationMessage('技能修改已保存并回读核对。后续对话使用更新后的技能。'); return true;
  }
  async diagnose() {
    const result = await this.invoke(`${SKILLS}health`, {});
    const state = result.value || {};
    const uri = this.document('health.md', `# 技能状态\n\n${state.ok === true ? '技能服务正常。' : '技能服务尚未就绪。'}\n\n已发现技能：${Number.isInteger(state.skills) && state.skills >= 0 ? state.skills : '未确认'} 个。\n\n${state.complete === true ? '技能列表已完整加载。' : '技能列表尚未完整加载，可稍后刷新。'}`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }
  configReport() {
    return profileReport({ source: inspectProfile('desktop'), target: inspectProfile(this.panel.config().fallbackProfile), connection: this.connections.snapshot(), catalog: this.catalog });
  }
  async diagnoseConfig() {
    try { await this.refresh(); } catch { this.catalog = { capabilities: [] }; }
    const uri = this.document('configuration.md', this.configReport());
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }
  async copyDiagnostics() {
    await vscode.env.clipboard.writeText(this.configReport());
    void vscode.window.showInformationMessage('已复制连接与安装诊断。');
  }
  async installGuide() {
    const cfg = this.panel.config();
    const targets = this.panel.profilesFor(cfg).filter(name => name !== 'desktop').map(name => inspectProfile(name)).filter(profile => profile.exists && profile.hasWebApp);
    if (!targets.length) {
      const choice = await vscode.window.showInformationMessage('尚未找到可用的面板配置集，请先准备自启配置。', '准备自启配置');
      if (choice) await vscode.commands.executeCommand('dshPanel.setupProfile'); return;
    }
    const selected = await vscode.window.showQuickPick(targets.map(profile => ({ label: profile.profile, description: profile.profile === cfg.fallbackProfile ? '面板自启目标' : '其他网页配置集', profile })), { placeHolder: '选择安装目标配置集' });
    if (!selected) return;
    const source = inspectProfile('desktop'), target = selected.profile, plan = installationPlan(source, target);
    const text = ['# 插件安装说明', '', `目标配置集：${target.profile}`, '',
      '| 插件 | 精确版本 | 来源与安装方式 | 操作 |', '| --- | --- | --- | --- |',
      ...plan.map(item => `| ${item.name} | ${item.version || '未确认'} | ${item.state} | ${!item.needed ? '磁盘版本与引用已核对' : item.executable ? '可在确认后安装' : '手工处理'} |`),
      plan.some(item => item.needed) ? '' : '已安装版本与引用清单没有需要同步的项目。', '',
      '注册表安装仅使用桌面配置集中已确认的精确版本。安装前保存目标清单、锁文件和旧包，安装后核对版本及引用清单。',
      '本地候选与 Git 来源需要使用原文件或原提交；本地候选版本可能尚未发布，不能改写为注册表安装命令。',
      '磁盘安装通过后，内核仍需重新加载并刷新能力。外部内核由其所属应用重启；面板启动的空闲内核可使用“重新加载面板后台内核”。', '',
    ].join('\n');
    const uri = this.document('installation.md', text);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    if (!plan.some(item => item.executable)) return;
    if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage('安装操作需要受信任的工作区；当前仅提供安装说明。'); return; }
    const picked = await vscode.window.showQuickPick(plan.filter(item => item.executable).map(item => ({ label: item.name, description: `${item.version} → ${item.target}`, item })), { placeHolder: '选择需要安装的插件；关闭选择框可保留安装说明' });
    if (!picked || this.installPending) return;
    const confirmation = await vscode.window.showWarningMessage(`安装 ${picked.item.name}@${picked.item.version} 到配置集 ${picked.item.target}。来源：注册表。安装前将备份目标配置和旧包。`, { modal: true }, '备份并安装');
    if (!confirmation) return;
    if (!vscode.workspace.isTrusted) throw Object.assign(new Error(), { code: -32044 });
    for (const entry of this.panel.kernels.entries.values()) if (entry.profile === picked.item.target && (entry.activeBridgeRuns.size || [...this.connections.sessions.values()].some(session => session.busy))) throw Object.assign(new Error(), { code: -32045 });
    this.installPending = true;
    try {
      let command;
      for (const candidate of this.panel.candidatesFor(cfg)) {
        try { await runAsync({ command: candidate, args: ['--version'], timeoutMs: 15000 }); command = candidate; break; } catch {}
      }
      if (!command) throw new Error('未找到可用的 DSH 命令行');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在备份并安装插件', cancellable: false },
        () => installRegistry({ item: picked.item, command, storage: this.context.globalStorageUri.fsPath }));
      const action = await vscode.window.showInformationMessage('安装内容已核对。重新加载对应内核并刷新能力后，才能确认插件已经生效。', '诊断配置', '重新加载面板后台内核');
      if (action === '诊断配置') await this.diagnoseConfig();
      else if (action) await this.reloadOwned();
    } finally { this.installPending = false; }
  }
  async reloadOwned() {
    if (!vscode.workspace.isTrusted) throw Object.assign(new Error(), { code: -32044 });
    const entry = this.connections.currentEntry?.();
    if (!entry || entry.key !== this.connections.key) { void vscode.window.showInformationMessage('当前连接由外部应用管理，请在所属应用重新加载内核，再刷新插件能力。'); return; }
    if (entry.activeBridgeRuns.size || this.panel.session?.busy || [...this.connections.sessions.values()].some(session => session.busy)) throw Object.assign(new Error(), { code: -32045 });
    const choice = await vscode.window.showWarningMessage('重新加载面板后台内核将结束其空闲会话。磁盘插件将在新内核启动时加载。', { modal: true }, '重新加载');
    if (!choice) return;
    this.panel.teardown(); this.panel.kernels.stop(entry.key, '显式重新加载插件');
    await this.refresh(); await this.diagnoseConfig();
  }
  async retry(item) {
    let id = typeof item === 'string' ? item : item?.id;
    if (!id) id = (await vscode.window.showQuickPick([...this.operations.values()].filter(op => TERMINAL.has(op.status) && op.input).map(op => ({ label: op.title || '代码审查', description: `${LABELS[op.status]} · ${op.cwd}`, id: op.id })), { placeHolder: '选择需要重新运行的审查' }))?.id;
    const op = this.operations.get(id); if (!op || !TERMINAL.has(op.status) || !op.input || this.retrying?.has(id)) return;
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(op.cwd))) throw Object.assign(new Error(), { code: -32044 });
    this.retrying ||= new Set(); this.retrying.add(id);
    try {
      const input = { ...op.input };
      if (input.mode === 'custom' && !input.instructions) {
        const instructions = await vscode.window.showInputBox({ prompt: '自定义要求未持久保存，请重新输入审查要求', ignoreFocusOut: true });
        if (!instructions?.trim()) return; input.instructions = instructions.trim();
      }
      return await this.reviewRequest({ cwd: op.cwd, input, userInitiated: true, retryOf: id });
    } finally { this.retrying.delete(id); }
  }
  cleanupReport(op) {
    if (this.reportOwners.get(op.cwd) === op.id) {
      for (const file of this.reports.get(op.cwd) || []) this.diagnostics?.delete(vscode.Uri.file(file));
      this.reports.delete(op.cwd); this.reportOwners.delete(op.cwd);
    }
    if (op.uri && !vscode.workspace.textDocuments.some(doc => doc.uri.toString() === op.uri.toString())) this.documents.delete(op.uri.toString());
  }
  async removeOperation(item) {
    let id = typeof item === 'string' ? item : item?.id;
    if (!id) id = (await vscode.window.showQuickPick([...this.operations.values()].filter(op => TERMINAL.has(op.status)).map(op => ({ label: op.title || '代码审查', description: LABELS[op.status], id: op.id })), { placeHolder: '选择需要移除的已结束记录' }))?.id;
    this.operations.remove(id); await this.saveActive(); this.operationEmitter.fire();
  }
  async clearFinished() { const count = this.operations.clearFinished(); await this.saveActive(); this.operationEmitter.fire(); return count; }
  async saveActive() {
    const state = this.operations.serialize();
    await this.context.workspaceState.update('dshPanel.bridge.records.v2', state);
    await this.context.workspaceState.update('dshPanel.bridge.active', state.records.filter(op => ACTIVE.has(op.status)));
  }
  async restore() {
    if (!this.connections.bridge?.supported) return;
    await Promise.all([...this.operations.values()].filter(op => ACTIVE.has(op.status) && !this.waiters.has(op.id)).map(async op => {
      this.retain(op.id);
      try { const result = await this.waitOperation(op.id); if (result.status === 'completed' && result.result && !this.disposed) await this.presentReport(op.id, result.result); }
      finally { if (TERMINAL.has(op.status)) this.release(op.id); await this.saveActive(); }
    }));
  }
  dispose() {
    this.disposed = true; clearTimeout(this.refreshTimer);
    for (const { timer, resolve } of this.timers.values()) { clearTimeout(timer); resolve(); } this.timers.clear();
    void this.saveActive();
    this.connections.off('operation', this.onOperation); this.connections.off('catalogChanged', this.onCatalog); this.connections.off('state', this.onState);
    for (const id of this.retained.keys()) this.release(id);
  }
}
module.exports = { BridgeViews };
