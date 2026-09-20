/*
 * 代码骨架改动检查器（质量门禁工具，已纳入版本控制：tools/text/）。
 *
 * 用途：确认本次「注释与文案正式化」只改动了注释与字符串文本，没有改到代码。
 *
 * 口径：逐文件比较 HEAD 版本与工作区版本的「代码行多重集合」。一行的归属按下述规则判定：
 *   1. 空行与纯注释行（以行注释符号、块注释的起止符号、`#` 或 `<!--` 开头）→ 忽略；
 *   2. 剥掉行内块注释与行尾注释后为空 → 忽略；
 *   3. 剥离后仍含中文 → 该行的中文必然位于字符串、模板或正则里，不属于「代码骨架」，忽略
 *      （被忽略的行会统计并抽样列出，便于人工确认前提成立）；
 *   4. 其余行 → 计入代码多重集合，逐字符比较。
 *
 * 该口径成立的前提：本仓库的代码标识符、关键字与运算符均为 ASCII，中文只出现在注释与
 * 字符串/模板/正则里。工具会把「剥离注释后仍含中文」的行全部列出（`--list-skipped` 显示全部），
 * 该列表即是前提的核查依据。
 *
 * 已知覆盖缺口：
 *   1. 含中文的正则字面量（例如 `/不认识权限方法/`）会被规则 3 排除，因此这类正则的文本改动
 *      不会被本工具发现；它们由 test/ 与 tools/ 里的断言覆盖，并在终验时人工核对。
 *   2. 只比较 `.js`、`.cjs`、`.mjs`。`.json`、`.yml`、`.css`、`.html` 的改动不在本工具范围内
 *      （例如 `package.json` 的市场描述与设置项文案），由 test/static.js 与人工核对覆盖。
 *
 * 允许出现代码行改动的文件：
 *   ① 第一批权限改动：错误码 -32002/-32003 与展示项 selectable，已完成并跑过测试；
 *   ② 界面文案与断言：用户已批准正式化界面文案，会牵动断言与正则取值。
 *
 * 用法：node tools/text/code-diff-check.cjs [--base=<提交>] [--list-skipped] [路径 ...]
 *   基线默认为 HEAD（提交前比较工作区）。提交之后用 `--base=<基线提交>` 复现同一批证据。
 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CJK = /[\u4e00-\u9fff]/;

const SCOPE_ALLOWED = [
  // ① 第一批权限改动
  'dsh-door/lib/index.js',
  'dsh-door/lib/permission.js',
  'dsh-door/test/permission.js',
  'vscode-extension/src/panel/view.js',
  'vscode-extension/test/permission-live.js',
  // ② 界面文案与断言
  'vscode-extension/media/main.js',
  'vscode-extension/src/dsh/permission.js',
  'vscode-extension/src/dsh/errors.js',
  'vscode-extension/tools/uitest.js',
  'vscode-extension/test/panel.js',
  'vscode-extension/test/static.js',
  'vscode-extension/test/permission.js',
];

const LIST_SKIPPED = process.argv.includes('--list-skipped');
const baseArg = process.argv.find((arg) => arg.startsWith('--base='));
const BASE = baseArg ? baseArg.slice('--base='.length) : 'HEAD';

/** 纯注释行或空行。 */
function isCommentOnly(line) {
  const t = line.trim();
  if (t === '') return true;
  return (
    t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/') ||
    t.startsWith('#') || t.startsWith('<!--')
  );
}

/**
 * 混合行残余：含中文的行整体跳过比较，但其中仍可能有代码（例如 `check('中文名', a === b)`）。
 * 去掉中文字符并剥离成对引号内的文本后，残余部分用作该行的代码指纹。
 * 引号不成对（跨行模板或注释续行）时返回 null，表示无法安全判定。
 */
