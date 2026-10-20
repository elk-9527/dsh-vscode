'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MAX_CONTEXT_BYTES } = require('../chat/context');
const exec = promisify(execFile);
const MAX_FILES = 200;
const inside = (file, root) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const cancelled = signal => { if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: -32800 }); };
const matches = (name, query) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase());

async function scopedFile(cwd, file, signal) {
  cancelled(signal);
  if (!inside(file, cwd) || path.resolve(file) === path.resolve(cwd)) throw new Error('上下文文件不在本次对话目录内。');
  const root = await fs.realpath(cwd);
  let current = file;
  while (true) {
    try { if (!inside(await fs.realpath(current), root)) throw new Error('上下文文件链接指向目录外部。'); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current || !inside(parent, cwd)) throw error;
      current = parent;
    }
  }
  cancelled(signal);
}

async function git(cwd, args, signal, maxBuffer = MAX_CONTEXT_BYTES) {
  cancelled(signal);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' });
  try {
    const result = await exec('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd, env, signal, timeout: 15000, maxBuffer, encoding: 'utf8', windowsHide: true });
    cancelled(signal); return result.stdout;
  } catch (error) {
    cancelled(signal);
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git 变更超过 256 KiB，请按文件名筛选后重新添加。');
    throw new Error(error.code === 'ENOENT' ? '未找到 Git，请先安装 Git。' : '无法读取当前目录的 Git 变更，请确认目录属于可用仓库。');
  }
}
const diffArgs = staged => ['diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--relative', '--ignore-submodules=all'];

async function gitChoices(cwd, query, signal) {
  const choices = [];
  for (const staged of [false, true]) {
    const names = await git(cwd, [...diffArgs(staged), '--name-only', '-z', '--', '.'], signal);
    const paths = names.split('\0').filter(Boolean).filter(name => matches(name, query));
    if (paths.length > MAX_FILES) throw new Error('匹配的变更超过 200 个文件，请输入文件名缩小范围。');
    const safe = [];
    for (const name of paths) {
      const file = path.resolve(cwd, name);
      try { await scopedFile(cwd, file, signal); safe.push(name); }
      catch (error) { cancelled(signal); if (error.code === 'ENOENT' || /目录外部|目录内/.test(error.message)) continue; throw error; }
    }
    if (!safe.length) continue;
    const label = staged ? '已暂存变更' : '未暂存变更';
    choices.push({ kind: 'git-diff', label: `${query ? '匹配的' : '全部'}${label}`, description: `${safe.length} 个已跟踪文件 · 不含未保存编辑`, staged, paths: safe, group: true });
    for (const name of safe) choices.push({ kind: 'git-diff', label: name, description: label, staged, paths: [name] });
  }
  choices.sort((a, b) => Number(Boolean(b.group)) - Number(Boolean(a.group)));
  return { choices, note: choices.length ? '选择后附加 Git 补丁。未保存编辑和未跟踪文件需另行添加；子模块内容不在此范围。' : '没有匹配的已跟踪变更。未保存编辑和未跟踪文件可通过文件或选区添加。' };
}

async function diagnosticChoices(vscode, cwd, query, signal) {
  const choices = [];
  for (const [uri, diagnostics] of vscode.languages?.getDiagnostics?.() || []) {
    cancelled(signal);
    if (uri.scheme !== 'file' || !inside(uri.fsPath, cwd) || !diagnostics.length) continue;
    const name = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
    if (!matches(name, query)) continue;
    try { await scopedFile(cwd, uri.fsPath, signal); }
    catch (error) { cancelled(signal); if (error.code === 'ENOENT' || /目录外部|目录内/.test(error.message)) continue; throw error; }
    choices.push({ kind: 'diagnostics', label: name, description: `${diagnostics.length} 项问题诊断`, uris: [uri] });
    if (choices.length > MAX_FILES) throw new Error('匹配的问题文件超过 200 个，请输入文件名缩小范围。');
  }
  choices.sort((a, b) => a.label.localeCompare(b.label));
  if (choices.length) choices.unshift({ kind: 'diagnostics', label: '当前目录的全部问题诊断', description: `${choices.length} 个匹配文件 · 选中时读取`, uris: choices.flatMap(choice => choice.uris) });
  return { choices, note: '仅收集 VS Code 已提供的问题诊断，不运行检查。结果可能来自未保存编辑，且不代表完整测试或审查。' };
}

function attachment(cwd, choice, text, scope, source, detail) {
  if (text.includes('\0') || Buffer.byteLength(text) > MAX_CONTEXT_BYTES) throw new Error('上下文超过 256 KiB，请按文件名筛选后重新添加。');
  const key = scope === 'git-diff' ? `${choice.staged}:${choice.paths.join('\0')}` : choice.uris.map(uri => uri.toString()).join('\0');
  return { kind: 'content', id: `${scope}:${require('node:crypto').createHash('sha256').update(cwd).update(key).digest('hex')}`, name: choice.label, text, language: scope === 'git-diff' ? 'diff' : 'text', scope, source, detail, sourcePath: cwd, snapshotAt: new Date().toISOString(), byteLength: Buffer.byteLength(text) };
}

async function captureGit(cwd, choice, signal) {
  for (const name of choice.paths) await scopedFile(cwd, path.resolve(cwd, name), signal);
  const patch = await git(cwd, [...diffArgs(choice.staged), '--', ...choice.paths], signal);
  for (const name of choice.paths) await scopedFile(cwd, path.resolve(cwd, name), signal);
  if (!patch.trim()) throw new Error('所选 Git 变更已消失，请重新选择。');
  const label = choice.staged ? '已暂存：HEAD 与暂存区的差异' : '未暂存：暂存区与磁盘工作文件的差异';
  return attachment(cwd, choice, `${label}\n范围：${choice.paths.map(name => JSON.stringify(name)).join(', ')}\n仅包含 Git 输出；不包含未保存编辑、未跟踪文件或子模块正文。\n\n${patch}`, 'git-diff', choice.staged ? 'git-index' : 'git-worktree', label);
}

async function captureDiagnostics(vscode, cwd, choice, signal) {
  const entries = []; let count = 0, bytes = 0;
  for (const uri of choice.uris) {
    await scopedFile(cwd, uri.fsPath, signal);
    const diagnostics = vscode.languages.getDiagnostics(uri) || [];
    const name = path.relative(cwd, uri.fsPath).split(path.sep).join('/');
    const document = (vscode.workspace.textDocuments || []).find(doc => doc.uri.toString() === uri.toString());
    for (const item of diagnostics) {
      if (++count > 1000) throw new Error('问题诊断超过 1000 项，请按文件名筛选。');
      const start = item.range?.start, end = item.range?.end;
      if (!start || !end || !Number.isInteger(start.line) || !Number.isInteger(start.character) || start.line < 0 || start.character < 0) continue;
      const severity = ['错误', '警告', '信息', '提示'][item.severity] || '未知';
      const code = typeof item.code === 'object' ? item.code?.value : item.code;
      const source = [item.source, typeof code === 'number' || typeof code === 'string' ? String(code) : ''].filter(Boolean).join(' ');
      const message = String(item.message || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      const entry = `${JSON.stringify(name)}:${start.line + 1}:${start.character + 1}–${end.line + 1}:${end.character + 1}（末端不含） [${severity}${source ? ' · ' + source : ''}]${document?.isDirty ? '（文件含未保存编辑）' : ''}\n${message}`;
      bytes += Buffer.byteLength(entry) + 2;
      if (bytes > MAX_CONTEXT_BYTES) throw new Error('问题诊断超过 256 KiB，请按文件名筛选后重新添加。');
      entries.push(entry);
    }
    await scopedFile(cwd, uri.fsPath, signal);
  }
  cancelled(signal);
  if (!entries.length) throw new Error('所选问题诊断已清除，请重新选择。');
  return attachment(cwd, choice, `VS Code 问题诊断 · ${entries.length} 项\n仅为当前已提供的诊断；没有运行测试或代码审查，结果可能尚未更新。\n\n${entries.join('\n\n')}`, 'diagnostics', 'vscode-diagnostics', `${entries.length} 项问题诊断`);
}
module.exports = { gitChoices, diagnosticChoices, captureGit, captureDiagnostics };
