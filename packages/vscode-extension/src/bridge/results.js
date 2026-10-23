'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
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
async function repositorySnapshot(cwd, { signal, timeout = 10000, concurrency = 4 } = {}) {
  signal?.throwIfAborted();
  const options = { cwd, signal, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } };
  let rootText;
  try { ({ stdout: rootText } = await exec('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], options)); }
  catch (error) {
    if (error.code === 128 && /not a git repository/i.test(error.stderr || '')) error.code = 'NOT_GIT_REPOSITORY';
    throw error;
  }
  const root = await fsp.realpath(rootText.trim());
  const { stdout: status } = await exec('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { ...options, cwd: root });
  const { stdout: names } = await exec('git', ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { ...options, cwd: root });
  const { stdout: index } = await exec('git', ['--no-optional-locks', 'ls-files', '--stage', '-z'], { ...options, cwd: root });
  let head, headState = 'committed';
  try { ({ stdout: head } = await exec('git', ['--no-optional-locks', 'rev-parse', '--verify', '--quiet', 'HEAD'], { ...options, cwd: root })); }
  catch (error) {
    if (error.code !== 1) throw error;
    // A missing symbolic branch is a valid initial repository; detached or corrupt HEAD is not.
    const { stdout: branch } = await exec('git', ['symbolic-ref', '-q', 'HEAD'], { ...options, cwd: root });
    let missingBranch = false;
    try { await exec('git', ['show-ref', '--verify', '--quiet', branch.trim()], { ...options, cwd: root }); }
    catch (missing) { if (missing.code !== 1) throw missing; missingBranch = true; }
    if (!missingBranch) throw error;
    head = 'unborn\n'; headState = 'unborn';
  }
  const hash = createHash('sha256').update(head);
  let bytes = 0;
  const files = [...new Set(names.split('\0').filter(Boolean))].sort();
  if (files.length > 20000) throw new Error('仓库文件数量超过快照限制。');
  const read = async name => {
    signal?.throwIfAborted();
    const file = path.resolve(root, name);
    try {
      const stat = await fsp.lstat(file);
      if (stat.isSymbolicLink()) return await fsp.readlink(file);
      if (!stat.isFile()) return '';
      bytes += stat.size;
      if (bytes > 128 * 1024 * 1024) throw new Error('仓库内容超过快照限制。');
      const content = await fsp.readFile(file, { signal });
      bytes += Math.max(0, content.length - stat.size);
      if (bytes > 128 * 1024 * 1024) throw new Error('仓库内容超过快照限制。');
      return content;
    } catch (error) { if (error.code === 'ENOENT') return '(deleted)'; throw error; }
  };
  const width = Math.max(1, Math.min(16, Number.isInteger(concurrency) ? concurrency : 4));
  for (let offset = 0; offset < files.length; offset += width) {
    const batch = files.slice(offset, offset + width);
    const results = await Promise.allSettled(batch.map(read));
    for (let i = 0; i < results.length; i++) {
      const result = results[i]; if (result.status === 'rejected') throw result.reason;
      // Preserve the original ordered byte fingerprint while yielding file I/O.
      hash.update(batch[i]).update('\0').update(result.value);
    }
  }
  return { cwd: root, fingerprint: hash.digest('hex'), indexFingerprint: createHash('sha256').update(index).digest('hex'), hasChanges: status.length > 0, headState };
}
/** Older records retain their original content-only comparison semantics. */
function sameRepositorySnapshot(record, current) {
  return record.fingerprint === current.fingerprint &&
    (!record.indexFingerprint || record.indexFingerprint === current.indexFingerprint) &&
    (!record.headState || record.headState === current.headState);
}
async function validateReviewInput(cwd, input) {
  if (!input || !['worktree', 'base', 'commit', 'custom'].includes(input.mode)) throw Object.assign(new Error('审查范围无效'), { code: -32051 });
  if (['base', 'commit'].includes(input.mode)) {
    if (typeof input.ref !== 'string' || !input.ref.trim() || input.ref.length > 256 || /[\r\n\0]/.test(input.ref)) throw Object.assign(new Error('目标分支或提交无效'), { code: -32051 });
    try { const result = await exec('git', ['--no-optional-locks', 'rev-parse', '--verify', '--end-of-options', `${input.ref}^{commit}`], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 65536, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }); return result.stdout.trim(); }
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
module.exports = { findingLocation, repositorySnapshot, sameRepositorySnapshot, validateReviewInput, reportText };
