'use strict';
/** 合并 DSH 视图：通过编辑器自身命令更新布局，保留其他视图与账号数据。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { ROOT, runDir, sourceState } = require('../compat/lib.cjs');
const { installedEditor } = require('./editor-context.cjs');
const { isolatedEditorOptions } = require('../../packages/vscode-extension/tools/editor-isolation.cjs');
const manifest = require('../../packages/vscode-extension/package.json');
const IDS = ['dshPanel.chat', 'dshPanel.capabilities', 'dshPanel.operations'];
const LAYOUT_KEYS = ['views.customizations', 'workbench.activity.pinnedViewlets2'];
const dailyData = path.join(process.env.APPDATA, 'Code');

function readLayout(userData) {
  const file = path.join(userData, 'User/globalStorage/state.vscdb');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(LAYOUT_KEYS.map(key => [key, db.prepare('SELECT value FROM ItemTable WHERE key=?').get(key)?.value || null]));
  } finally { db.close(); }
}
function accounts() {
  return [path.join(os.homedir(), '.vscode-shared/sharedStorage/state.vscdb'),
    path.join(dailyData, 'User/globalStorage/state.vscdb')].map(file => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT key,value FROM ItemTable WHERE key LIKE 'secret://%' ORDER BY key").all();
      const digest = createHash('sha256');
      for (const row of rows) digest.update(row.key).update('\0').update(Buffer.isBuffer(row.value) ? row.value : String(row.value)).update('\0');
      return { location: file.includes('.vscode-shared') ? 'shared' : 'user', count: rows.length, ciphertextDigest: digest.digest('hex') };
    } finally { db.close(); }
  });
}
function verifyLayout(before, after) {
  const old = JSON.parse(before['views.customizations'] || '{}');
  const next = JSON.parse(after['views.customizations'] || '{}');
  const generated = new Set(IDS.map(id => old.viewLocations?.[id]).filter(id => id?.startsWith('workbench.views.service.')));
  for (const id of IDS) assert(!next.viewLocations?.[id] || next.viewLocations[id] === 'workbench.view.extension.dshPanel', `视图仍在独立容器：${id}`);
  for (const [id, value] of Object.entries(old.viewLocations || {})) if (!IDS.includes(id)) assert.equal(next.viewLocations?.[id], value, `其他视图发生移动：${id}`);
  for (const [id, value] of Object.entries(old.viewContainerLocations || {})) if (!generated.has(id) && id !== 'workbench.view.extension.dshPanel') assert.equal(next.viewContainerLocations?.[id], value, `其他容器发生移动：${id}`);
  assert.deepEqual(next.viewContainerBadgeEnablementStates || {}, old.viewContainerBadgeEnablementStates || {}, '容器徽标设置发生变化');
  const used = new Set(Object.values(next.viewLocations || {}));
  const pins = JSON.parse(after['workbench.activity.pinnedViewlets2'] || '[]');
  for (const id of generated) if (!used.has(id)) {
    assert(!(id in (next.viewContainerLocations || {})), '空的生成容器未移除');
    assert(!pins.some(item => item.id === id && item.visible), '空的生成入口仍然显示');
  }
  return { viewIds: IDS, generatedContainersRemoved: [...generated].filter(id => !used.has(id)), unrelatedLocationsPreserved: true };
}
async function repair(mode) {
  assert(['--verify', '--apply'].includes(mode), '使用 --verify 隔离复现，或 --apply 合并日常布局');
  const folder = runDir(mode === '--apply' ? 'daily-view-layout' : 'isolated-view-layout');
  const before = readLayout(dailyData), accountBefore = accounts();
  fs.writeFileSync(path.join(folder, 'layout-before.json'), JSON.stringify(before, null, 2));
  const name = fs.readdirSync(path.join(os.homedir(), '.vscode/extensions')).find(name => name.toLowerCase() === `${manifest.publisher}.${manifest.name}-${manifest.version}`.toLowerCase());
  assert(name, '当前候选扩展尚未安装');
  const installed = path.join(os.homedir(), '.vscode/extensions', name);
  let userData = dailyData, environment = { ...process.env }, flags = [];
  if (mode === '--verify') {
    userData = path.join(folder, 'editor-data');
    const extensions = path.join(folder, 'editor-extensions'), sharedData = path.join(folder, 'editor-shared-data');
    fs.mkdirSync(extensions);
    fs.mkdirSync(path.join(userData, 'User/globalStorage'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false,
      'dshPanel.autoStart': false, 'workbench.startupEditor': 'none', 'update.mode': 'none', 'extensions.autoUpdate': false }));
    // 仅复制布局键，在独立数据库中复现；账号、安装清单和其他用户状态不参与复制。
    const db = new DatabaseSync(path.join(userData, 'User/globalStorage/state.vscdb'));
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    for (const [key, value] of Object.entries(before)) if (value !== null) db.prepare('INSERT INTO ItemTable VALUES (?,?)').run(key, value);
    db.close();
    const isolation = isolatedEditorOptions({ userData, extensions, sharedData });
    flags = isolation.args; environment = isolation.env;
  } else {
    for (const key of Object.keys(environment)) if (/^(VSCODE_PORTABLE|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete environment[key];
    flags = ['--disable-extension', 'vscode.github-authentication', '--disable-extension', 'vscode.microsoft-authentication'];
  }
  environment.DSH_PANEL_AUTOFOCUS = '0';
  const workspace = path.join(folder, 'workspace'), helper = path.join(folder, 'layout-helper');
  fs.mkdirSync(workspace); fs.mkdirSync(helper);
  fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'dsh-layout-repair', publisher: 'local', version: '1.0.0',
    engines: { vscode: '^1.85.0' }, main: './index.js', activationEvents: ['onStartupFinished'] }));
  const resultFile = path.join(folder, 'editor-result.json');
  fs.writeFileSync(path.join(helper, 'index.js'), `'use strict';
const vscode=require('vscode'),fs=require('node:fs'),assert=require('node:assert/strict');
exports.activate=async()=>{
 try {
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(),${JSON.stringify(workspace.toLowerCase())});
  const commands=await vscode.commands.getCommands(true),ids=${JSON.stringify(IDS)};
  for(const id of ids) assert(commands.includes(id+'.resetViewLocation'),'缺少视图位置恢复命令：'+id);
  for(const id of ids) await vscode.commands.executeCommand(id+'.resetViewLocation');
  await vscode.commands.executeCommand('dshPanel.chat.focus');
  await new Promise(resolve=>setTimeout(resolve,1800));
  fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({status:'passed',vscode:vscode.version,commands:ids.map(id=>id+'.resetViewLocation')}));
  await vscode.commands.executeCommand('workbench.action.closeWindow');
 } catch(error) {fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({status:'failed',error:String(error.stack||error)}));}
};
`);
  const report = { time: new Date().toISOString(), mode, status: 'failed', source: sourceState(), installedVersion: manifest.version,
    temporaryExtensionInstalled: false, backup: path.relative(ROOT, path.join(folder, 'layout-before.json')).replace(/\\/g, '/') };
  try {
    // 开发路径仅增加现有 DSH 与无界面修复脚本；该窗口禁用第三方扩展，内置扩展仍可能激活。
    const editor = spawn(installedEditor(), [...flags, '--new-window', '--disable-extensions', '--skip-welcome',
      '--extensionDevelopmentPath', installed, '--extensionDevelopmentPath', helper, workspace],
    { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [editor.stdout, editor.stderr]) stream.on('data', bytes => fs.appendFileSync(path.join(folder, 'editor-launch.log'), bytes));
    const deadline = Date.now() + 45000;
    while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 300));
    assert(fs.existsSync(resultFile), '编辑器布局修复超时；日常窗口保留');
    report.editor = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(report.editor.status, 'passed', report.editor.error);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const after = readLayout(userData);
    fs.writeFileSync(path.join(folder, 'layout-after.json'), JSON.stringify(after, null, 2));
    report.layout = verifyLayout(before, after);
    report.layoutStatus = 'passed';
    report.accountsBefore = accountBefore; report.accountsAfter = accounts();
    report.accountCheck = JSON.stringify(report.accountsAfter) === JSON.stringify(accountBefore) ? 'unchanged' : 'ciphertext-changed';
    assert.deepEqual(report.accountsAfter, accountBefore, '日常账号记录发生变化');
    report.accountsUnchanged = true;
    report.status = 'passed';
  } catch (error) { report.error = String(error.stack || error); throw error; }
  finally {
    fs.writeFileSync(path.join(folder, 'layout-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, report: path.relative(ROOT, path.join(folder, 'layout-report.json')).replace(/\\/g, '/'), error: report.error || null }));
  }
  return report;
}
if (require.main === module) repair(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { readLayout, verifyLayout, repair };
