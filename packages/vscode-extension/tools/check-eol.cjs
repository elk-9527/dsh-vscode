'use strict';
// 同一文件中混用 CRLF 与 LF 是最严重的情况：git 归一化后两侧均显示为干净，
// 但 doorDrift() 那类逐字节比对会报告"不一致"。
//
// 用法：可在任意目录下运行 node tools/check-eol.cjs
// 仅报告，不修改文件。存在混用两种换行的文件时以非 0 状态退出（可用于 CI）。
const fs = require('node:fs');
const path = require('node:path');

// 由脚本位置推导仓库根：tools → vscode-extension → packages → 仓库根。
// 不依赖当前工作目录 —— 原实现要求"在仓库根目录运行"，移入 tools/ 后必须修正。
const REPO = path.resolve(__dirname, '..', '..', '..');

const roots = [
  'packages/dsh-door',
  'packages/vscode-extension/src',
  'packages/vscode-extension/media',
  'packages/vscode-extension/test',
  'packages/vscode-extension/tools',
  'docs',
].map((r) => path.join(REPO, r));
const EXTS = new Set(['.js', '.mjs', '.cjs', '.css', '.json', '.md', '.yml', '.yaml', '.html']);

const mixed = [];
const crlfOnly = [];
const lfOnly = [];
const bom = [];
let total = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === '.git') continue;
      walk(p);
      continue;
    }
    if (!EXTS.has(path.extname(entry.name))) continue;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) continue;
    /*
     * BOM 亦在此处检查（2026-09-19 发生的真实事故）：
     * 使用 PowerShell 的 `Set-Content -Encoding UTF8` 修改过的 JSON 会**带上 UTF-8 BOM**
     * （EF BB BF），而 `JSON.parse` 不识别该字节序列 → 内核加载插件时直接抛出
     * `SyntaxError: Unexpected token '﻿'`，整个 profile 的插件状态均损坏。
     * 当时即以此方式将 ACP 接入点插件（`dsh-acp-door`）的新版本装入用户档：
     * 包中的 package.json 带 BOM，安装后 `dsh plugin` 立即报错。因此本工具将其纳入检查 ——
     * 修改文件应当使用编辑工具，不使用 PowerShell 写入。
     */
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      bom.push(path.relative(REPO, p));
    }
    const text = buf.toString('utf8');
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/(?<!\r)\n/g) || []).length;
    total += 1;
    const rel = path.relative(REPO, p);
    if (crlf > 0 && lf > 0) mixed.push(`${rel}  (CRLF ${crlf} 行 / LF ${lf} 行)`);
    else if (crlf > 0) crlfOnly.push(rel);
    else lfOnly.push(rel);
  }
}

for (const r of roots) if (fs.existsSync(r)) walk(r);

console.log(`看了 ${total} 个文本文件（仓库根：${REPO}）`);
console.log(`  LF：${lfOnly.length}   CRLF：${crlfOnly.length}   **混着两种：${mixed.length}**`);
console.log(`  **带 UTF-8 BOM：${bom.length}**（BOM 会使 JSON.parse 立即失败，安装到配置集时会整体失败）`);
if (mixed.length) {
  console.log('\n混着两种换行的文件（这几个要修）：');
  for (const m of mixed) console.log('  ' + m);
}
if (bom.length) {
  console.log('\n带 BOM 的文件（这几个需要修复：用编辑工具重写，不使用 PowerShell 的 Set-Content）：');
  for (const b of bom) console.log('  ' + b);
}
if (crlfOnly.length && crlfOnly.length <= 12) {
  console.log('\n纯 CRLF 的文件：');
  for (const c of crlfOnly) console.log('  ' + c);
}
process.exit(mixed.length || bom.length ? 1 : 0);
