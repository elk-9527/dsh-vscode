'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const run = promisify(execFile);
const { readFileState } = require('./file-state');
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (file, cwd) => { const rel = path.relative(cwd, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const MAX_FILES = 1000, MAX_FILE = 256 * 1024, MAX_TOTAL = 16 * 1024 * 1024;
const MAX_TURNS = 10, MAX_HISTORY_BYTES = 32 * 1024 * 1024;

/** 文件快照只保存在当前窗口内；基线包含已有的本地修改。 */
class TurnWorkflow {
  constructor({ vscode, panel }) {
    this.vscode = vscode; this.panel = panel; this.documents = new Map(); this.records = []; this.recording = false;
    this.registration = vscode.workspace.registerTextDocumentContentProvider('dsh-turn', { provideTextDocumentContent: uri => this.documents.get(uri.toString()) || '' });
  }
  guard(cwd) {
    const folder = this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(cwd));
    if (!this.vscode.workspace.isTrusted || !folder || !inside(cwd, folder.uri.fsPath) || this.panel.workdir() !== cwd) throw new Error('请在原来的受信任工作区执行此操作。');
  }
  async state(file, cwd) { return readFileState(this.vscode, file, cwd, () => this.guard(cwd)); }
  async capture(cwd) {
    this.guard(cwd);
    let files, source = 'Git 跟踪及未忽略文件';
    try {
      const result = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
      files = [...new Set(result.stdout.split('\0').filter(Boolean))].map(name => path.resolve(cwd, name));
    } catch {
      source = '工作区文件';
      const uris = await this.vscode.workspace.findFiles(new this.vscode.RelativePattern(this.vscode.Uri.file(cwd), '**/*'), '**/{.git,node_modules,build,dist,coverage,.next}/**', MAX_FILES + 1);
      files = uris.map(uri => uri.fsPath);
    }
    const entries = new Map(); let skipped = Math.max(0, files.length - MAX_FILES), size = 0;
    for (const file of files.slice(0, MAX_FILES).sort()) {
      if (!inside(file, cwd)) { skipped++; continue; }
      const name = path.relative(cwd, file).split(path.sep).join('/');
      let value;
      try { value = await this.state(file, cwd); } catch { value = null; }
      if (value && size + value.bytes > MAX_TOTAL) value = null;
      if (value === null) skipped++;
      entries.set(name, value); size += value?.bytes || 0;
    }
    this.guard(cwd); return { entries, skipped, source };
  }
  async begin({ turnId } = {}) {
    if (!this.vscode.workspace.isTrusted || this.disposed) return;
    if (this.recording || this.activeTest || this.undoing) throw new Error('请等改动整理、测试或撤销结束后再开始新回合。');
    const cwd = this.panel.workdir();
    const turn = { id: typeof turnId === 'string' && turnId && !this.records.some(item => item.id === turnId) ? turnId : randomUUID(), cwd,
      before: { entries: new Map(), skipped: 0, source: '工作区文件' }, started: Date.now(), status: 'running', files: [] };
    this.latest = turn; this.records.push(turn); this.testResult = undefined; this.note = ''; this.recording = true; this.compact(); this.publish();
    try {
      turn.before = await this.capture(cwd);
    } catch (error) { turn.captureError = true; turn.note = `无法记录本轮改动：${error.message}`; }
    finally { this.recording = false; this.compact(); this.publish(); }
    return turn;
  }
  async finish(turn, outcome) {
    if (!turn || this.latest !== turn || turn.finished || turn.finishing || this.disposed) return;
    turn.finishing = true;
    this.recording = true; this.publish();
    try {
      if (turn.captureError) return;
      const after = await this.capture(turn.cwd); turn.after = after;
      turn.files = [];
      for (const name of new Set([...turn.before.entries.keys(), ...after.entries.keys()])) {
        const before = turn.before.entries.get(name), current = after.entries.get(name);
        if (before === null || current === null || !before && !current || before?.text === current?.text && before?.disk === current?.disk) continue;
        // 截断扫描时无法确定文件是否新建或删除，避免产生可撤销的错误基线。
        if ((!before || !current) && (turn.before.skipped || after.skipped)) continue;
        turn.files.push({ id: randomUUID(), name, before, after: current, kind: !before ? 'added' : !current ? 'deleted' : 'modified',
          changes: lineChanges(before?.text || '', current?.text || '') });
      }
      this.note = '';
    } catch (error) { turn.note = `无法完成改动对比：${error.message}`; }
    finally {
      turn.finished = Date.now(); const status = typeof outcome === 'string' ? outcome : outcome?.status;
      turn.status = ['failed', 'cancelled'].includes(status) ? status : 'completed'; turn.finishing = false;
      // 完成后仅留差异所需文本；未变化的工作区正文不进入多轮历史。
      turn.before.entries = new Map(turn.files.map(file => [file.name, file.before]));
      if (turn.after) turn.after.entries = new Map(turn.files.map(file => [file.name, file.after]));
      this.recording = false; this.compact(); this.publish();
    }
  }
  compact() {
    const bytes = turn => (turn.finished ? turn.files.reduce((size, file) => size + (file.before?.bytes || 0) + (file.after?.bytes || 0), 0)
      : [...turn.before.entries.values()].reduce((size, value) => size + (value?.bytes || 0), 0)) + (turn.test?.userLog?.byteLength || 0);
    const standaloneLogBytes = this.records.some(turn => turn.test === this.testResult) ? 0 : this.testResult?.userLog?.byteLength || 0;
    let total = this.records.reduce((size, turn) => size + bytes(turn), standaloneLogBytes);
    while (this.records.length > 1 && (this.records.length > MAX_TURNS || total > MAX_HISTORY_BYTES)) total -= bytes(this.records.shift());
    this.historyBytes = total;
    this.onTestRetentionChange?.();
  }
  testSummary(result) {
    if (!result || !this.testSourceCurrent) return result;
    const sourceCurrent = this.testSourceCurrent(result);
    return { ...result, sourceCurrent, sourceNote: sourceCurrent ? '' : '测试来源的连接、会话或信任状态已变化；旧退出结果仅供参考，请在当前会话重新测试。' };
  }
  turnSummary(turn) {
    return { id: turn.id, turnId: turn.id, messageId: turn.messageId, status: turn.status, started: turn.started,
      finished: Boolean(turn.finished), finishedAt: turn.finished,
      note: turn.note || `${turn.before.source}；跳过 ${turn.before.skipped + (turn.after?.skipped || 0)} 项超限、非文本或不可读文件。变化包含本轮期间发生的编辑。`,
      files: turn.files.map(file => ({ id: file.id, name: file.name, kind: file.kind, restored: file.restored,
        canUndo: turn === this.latest && Boolean(turn.finished) && !file.restored && !(file.kind === 'added' && file.after?.dirty) && !(file.before?.dirty && file.before.disk !== file.after?.disk),
        ...(file.changes || lineChanges(file.before?.text || '', file.after?.text || '')) })), test: this.testSummary(turn.test) };
  }
  summary() {
    const turn = this.latest, latest = turn && this.turnSummary(turn);
    return { type: 'workflow', recording: this.recording, turnId: turn?.id, finished: Boolean(turn?.finished),
      status: turn?.status, note: this.note || latest?.note || '发送一轮对话后显示本轮改动。',
      files: latest?.files || [], test: this.testSummary(this.testResult), turns: this.records.slice().reverse().map(item => this.turnSummary(item)) };
  }
  publish() { this.panel.post(this.summary()); }
  document(key, text) {
    if (this.documents.size >= 40) this.documents.delete(this.documents.keys().next().value);
    const uri = this.vscode.Uri.parse(`dsh-turn:/${key}`); this.documents.set(uri.toString(), text); return uri;
  }
  item(id) {
    const turn = this.records.find(item => item.files.some(file => file.id === id)), file = turn?.files.find(item => item.id === id);
    if (!file || !turn.finished) throw new Error('改动记录已失效，请查看最新一轮。');
    this.guard(turn.cwd); return { turn, file, absolute: path.join(turn.cwd, file.name) };
  }
  async preview(id) {
    const { turn, file } = this.item(id);
    await this.vscode.commands.executeCommand('vscode.diff', this.document(`${turn.id}/${file.id}/before`, file.before?.text || ''), this.document(`${turn.id}/${file.id}/after`, file.after?.text || ''), `本轮改动：${file.name}`);
  }
  async undo(id) {
    if (this.panel.session?.busy || this.panel.queue?.active || this.panel.newSessionPending || this.recording || this.activeTest || this.undoing) throw new Error('请等当前任务结束后再撤销。');
    const { turn, file, absolute } = this.item(id);
    if (turn !== this.latest) throw new Error('历史改动仅供查看；只能撤销最新一轮，请通过差异视图检查。');
    if (!this.summary().files.find(item => item.id === id)?.canUndo) throw new Error('此改动无法安全撤销，请通过差异视图检查。');
    this.undoing = true;
    try {
      await this.preview(id);
      const approved = await this.vscode.window.showInformationMessage(`撤销 ${file.name} 的本轮改动？`, { modal: true, detail: '恢复到本轮开始时的内容，保留此前的本地修改。文本修改进入编辑器；自动保存可能写入磁盘。新建文件会删除，已删除文件会重建。' }, '撤销此文件');
      if (approved !== '撤销此文件') return;
      this.item(id);
      if (this.panel.session?.busy || this.panel.queue?.active || this.panel.newSessionPending || this.recording || this.activeTest) throw new Error('当前任务已变化，请结束后重新查看。');
      const current = await this.state(absolute, turn.cwd);
      if (current === null || current?.text !== file.after?.text || current?.disk !== file.after?.disk || file.kind === 'added' && current?.dirty) throw new Error('文件在回合结束后又被修改，请重新检查，未执行撤销。');
      const edit = new this.vscode.WorkspaceEdit(), uri = this.vscode.Uri.file(absolute);
      if (!file.before) edit.deleteFile(uri);
      else {
        if (!current) edit.createFile(uri, { overwrite: false });
        const document = current ? await this.vscode.workspace.openTextDocument(uri) : undefined;
        edit.replace(uri, document ? new this.vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)) : new this.vscode.Range(0, 0, 0, 0), file.before.text);
      }
      // 打开文件和确认均可能让出执行权，提交前再次核对原始快照。
      const check = await this.state(absolute, turn.cwd);
      if (this.latest !== turn || check?.text !== current?.text || check?.disk !== current?.disk || this.panel.session?.busy || this.panel.queue?.active || this.panel.newSessionPending || this.recording || this.activeTest) throw new Error('文件或回合已变化，未执行撤销。');
      if (!await this.vscode.workspace.applyEdit(edit)) throw new Error('编辑器未完成撤销。');
      file.restored = true; turn.note = this.note = '已恢复选中文件的本轮起始内容；编辑器中的未保存修改需要保存。'; this.publish();
    } finally { this.undoing = false; }
  }
  async showChanges() { await this.panel.reveal(); this.publish(); this.panel.post({ type: 'workflowFocus' }); }
  reset() { if (!this.activeTest) { this.latest = undefined; this.records = []; this.historyBytes = 0; this.testResult = undefined; this.note = ''; this.documents.clear(); this.onTestRetentionChange?.(); this.publish(); } }
  dispose() { this.disposed = true; this.registration.dispose(); this.documents.clear(); this.records = []; this.latest = undefined; this.testResult = undefined; this.historyBytes = 0; this.onTestRetentionChange?.(); for (const subscription of this.taskSubscriptions || []) subscription.dispose(); }
}

function lineChanges(before, after) {
  let a = before ? before.split(/\r?\n/) : [], b = after ? after.split(/\r?\n/) : [];
  if (a.at(-1) === '') a.pop();
  if (b.at(-1) === '') b.pop();
  let prefix = 0; while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  a = a.slice(prefix); b = b.slice(prefix);
  while (a.length && b.length && a.at(-1) === b.at(-1)) { a.pop(); b.pop(); }
  if (a.length * b.length > 1000000) return {};
  let row = new Uint32Array(b.length + 1);
  for (const text of a) { const next = new Uint32Array(b.length + 1); for (let j = 0; j < b.length; j++) next[j + 1] = text === b[j] ? row[j] + 1 : Math.max(row[j + 1], next[j]); row = next; }
  return { added: b.length - row[b.length], removed: a.length - row[b.length] };
}
module.exports = { TurnWorkflow, inside, lineChanges, MAX_TURNS, MAX_HISTORY_BYTES };
