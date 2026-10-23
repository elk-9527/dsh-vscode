'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { findingLocation, repositorySnapshot } = require('./results');
const MAX_BYTES = 128 * 1024;
const fail = message => { throw new Error(message); };

/** 模型只返回同一文件中的精确替换，不接受命令、路径或任意文件写入。 */
function parseEdits(response, original) {
  if (typeof response !== 'string') fail('修复建议不是有效 JSON，请重新生成。');
  if (Buffer.byteLength(response) > 256 * 1024) fail('修复建议过大，请缩小范围。');
  const text = response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  let value; try { value = JSON.parse(text); } catch { fail('修复建议不是有效 JSON，请重新生成。'); }
  if (!value || !Array.isArray(value.edits) || !value.edits.length || value.edits.length > 20) fail('修复建议没有可应用的替换。');
  const ranges = [];
  return value.edits.map((edit, index) => {
    if (!edit || typeof edit.before !== 'string' || !edit.before || typeof edit.after !== 'string' || edit.before === edit.after || edit.before.includes('\0') || edit.after.includes('\0') ||
      Buffer.byteLength(edit.before) + Buffer.byteLength(edit.after) > MAX_BYTES) fail('修复建议包含无效替换。');
    const start = original.indexOf(edit.before);
    if (start < 0 || original.indexOf(edit.before, start + 1) !== -1) fail('原文未唯一匹配，请重新生成修复。');
    const end = start + edit.before.length;
    if (ranges.some(range => start < range.end && end > range.start)) fail('修复建议存在重叠，请重新生成。');
    ranges.push({ start, end });
    return { before: edit.before, after: edit.after, explanation: typeof edit.explanation === 'string' ? edit.explanation.slice(0, 2000) : '', index, applied: false };
  });
}
function replacement(text, edit) {
  const start = text.indexOf(edit.before);
  if (start < 0 || text.indexOf(edit.before, start + 1) !== -1) fail('原文已变化，请重新生成修复。');
  return { start, end: start + edit.before.length, text: text.slice(0, start) + edit.after + text.slice(start + edit.before.length) };
}

