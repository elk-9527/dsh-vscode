'use strict';
/*
 * 覆盖面审计：列出「含中文但未被本次改动触及」的已跟踪文件。
 * 目的：扫描器只能检查已改过的文本，无法发现整份文件被漏掉的情况。
 * 只读脚本，不修改任何文件，也不写入 git 索引。
 *
 * 路径获取一律使用 `-z` 形式：非 ASCII 路径在默认模式下会被引号与八进制转义，
 * 既无法用于读取文件，也会让「含中文文件名的文件」被静默跳过。
 *
 * 用法：node tools/text/coverage-audit.cjs [--base=<提交>]
 *   改动集合取「工作区状态」与「相对基线的差异」的并集：提交前两者等价，
 *   提交之后只有后者非空。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = new Set(['.js', '.cjs', '.mjs', '.md', '.css', '.html', '.json', '.yml', '.yaml', '.ts']);
const CJK = /[\u4e00-\u9fff]/;
const baseArg = process.argv.find((arg) => arg.startsWith('--base='));
const BASE = baseArg ? baseArg.slice('--base='.length) : 'HEAD';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** 解析 `git status --porcelain -z`：重命名/复制记录的下一段是原路径，需要跳过。 */
function changedPaths() {
  const raw = git(['status', '--porcelain', '-z']);
  const fields = raw.split('\0').filter((s) => s.length > 0);
  const out = new Set();
  for (let i = 0; i < fields.length; i += 1) {
    const rec = fields[i];
    const status = rec.slice(0, 2);
    out.add(rec.slice(3));
    if (status[0] === 'R' || status[0] === 'C') i += 1; // 跳过紧随其后的原路径
  }
  return out;
}

/** 相对基线的改动路径。提交之后工作区状态为空，这一项才是有效来源。 */
function diffPaths() {
  const raw = git(['diff', '--name-only', '-z', BASE]);
  return new Set(raw.split('\0').filter((s) => s.length > 0));
}

const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
const changed = new Set([...changedPaths(), ...diffPaths()]);

const withCjk = [];
const missed = [];
let unreadable = 0;
for (const rel of tracked) {
  if (!EXT.has(path.extname(rel).toLowerCase())) continue;
  if (/(^|\/)(node_modules|build|backup|shots|dist)\//.test(rel)) continue;
  if (rel.startsWith('spike/capture/')) continue;
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    // 读不到的文件会计入下面的计数并输出：静默跳过会让审计结果虚高。
    unreadable += 1;
    console.log(`  [无法读取] ${rel}`);
    continue;
  }
  if (!CJK.test(text)) continue;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  withCjk.push(rel);
  if (!changed.has(rel)) missed.push({ rel, cjkCount });
}

console.log(`基线：${BASE}`);
console.log(`含中文的已跟踪文件：${withCjk.length} 个（已被本次改动触及：${withCjk.length - missed.length} 个）`);
console.log(`其中未被触及：${missed.length} 个；无法读取：${unreadable} 个\n`);
missed.sort((a, b) => b.cjkCount - a.cjkCount);
for (const m of missed) console.log(`  ${String(m.cjkCount).padStart(6)} 字  ${m.rel}`);
