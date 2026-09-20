'use strict';
/*
 * 覆盖面审计：列出「含中文但工作区未改动」的已跟踪文件。
 * 目的：扫描器只能检查已改过的文本，无法发现整份文件被漏掉的情况。
 * 只读脚本，不修改任何文件，也不写入 git 索引。
 *
 * 路径获取使用 `git status --porcelain -z`：非 ASCII 路径在该模式下不转义，
 * 避免按显示形式做字符串比较而误判。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = new Set(['.js', '.cjs', '.mjs', '.md', '.css', '.html', '.json', '.yml', '.yaml', '.ts']);
const CJK = /[\u4e00-\u9fff]/;

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

const tracked = git(['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean);
const changed = changedPaths();

const withCjk = [];
const missed = [];
for (const rel of tracked) {
  if (!EXT.has(path.extname(rel).toLowerCase())) continue;
  if (/(^|\/)(node_modules|build|backup|shots|dist)\//.test(rel)) continue;
  if (rel.startsWith('spike/capture/')) continue;
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (!CJK.test(text)) continue;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  withCjk.push(rel);
  if (!changed.has(rel)) missed.push({ rel, cjkCount });
}

console.log(`含中文的已跟踪文件：${withCjk.length} 个（工作区改动：${withCjk.length - missed.length} 个）`);
console.log(`其中工作区未改动：${missed.length} 个\n`);
missed.sort((a, b) => b.cjkCount - a.cjkCount);
for (const m of missed) console.log(`  ${String(m.cjkCount).padStart(6)} 字  ${m.rel}`);