class ReviewFixes {
  constructor({ vscode, views, context }) {
    this.vscode = vscode; this.views = views; this.plans = new Map(); this.pending = new Set();
    const commands = [['generateFix', (id, index) => this.generate(id, index)], ['applyFix', id => this.apply(id)], ['verifyFix', id => this.verify(id)]];
    context.subscriptions.push(...commands.map(([key, fn]) => vscode.commands.registerCommand(`dshPanel.bridge.${key}`, async (...args) => {
      try { return await fn(...args); } catch (error) { void vscode.window.showErrorMessage(error.message); }
    })));
    if (vscode.languages.registerCodeActionsProvider) context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
      provideCodeActions: (document, range, context) => {
        const actions = [];
        if (!vscode.workspace.isTrusted) return actions;
        for (const diagnostic of context.diagnostics) {
          const ref = diagnostic.code;
          if (diagnostic.source !== 'DSH' || typeof ref !== 'string' || !ref.startsWith('dsh-finding:')) continue;
          const [, id, index] = ref.split(':');
          const action = new vscode.CodeAction('DSH：为此问题生成修复建议', vscode.CodeActionKind.QuickFix);
          action.diagnostics = [diagnostic]; action.command = { command: 'dshPanel.bridge.generateFix', title: action.title, arguments: [id, Number(index)] };
          actions.push(action);
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
      for (const [id, plan] of this.plans) if (plan.document === document) this.plans.delete(id);
    }));
  }
  trusted(cwd) {
    if (!this.vscode.workspace.isTrusted || !this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(cwd))) fail('修复需要受信任的当前工作区。');
  }
  assertFile(plan) {
    this.trusted(plan.cwd);
    let current = plan.cwd;
    for (const part of path.relative(plan.cwd, plan.file).split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) fail('链接文件不能应用修复。');
    }
    if (fs.realpathSync(plan.file) !== plan.file) fail('修复目标已变化，请重新生成。');
    const disk = fs.readFileSync(plan.file, 'utf8');
    // 编辑器的自动保存可以落盘已经确认的替换，仍须与当前计划逐字一致。
    if (!plan.document.isDirty && plan.edits.some(edit => edit.applied) && disk === plan.expected) plan.diskText = disk;
    if (plan.document.isClosed || plan.document.getText() !== plan.expected || disk !== plan.diskText) fail('文件已变化，请重新生成修复。');
  }
  async generate(id, index) {
    const vscode = this.vscode;
    id = typeof id === 'string' ? id : id?.id;
    let op = this.views.operations.get(id);
    if (!op) {
      const entries = [...this.views.operations.values()].filter(item => item.status === 'completed' && item.result?.findings?.length);
      const choice = await vscode.window.showQuickPick(entries.map(item => ({ label: '代码审查', description: item.finishedAt || item.startedAt, op: item })), { placeHolder: '选择审查报告' });
      op = choice?.op; if (!op) return;
    }
    if (op.status !== 'completed' || !op.result?.findings?.length) fail('请选择已完成且包含问题的审查报告。');
    this.trusted(op.cwd);
    if (!this.api) fail('修复服务尚未就绪。');
    const snapshot = await repositorySnapshot(op.cwd);
    if (snapshot.fingerprint !== op.fingerprint) fail('审查快照已变化，请重新审查后生成修复。');
    const findings = op.result?.findings || [];
    if (!Number.isInteger(index)) {
      const choice = await vscode.window.showQuickPick(findings.map((finding, index) => ({ label: finding.title, description: finding.file, index })), { placeHolder: '选择要修复的问题' });
      if (!choice) return; index = choice.index;
    }
    const finding = findings[index], location = finding && findingLocation(op.cwd, finding);
    if (!location) fail('该问题没有有效的文件位置。');
    if (this.pending.has(location.file)) fail('此文件正在生成修复，请稍后再试。');
    this.pending.add(location.file);
    let handle;
    try {
      if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.file));
      if (document.isDirty) fail('请先保存文件并重新审查，再生成修复。');
      const original = document.getText();
      if (Buffer.byteLength(original) > MAX_BYTES || original.includes('\0')) fail('文件过大或不是文本，请缩小修复范围。');
      const plan = { id: randomUUID(), opId: op.id, findingIndex: index, cwd: op.cwd, file: location.file, document, expected: original, diskText: fs.readFileSync(location.file, 'utf8'), edits: [], expires: Date.now() + 10 * 60 * 1000 };
      this.assertFile(plan);
      const response = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在生成修复建议', cancellable: true }, async (_progress, token) => {
        const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try {
          if (abort.signal.aborted) fail('修复生成已取消。');
          handle = await this.api.createSession({ cwd: plan.cwd, preset: 'minimal', userInitiated: true });
          const client = this.views.connections.client;
          const permission = await client.permissionSet(handle.sessionId, 'read-only');
          if (permission.currentValue !== 'read-only') fail('无法确认只读权限，修复生成已停止。');
          if (typeof this.api.generateText !== 'function') fail('当前接入点不支持禁用工具的修复生成，请更新后重试。');
          const result = await this.api.generateText(handle, `为下述审查问题生成最小修复。只返回 JSON {"edits":[{"before":"唯一匹配的原文","after":"替换正文","explanation":"原因"}]}。只修改提供的文件，不运行工具，不写文件。每项原文必须完整且唯一，替换不能重叠；保留换行格式。\n问题：${JSON.stringify(finding)}\n文件：${finding.file}\n完整原文（JSON 字符串）：${JSON.stringify(original)}`, { userInitiated: true, signal: abort.signal });
          if (abort.signal.aborted) fail('修复生成已取消。');
          if (result?.path !== 'llm-direct-v1' || result.tools !== false || typeof result.text !== 'string') fail('内核未确认无工具生成结果，请重试。');
          return result.text;
        } finally { subscription.dispose(); }
      });
      this.assertFile(plan);
      if ((await repositorySnapshot(plan.cwd)).fingerprint !== op.fingerprint) fail('生成期间代码已变化，请重新审查。');
      plan.edits = parseEdits(response, original); this.plans.set(plan.id, plan);
      await this.apply(plan.id);
      return plan.id;
    } finally { this.pending.delete(location.file); if (handle) await this.api.closeSession(handle).catch(() => {}); }
  }
  async apply(id) {
    id = await this.selectPlan(id); if (!id) return;
    const plan = this.plans.get(id); if (!plan) fail('修复建议已关闭，请重新生成。');
    if (plan.applying || plan.verifying) return; plan.applying = true;
    try {
      if (Date.now() > plan.expires) { this.plans.delete(id); fail('修复建议已过期，请重新生成。'); }
      this.assertFile(plan);
      const remaining = plan.edits.filter(edit => !edit.applied);
      if (!remaining.length) { void this.vscode.window.showInformationMessage('所有建议已应用，可执行“DSH：保存修复并重新审查”。'); return; }
      const selected = await this.vscode.window.showQuickPick(remaining.map(edit => ({ label: `修改 ${edit.index + 1}`, description: edit.explanation, edit })), { placeHolder: '选择一项查看差异' });
      if (!selected) return;
      const edit = selected.edit, next = replacement(plan.expected, edit);
      if (Buffer.byteLength(next.text) > MAX_BYTES) fail('修复后的文件超过 128 KiB，请缩小修复范围。');
      const originalUri = this.views.document(`fix/${plan.id}/before`, plan.expected);
      const proposedUri = this.views.document(`fix/${plan.id}/after`, next.text);
      await this.vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, `DSH 修复预览：${path.basename(plan.file)}（${edit.index + 1}）`);
      const autoSave = this.vscode.workspace.getConfiguration?.('files', plan.document.uri).get('autoSave', 'off');
      const saveNotice = autoSave && autoSave !== 'off' ? '修改可撤销；编辑器已启用自动保存，应用后可能自动写入磁盘。' : '修改后可撤销，保存前不会写入磁盘。';
      const approved = await this.vscode.window.showInformationMessage('应用预览中的这一项修改到编辑器？', { modal: true, detail: `${plan.file}\n${edit.explanation}\n${saveNotice}` }, '应用此项');
      if (approved !== '应用此项') return;
      this.assertFile(plan);
      const workspaceEdit = new this.vscode.WorkspaceEdit();
      workspaceEdit.replace(plan.document.uri, new this.vscode.Range(plan.document.positionAt(next.start), plan.document.positionAt(next.end)), edit.after);
      if (!await this.vscode.workspace.applyEdit(workspaceEdit) || plan.document.getText() !== next.text) fail('编辑器未应用预期修改，请检查当前文件。');
      const before = plan.expected; plan.expected = next.text; edit.applied = true;
      plan.caseKey = await this.views.recordFix?.(plan.opId, { planId: plan.id, findingIndex: plan.findingIndex, editIndex: edit.index,
        file: path.relative(plan.cwd, plan.file).split(path.sep).join('/'), before, after: next.text }) || plan.caseKey;
      const choice = await this.vscode.window.showInformationMessage('修复已应用到编辑器。', ...(plan.edits.some(item => !item.applied) ? ['查看下一项'] : []), '保存并重新审查');
      if (choice === '查看下一项') { plan.applying = false; return this.apply(id); }
      if (choice === '保存并重新审查') { plan.applying = false; return this.verify(id); }
      return true;
    } finally { plan.applying = false; }
  }
  async verify(id) {
    id = await this.selectPlan(id); if (!id) return;
    const plan = this.plans.get(id); if (!plan) fail('修复建议已关闭，请重新运行审查。');
    if (plan.applying || plan.verifying) return;
    plan.verifying = true;
    try {
      this.assertFile(plan);
      if (!plan.edits.some(edit => edit.applied)) fail('尚未应用修复。');
      if (!await plan.document.save()) fail('保存未完成，请保存后重新审查。');
      this.plans.delete(id);
      return this.views.reviewRequest({ cwd: plan.cwd, input: { mode: 'worktree' }, userInitiated: true, ...(plan.caseKey ? { caseKey: plan.caseKey } : {}) });
    } finally { plan.verifying = false; }
  }
  async selectPlan(id) {
    if (id) return id;
    if (!this.plans.size) { void this.vscode.window.showInformationMessage('当前没有待处理的修复建议。'); return; }
    const selected = await this.vscode.window.showQuickPick([...this.plans.values()].map(plan => ({ label: path.basename(plan.file), description: `${plan.edits.filter(edit => !edit.applied).length} 项待应用`, id: plan.id })), { placeHolder: '选择修复建议' });
    return selected?.id;
  }
}
module.exports = { ReviewFixes, parseEdits, replacement };
