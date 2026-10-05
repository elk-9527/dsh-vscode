'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { ROOT, argsOf, versions, sourceState, resolveRuntime, runDir, writeReport, locate, sha256, discover, redact, semver } = require('./lib.cjs');
const { fixtureProvider } = require('./fixture-provider.cjs');
const { DoorClient } = require('../../packages/vscode-extension/src/door/client');
const { DshSession } = require('../../packages/vscode-extension/src/dsh/session');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`等待超时 ${timeout}ms`);
}
async function bounded(promise, timeout = 45000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`回合超时 ${timeout}ms`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function npmRun(args) { return locate.runDshSync({ command: 'npm', args, timeoutMs: 300000 }); }
async function run(options) {
  const folder = runDir(options.dsh || 'local');
  const report = { schemaVersion: 1, time: new Date().toISOString(), source: sourceState(), node: process.version,
    packages: versions(), requested: options.dsh, status: 'failed', stages: [], artifacts: [], model: 'fixture' };
  let kernel, client, session, provider, port;
  const previousHome = process.env.DSH_HOME;
  const savedProxy = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map((key) => [key, process.env[key]]));
  // 夹具只访问回环；失效的终端代理不能把回环请求发送到另一端口。
  for (const key of Object.keys(savedProxy)) delete process.env[key];
  const stage = async (name, action) => {
    const started = Date.now();
    try { const evidence = await action(); report.stages.push({ name, status: 'passed', ms: Date.now() - started, evidence }); console.log(`PASS ${name}`); return evidence; }
    catch (error) { report.stages.push({ name, status: error.kind || 'failed', ms: Date.now() - started, error: redact(error.message) }); throw error; }
  };
  try {
    process.env.DSH_HOME = path.join(folder, 'home');
    fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
    let runtime;
    await stage('runtime', async () => {
      if (options.install) {
        if (!semver.valid(options.dsh)) throw new Error('--install 需要精确 --dsh 版本');
        const runtimeDir = path.join(folder, 'runtime');
        fs.mkdirSync(runtimeDir);
        try { npmRun(['install', '--prefix', runtimeDir, '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=20000', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${options.dsh}`]); }
        catch (error) { error.kind = 'acquisition-failed'; throw error; }
        runtime = { command: `${locate.quoteArg(process.execPath)} ${locate.quoteArg(path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))}`, distribution: 'npm', version: options.dsh };
      } else runtime = resolveRuntime(options);
      const actual = locate.runDshSync({ command: runtime.command, args: ['--version'], timeoutMs: 10000 }).trim();
      assert(actual.includes(runtime.version));
      report.runtime = runtime;
      return { version: runtime.version, distribution: runtime.distribution };
    });
    await stage('package', async () => {
      const packed = JSON.parse(npmRun(['pack', path.join(ROOT, 'packages/dsh-door'), '--pack-destination', folder, '--json']));
      const file = path.join(folder, packed[0].filename);
      report.artifacts.push({ kind: 'tgz', file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file) });
      return { sha256: sha256(file), file: path.basename(file) };
    });
    await stage('installation', async () => {
      locate.runDshSync({ command: runtime.command, args: ['--profile', 'compat', '--from-default-profile', 'web', '--dump-config'] });
      locate.runDshSync({ command: runtime.command, args: ['plugin', '--profile', 'compat', 'add', `file:${path.join(ROOT, report.artifacts[0].file).replace(/\\/g, '/')}`], timeoutMs: 180000 });
      const manifest = path.join(process.env.DSH_HOME, 'profiles/compat/node_modules/dsh-acp-door/package.json');
      assert.equal(JSON.parse(fs.readFileSync(manifest)).version, report.packages.door);
      return { installedVersion: report.packages.door };
    });
    provider = await fixtureProvider();
    process.env.DSH_COMPAT_FIXTURE_KEY = 'compat-local-fixture';
    port = await freePort();
    const cwd = path.join(folder, 'workspace');
    fs.mkdirSync(cwd);
    const sample = path.join(cwd, 'compat-read.txt');
    fs.writeFileSync(sample, 'COMPAT_FILE_CONTENT');
    const patch = path.join(folder, 'fixture.yml');
    fs.writeFileSync(patch, [
      '- id: llm-pi-ai', '  config:', '    providers:', '      compat-fixture:', '        api: openai-completions',
      `        baseURL: ${provider.url}`, '        apiKeyEnv: DSH_COMPAT_FIXTURE_KEY', '        models:', '          - id: compat-model',
      '            name: Compatibility fixture', '            contextWindow: 32768', '            maxTokens: 4096',
      '          - id: compat-model-b', '            name: Compatibility alternate', '            contextWindow: 32768', '            maxTokens: 4096',
      '- id: acp-door', '  config:', '    provider: compat-fixture', '    model: compat-model',
      '- id: session-title-llm', '  disabled: true', '',
    ].join('\n'));
    const output = [];
    await stage('startup', async () => {
      kernel = locate.spawnBackgroundDsh({ command: runtime.command, profile: 'compat', port, extraArgs: ['--patch', patch],
        log(level, line) { output.push(`${level}: ${redact(line)}`); fs.appendFileSync(path.join(folder, 'kernel.log'), `${level}: ${redact(line)}\n`); } });
      await waitFor(async () => {
        if (kernel.child.exitCode !== null) throw new Error(`内核提前退出：${output.slice(-8).join('\n')}`);
        return locate.probePort('127.0.0.1', port, 200);
      }, 60000);
      return { port };
    });
    client = new DoorClient({ host: '127.0.0.1', port });
    await stage('handshake', async () => { const result = await client.connect(); assert(result.agentInfo); return result.agentInfo; });
    await stage('status', async () => {
      const result = await client.doorStatus();
      assert.equal(result.version, report.packages.door);
      assert(semver.satisfies(result.runtime?.acpVersion || '', report.packages.peer), '实际 ACP 包版本不在依赖声明中');
      if (runtime.acp) assert.equal(result.runtime.acpVersion, runtime.acp, 'Desktop 状态与内置 ACP 不一致');
      // npm 的旧发行物使用依赖范围；DSH 版本不一定等于实际解析的 ACP 版本。
      report.runtime.acpVersion = result.runtime.acpVersion;
      assert(result.model.ready); assert(result.capabilities.history); assert(result.capabilities.permissionPresets);
      return result;
    });
    session = new DshSession({ client });
    await stage('session', async () => {
      await session.start({ cwd, preset: 'standard' });
      assert(session.sessionId); assert(session.doorMeta?.presets?.length); assert(session.configOptions.length);
      return { presets: session.doorMeta.presets.map((item) => item.value || item.id), modelOptions: session.configOptions.length };
    });
    const sessionId = session.sessionId;
    await stage('model-switch', async () => {
      const model = session.configOptions.find((item) => item.id === 'model');
      const flat = (items) => (items || []).flatMap((item) => item.options ? flat(item.options) : [item]);
      const choices = flat(model?.options);
      const alternative = choices.find((item) => String(item.value).includes('compat-model-b'));
      assert(alternative, '测试模型目录缺少第二个模型');
      await session.setModel(alternative.value);
      assert.equal(session.configOptions.find((item) => item.id === 'model').currentValue, alternative.value);
      return { changed: true };
    });
    await stage('preset-switch', async () => {
      const alternative = session.doorMeta.presets.find((item) => item.id !== 'standard');
      assert(alternative);
      const other = new DshSession({ client });
      try {
        await other.start({ cwd, preset: alternative.id });
        assert.equal(other.doorMeta.current, alternative.id);
        await client.closeSession(other.sessionId);
      } finally { other.dispose(); }
      return { selected: alternative.id };
    });
    await stage('stream', async () => {
      let text = '', updates = 0;
      session.on('text', ({ delta }) => { text += delta; updates += 1; });
      await bounded(session.send('COMPAT_STREAM'));
      assert.equal(text, 'COMPAT_OK');
      if (semver.gte(runtime.version, '0.2.0-rc.1')) assert(updates >= 2, `没有收到实时增量：${updates}`);
      return { text, updates };
    });
    let permissionRequests = 0;
    let allowPermission = true;
    client.on('permission', (requestId, params) => {
      permissionRequests += 1;
      report.permissionRequests = permissionRequests;
      report.lastPermission = params.options;
      const choice = allowPermission ? params.options?.find((item) => /allow/.test(item.kind)) : undefined;
      client.respond(requestId, { outcome: choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' } });
    });
    await stage('permissions', async () => {
      const current = await client.permissionGet(sessionId); assert(current.options.length >= 2);
      const choice = current.options.find((item) => item.value === 'workspace-write') || current.options[0];
      const result = await client.permissionSet(sessionId, choice.value); assert.equal(result.currentValue, choice.value);
      return { values: current.options.map((item) => item.value), selected: result.currentValue };
    });
    await stage('tools', async () => {
      let completed = false;
      session.on('tool', ({ tool }) => { if (tool.status === 'completed') completed = true; });
      await bounded(session.send(`COMPAT_TOOL ${sample}`));
      const replies = provider.requests.flatMap((request) => request.messages || []).filter((message) => message.role === 'tool');
      assert(replies.some((reply) => JSON.stringify(reply.content).includes('COMPAT_FILE_CONTENT')), '模型服务没有收到真实文件工具结果');
      assert(completed, '面板没有收到工具完成状态');
      return { toolReplies: replies.length, permissionRequests };
    });
    await stage('permission-request', async () => {
      const target = path.join(folder, 'permission-target.txt');
      await bounded(session.send(`COMPAT_PERMISSION ${target}`));
      assert(permissionRequests > 0, '没有收到真实权限问答');
      assert.equal(fs.readFileSync(target, 'utf8'), 'COMPAT_PERMISSION_FILE');
      return { permissionRequests, fileWritten: true };
    });
    await stage('permission-cancel', async () => {
      allowPermission = false;
      const before = permissionRequests;
      const target = path.join(folder, 'cancelled-target.txt');
      await bounded(session.send(`COMPAT_PERMISSION ${target}`));
      assert(permissionRequests > before, '取消场景没有收到权限问答');
      assert(!fs.existsSync(target), '拒绝授权后仍然写入了文件');
      allowPermission = true;
      return { cancelled: true, fileWritten: false };
    });
    await stage('history', async () => {
      const history = await client.listHistory(); assert(history.sessions.some((item) => item.id === sessionId));
      const replay = await client.getHistory(sessionId); assert(replay.entries.some((entry) => entry.kind === 'assistant'));
      return { sessions: history.sessions.length, entries: replay.entries.length };
    });
    await stage('resume', async () => {
      session.dispose(); client.close();
      client = new DoorClient({ host: '127.0.0.1', port }); await client.connect();
      session = new DshSession({ client }); await session.resume(sessionId, cwd, { preset: 'standard' });
      await bounded(session.send('COMPAT_RESUME')); assert.equal(session.sessionId, sessionId);
      return { restored: true };
    });
    await stage('cancel', async () => {
      const before = provider.requests.length;
      const pending = bounded(session.send('COMPAT_CANCEL'));
      await waitFor(() => provider.requests.length > before);
      session.stop();
      const result = await pending;
      assert.equal(result.stopReason, 'cancelled'); assert.equal(session.busy, false);
      return { stopReason: result.stopReason };
    });
    fs.writeFileSync(path.join(folder, 'kernel.log'), output.join('\n'));
    report.status = 'passed';
  } catch (error) { report.status = error.kind || 'failed'; report.error = redact(error.message); }
  finally {
    session?.dispose(); client?.close(); kernel?.dispose();
    if (provider) {
      fs.writeFileSync(path.join(folder, 'fixture-requests.json'), JSON.stringify(require('./lib.cjs').safeObject(provider.requests), null, 2));
      await provider.close();
    }
    if (kernel && port) {
      try { await waitFor(async () => !await locate.probePort('127.0.0.1', port, 200), 10000); report.stages.push({ name: 'cleanup', status: 'passed' }); }
      catch (error) { report.stages.push({ name: 'cleanup', status: 'failed', error: error.message }); report.status = 'failed'; }
    }
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    delete process.env.DSH_COMPAT_FIXTURE_KEY;
    for (const [key, value] of Object.entries(savedProxy)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    report.finishedAt = new Date().toISOString();
    const file = writeReport(folder, report);
    if (options.record && report.status === 'passed') console.log(`矩阵证据：${require('./matrix.cjs').recordEvidence(file)}`);
    console.log(`${report.status}: ${file}${report.error ? `\n${report.error}` : ''}`);
  }
  return report;
}
if (require.main === module) {
  const options = argsOf();
  if (options['record-report']) {
    try { console.log(require('./matrix.cjs').recordEvidence(options['record-report'])); }
    catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
  } else if (options.discover) discover().then((result) => {
    const output = options.matrix ? result.matrix : result;
    console.log(JSON.stringify(output));
  }).catch((error) => { console.error(`acquisition-failed: ${redact(error.message)}`); process.exitCode = 1; });
  else run(options).then((report) => { process.exitCode = report.status === 'passed' ? 0 : 1; }).catch((error) => { console.error(redact(error.stack)); process.exitCode = 1; });
}
module.exports = { run, freePort, waitFor, bounded };
