/*
 * 注释信息量检查器（质量门禁工具，已纳入版本控制：tools/text/）。
 *
 * 用途：为「改写不得减少信息量」提供量化证据。逐个文件比对 HEAD 与当前工作区
 *       注释文本中的中文字符数，降幅超过阈值的文件列为可疑，需要人工对照原文。
 *
 * 为什么用中文字符数：正式化会去掉口语助词、人称与比喻，字数必然小幅下降；
 * 但大幅下降通常意味着整段因果说明被删。阈值取 25%（正常改写经验值在 15% 以内）。
 *
 * 已知限制：只统计注释，不判断内容是否等价。降幅达标不等于内容等价，
 *           仍需对高价值注释抽样对照。
 *
 * 用法：node tools/text/comment-volume.cjs [--base=<提交>] [阈值百分比]
 *   基线默认为 HEAD（提交前比较工作区）。提交之后用 `--base=<基线提交>` 复现同一批证据。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const baseArg = process.argv.find((arg) => arg.startsWith('--base='));
const BASE = baseArg ? baseArg.slice('--base='.length) : 'HEAD';
const THRESHOLD = Number(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || 25);

/** 判断一行是否是注释行。 */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/');
}

/** 取出一段文本里注释部分的中文字符数（含行尾注释）。 */
function cjkInComments(text) {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    let comment = '';
    if (isCommentLine(line)) {
      comment = line;
    } else {
      const block = /\/\*.*?\*\//.exec(line);
      const tail = /\s\/\/.*$/.exec(line);
      comment = `${block ? block[0] : ''}${tail ? tail[0] : ''}`;
    }
    total += (comment.match(/[\u4e00-\u9fff]/g) || []).length;
  }
  return total;
}

const changed = execFileSync('git', ['diff', '--name-only', BASE], { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((name) => /\.(js|cjs|mjs)$/.test(name));

const rows = [];
for (const name of changed) {
  let before = '';
  try {
    before = execFileSync('git', ['show', `${BASE}:${name}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    continue; // 新文件（基线里没有）不参与比对
  }
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  const after = fs.readFileSync(file, 'utf8');
  const oldCount = cjkInComments(before);
  const newCount = cjkInComments(after);
  if (oldCount === 0) continue;
  rows.push({ name, oldCount, newCount, delta: ((newCount - oldCount) / oldCount) * 100 });
}

rows.sort((a, b) => a.delta - b.delta);
const suspicious = rows.filter((row) => row.delta < -THRESHOLD);

console.log(`基线 ${BASE}：对比 ${rows.length} 个代码文件的注释中文字符量，阈值 ${THRESHOLD}%\n`);
console.log('降幅最大的 12 个文件：');
for (const row of rows.slice(0, 12)) {
  console.log(`  ${row.delta.toFixed(1).padStart(6)}%   ${String(row.oldCount).padStart(5)} → ${String(row.newCount).padStart(5)}   ${row.name}`);
}
const sumOld = rows.reduce((n, r) => n + r.oldCount, 0);
const sumNew = rows.reduce((n, r) => n + r.newCount, 0);
console.log(`\n合计：${sumOld} → ${sumNew}（${(((sumNew - sumOld) / sumOld) * 100).toFixed(1)}%）`);
if (suspicious.length === 0) {
  console.log(`\n✅ 没有文件降幅超过 ${THRESHOLD}%，未见成段删除的迹象。`);
} else {
  console.log(`\n── 降幅超过 ${THRESHOLD}% 的文件（${suspicious.length} 个，需人工对照原文） ──`);
  for (const row of suspicious) console.log(`  ${row.name}  ${row.oldCount} → ${row.newCount}`);
}
