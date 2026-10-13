'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { referenceAttachments, MAX_CONTEXT_BYTES, selectionEndLine } = require('../chat/context');
const { commandChoices } = require('../workflow/commands');

const SKILLS = 'linxin.skill-explorer.';
const EXCLUDE = '**/{.git,node_modules,build,dist,coverage,.next}/**';
const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(target, base) { const rel = path.relative(base, target); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
function matches(value, query) {
  let at = 0;
  const text = value.toLocaleLowerCase();
  for (const char of query.toLocaleLowerCase()) { at = text.indexOf(char, at); if (at < 0) return false; at++; }
  return true;
}
function fileGlob(query) {
  return '**/*' + [...query.replace(/\\/g, '/')].map(char => '*?[]{}'.includes(char) ? `[${char}]` : char === '/' ? '/*' : char + '*').join('');
}

/** 候选只含名称；选中后才读取正文，不接受界面任意指定的文件地址。 */
class ComposerContext {
  constructor({ vscode, workdir, invoke, connected = () => true, busy = () => false, sessionId = () => undefined }) {
    Object.assign(this, { vscode, workdir, invoke, connected, busy, sessionId }); this.candidates = new Map(); this.disposables = []; this.queryGeneration = 0;
    this.captureEditor(vscode.window?.activeTextEditor);
    const watch = (owner, event, handler) => { if (typeof owner?.[event] === 'function') this.disposables.push(owner[event](handler)); };
    watch(vscode.window, 'onDidChangeActiveTextEditor', editor => { if (editor) this.captureEditor(editor); });
    watch(vscode.window, 'onDidChangeTextEditorSelection', event => this.captureEditor(event.textEditor));
    watch(vscode.workspace, 'onDidCloseTextDocument', doc => {
      if (this.recentEditor?.document === doc) this.recentEditor = undefined;
      for (const [id, choice] of this.candidates) if (choice.uri?.toString() === doc.uri.toString()) this.candidates.delete(id);
    });
    watch(vscode.workspace, 'onDidChangeWorkspaceFolders', () => { this.recentEditor = undefined; this.candidates.clear(); this.queryGeneration++; });
    watch(vscode.workspace, 'onDidGrantWorkspaceTrust', () => { this.candidates.clear(); this.recentEditor = undefined; this.skillCatalog = undefined; this.queryGeneration++; });
  }
  dispose() { for (const item of this.disposables) item?.dispose(); this.disposables = []; this.candidates.clear(); this.recentEditor = undefined; this.queryGeneration++; }
  captureEditor(editor) {
    if (!editor) return;
    const document = editor?.document, uri = document?.uri;
    if (!uri || document.isClosed || !['file', 'untitled'].includes(uri.scheme) || !this.vscode.workspace.isTrusted) { this.recentEditor = undefined; return; }
    const cwd = this.workdir();
    if (uri.scheme === 'file' && !inside(uri.fsPath, cwd)) { this.recentEditor = undefined; return; }
    const selection = editor.selection;
    let range;
    if (selection && !selection.isEmpty) {
      const { start, end } = selection;
      range = this.vscode.Range ? new this.vscode.Range(start.line, start.character, end.line, end.character) : { start: { ...start }, end: { ...end }, isEmpty: false };
    }
    this.recentEditor = { document, uri, range, documentVersion: document.version, cwd, sessionId: this.sessionId() };
  }
  editorContext(cwd) {
    if (this.vscode.window?.activeTextEditor) this.captureEditor(this.vscode.window.activeTextEditor);
    const recent = this.recentEditor;
    if (!recent || recent.document.isClosed || identity(recent.cwd) !== identity(cwd) || recent.sessionId !== this.sessionId()) return undefined;
    return recent;
  }
  async fromEditor(editor, scope = 'file', signal) {
    this.captureEditor(editor);
    const cwd = this.workdir(), recent = this.editorContext(cwd);
    if (!recent || recent.document !== editor?.document) throw new Error('当前编辑器不可引用，请重新选择。');
    if (scope === 'selection' && !recent.range) throw new Error('请先在编辑器中选择代码。');
    const choice = { kind: 'context', cwd, uri: recent.uri, ...(scope === 'selection' ? { range: recent.range, documentVersion: recent.documentVersion, description: `${recent.range.start.line + 1}–${selectionEndLine(recent.range)} 行选区` } : {}) };
    const id = randomUUID(); this.candidates.set(id, { ...choice, sessionId: this.sessionId() });
    try { return await this.select(id, signal); } finally { this.candidates.delete(id); }
  }
  async findFiles(cwd, pattern, signal) {
    await this.realGuard(cwd, signal);
    const cancellation = new this.vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const files = await this.vscode.workspace.findFiles(new this.vscode.RelativePattern(this.vscode.Uri.file(cwd), pattern), EXCLUDE, 200, cancellation.token);
      await this.realGuard(cwd, signal); return files;
    } finally { signal?.removeEventListener('abort', abort); cancellation.dispose(); }
  }
  guard(cwd, signal) {
    if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: -32800 });
    if (!this.vscode.workspace.isTrusted) { this.candidates.clear(); this.recentEditor = undefined; this.skillCatalog = undefined; throw new Error('请先信任工作区，再引用文件或技能。'); }
    if (identity(this.workdir()) !== identity(cwd)) throw new Error('工作区已变化，请重新选择。');
    const folder = this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(cwd));
    if (!folder || !inside(cwd, folder.uri.fsPath)) throw new Error('请先打开本次对话的工作区。');
    return folder;
  }
  async realGuard(cwd, signal) {
    const folder = this.guard(cwd, signal);
    const [base, target] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(cwd)]);
    this.guard(cwd, signal);
    if (!inside(target, base)) throw new Error('当前对话目录链接指向工作区外部，无法引用。');
    return folder;
  }
  async query(trigger, query = '', signal, options = {}) {
    const cwd = this.workdir();
    const generation = ++this.queryGeneration;
    const sessionId = this.sessionId(), origin = options.origin || 'syntax', source = options.source;
    const context = origin === 'context';
    if (context && !['file', 'selection', 'search', 'skill'].includes(source)) throw new Error('无效的上下文来源。');
    if (context) trigger = source === 'skill' ? '/' : source === 'search' ? '@' : '#';
    if (!['@', '/', '#'].includes(trigger) || typeof query !== 'string' || query.length > 128 || /[\0\r\n]/.test(query)) throw new Error('无效的快捷查询。');
    if (!context && trigger === '/' && !this.vscode.workspace.isTrusted) { this.candidates.clear(); this.recentEditor = undefined; this.skillCatalog = undefined; return { items: commandChoices(query, { busy: this.busy(), trusted: false }), note: '受限工作区仅提供命令；文件技能需要工作区信任。' }; }
    await this.realGuard(cwd, signal);
    query = query.trim().replace(/\\/g, '/');
    const choices = []; let note = '';
    if (trigger === '/') {
      if (!context) choices.push(...commandChoices(query, { busy: this.busy(), trusted: this.vscode.workspace.isTrusted }));
      if (!this.skillCatalog || this.skillCatalog.cwd !== cwd || this.skillCatalog.sessionId !== sessionId || Date.now() > this.skillCatalog.expires) {
        const promise = Promise.resolve().then(() => { if (!this.connected()) throw new Error('技能服务尚未连接'); return this.invoke(SKILLS + 'list', {}, { cwd }); });
        const catalog = { cwd, sessionId, expires: Infinity, promise }; this.skillCatalog = catalog;
        const expire = () => { if (this.skillCatalog === catalog) catalog.expires = Date.now() + 3000; };
        promise.then(expire, expire);
      }
      let result;
      try { result = await this.skillCatalog.promise; }
      catch {
        this.guard(cwd, signal);
        const files = await this.findFiles(cwd, '{.dsh,.agents}/skills/**/SKILL.md', signal);
        for (const uri of files) {
          const relative = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
          if (uri.scheme !== 'file' || !/^(\.dsh|\.agents)\/skills\/(?!.*(?:^|\/)\.trash\/).+\/SKILL\.md$/.test(relative)) continue;
          const label = path.basename(path.dirname(uri.fsPath));
          if (matches(`${label} ${relative}`, query)) choices.push({ kind: 'localSkill', label, description: relative, uri });
        }
        note = '技能服务暂不可用；当前显示项目文件技能，选择后随消息使用。';
      }
      if (result) {
        this.guard(cwd, signal);
        for (const group of result.value?.groups || []) for (const skill of group.skills || []) {
          if (typeof skill.id === 'string' && typeof skill.name === 'string' && matches(`${skill.name} ${skill.description || ''}`, query)) {
            choices.push({ kind: 'skill', label: skill.name, description: `${group.title || '技能'} · ${skill.description || ''}`.slice(0, 240), skillId: skill.id });
          }
        }
        note = '选择技能后附加正文，发送消息时使用。';
      }
    } else {
      if (trigger === '#') {
        const recent = this.editorContext(cwd);
        const editor = recent && { document: recent.document, selection: recent.range };
        if (editor && ['file', 'untitled'].includes(editor.document.uri.scheme)) {
          const uri = editor.document.uri;
          const folder = uri.scheme === 'file' && this.vscode.workspace.getWorkspaceFolder(uri);
          if (uri.scheme === 'untitled' || folder && inside(uri.fsPath, cwd)) {
            const name = path.basename(editor.document.fileName || uri.path);
            if ((!context || source === 'file') && matches(`当前文件 file ${name}`, query)) choices.push({ kind: 'context', label: '当前文件', description: name, uri });
            if ((!context || source === 'selection') && editor.selection && !editor.selection.isEmpty && matches(`当前选区 selection ${name}`, query)) choices.push({ kind: 'context', label: '当前选区', description: `${name} · ${editor.selection.start.line + 1}–${selectionEndLine(editor.selection)} 行`, uri, range: editor.selection, documentVersion: recent.documentVersion });
          }
        }
      }
      const files = context && ['file', 'selection'].includes(source) ? [] : await this.findFiles(cwd, fileGlob(query), signal);
      const opened = new Set((this.vscode.workspace.textDocuments || []).filter(doc => doc.uri.scheme === 'file').map(doc => identity(doc.uri.fsPath)));
      const names = [...new Map([...(this.vscode.workspace.textDocuments || []).map(doc => doc.uri), ...files].filter(uri => uri.scheme === 'file' && inside(uri.fsPath, cwd)).map(uri => [identity(uri.fsPath), { kind: 'file', label: path.relative(cwd, uri.fsPath).split(path.sep).join('/'), uri, description: opened.has(identity(uri.fsPath)) ? '已打开文件' : '' }])).values()].filter(item => matches(item.label, query));
      names.sort((a, b) => Number(opened.has(identity(b.uri.fsPath))) - Number(opened.has(identity(a.uri.fsPath))) || Number(path.basename(b.label).toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) - Number(path.basename(a.label).toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) || a.label.localeCompare(b.label));
      if (!context || source === 'search') choices.push(...names);
      note = context && source === 'selection' && !choices.length ? '请先在编辑器中选择代码。' : context && source === 'file' && !choices.length ? '请先打开当前对话目录中的文件。' : files.length === 200 ? '继续输入路径缩小范围。' : '选择后附加正文快照，文件后续变化不会修改附件。';
    }
    await this.realGuard(cwd, signal);
    if (this.sessionId() !== sessionId) throw new Error('会话已变化，请重新选择。');
    if (generation !== this.queryGeneration) throw Object.assign(new Error('请求已取消'), { code: -32800 });
    this.candidates.clear();
    const items = choices.slice(0, 50).map(choice => { const id = choice.kind === 'command' ? choice.id : randomUUID(); this.candidates.set(id, { ...choice, cwd, sessionId, origin, source, queryRequestId: options.requestId }); return { id, kind: choice.kind, label: choice.label, description: choice.description || '', disabled: Boolean(choice.disabled) }; });
    return { items, note };
  }
  async select(id, signal, options = {}) {
    try { return await this.selectCandidate(id, signal, options); }
    catch (error) {
      if (!this.vscode.workspace.isTrusted) { this.candidates.clear(); this.recentEditor = undefined; this.skillCatalog = undefined; }
      throw error;
    }
  }
  async selectCandidate(id, signal, options = {}) {
    const choice = this.candidates.get(id);
    if (!choice) throw new Error('候选已过期，请重新选择。');
    const guardChoice = () => {
      if (this.candidates.get(id) !== choice) throw new Error('候选已过期，请重新选择。');
      if (choice.sessionId !== this.sessionId()) throw new Error('会话已变化，请重新选择。');
      for (const key of ['origin', 'source', 'queryRequestId']) if (options[key] !== undefined && options[key] !== choice[key]) throw new Error('候选来源已变化，请重新选择。');
      this.guard(choice.cwd, signal);
    };
    guardChoice();
    await this.realGuard(choice.cwd, signal); guardChoice();
    const { cwd } = choice; this.guard(cwd, signal);
    if (choice.kind === 'command') throw new Error('命令需要通过命令入口执行。');
    if (choice.kind === 'skill') {
      const result = await this.invoke(SKILLS + 'read', { skillId: choice.skillId }, { cwd, signal });
      await this.realGuard(cwd, signal);
      guardChoice();
      const text = result.value?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('该技能没有可读取的正文。');
      if (text.includes('\0') || Buffer.byteLength(text) > MAX_CONTEXT_BYTES) throw new Error('技能正文超过限制或不是文本。');
      return { kind: 'skill', id: `skill:${choice.skillId}`, name: choice.label, text, detail: '手动调用技能', language: 'markdown', scope: 'skill', sourcePath: choice.skillId, snapshotAt: new Date().toISOString(), byteLength: Buffer.byteLength(text) };
    }
    const checkFile = async () => {
      if (choice.uri.scheme !== 'file') return;
      const [base, target] = await Promise.all([fs.realpath(cwd), fs.realpath(choice.uri.fsPath)]);
      const rel = path.relative(base, target);
      if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('文件链接指向工作区外部，无法引用。');
    };
    await checkFile();
    if (!choice.range && choice.uri.scheme === 'file' && !(this.vscode.workspace.textDocuments || []).some(doc => doc.uri.toString() === choice.uri.toString()) && (await fs.stat(choice.uri.fsPath)).size > MAX_CONTEXT_BYTES) throw new Error('文件超过 256 KiB，请打开文件后选择较小的代码片段。');
    if (choice.range && choice.documentVersion !== undefined) {
      const document = await this.vscode.workspace.openTextDocument(choice.uri);
      if (document.version !== choice.documentVersion) throw new Error('引用选区已变化，请重新选择。');
    }
    const [item] = await referenceAttachments(this.vscode, [{ value: choice.range ? { uri: choice.uri, range: choice.range, documentVersion: choice.documentVersion } : choice.uri }], cwd, signal);
    await checkFile();
    await this.realGuard(cwd, signal);
    guardChoice();
    if (choice.kind === 'localSkill') {
      if (!item.text.trim()) throw new Error('该技能没有可读取的正文。');
      return { ...item, kind: 'skill', scope: 'skill', id: `skill:local:${choice.uri.toString()}`, name: choice.label, detail: '项目文件技能', language: 'markdown' };
    }
    return { ...item, ...(choice.uri.scheme === 'file' ? { name: path.relative(cwd, choice.uri.fsPath).split(path.sep).join('/') } : {}), id: choice.uri.toString() + (choice.range ? `:${choice.range.start.line}:${choice.range.start.character}-${choice.range.end.line}:${choice.range.end.character}` : ''), detail: choice.range ? choice.description : '文件快照' };
  }
}
module.exports = { ComposerContext, matches, fileGlob };
