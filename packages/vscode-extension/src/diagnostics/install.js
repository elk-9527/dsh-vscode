'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { commandLine, resolveCommand, redactSensitiveOutput } = require('../door/locate');
const { PACKAGE, VERSION, inspectProfile, installationPlan } = require('./profiles');
function runAsync({ command, args, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : resolveCommand(command)[0];
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', '"' + commandLine(command, args) + '"'] : [...resolveCommand(command).slice(1), ...args];
    execFile(executable, argv, { windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(redactSensitiveOutput(stderr || stdout || error.message)));
      else resolve();
    });
  });
}
/** 安装前重新核对来源；只处理明确选择的 web 配置集，不改 desktop。 */
async function installRegistry({ item, command, storage, options = {}, run = runAsync }) {
  if (!PACKAGE.test(item.name) || !VERSION.test(item.version || '') || item.target === 'desktop') throw new Error('安装目标或精确版本无效');
  const source = inspectProfile('desktop', options), target = inspectProfile(item.target, options);
  const fresh = installationPlan(source, target).find(x => x.name === item.name && x.executable && x.version === item.version);
  if (!fresh) throw new Error('安装来源或目标已变化，请重新查看安装说明。');
  const backup = path.join(storage, 'install-backups', Date.now() + '-' + require('node:crypto').randomUUID());
  fs.mkdirSync(backup, { recursive: true });
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const file = path.join(target.directory, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, name));
  }
  const old = path.join(target.directory, 'node_modules', ...item.name.split('/'));
  if (fs.existsSync(old)) fs.cpSync(fs.realpathSync(old), path.join(backup, 'old-package'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'record.json'), JSON.stringify({ name: item.name, version: item.version, target: item.target, status: 'prepared' }, null, 2));
  try {
    await run({ command, args: ['plugin', '--profile', item.target, 'add', item.name + '@' + item.version] });
    const after = inspectProfile(item.target, options), installed = after.packages.find(x => x.name === item.name);
    if (!installed?.installed || installed.version !== item.version || !installed.bundled) throw new Error('命令已完成，但安装内容或启用清单未通过核对。');
    fs.writeFileSync(path.join(backup, 'result.json'), JSON.stringify({ status: 'installed', runtimeRegistered: 'awaiting-reload', name: item.name, version: item.version }));
    return { backup, installed };
  } catch (error) {
    const reason = /未通过核对/.test(error.message) ? '安装回读未通过' : /timeout|timed out/i.test(error.message) ? '安装命令超时' : /ENOENT|not found|找不到/i.test(error.message) ? '安装命令或来源不存在' : '安装命令执行失败';
    fs.writeFileSync(path.join(backup, 'result.json'), JSON.stringify({ status: 'failed', reason, name: item.name, version: item.version }));
    throw Object.assign(new Error(reason + '，目标配置和旧包已备份。'), { backup, code: -32050 });
  }
}
module.exports = { installRegistry, runAsync };
