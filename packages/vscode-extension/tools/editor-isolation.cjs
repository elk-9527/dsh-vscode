'use strict';
/** 编辑器测试隔离用户、扩展和共享账号目录，不继承便携模式覆盖。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function resolved(file) {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(resolved(parent), path.basename(absolute));
}
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function isolatedEditorOptions({ userData, extensions, sharedData, env = process.env }) {
  const directories = [userData, extensions, sharedData];
  if (directories.some(file => typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('编辑器测试需要明确的绝对隔离目录');
  const actual = directories.map(resolved);
  const protectedRoots = [path.join(os.homedir(), '.vscode'), path.join(os.homedir(), '.vscode-shared'),
    path.join(os.homedir(), '.vscode-insiders'), path.join(os.homedir(), '.vscode-insiders-shared'),
    ...(env.APPDATA ? [path.join(env.APPDATA, 'Code'), path.join(env.APPDATA, 'Code - Insiders')] : [])].map(resolved);
  if (actual.some(file => protectedRoots.some(root => inside(file, root) || inside(root, file)))) throw new Error('编辑器测试目录与日常数据目录重叠');
  if (actual.some((file, index) => actual.some((other, otherIndex) => otherIndex !== index && (inside(file, other) || inside(other, file))))) throw new Error('编辑器测试的三类数据目录需要独立');
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (/^(VSCODE_PORTABLE|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete childEnv[key];
  return { args: ['--user-data-dir', userData, '--extensions-dir', extensions, '--shared-data-dir', sharedData,
    '--disable-extension', 'vscode.github-authentication', '--disable-extension', 'vscode.microsoft-authentication'], env: childEnv };
}
function ownsEditorProcess(commandLine, userData) {
  const match = String(commandLine || '').match(/--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))/);
  if (!match) return false;
  const actual = path.resolve(match[1] || match[2]), expected = path.resolve(userData);
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}
function belongsToEditor(item, all, userData) {
  const byPid = new Map(all.map(entry => [entry.pid, entry])), seen = new Set();
  for (let current = item; current && !seen.has(current.pid); current = byPid.get(current.ppid)) {
    seen.add(current.pid);
    if (/^Code\.exe$/i.test(current.name) && ownsEditorProcess(current.cmdline, userData)) return true;
  }
  return false;
}
module.exports = { isolatedEditorOptions, ownsEditorProcess, belongsToEditor };
