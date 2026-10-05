'use strict';
/** 本机真实使用场景：隔离账号与 DSH 数据，使用发行内容和实际模型；--candidate 验证未安装的 VSIX。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { spawn, execFileSync } = require('node:child_process');
const { ROOT, runDir, sourceState, sha256, redact, resolveRuntime, locate } = require('../compat/lib.cjs');
const { isolatedEditorOptions, ownsEditorProcess } = require('../../packages/vscode-extension/tools/editor-isolation.cjs');
const { shipFiles } = require('../../packages/vscode-extension/tools/ship-list');
const { installedEditor } = require('./editor-context.cjs');
const { freePort, waitFor } = require('../compat/test.cjs');
const { createHash } = require('node:crypto');
const manifest = require('../../packages/vscode-extension/package.json');
function accounts() {
  return [path.join(os.homedir(), '.vscode-shared/sharedStorage/state.vscdb'),
    path.join(process.env.APPDATA, 'Code/User/globalStorage/state.vscdb')].map(file => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT key,value FROM ItemTable WHERE key LIKE 'secret://%' ORDER BY key").all(), hash = createHash('sha256');
      for (const row of rows) hash.update(row.key).update('\0').update(Buffer.isBuffer(row.value) ? row.value : String(row.value)).update('\0');
      return { location: file.includes('.vscode-shared') ? 'shared' : 'user', count: rows.length, ciphertextDigest: hash.digest('hex') };
    } finally { db.close(); }
  });
}
async function run() {
  const folder = runDir('realistic-use'), before = accounts(), originalHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidate = process.argv.includes('--candidate');
  const home = path.join(folder, 'home'), profile = path.join(home, 'profiles/scenario');
  const userData = path.join(folder, 'editor-data'), extensions = path.join(folder, 'editor-extensions'), sharedData = path.join(folder, 'editor-shared-data');
  const report = { time: new Date().toISOString(), source: sourceState(), status: 'failed', model: 'real', checks: [], limitations: ['选择框由脚本选择实际选项；不包含鼠标点击和像素级验收', '日常窗口交互和最低编辑器完整验收分别保留'] };
  let editor, port, sourceConfigHashes;
  const recordPath = path.join(folder, 'scenario-report.json');
  try {
    if (!candidate) execFileSync(process.execPath, ['packages/vscode-extension/tools/check-installed.cjs'], { cwd: ROOT, stdio: 'pipe', windowsHide: true });
    const runtime = resolveRuntime({ dsh: '0.2.0-rc.2' });
    const sourceProfile = path.join(originalHome, 'profiles/bridge-real');
    const sourcePatch = path.join(originalHome, 'profiles/desktop/cordis.patch.yml');
    sourceConfigHashes = [path.join(sourceProfile, 'package.json'), path.join(sourceProfile, 'cordis.yml'), path.join(sourceProfile, 'cordis.patch.yml'), sourcePatch].map(file => ({ file, sha256: sha256(file) }));
    fs.mkdirSync(profile, { recursive: true });
    for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      const file = path.join(sourceProfile, name); if (fs.existsSync(file)) fs.copyFileSync(file, path.join(profile, name));
    }
    // 在隔离配置集中由正式插件管理器安装，避免复制依赖后沿用原虚拟仓库位置。
    const skillPilot = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/ide-bridge/pilots/manifest.json'), 'utf8')).find(item => item.key === 'skills');
    const pilotFile = path.join(ROOT, skillPilot.file); assert.equal(sha256(pilotFile), skillPilot.packageSha256);
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try { locate.runDshSync({ command: runtime.command, args: ['plugin', '--profile', 'scenario', 'add', `file:${pilotFile.replace(/\\/g, '/')}`], timeoutMs: 180000 }); }
    finally { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; }
    const credentials = path.join(originalHome, '.credentials.yaml'); if (fs.existsSync(credentials)) fs.copyFileSync(credentials, path.join(home, '.credentials.yaml'));
    const patch = path.join(folder, 'model.patch.yml'); fs.copyFileSync(sourcePatch, patch);
    fs.copyFileSync(patch, path.join(profile, 'cordis.patch.yml'));
    const pilotVersions = {};
    for (const name of ['dsh-acp-door', '@michengai/dsh-code-review', '@linxin666/dsh-client-ui-skill-explorer']) {
      pilotVersions[name] = JSON.parse(fs.readFileSync(path.join(profile, 'node_modules', name, 'package.json'), 'utf8')).version;
    }
    assert.equal(pilotVersions['dsh-acp-door'], '0.2.0');
    assert.equal(pilotVersions[skillPilot.name], skillPilot.candidate);
    report.runtime = { dsh: runtime.version, distribution: runtime.distribution, packages: pilotVersions };
    port = await freePort();
    const cwd = path.join(folder, '示例项目 with spaces'), sample = path.join(cwd, '计算 sample.js'); fs.mkdirSync(cwd);
    const skill = path.join(cwd, '.dsh/skills/scenario-skill'); fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: scenario-skill\ndescription: Realistic usage acceptance skill\n---\n\nSCENARIO_SKILL_BODY\n');
    fs.writeFileSync(sample, 'export function sum(a, b) { return a + b; }\n');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Scenario acceptance', '-c', 'user.email=scenario@example.invalid', 'commit', '-qm', 'baseline']]) {
      execFileSync('git', ['-C', cwd, ...args], { windowsHide: true });
    }
    fs.writeFileSync(sample, 'export function sum(a, b) { return a - b; }\n');
    const extensionName = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
    let source;
    if (candidate) {
      const vsix = path.join(ROOT, `packages/vscode-extension/build/${manifest.name}-${manifest.version}.vsix`);
      const extracted = path.join(folder, 'candidate-vsix');
      const quote = value => `'${value.replace(/'/g, "''")}'`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(vsix)}, ${quote(extracted)})`], { windowsHide: true });
      source = path.join(extracted, 'extension'); report.vsixSha256 = sha256(vsix);
      for (const file of shipFiles(path.join(ROOT, 'packages/vscode-extension'))) assert.equal(sha256(path.join(source, file)), sha256(path.join(ROOT, 'packages/vscode-extension', file)));
    } else {
      const name = fs.readdirSync(path.join(os.homedir(), '.vscode/extensions')).find(x => x.toLowerCase() === extensionName.toLowerCase()); assert(name);
      source = path.join(os.homedir(), '.vscode/extensions', name);
    }
    const target = path.join(extensions, extensionName);
    for (const file of shipFiles(source)) { const destination = path.join(target, file); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(source, file), destination); assert.equal(sha256(destination), sha256(path.join(source, file))); }
    const entry = path.join(target, 'src/extension.js'), originalEntry = fs.readFileSync(entry, 'utf8');
    assert.equal(originalEntry.split('  return Object.freeze({').length, 2);
    fs.writeFileSync(entry, originalEntry.replace('  return Object.freeze({',
      "  process[Symbol.for('dsh.scenario.observer')] = { nativeViews, view, context, vscode };\r\n  return Object.freeze({"));
    report.extensionArtifact = { source: candidate ? 'candidate-vsix' : 'installed', version: manifest.version, shippedFiles: shipFiles(source).length, copiedBytesMatchArtifactBeforeInstrumentation: true,
      runtimeFilesInstrumented: ['src/extension.js'], observerStatementAddedOnlyInIsolation: true, productBehaviorReplaced: false };
    fs.mkdirSync(path.join(userData, 'User/globalStorage'), { recursive: true });
    const daily = new DatabaseSync(path.join(process.env.APPDATA, 'Code/User/globalStorage/state.vscdb'), { readOnly: true });
    const isolated = new DatabaseSync(path.join(userData, 'User/globalStorage/state.vscdb'));
    isolated.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    for (const key of ['views.customizations', 'workbench.activity.pinnedViewlets2']) {
      const row = daily.prepare('SELECT value FROM ItemTable WHERE key=?').get(key); if (row) isolated.prepare('INSERT INTO ItemTable VALUES (?,?)').run(key, row.value);
    }
    daily.close(); isolated.close();
    fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
      'update.mode': 'none', 'extensions.autoUpdate': false, 'dshPanel.port': port, 'dshPanel.selfStartPort': port,
      'dshPanel.fallbackProfile': 'scenario', 'dshPanel.dshCommand': runtime.command,
      'dshPanel.kernelIdleMinutes': 1, 'dshPanel.autoStart': true }));
    const checker = path.join(extensions, 'scenario-checker'); fs.mkdirSync(checker);
    fs.writeFileSync(path.join(checker, 'package.json'), JSON.stringify({ name: 'scenario-checker', publisher: 'local', version: '1.0.0', engines: { vscode: '^1.85.0' }, main: './index.js', activationEvents: ['*'] }));
    fs.copyFileSync(path.join(__dirname, 'scenario-actor.cjs'), path.join(checker, 'index.js'));
    fs.writeFileSync(path.join(checker, 'scenario-config.json'), JSON.stringify({ folder, home, cwd, sample, port }));
    const isolation = isolatedEditorOptions({ userData, extensions, sharedData, env: { ...process.env, DSH_HOME: home, DSH_PANEL_AUTOFOCUS: '0' } });
    const launch = () => {
      const child = spawn(installedEditor(), [...isolation.args, '--new-window', cwd], { windowsHide: true, env: isolation.env, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => fs.appendFileSync(path.join(folder, 'editor-launch.log'), redact(bytes.toString())));
      return child;
    };
    editor = launch(); let reopenCount = 0, last = '';
    const deadline = Date.now() + 450000;
    while (!fs.existsSync(path.join(folder, 'editor-result.json')) && Date.now() < deadline) {
      const progress = path.join(folder, 'progress.json');
      if (fs.existsSync(progress)) {
        const data = JSON.parse(fs.readFileSync(progress, 'utf8')); const current = data.checks.at(-1)?.name;
        if (current && last !== current) { console.log(`PASS ${current}`); last = current; }
      }
      const checkpoint = path.join(folder, reopenCount === 0 ? 'running-checkpoint.json' : 'cleanup-checkpoint.json');
      if (reopenCount < 2 && fs.existsSync(checkpoint) && editor.exitCode !== null) {
        if (reopenCount === 0) {
          const meta = JSON.parse(fs.readFileSync(path.join(folder, 'test-kernel.json'), 'utf8')); process.kill(meta.pid, 0);
          assert(await locate.probePort('127.0.0.1', port)); report.kernelSurvivedActiveWindowClose = true;
        }
        editor = launch(); reopenCount++;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert(fs.existsSync(path.join(folder, 'editor-result.json')), '场景验收未完成');
    const result = JSON.parse(fs.readFileSync(path.join(folder, 'editor-result.json'), 'utf8')); report.checks = result.checks; report.reopenCount = reopenCount;
    assert.equal(result.status, 'passed', redact(result.error || '')); assert.equal(reopenCount, 2);
    await waitFor(() => editor.exitCode !== null, 10000);
    const state = new DatabaseSync(path.join(userData, 'User/globalStorage/state.vscdb'), { readOnly: true });
    const layout = JSON.parse(state.prepare('SELECT value FROM ItemTable WHERE key=?').get('views.customizations').value);
    const pins = JSON.parse(state.prepare('SELECT value FROM ItemTable WHERE key=?').get('workbench.activity.pinnedViewlets2').value); state.close();
    assert(!Object.keys(layout.viewLocations || {}).some(x => x.startsWith('dshPanel.')));
    assert.equal(pins.filter(x => x.id === 'workbench.view.extension.dshPanel').length, 1);
    report.layout = { singleDshContainer: true, splitViews: false };
    report.status = 'passed';
  } catch (error) {
    report.error = redact(error.message); const progress = path.join(folder, 'progress.json');
    if (fs.existsSync(progress)) report.checks = JSON.parse(fs.readFileSync(progress, 'utf8')).checks;
    process.exitCode = 1;
  } finally {
    const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'Code.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true }).trim() || '[]');
    for (const row of Array.isArray(rows) ? rows : [rows]) if (ownsEditorProcess(row.CommandLine, userData)) {
      try { execFileSync('taskkill.exe', ['/PID', String(row.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (error) { if (error.status !== 128) throw error; }
    }
    const kernelFile = path.join(folder, 'test-kernel.json');
    if (fs.existsSync(kernelFile)) {
      const metadata = JSON.parse(fs.readFileSync(kernelFile, 'utf8'));
      // PID 仅来自本次隔离 DSH_HOME；清理前核对同一实例的端点登记，避免处理其他内核。
      const endpoint = path.join(home, `run/dsh-acp-door/${metadata.port}.json`);
      if (fs.existsSync(endpoint)) {
        const current = JSON.parse(fs.readFileSync(endpoint, 'utf8'));
        assert.equal(current.pid, metadata.pid); assert.equal(current.instanceId, metadata.instanceId);
        try { execFileSync('taskkill.exe', ['/PID', String(metadata.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (error) { if (error.status !== 128) throw error; }
      }
      await waitFor(async () => !await locate.probePort('127.0.0.1', metadata.port), 10000); report.testKernelCleaned = true;
    }
    report.accountsBefore = before; report.accountsAfter = accounts();
    report.accountStorageIsolation = { sharedDirectoryCreated: fs.existsSync(path.join(sharedData, 'sharedStorage/state.vscdb')), dailySecretsUnchanged: JSON.stringify(before) === JSON.stringify(report.accountsAfter) };
    report.dailyDshConfigUnchanged = sourceConfigHashes?.every(x => sha256(x.file) === x.sha256) || false;
    if (!report.accountStorageIsolation.dailySecretsUnchanged || !report.dailyDshConfigUnchanged) { report.status = 'partial'; process.exitCode = 1; }
    fs.writeFileSync(recordPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: path.relative(ROOT, recordPath).replace(/\\/g, '/'), error: report.error }));
  }
}
if (require.main === module) run().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
