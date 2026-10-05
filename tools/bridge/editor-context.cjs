'use strict';
/** 核对编辑器运行时是否能查询启动它的进程；环境限制不计为产品兼容失败。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolatedEditorOptions } = require('../../packages/vscode-extension/tools/editor-isolation.cjs');

function childProbe() {
  const parent = Number(process.argv[process.argv.indexOf('--parent-pid') + 1]);
  if (!Number.isInteger(parent) || parent < 1) throw new Error('启动进程编号无效');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `$probeSelf = [bool](Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue); `
    + `$probeParent = [bool](Get-Process -Id ${parent} -ErrorAction SilentlyContinue); `
    + `$probeGroups = (whoami /groups | Out-String); $probeLevel = [regex]::Match($probeGroups, 'S-1-16-([0-9]+)').Groups[1].Value; `
    + `@{selfAlive=$probeSelf;parentAlive=$probeParent;integrityRid=$probeLevel} | ConvertTo-Json -Compress`;
  const query = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 7000 });
  if (query.status !== 0) throw new Error('进程可见范围查询未完成');
  console.log(JSON.stringify({ node: process.version, ...JSON.parse(query.stdout.trim()) }));
}

function probeEditorContext({ code, folder }) {
  if (!fs.existsSync(code)) throw new Error('找不到待验收编辑器');
  const userData = path.join(folder, 'context-user'), extensions = path.join(folder, 'context-extensions'), sharedData = path.join(folder, 'context-shared');
  for (const directory of [userData, extensions, sharedData]) fs.mkdirSync(directory, { recursive: true });
  const isolation = isolatedEditorOptions({ userData, extensions, sharedData });
  // 此处只运行签名编辑器所带的 Node；保留隔离参数，避免意外进入图形模式时访问日常目录。
  const result = spawnSync(code, [__filename, '--ms-enable-electron-run-as-node', '--probe', '--parent-pid', String(process.pid), ...isolation.args],
    { env: { ...isolation.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  let observed;
  try { if (result.status !== 0) throw new Error(); observed = JSON.parse(result.stdout.trim()); }
  catch { return { status: 'unavailable', exitCode: result.status, spawnError: result.error?.code, reason: '编辑器运行环境查询未完成' }; }
  const status = observed.selfAlive && observed.parentAlive ? 'passed' : 'environment-blocked';
  return { status, ...observed, ...(status === 'environment-blocked' ? { reason: '编辑器运行时无法查询仍在等待本次检查的启动进程；外部内核身份检查没有足够的环境条件' } : {}) };
}

function requireEditorContext(context) {
  if (context.status !== 'passed') throw Object.assign(new Error(context.reason), {
    code: context.status === 'environment-blocked' ? 'DSH_EDITOR_ENVIRONMENT_RESTRICTED' : 'DSH_EDITOR_CONTEXT_UNAVAILABLE', editorContext: context,
  });
}

function installedEditor() {
  const found = spawnSync('where.exe', ['code'], { encoding: 'utf8', windowsHide: true });
  for (const file of String(found.stdout || '').trim().split(/\r?\n/)) {
    const executable = path.resolve(path.dirname(file), '..', 'Code.exe');
    if (fs.existsSync(executable)) return executable;
  }
  throw new Error('未从命令行入口找到本机 VS Code，需明确指定编辑器路径');
}

if (require.main === module) {
  if (process.argv.includes('--probe')) { try { childProbe(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
  else {
    const { ROOT, argsOf, runDir } = require('../compat/lib.cjs');
    try {
      const args = argsOf(); const folder = runDir('editor-context');
      const report = probeEditorContext({ code: args.code || process.env.DSH_PANEL_CODE || installedEditor(), folder });
      const file = path.join(folder, 'editor-context.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ ...report, report: path.relative(ROOT, file).replace(/\\/g, '/') }));
      process.exitCode = report.status === 'passed' ? 0 : 2;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { probeEditorContext, requireEditorContext, installedEditor };
