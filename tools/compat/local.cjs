'use strict';
/** 已安装候选包的本机验收；自启只管理本工具启动的进程。 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, argsOf, json, versions, sourceState, resolveRuntime, locate, runDir, safeObject } = require('./lib.cjs');
const { freePort, waitFor, bounded } = require('./test.cjs');
const { desktopProfilePatchArgs, syncPanelProfilePlugins } = require('../../packages/vscode-extension/src/door/setup');
const { DoorClient } = require('../../packages/vscode-extension/src/door/client');
const { DshSession } = require('../../packages/vscode-extension/src/dsh/session');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

function check(report, name, evidence) {
  report.checks = report.checks.filter((item) => item.name !== name);
  report.checks.push({ name, status: 'passed', evidence });
}

async function editor(report, options, folder) {
  const mode = options.path;
  assert(['attach', 'self'].includes(mode), '--path 需要 attach 或 self');
  const gui = require('./lib.cjs').desktopGuiProcessIds();
  assert(mode === 'attach' ? gui.length > 0 : gui.length === 0, 'Desktop GUI 状态不符合测试路径');
  const file = path.join(ROOT, `packages/vscode-extension/build/dsh-acp-panel-${versions().panel}.vsix`);
  const destination = path.join(folder, 'vsix');
  const quote = (text) => `'${text.replace(/'/g, "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(file)}, ${quote(destination)})`], { windowsHide: true, timeout: 10000 });
  const port = mode === 'attach' ? 47821 : await freePort();
  assert.equal(await locate.probePort('127.0.0.1', port), mode === 'attach');
  const env = { ...process.env, DSH_PANEL_CHECK_EXTENSION_SOURCE: path.join(destination, 'extension'),
    DSH_PANEL_CHECK_PROFILE: 'vscode-panel', DSH_PANEL_CHECK_PORT: String(port), DSH_PANEL_CHECK_SELF_PORT: String(port) };
  delete env.DSH_PANEL_CHECK_DSH;
  const result = spawnSync(process.execPath, [path.join(ROOT, 'packages/vscode-extension/tools/vscode-check.js')], { env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  const log = path.join(folder, 'editor.log');
  fs.writeFileSync(log, require('./lib.cjs').redact(`${result.stdout || ''}${result.stderr || ''}`));
  assert.equal(result.status, 0, `VSIX 编辑器检查失败：${log}`);
  assert(result.stdout.includes('全部通过'), '编辑器没有留下完整通过证据');
  const evidence = { mode, exitCode: result.status, vsixSha256: require('./lib.cjs').sha256(file), log: path.relative(ROOT, log).replace(/\\/g, '/'), logSha256: require('./lib.cjs').sha256(log) };
  check(report, `vsix-editor-${mode}`, evidence);
  const results = ['attach', 'self'].map((name) => report.checks.find((item) => item.name === `vsix-editor-${name}`));
  if (results.every((item) => item?.status === 'passed' && item.evidence.vsixSha256 === evidence.vsixSha256)) check(report, 'vsix-editor', { paths: results.map((item) => item.evidence) });
}

function installed(report) {
  const home = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh');
  const files = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'];
  const walk = (base, prefix) => { for (const name of fs.readdirSync(base)) { const rel = path.join(prefix, name), file = path.join(base, name); if (fs.statSync(file).isDirectory()) walk(file, rel); else files.push(rel); } };
  walk(path.join(ROOT, 'packages/dsh-door/lib'), 'lib');
  const hashes = [];
  for (const profile of ['desktop', 'vscode-panel']) {
    const directory = path.join(home, 'profiles', profile);
    assert(json(path.join(directory, 'package.json')).dsh.profile.bundles.includes('dsh-acp-door'));
    for (const file of files) {
      const sha = require('./lib.cjs').sha256(path.join(ROOT, 'packages/dsh-door', file));
      assert.equal(require('./lib.cjs').sha256(path.join(directory, 'node_modules/dsh-acp-door', file)), sha, `${profile}/${file} 内容不一致`);
      hashes.push({ profile, file: file.replace(/\\/g, '/'), sha256: sha });
    }
  }
  const result = spawnSync(process.execPath, [path.join(ROOT, 'packages/vscode-extension/tools/check-installed.cjs')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, '面板装机文件与源码不同');
  check(report, 'installed-files', { doorFilesPerProfile: files.length, files: hashes, panel: require('./lib.cjs').redact(result.stdout) });
  report.artifacts = ['tgz', 'vsix'].map((kind) => {
    const file = kind === 'tgz' ? `build/dsh-acp-door-${versions().door}.tgz` : `packages/vscode-extension/build/dsh-acp-panel-${versions().panel}.vsix`;
    return { kind, file, sha256: require('./lib.cjs').sha256(path.join(ROOT, file)) };
  });
}

async function local(options) {
  if (!['attach', 'self', 'probe', 'editor', 'installed'].includes(options.mode)) throw new Error('--mode 需要 attach、self、probe、editor 或 installed');
  const folder = runDir(`local-${options.mode}`);
  const file = options.out ? path.resolve(options.out) : path.join(folder, 'local-report.json');
  const report = fs.existsSync(file) ? json(file) : { schemaVersion: 1, time: new Date().toISOString(), source: sourceState(), packages: versions(), checks: [], artifacts: [] };
  assert.equal(report.source.fingerprint, sourceState().fingerprint, '本机报告对应的源码已变化');
  let kernel, client, session, port;
  try {
    if (options.mode === 'editor') { await editor(report, options, folder); return report; }
    if (options.mode === 'installed') { installed(report); return report; }
    port = Number(options.port || 47821);
    if (options.mode !== 'attach') {
      const runtime = resolveRuntime(options);
      const profile = options.profile || (options.mode === 'probe' ? 'compat-real' : 'vscode-panel');
      if (options.mode === 'self') {
        assert(options['desktop-closed'], '需要 --desktop-closed');
        assert.equal(require('./lib.cjs').desktopGuiProcessIds().length, 0, 'Desktop GUI 尚未退出');
        syncPanelProfilePlugins({ command: runtime.command, profile });
      } else {
        const directory = path.join(process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh'), 'profiles', profile);
        if (profile !== 'compat-real') throw new Error('probe 只允许操作专用 compat-real 配置集');
        if (!fs.existsSync(path.join(directory, 'package.json'))) locate.runDshSync({ command: runtime.command, args: ['--profile', profile, '--from-default-profile', 'web', '--dump-config'] });
        locate.runDshSync({ command: runtime.command, args: ['plugin', '--profile', profile, 'add', `file:${path.join(ROOT, `build/dsh-acp-door-${versions().door}.tgz`).replace(/\\/g, '/')}`] });
        const manifestFile = path.join(directory, 'package.json');
        const manifest = json(manifestFile);
        const source = json(path.join(directory, '..', 'desktop/package.json'));
        const additions = source.dsh.profile.bundles.filter((name) => /^@deepseek-ai\/dsh-experimental-/.test(name));
        manifest.dsh.profile.bundles = [...new Set([...manifest.dsh.profile.bundles, ...additions])];
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
      }
      port = options.port ? Number(options.port) : await freePort();
      kernel = locate.spawnBackgroundDsh({ command: runtime.command, profile, port,
        extraArgs: desktopProfilePatchArgs({ profile: options.mode === 'probe' ? 'vscode-panel' : profile }),
        log(level, text) { fs.appendFileSync(path.join(folder, 'kernel.log'), `${level}: ${require('./lib.cjs').redact(text)}\n`); } });
      await waitFor(() => locate.probePort('127.0.0.1', port), 60000);
    }
    client = new DoorClient({ host: '127.0.0.1', port });
    await client.connect();
    const status = await client.doorStatus();
    assert.equal(status.version, versions().door);
    assert.equal(status.runtime?.acpVersion, options.dsh || '0.2.0-rc.2');
    assert(status.model.ready);
    const cwd = path.join(folder, 'workspace'); fs.mkdirSync(cwd);
    session = new DshSession({ client }); await session.start({ cwd, preset: 'standard' });
    const flat = (items) => (items || []).flatMap((item) => item.options ? flat(item.options) : [item]);
    const catalog = flat(session.configOptions.find((item) => item.id === 'model')?.options).map((item) => item.value).sort();
    const permissions = await client.permissionGet(session.sessionId);
    const snapshot = { model: status.model, catalog, permissions: permissions.options.map((item) => item.value).sort(), runtime: status.runtime };
    const name = options.mode === 'attach' ? 'desktop-attach' : options.mode === 'probe' ? 'kernel-self-start' : 'desktop-closed-self-start';
    check(report, name, snapshot);
    if (options.mode !== 'attach') {
      const desktop = report.checks.find((item) => item.name === 'desktop-attach');
      if (options.mode === 'self') {
        assert(desktop, '需要先保存 Desktop 接入快照');
        assert.deepEqual(snapshot.model, desktop.evidence.model, '默认模型没有继承');
        assert.deepEqual(snapshot.catalog, desktop.evidence.catalog, '完整模型目录没有继承');
        assert.deepEqual(snapshot.permissions, desktop.evidence.permissions, '权限清单没有继承');
        check(report, 'configuration-inheritance', { modelCount: catalog.length, permissionValues: snapshot.permissions });
      }
      const marker = `COMPAT_LOCAL_${crypto.randomBytes(4).toString('hex')}`;
      const sample = path.join(cwd, 'compat-real-model.txt'); fs.writeFileSync(sample, marker);
      let answer = '', toolComplete = false;
      session.on('text', ({ delta }) => { answer += delta; });
      session.on('tool', ({ tool }) => { if (tool.status === 'completed') toolComplete = true; });
      const result = await bounded(session.send(`请调用读文件工具读取 ${sample}，然后只回复文件中的文本。`), 180000);
      assert.equal(result.stopReason, 'end_turn'); assert(toolComplete, '真实模型没有完成文件工具'); assert(answer.includes(marker), '真实模型没有读取测试文件');
      check(report, 'real-model-tool', { completedTool: true, markerRead: true, provider: status.model.provider, model: status.model.model });
    }
  } catch (error) { report.checks.push({ name: `${options.mode}-failure`, status: 'failed', evidence: require('./lib.cjs').redact(error.message) }); throw error; }
  finally {
    if (session?.sessionId && client) { try { await client.closeSession(session.sessionId); } catch {} }
    session?.dispose(); client?.close(); kernel?.dispose();
    let cleanupError;
    if (kernel) {
      try { await waitFor(async () => !await locate.probePort('127.0.0.1', port), 10000); check(report, 'local-kernel-cleanup', { portClosed: true }); }
      catch (error) { cleanupError = error; report.checks.push({ name: 'local-kernel-cleanup', status: 'failed', evidence: error.message }); }
    }
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(safeObject(report), null, 2)}\n`);
    console.log(`本机验收记录：${file}`);
    if (cleanupError) throw cleanupError;
  }
  return report;
}
if (require.main === module) local(argsOf()).catch((error) => { console.error(require('./lib.cjs').redact(error.stack)); process.exitCode = 1; });
module.exports = { local };
