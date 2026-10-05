'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

/** 将报告路径限制到实际仓库内，符号链接和越界路径不能创建诊断。 */
function findingLocation(cwd, finding) {
  if (typeof finding.file !== 'string' || !Number.isInteger(finding.startLine) || finding.startLine < 1) return undefined;
  try {
    const root = fs.realpathSync(cwd);
    const file = fs.realpathSync(path.resolve(root, finding.file));
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return undefined;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const end = finding.endLine ?? finding.startLine;
    if (!Number.isInteger(end) || end < finding.startLine || end > lines.length) return undefined;
    return { file, start: finding.startLine - 1, end: end - 1, endCharacter: lines[end - 1].length };
  } catch { return undefined; }
}
async function repositorySnapshot(cwd) {
  const options = { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } };
  const { stdout: rootText } = await exec('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], options);
  const root = fs.realpathSync(rootText.trim());
  const { stdout: names } = await exec('git', ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { ...options, cwd: root });
  const { stdout: head } = await exec('git', ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'], { ...options, cwd: root });
  const hash = createHash('sha256').update(head);
  let bytes = 0;
  const files = [...new Set(names.split('\0').filter(Boolean))].sort();
  if (files.length > 20000) throw new Error('仓库文件数量超过快照限制。');
  for (const name of files) {
    hash.update(name).update('\0');
    const file = path.resolve(root, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { hash.update(fs.readlinkSync(file)); continue; }
      if (!stat.isFile()) continue;
      bytes += stat.size;
      if (bytes > 128 * 1024 * 1024) throw new Error('仓库内容超过快照限制。');
      hash.update(fs.readFileSync(file));
    } catch (error) { if (error.code === 'ENOENT') hash.update('(deleted)'); else throw error; }
  }
  return { cwd: root, fingerprint: hash.digest('hex') };
}
async function validateReviewInput(cwd, input) {
  if (!input || !['worktree', 'base', 'commit', 'custom'].includes(input.mode)) throw Object.assign(new Error('审查范围无效'), { code: -32051 });
  if (['base', 'commit'].includes(input.mode)) {
    if (typeof input.ref !== 'string' || !input.ref.trim() || input.ref.length > 256 || /[\r\n\0]/.test(input.ref)) throw Object.assign(new Error('目标分支或提交无效'), { code: -32051 });
    try { await exec('git', ['--no-optional-locks', 'rev-parse', '--verify', '--end-of-options', `${input.ref}^{commit}`], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 65536, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }); }
    catch { throw Object.assign(new Error('目标分支或提交不存在'), { code: -32051 }); }
  }
}
function reportText(report, stale = false) {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  return ['# 代码审查', stale ? '快照已变化，报告中的位置尚未投影到问题列表。' : '',
    String(report.verdict || report.status || ''),
    ...findings.map(f => `## [${f.priority || 'P3'}] ${f.title || '审查发现'}\n\n${f.body || ''}\n\n${f.file || '未定位'}${f.startLine ? `:${f.startLine}` : ''}`),
    findings.length ? '' : '未返回可定位的发现。', String(report.rawText || ''),
  ].filter(Boolean).join('\n\n');
}
module.exports = { findingLocation, repositorySnapshot, validateReviewInput, reportText };
