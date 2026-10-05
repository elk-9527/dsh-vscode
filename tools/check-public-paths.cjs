'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const ROOT = rootAt < 0 ? path.resolve(__dirname, '..') : path.resolve(args[rootAt + 1]);
const staged = args.includes('--staged');
const git = (...items) => childProcess.execFileSync('git', items, {cwd:ROOT, windowsHide:true, maxBuffer:64*1024*1024});
const allowedDocs = new Set(['bridge-v1.md','DSH兼容维护流程.md','发布清单.md','注释与文档规范.md']);
const localOnly = /^(?:backup\/|build\/|local-notes\/|\.workbuddy\/|AGENTS\.md$|%SystemDrive%\/|spike\/(?:capture\/|scratch\/|session-survey-report\.txt$)|compat\/evidence\/(?:local|baseline|doctor|release-check))/i;
const privateScreenshots = /(?:^|\/)(?:assets|screenshots)\/panel-chat\.png$/i;
const SEP = String.fromCharCode(92);
const forbidden = [
  ['D:', 'dsh-vscode'], ['D:', 'dsh-backups'], ['D:', 'dsh-temp'],
  ['D:', 'dsh-research'], ['D:', 'Microsoft VS Code'],
  ['D:', 'Program Files', 'DSH Desktop'], ['C:', 'Program Files', 'Google', 'Chrome'],
].map(items => items.join(SEP).toLowerCase());
const homePath = /\b[a-z]:\\(?:users\\(?!public(?:\\|$)|default(?:\\|$)|(?:x|example|test-user|username|…)(?:\\|$|[\s"'`])|[<$])[^\\\s"'`<>]+|documents and settings\\(?![<$])[^\\\s"'`<>]+)/i;
const files = [...new Set(git('ls-files','--cached', ...(staged ? [] : ['--others','--exclude-standard']), '-z').toString('utf8').split('\0').filter(Boolean))];
const hits = [];
for (const relative of files) {
  if (!staged && !fs.existsSync(path.join(ROOT, relative))) continue;
  if (localOnly.test(relative) || privateScreenshots.test(relative) || (relative.startsWith('docs/') && !allowedDocs.has(relative.slice(5)))) {
    hits.push({file:relative,reason:'本地资料不属于公开项目内容'});continue;
  }
  let content;
  if (staged) content = git('show', ':'+relative);
  else {const file=path.join(ROOT,relative);if(!fs.existsSync(file))continue;content=fs.readFileSync(file);}
  if(content.includes(0))continue;
  const portable=content.toString('utf8').replaceAll('\\\\',SEP).replaceAll('/',SEP).toLowerCase();
  if(homePath.test(portable)||forbidden.some(item=>portable.includes(item)))hits.push({file:relative,reason:'包含本机绝对路径'});
}
if(hits.length){
  console.error(`公开内容检查未通过：${hits.length} 个文件。`);
  for(const hit of hits)console.error(`  ${hit.file}：${hit.reason}`);
  process.exit(1);
}
console.log(`公开内容检查通过：已检查 ${files.length} 个文件。`);
