'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SEP = String.fromCharCode(92);
const forbidden = [
  ['C:', 'Users', 'Lenovo'].join(SEP),
  ['D:', 'dsh-vscode'].join(SEP),
  ['D:', 'dsh-backups'].join(SEP),
  ['D:', 'dsh-temp'].join(SEP),
  ['D:', 'dsh-research'].join(SEP),
  ['D:', 'Microsoft VS Code'].join(SEP),
  ['D:', 'Program Files', 'DSH Desktop'].join(SEP),
  ['C:', 'Program Files', 'Google', 'Chrome'].join(SEP),
].map((item) => item.toLowerCase());

const files = childProcess.execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const hits = [];

for (const relative of files) {
  const file = path.join(ROOT, relative);
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  const portable = content.toString('utf8').replaceAll('\\\\', SEP).replaceAll('/', SEP).toLowerCase();
  const matched = forbidden.find((item) => portable.includes(item));
  if (matched) hits.push(relative);
}

if (hits.length) {
  console.error(`发现 ${hits.length} 个公开文件仍含开发机绝对路径：`);
  for (const relative of hits) console.error(`  ${relative}`);
  process.exit(1);
}

console.log(`公开路径检查通过：已检查 ${files.length} 个受版本控制文件。`);
