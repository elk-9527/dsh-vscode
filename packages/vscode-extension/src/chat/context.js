'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');

const MAX_CONTEXT_BYTES = 256 * 1024;
const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(target, base) { const rel = path.relative(base, target); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
function selectionEndLine(range) { return range.end.line + (range.end.character === 0 && range.end.line > range.start.line ? 0 : 1); }

async function validateReference(vscode, uri, cwd, signal) {
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: -32800 });
  if (!vscode.workspace.isTrusted) throw new Error('读取文件引用需要受信任工作区。');
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri?.file ? vscode.Uri.file(cwd) : { scheme: 'file', fsPath: cwd });
  if (!folder || !inside(cwd, folder.uri.fsPath)) throw new Error('文件引用不在本次对话工作区，请分别发送。');
  const [workspaceRoot, base] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(cwd)]);
  if (!inside(base, workspaceRoot)) throw new Error('当前对话目录链接指向工作区外部，无法引用。');
  if (uri.scheme === 'file') {
    if (!inside(uri.fsPath, cwd)) throw new Error('文件引用不在本次对话工作区，请分别发送。');
    const target = await fs.realpath(uri.fsPath);
    if (!inside(target, base) || identity(target) === identity(base)) throw new Error('文件链接指向工作区外部，无法引用。');
  }
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: -32800 });
  if (!vscode.workspace.isTrusted) throw new Error('读取文件引用需要受信任工作区。');
}

/** 只收集用户显式引用的编辑器快照，包括未保存文件和 Location 选区。 */
async function referenceAttachments(vscode, references, cwd, signal) {
  const attachments = [], seen = new Set(); let bytes = 0;
  if ((references || []).length > 20) throw new Error('最多附加 20 项。');
  for (const reference of references || []) {
    if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: -32800 });
    const value = reference.value, uri = value?.uri || value;
    if (!uri?.scheme || !['file', 'untitled'].includes(uri.scheme)) throw new Error('DSH 当前仅支持文件和选区引用。');
    await validateReference(vscode, uri, cwd, signal);
    const range = value?.range;
    const key = uri.toString() + (range ? `:${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}` : '');
    if (seen.has(key)) continue;
    seen.add(key);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isClosed) throw new Error('引用文件已关闭，请重新选择。');
    if (!vscode.workspace.isTrusted) throw new Error('读取文件引用需要受信任工作区。');
    if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: -32800 });
    if (range && (range.start.line < 0 || range.end.line >= document.lineCount || document.validateRange(range).isEqual(range) !== true)) throw new Error('引用选区已变化，请重新选择。');
    if (value?.documentVersion !== undefined && document.version !== value.documentVersion) throw new Error('引用文件或选区已变化，请重新选择。');
    const text = document.getText(range);
    if (text.includes('\0')) throw new Error('DSH 当前仅支持文本文件引用。');
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CONTEXT_BYTES) throw new Error('文件上下文超过 256 KiB，请选择较小的代码片段。');
    const name = uri.scheme === 'file' ? path.relative(cwd, uri.fsPath).split(path.sep).join('/') : path.basename(document.fileName || uri.path || '未保存文件');
    const version = document.version;
    const item = { kind: range ? 'selection' : 'content', text, name, language: document.languageId,
      sourceUri: uri.toString(), sourcePath: uri.scheme === 'file' ? uri.fsPath : document.fileName || uri.path || name,
      scope: range ? 'selection' : 'file', isDirty: Boolean(document.isDirty), isUntitled: uri.scheme === 'untitled' || Boolean(document.isUntitled),
      snapshotAt: new Date().toISOString(), byteLength: Buffer.byteLength(text, 'utf8'), documentVersion: version,
      ...(range ? { startLine: range.start.line + 1, endLine: selectionEndLine(range), rangeEndLine: range.end.line + 1, startCharacter: range.start.character, endCharacter: range.end.character } : {}) };
    await validateReference(vscode, uri, cwd, signal);
    if (document.isClosed || document.version !== version) throw new Error('引用文件或选区已变化，请重新选择。');
    attachments.push(item);
  }
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: -32800 });
  return attachments;
}

function filterSkillGroups(groups, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return (groups || []).map(group => ({ ...group, skills: (group.skills || []).filter(skill => !needle ||
    `${skill.name || ''}\n${skill.description || ''}`.toLocaleLowerCase().includes(needle)) })).filter(group => group.skills.length);
}
module.exports = { referenceAttachments, filterSkillGroups, MAX_CONTEXT_BYTES, selectionEndLine };
