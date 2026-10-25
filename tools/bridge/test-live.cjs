'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { ROOT, resolveRuntime, locate, runDir, sha256, redact, sourceState } = require('../compat/lib.cjs');
const { fixtureProvider } = require('../compat/fixture-provider.cjs');
const { DoorClient } = require('../../packages/vscode-extension/src/door/client');
const { BridgeClient } = require('../../packages/vscode-extension/src/bridge/client');
const { DshSession } = require('../../packages/vscode-extension/src/dsh/session');

async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function waitFor(fn, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) {
  const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100));
} throw new Error('等待超时'); }
async function run() {
  const folder = runDir('bridge-live');
  const resources = require('../run-resources.cjs').createRunResources({ folder, label: 'work', keep: process.argv.includes('--keep-work') });
  const work = resources.work; resources.override(resources.childEnv());
  const start = sourceState();
  const report = { schemaVersion: 2, time: new Date().toISOString(), source: start, sourceStart: start, platform: process.platform,
    packages: require('../compat/lib.cjs').versions(), status: 'failed', stages: [], artifacts: [] };
  const previous = process.env.DSH_HOME;
  const proxy = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(k => [k, process.env[k]]));
  let kernel, model, client, bridge, session;
  resources.defer('model', () => model?.close());
  resources.defer('kernel', () => kernel?.dispose());
  resources.defer('connections', () => { session?.dispose(); bridge?.dispose(); client?.close(); });
  const stage = async (name, fn) => { const started = Date.now();
    try { const result = await resources.guard(fn); report.stages.push({ name, status: 'passed', ms: Date.now() - started, result }); console.log(`PASS ${name}`); return result; }
    catch (error) {
      const environmentBlocked = error.kind === 'environment-blocked' || error.code === 'DSH_EDITOR_ENVIRONMENT_RESTRICTED';
      report.stages.push({ name, status: environmentBlocked ? 'environment-blocked' : 'failed', error: redact(error.message), ...(error.editorContext ? { editorContext: error.editorContext } : {}) });
      if (environmentBlocked) report.status = 'environment-blocked';
      throw error;
    } };
  try {
    const reuseVsix = process.argv.includes('--packed-vsix');
    assert(!reuseVsix || process.argv.includes('--editor'), '--packed-vsix requires --editor');
    const versionArgument = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
    const options = require('../compat/lib.cjs').argsOf(process.argv.slice(versionArgument ? 3 : 2));
    const supplied = require('./packages.cjs').candidates(options, { editor: Boolean(options.editor) });
    const vsix = supplied.vsix?.file;
    const suppliedVsixSha256 = supplied.vsix?.sha256;
    await stage('loopback-environment', () => require('../compat/loopback.cjs').verifyLoopback());
    for (const k of Object.keys(proxy)) delete process.env[k];
    const runtimeHome = path.join(work, 'home');
    process.env.DSH_HOME = runtimeHome; fs.mkdirSync(runtimeHome, { recursive: true });
    const runtime = resolveRuntime({ dsh: versionArgument || '0.2.0-rc.2' }); report.runtime = runtime;
    const cwd = path.join(work, 'workspace'); fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'sample.js'), 'export function sum(a, b) { return a - b; }\n');
    fs.writeFileSync(path.join(cwd, 'context-git.txt'), 'context-base\n');
    for (const args of [['init', '-q'], ['add', 'sample.js', 'context-git.txt'], ['-c', 'user.name=Bridge test', '-c', 'user.email=bridge@example.invalid', 'commit', '-qm', 'fixture']]) locate.runDshSync({ command: 'git', args: ['-C', cwd, ...args] });
    fs.writeFileSync(path.join(cwd, 'context-git.txt'), 'context-working\n');
    const skillDir = path.join(process.env.DSH_HOME, 'skills/bridge-fixture'); fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: bridge-fixture\ndescription: Bridge read fixture\n---\n\nBRIDGE_SKILL_CONTENT\n');
    await stage('packages', async () => {
      const pilots = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/ide-bridge/pilots/manifest.json')));
      const example = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', path.join(ROOT, 'packages/dsh-bridge-sdk/examples/echo'), '--ignore-scripts', '--pack-destination', folder, '--json'] }));
      const files = [supplied.tgz.file, supplied.sdk.file, ...pilots.map(p => path.join(ROOT, p.file)), path.join(folder, example[0].filename)];
      report.artifacts = [require('./packages.cjs').artifactRecord(supplied.tgz), require('./packages.cjs').artifactRecord(supplied.sdk),
        ...files.slice(2).map(file => ({ kind: 'fixture', file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file) }))];
      locate.runDshSync({ command: runtime.command, args: ['--profile', 'bridge', '--from-default-profile', 'web', '--dump-config'] });
      require('./packages.cjs').pinSdk(path.join(process.env.DSH_HOME, 'profiles/bridge'), files[1]);
      locate.runDshSync({ command: runtime.command, args: ['plugin', '--profile', 'bridge', 'add', ...files.map(file => `file:${file.replace(/\\/g, '/')}`)], timeoutMs: 180000 });
      for (const item of [supplied.tgz, supplied.sdk]) require('./packages.cjs').verifyInstalledCandidate(item, path.join(process.env.DSH_HOME, 'profiles/bridge/node_modules', item.name), { root: process.env.DSH_HOME });
      return { installed: files.length };
    });
    model = await fixtureProvider({ reviewReport: { findings: [{ title: '[P2] Incorrect sum', body: 'The function subtracts instead of adding.', priority: 2,
      code_location: { absolute_file_path: path.join(cwd, 'sample.js'), line_range: { start: 1, end: 1 } } }], overall_correctness: 'patch is incorrect', overall_explanation: 'Fixture issue detected.' } });
    resources.override({ DSH_COMPAT_FIXTURE_KEY: 'bridge-local-fixture' });
    const patch = path.join(work, 'fixture.yml'); fs.writeFileSync(patch, [
      '- id: llm-pi-ai', '  config:', '    providers:', '      bridge-fixture:', '        api: openai-completions',
      `        baseURL: ${model.url}`, '        apiKeyEnv: DSH_COMPAT_FIXTURE_KEY', '        models:', '          - id: bridge-model',
      '            name: Bridge fixture', '            contextWindow: 32768', '            maxTokens: 4096',
      '- id: acp-door', '  config:', '    provider: bridge-fixture', '    model: bridge-model', '- id: session-title-llm', '  disabled: true', '',
    ].join('\n'));
    const port = await freePort();
    await stage('startup', async () => {
      resources.port(port, value => locate.probePort('127.0.0.1', value, 200));
      kernel = locate.spawnBackgroundDsh({ command: runtime.command, profile: 'bridge', port, ownedIdleMs: 30000, extraArgs: ['--patch', patch],
        log(level, line) { resources.appendLog(path.join(folder, 'kernel.log'), `${level}: ${redact(line)}\n`); } });
      await waitFor(async () => {
        resources.signal.throwIfAborted();
        if (kernel.child.exitCode !== null) throw new Error('测试内核提前退出');
        const log = fs.existsSync(path.join(folder, 'kernel.log')) ? fs.readFileSync(path.join(folder, 'kernel.log'), 'utf8') : '';
        if (/acp-door.*Error:|michengai-code-review.*Error:|skill-explorer.*Error:/.test(log)) throw new Error('插件未完成加载，见内核日志');
        return locate.probePort('127.0.0.1', port, 100);
      }); return { port };
    });
    client = new DoorClient({ host: '127.0.0.1', port }); await client.connect();
    const status = await stage('handshake', () => client.doorStatus()); assert.equal(status.capabilities.bridge.protocolVersion, 1);
    bridge = new BridgeClient({ client, status, clientId: 'bridge-live-test' });
    await stage('unauthorized-is-blocked', async () => { await assert.rejects(client.request('dsh-door/bridge/invoke', {}), error => error.code === -32041); return true; });
    await stage('auth-and-catalog', async () => {
      await bridge.auth(); const catalog = await bridge.catalog();
      for (const id of ['michengai.code-review.run', 'linxin.skill-explorer.list', 'linxin.skill-explorer.read', 'linxin.skill-explorer.health']) assert(catalog.capabilities.some(c => c.id === id), `能力缺失：${id}`);
      return { ids: catalog.capabilities.map(c => c.id) };
    });
    const invoke = (capabilityId, input, context = {}) => bridge.request('invoke', { requestId: require('node:crypto').randomUUID(), capabilityId, input,
      context: { cwd, userInitiated: true, workspaceTrusted: true, ...context } });
    await stage('independent-sdk-package-provider', async () => {
      const result = await invoke('example.echo.read', { text: 'SDK_REAL_HOST' }); assert.equal(result.value.text, 'SDK_REAL_HOST');
      await assert.rejects(invoke('example.echo.read', { text: 'x'.repeat(129) }), error => error.code === -32046);
      return { independentPackage: true, installedFromArchive: true, validatedThroughRealBridge: true };
    });
    await stage('skill-list-read-health', async () => {
      const listed = await invoke('linxin.skill-explorer.list', {}); const skills = listed.value.groups.flatMap(g => g.skills);
      const found = skills.find(s => s.name === 'bridge-fixture'); assert(found, '未发现测试技能');
      const read = await invoke('linxin.skill-explorer.read', { skillId: found.id }); assert(read.value.content.includes('BRIDGE_SKILL_CONTENT'));
      await assert.rejects(invoke('linxin.skill-explorer.read', { skillId: '../outside' }));
      const health = await invoke('linxin.skill-explorer.health', {}); assert.equal(health.value.ok, true);
      return { found: found.name, health: health.value.ok };
    });
    await stage('skill-write-preview-confirm-recovery', async () => {
      const text = '---\nname: managed-fixture\ndescription: Managed skill\n---\n\nMANAGED_BODY\n';
      const prefix = 'linxin.skill-explorer.';
      const created = await invoke(prefix + 'preview', { action: 'create', scope: 'project-dsh', name: 'managed-fixture', content: text });
      assert(!fs.existsSync(created.value.file));
      await assert.rejects(invoke(prefix + 'commit', { planId: created.value.planId }), error => error.code === -32044);
      await invoke(prefix + 'commit', { planId: created.value.planId }, { approved: true });
      assert.equal(fs.readFileSync(created.value.file, 'utf8'), text);
      const list = await invoke(prefix + 'list', {}), skill = list.value.groups.flatMap(group => group.skills).find(item => item.name === 'managed-fixture');
      assert(skill?.editable, 'Created project skill must be listed as writable');
      const disabled = await invoke(prefix + 'preview', { action: 'enabled', skillId: skill.id, enabled: false });
      await invoke(prefix + 'commit', { planId: disabled.value.planId }, { approved: true });
      assert(fs.readFileSync(created.value.file, 'utf8').includes('disable-model-invocation: true'));
      const deleted = await invoke(prefix + 'preview', { action: 'delete', skillId: skill.id });
      const result = await invoke(prefix + 'commit', { planId: deleted.value.planId }, { approved: true }); assert(!fs.existsSync(created.value.file));
      const trash = await invoke(prefix + 'trash', {}); assert(trash.value.entries.some(item => item.id === result.value.recoveryId));
      const restored = await invoke(prefix + 'preview', { action: 'restore', trashId: result.value.recoveryId });
      await invoke(prefix + 'commit', { planId: restored.value.planId }, { approved: true }); assert(fs.readFileSync(created.value.file, 'utf8').includes('MANAGED_BODY'));
      return { created: true, explicitApproval: true, disabled: true, deleted: true, restored: true };
    });
    session = new DshSession({ client }); await session.start({ cwd, preset: 'standard' });
    await stage('native-code-review', async () => {
      const run = await invoke('michengai.code-review.run', { mode: 'worktree' }, { sessionId: session.sessionId }); assert.equal(run.mode, 'operation');
      let result; await waitFor(async () => { result = await bridge.request('operation/get', { operationId: run.operationId }); return result.status !== 'running'; });
      report.review = result.result;
      assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.result.findings[0].priority, 'P2');
      assert.equal(result.result.findings[0].startLine, 1); assert(model.requests.length > 0);
      report.review = result.result; return { findings: result.result.findings.length, modelRequests: model.requests.length, operationId: run.operationId };
    });
    await stage('running-review-reconnect', async () => {
      const started = await invoke('michengai.code-review.run', { mode: 'worktree' }, { sessionId: session.sessionId });
      bridge.dispose(); session.dispose(); client.close();
      client = new DoorClient({ host: '127.0.0.1', port }); await client.connect();
      bridge = new BridgeClient({ client, status: await client.doorStatus(), clientId: 'bridge-live-test' });
      let restored; await waitFor(async () => { restored = await bridge.request('operation/get', { operationId: started.operationId }); return restored.status !== 'running'; });
      assert.equal(restored.status, 'completed', JSON.stringify(restored)); return { status: restored.status };
    });
    await stage('reconnect-final-result', async () => {
      const id = report.stages.find(s => s.name === 'native-code-review').result.operationId;
      bridge.dispose(); session.dispose(); client.close();
      client = new DoorClient({ host: '127.0.0.1', port }); await client.connect();
      bridge = new BridgeClient({ client, status: await client.doorStatus(), clientId: 'bridge-live-test' });
      const restored = await bridge.request('operation/get', { operationId: id }); assert.equal(restored.status, 'completed'); return true;
    });
    if (process.argv.includes('--editor')) {
      assert.equal(sha256(vsix), suppliedVsixSha256, 'Supplied VSIX changed before native validation');
      model.setReviewDelay(5000);
      bridge.dispose(); session.dispose(); client.close();
      await new Promise(resolve => setTimeout(resolve, 200));
      await stage('packed-vsix-native-editor', () => require('./editor-check.cjs').checkEditor({ folder, cwd, port, vsix, runtimeHome }));
      await stage('packed-context-model-transport', () => {
        assert(model.requests.some(request => { const body = JSON.stringify(request); return body.includes('CONTEXT_DIAGNOSTIC_MARKER') && body.includes('Git 变更补丁快照'); }), '模型服务未收到 Git 与问题诊断正文');
        return { gitDiffAndDiagnostics: true };
      });
      assert.equal(sha256(vsix), suppliedVsixSha256, 'Supplied VSIX changed during native validation');
      report.artifacts.push({ kind: 'vsix', file: path.relative(ROOT, vsix).replace(/\\/g, '/'), sha256: sha256(vsix) });
    }
    await stage('owned-idle-exit', async () => {
      bridge.dispose(); session.dispose(); client.close();
      await waitFor(() => kernel.child.exitCode !== null);
      assert([0,130].includes(kernel.child.exitCode), `后台内核退出码：${kernel.child.exitCode}`);
      assert(!fs.existsSync(path.join(process.env.DSH_HOME, 'run/dsh-acp-door', `${port}.json`)));
      return { exitCode: kernel.child.exitCode };
    });
    report.status = 'passed';
  } catch (error) { report.error = redact(error.message); console.error(report.error); process.exitCode = 1; }
  finally {
    try { if (model) fs.writeFileSync(path.join(folder, 'model-requests.json'), JSON.stringify(model.requests, null, 2)); }
    catch (error) { report.status = 'failed'; report.error ||= error.message; }
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    for (const [k, v] of Object.entries(proxy)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    report.resources = await resources.close();
    if (report.resources.status !== 'passed' || report.resources.abort) { report.status = 'failed'; report.error ||= report.resources.abort || report.resources.errors.join('; '); }
    require('./packages.cjs').finishEvidence(report);
    if (report.status !== 'passed') process.exitCode = 1;
    fs.writeFileSync(path.join(folder, 'bridge-report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(path.join(folder, 'bridge-report.json'));
  }
}
run();
