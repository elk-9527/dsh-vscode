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
/** Recognize a CLI launcher only; PID and isolated-editor ancestry establish ownership separately. */
function isDshKernelLauncher(item) {
  if (!/^cmd\.exe$/i.test(item.name || '')) return false;
  const shell = String(item.cmdline || '').match(/^(?:"([^"]+)"|(\S+))\s+(?:\/[ds]\s+)*\/c\s+([\s\S]+)$/i);
  if (!shell || !/^cmd\.exe$/i.test(path.win32.basename(shell[1] || shell[2]))) return false;
  let command = shell[3].trim();
  if (command.startsWith('"') && command.endsWith('"') && (command.startsWith('""') || command.indexOf('"', 1) === command.length - 1)) command = command.slice(1, -1);
  const argv = []; let word = '', quoted = false;
  for (const character of command) {
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && /[&|<>^]/.test(character)) return false;
    if (!quoted && /\s/.test(character)) { if (word) argv.push(word); word = ''; }
    else word += character;
  }
  if (quoted) return false;
  if (word) argv.push(word);
  const executable = path.win32.basename(argv[0] || '').toLowerCase();
  let flagsAt;
  if (/^dsh(?:\.cmd)?$/.test(executable)) flagsAt = 1;
  else if (/^node(?:\.exe)?$/.test(executable)) {
    if (/[\\/]dsh[\\/]lib[\\/]bin\.js$/i.test(argv[1] || '')) flagsAt = 2;
    else if (/[\\/]src[\\/]door[\\/]desktop-cli-host\.cjs$/i.test(argv[1] || '')
      && path.win32.isAbsolute(argv[2] || '') && /^DeepSeek Harness\.exe$/i.test(path.win32.basename(argv[2]))) {
      const packageRoot = path.win32.join(path.win32.dirname(argv[2]), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
      const entries = [['dsh-desktop-host', 'cli.js'], ['dsh', 'bin.js']]
        .map(([name, file]) => path.win32.join(packageRoot, name, 'lib', file).toLowerCase());
      if (!entries.includes(path.win32.normalize(argv[3] || '').toLowerCase())) return false;
      flagsAt = 4;
    } else return false;
  } else return false;
  const flags = argv.slice(flagsAt), end = flags.indexOf('--');
  if (end >= 0) flags.length = end;
  const profile = flags.indexOf('--profile');
  return flags.includes('--no-open') && profile >= 0 && /^(?!-)[A-Za-z0-9._-]+$/.test(flags[profile + 1] || '');
}
/** 清理实例根进程即可覆盖子进程，避免同一快照中重复终止已退出的后代。 */
function editorProcessRoots(all, userData) {
  const owned = all.filter(item => ownsEditorProcess(item.CommandLine, userData));
  const ownedIds = new Set(owned.map(item => item.ProcessId));
  const byPid = new Map(all.map(item => [item.ProcessId, item]));
  return owned.filter(item => {
    const seen = new Set([item.ProcessId]);
    for (let parent = byPid.get(item.ParentProcessId); parent && !seen.has(parent.ProcessId); parent = byPid.get(parent.ParentProcessId)) {
      if (ownedIds.has(parent.ProcessId)) return false;
      seen.add(parent.ProcessId);
    }
    return true;
  });
}
module.exports = { isolatedEditorOptions, ownsEditorProcess, belongsToEditor, isDshKernelLauncher, editorProcessRoots };
