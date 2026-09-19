'use strict';
// 一个文件里混着 CRLF 和 LF 是最坏的情况：git 归一化后两边看着都干净，
// 但 doorDrift() 那种逐字节比对会莫名其妙地报"不一致"。
//
// 用法：任意目录下都能跑：node tools/check-eol.cjs
// 只报告，不改文件。混着两种换行的文件会让它非 0 退出（可以进 CI）。
const fs = require('node:fs');
const path = require('node:path');

// 从脚本位置推出仓库根：tools → vscode-extension → packages → 仓库根。
// 不依赖当前工作目录 —— 原来这个脚本靠"在仓库根跑"才行，搬进 tools/ 后必须修掉。
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
if (mixed.length) {
  console.log('\n混着两种换行的文件（这几个要修）：');
  for (const m of mixed) console.log('  ' + m);
}
if (crlfOnly.length && crlfOnly.length <= 12) {
  console.log('\n纯 CRLF 的文件：');
  for (const c of crlfOnly) console.log('  ' + c);
}
process.exit(mixed.length ? 1 : 0);