function residue(line) {
  const s = line.replace(/[\u4e00-\u9fff]/g, '');
  const count = (ch) => s.split(ch).length - 1;
  if (count("'") % 2 !== 0 || count('"') % 2 !== 0 || count('`') % 2 !== 0) return null;
  return s
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 计算一份代码行的多重集合。
 * @param {string} text 文件内容
 * @param {{skipped: string[], mixed: string[]}} sink 收集被规则 3 排除的行与其残余
 */
function codeLines(text, sink) {
  const result = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (isCommentOnly(raw)) continue;
    let s = raw.replace(/\/\*.*?\*\//g, '');
    const hit = /\s\/\/.*$/.exec(s);
    if (hit) s = s.slice(0, hit.index);
    s = s.replace(/\s+$/, '');
    if (s.trim() === '') continue;
    if (CJK.test(s)) {
      sink.skipped.push(raw.trim());
      const r = residue(s);
      if (r !== null && r !== '') sink.mixed.push(r);
      continue;
    }
    result.push(s);
  }
  return result;
}

function headContent(rel) {
  try {
    return execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null; // 新增文件没有基线版本
  }
}

const pathArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const diffArgs = ['diff', '--name-only', BASE, '--no-color'];
if (pathArgs.length > 0) diffArgs.push('--', ...pathArgs);
const changed = execFileSync('git', diffArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && /\.(js|cjs|mjs)$/.test(line));

const changedFiles = [];
const addedFiles = [];
const skippedAll = [];
const mixedDiffs = [];
let skippedTotal = 0;
for (const rel of changed) {
  const head = headContent(rel);
  if (head === null) {
    // 新增文件在基线里没有版本，它不是「既有代码被改动」，不参与骨架比较。
    addedFiles.push(rel);
    continue;
  }
  const sink = { skipped: [], mixed: [] };
  const before = codeLines(head, { skipped: [], mixed: [] }).sort();
  const after = codeLines(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sink).sort();
  skippedTotal += sink.skipped.length;
  for (const line of sink.skipped) skippedAll.push(`${rel}  ${line.slice(0, 120)}`);
  if (before.length === after.length && before.every((line, i) => line === after[i])) continue;
  const onlyBefore = before.filter((line) => !after.includes(line));
  const onlyAfter = after.filter((line) => !before.includes(line));
  changedFiles.push({ name: rel, onlyBefore, onlyAfter });
}

// 混合行残余比较：单独统计，用于发现「同一行既有代码又有中文」位置的代码改动。
for (const rel of changed) {
  const head = headContent(rel);
  if (head === null) continue;
  const headMixed = [];
  const workMixed = [];
  codeLines(head, { skipped: [], mixed: headMixed });
  codeLines(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { skipped: [], mixed: workMixed });
  const a = headMixed.sort();
  const b = workMixed.sort();
  if (a.length !== b.length || !a.every((line, i) => line === b[i])) {
    mixedDiffs.push({ name: rel, onlyBefore: a.filter((l) => !b.includes(l)), onlyAfter: b.filter((l) => !a.includes(l)) });
  }
}

const allowed = changedFiles.filter((f) => SCOPE_ALLOWED.some((s) => f.name.endsWith(s)));
const violations = changedFiles.filter((f) => !allowed.includes(f));

console.log(`基线：${BASE}（被跳过的含中文代码行：${skippedTotal} 行；这些行的中文位于字符串/模板/正则内，不参与比较）`);
console.log(`代码行被改动的文件：${changedFiles.length} 个（允许范围内 ${allowed.length} 个）\n`);
if (addedFiles.length > 0) {
  console.log(`新增文件（基线中不存在，不参与比较）：${addedFiles.length} 个`);
  for (const name of addedFiles) console.log(`  [新增] ${name}`);
  console.log('');
}
for (const f of allowed) console.log(`  [允许] ${f.name}`);
if (violations.length === 0) {
  console.log('\n✅ 除允许范围外，没有任何文件出现「不含中文的代码行」改动。');
} else {
  console.log(`\n── 越界改动（${violations.length} 个文件，必须修正） ──`);
  for (const f of violations) {
    console.log(`  ${f.name}`);
    for (const line of f.onlyBefore.slice(0, 8)) console.log(`    -  ${line.trim().slice(0, 140)}`);
    for (const line of f.onlyAfter.slice(0, 8)) console.log(`    +  ${line.trim().slice(0, 140)}`);
  }
}
if (LIST_SKIPPED) {
  console.log(`\n被跳过的行（全部 ${skippedAll.length} 行，用于核对「中文只在注释或字符串里」这一前提）：`);
  for (const line of skippedAll) console.log(`  ${line}`);
}
console.log(`\n混合行残余有差异的文件：${mixedDiffs.length} 个`);
for (const f of mixedDiffs) {
  console.log(`  ${f.name}`);
  for (const line of f.onlyBefore.slice(0, 6)) console.log(`    -  ${line.slice(0, 140)}`);
  for (const line of f.onlyAfter.slice(0, 6)) console.log(`    +  ${line.slice(0, 140)}`);
}
process.exit(violations.length === 0 ? 0 : 1);
