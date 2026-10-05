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
  const report = { time: new Date().toISOString(), source: sourceState(), status: 'failed', stages: [], artifacts: [] };
  const previous = process.env.DSH_HOME;
  const proxy = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(k => [k, process.env[k]]));
  let kernel, model, client, bridge, session;
  const stage = async (name, fn) => { const started = Date.now();
    try { const result = await fn(); report.stages.push({ name, status: 'passed', ms: Date.now() - started, result }); console.log(`PASS ${name}`); return result; }
    catch (error) {
      const environmentBlocked = error.code === 'DSH_EDITOR_ENVIRONMENT_RESTRICTED';
      report.stages.push({ name, status: environmentBlocked ? 'environment-blocked' : 'failed', error: redact(error.message), ...(error.editorContext ? { editorContext: error.editorContext } : {}) });
      if (environmentBlocked) report.status = 'environment-blocked';
      throw error;
    } };
  try {
    for (const k of Object.keys(proxy)) delete process.env[k];
    process.env.DSH_HOME = path.join(folder, 'home'); fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
    const runtime = resolveRuntime({ dsh: process.argv.slice(2).find(value => !value.startsWith('--')) || '0.2.0-rc.2' }); report.runtime = runtime;
    const cwd = path.join(folder, 'workspace'); fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'sample.js'), 'export function sum(a, b) { return a - b; }\n');
    for (const args of [['init', '-q'], ['add', 'sample.js'], ['-c', 'user.name=Bridge test', '-c', 'user.email=bridge@example.invalid', 'commit', '-qm', 'fixture']]) locate.runDshSync({ command: 'git', args: ['-C', cwd, ...args] });
    const skillDir = path.join(process.env.DSH_HOME, 'skills/bridge-fixture'); fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: bridge-fixture\ndescription: Bridge read fixture\n---\n\nBRIDGE_SKILL_CONTENT\n');
    await stage('packages', async () => {
      const packed = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', path.join(ROOT, 'packages/dsh-door'), '--pack-destination', folder, '--json'] }));
      const pilots = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/ide-bridge/pilots/manifest.json')));
      const files = [path.join(folder, packed[0].filename), ...pilots.map(p => path.join(ROOT, p.file))];
      report.artifacts = files.map(file => ({ file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file) }));
      locate.runDshSync({ command: runtime.command, args: ['--profile', 'bridge', '--from-default-profile', 'web', '--dump-config'] });
      locate.runDshSync({ command: runtime.command, args: ['plugin', '--profile', 'bridge', 'add', ...files.map(file => `file:${file.replace(/\\/g, '/')}`)], timeoutMs: 180000 });
      return { installed: files.length };
    });
    model = await fixtureProvider({ reviewReport: { findings: [{ title: '[P2] Incorrect sum', body: 'The function subtracts instead of adding.', priority: 2,
      code_location: { absolute_file_path: path.join(cwd, 'sample.js'), line_range: { start: 1, end: 1 } } }], overall_correctness: 'patch is incorrect', overall_explanation: 'Fixture issue detected.' } });
    process.env.DSH_COMPAT_FIXTURE_KEY = 'bridge-local-fixture';
    const patch = path.join(folder, 'fixture.yml'); fs.writeFileSync(patch, [
      '- id: llm-pi-ai', '  config:', '    providers:', '      bridge-fixture:', '        api: openai-completions',
      `        baseURL: ${model.url}`, '        apiKeyEnv: DSH_COMPAT_FIXTURE_KEY', '        models:', '          - id: bridge-model',
      '            name: Bridge fixture', '            contextWindow: 32768', '            maxTokens: 4096',
      '- id: acp-door', '  config:', '    provider: bridge-fixture', '    model: bridge-model', '- id: session-title-llm', '  disabled: true', '',
    ].join('\n'));
    const port = await freePort();
    await stage('startup', async () => {
      kernel = locate.spawnBackgroundDsh({ command: runtime.command, profile: 'bridge', port, ownedIdleMs: 30000, extraArgs: ['--patch', patch],
        log(level, line) { fs.appendFileSync(path.join(folder, 'kernel.log'), `${level}: ${redact(line)}\n`); } });
      await waitFor(async () => {
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
    await stage('skill-list-read-health', async () => {
      const listed = await invoke('linxin.skill-explorer.list', {}); const skills = listed.value.groups.flatMap(g => g.skills);
      const found = skills.find(s => s.name === 'bridge-fixture'); assert(found, '未发现测试技能');
      const read = await invoke('linxin.skill-explorer.read', { skillId: found.id }); assert(read.value.content.includes('BRIDGE_SKILL_CONTENT'));
      await assert.rejects(invoke('linxin.skill-explorer.read', { skillId: '../outside' }));
      const health = await invoke('linxin.skill-explorer.health', {}); assert.equal(health.value.ok, true);
      return { found: found.name, health: health.value.ok };
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
      model.setReviewDelay(5000);
      bridge.dispose(); session.dispose(); client.close();
      await new Promise(resolve => setTimeout(resolve, 200));
      await stage('packed-vsix-native-editor', () => require('./editor-check.cjs').checkEditor({ folder, cwd, port }));
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
    session?.dispose(); bridge?.dispose(); client?.close(); kernel?.dispose(); await model?.close();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    for (const [k, v] of Object.entries(proxy)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.writeFileSync(path.join(folder, 'bridge-report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(path.join(folder, 'bridge-report.json'));
  }
}
run();
