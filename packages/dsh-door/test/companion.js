import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createCompanionInstaller, discoverEditors, registerCompanion, EXTENSION_ID, CHANNEL } from '../lib/companion/install.js';

const root = fileURLToPath(new URL('../../../build/test-runs/', import.meta.url));
await fs.mkdir(root, { recursive: true });
const home = await fs.mkdtemp(path.join(root, 'companion-'));
const editor = { id: 'stable', label: 'Visual Studio Code', location: '/example/editor', command: '/example/code', args: [],
  profiles: [{ id: 'default', label: '默认配置' }, { id: 'named', label: '开发 & 审查', name: '开发 & 审查' }] };
const discover = async () => [structuredClone(editor)];
const services = [];
const make = options => { const service = createCompanionInstaller({ home, discover, ...options }); services.push(service); return service; };
const target = { editorId: 'stable', profileId: 'default', confirmed: true };
let count = 0;
async function test(name, action) { await action(); count++; console.log('PASS ' + name); }
try {
  if (process.platform === 'win32') await test('custom Windows installations, versioned CLI, profiles and deduplication', async () => {
    const installation = path.join(home, 'Custom Editor');
    const cli = path.join(installation, 'version-folder', 'resources', 'app', 'out', 'cli.js');
    const bin = path.join(installation, 'bin');
    await fs.mkdir(path.dirname(cli), { recursive: true }); await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(installation, 'Code.exe'), 'fixture'); await fs.writeFile(cli, 'fixture');
    await fs.writeFile(path.join(bin, 'code.cmd'), '"%~dp0..\\Code.exe" "%~dp0..\\version-folder\\resources\\app\\out\\cli.js" %*');
    const portable = path.join(installation, 'data', 'user-data', 'User', 'globalStorage');
    await fs.mkdir(portable, { recursive: true });
    await fs.writeFile(path.join(portable, 'storage.json'), JSON.stringify({ userDataProfiles: [{ name: '工作 & 开发' }, { name: '工作 & 开发' }] }));
    const options = { env: { PATH: bin }, installRoots: async () => [installation, installation.toUpperCase()] };
    const editors = await discoverEditors(options);
    assert.equal(editors.length, 1); assert.equal(editors[0].args[0], cli);
    assert.deepEqual(editors[0].profiles.map(profile => profile.label), ['默认配置', '工作 & 开发']);
    await fs.writeFile(path.join(bin, 'code.cmd'), '"%~dp0..\\..\\outside\\cli.js"');
    assert.equal((await discoverEditors(options)).length, 0, 'launcher paths escaping the installation are rejected');
  });
  await test('discovery alone never executes or installs anything', async () => {
    const service = make({ run: () => { assert.fail('unexpected CLI invocation'); } });
    const status = await service.status();
    assert.equal(status.dismissed, false); assert.equal(status.editors.length, 1);
    assert.equal(status.editors[0].command, undefined);
    assert.equal(status.editors[0].profiles[1].name, undefined);
  });
  await test('explicit click, exact target, argument arrays and verified readback', async () => {
    const calls = []; let installed = false;
    const service = make({ run: async (_, args) => {
      calls.push(args);
      if (args.includes('--install-extension')) { installed = true; return 'done'; }
      return installed ? EXTENSION_ID.toLowerCase() + '@0.18.2\r\n' : '';
    } });
    await assert.rejects(service.install({ ...target, confirmed: false }), { code: 'confirmation-required' });
    assert.equal(calls.length, 0);
    await assert.rejects(service.install({ ...target, editorId: 'arbitrary executable' }), { code: 'target-changed' });
    await assert.rejects(service.install({ ...target, profileId: 'new profile' }), { code: 'target-changed' });
    assert.deepEqual(await service.install({ ...target, profileId: 'named' }), { installed: true, version: '0.18.2' });
    assert.deepEqual(calls[1], ['--profile', '开发 & 审查', '--install-extension', EXTENSION_ID]);
    assert.equal(calls.length, 3); assert.equal((await service.status()).dismissed, true);
  });
  await test('already installed means no install command or forced update', async () => {
    const service = make({ run: async (_, args) => {
      assert(!args.includes('--install-extension')); return EXTENSION_ID + '@0.18.2';
    } });
    assert.equal((await service.install(target)).installed, true);
  });
  await test('exit zero without the extension is a verification failure', async () => {
    const service = make({ run: async () => 'Successfully finished' });
    await assert.rejects(service.install(target), { code: 'verification-failed' });
  });
  await test('failed install remains retryable', async () => {
    let attempts = 0, installed = false;
    const service = make({ run: async (_, args) => {
      if (args.includes('--install-extension')) {
        if (++attempts === 1) throw Object.assign(new Error('Installation failed'), { code: 'cli-failed' });
        installed = true;
      }
      return installed ? EXTENSION_ID + '@1.0.0' : '';
    } });
    await assert.rejects(service.install(target), { code: 'cli-failed' });
    assert.equal((await service.install(target)).installed, true); assert.equal(attempts, 2);
  });
  await test('concurrent clicks cannot start two installations', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const service = make({ run: async () => { await gate; return EXTENSION_ID + '@1'; } });
    const first = service.install(target);
    await assert.rejects(service.install(target), { code: 'busy' });
    release(); await first;
  });
  await test('unload aborts and waits for the owned CLI', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    let settled = false;
    const service = make({ run: (_, __, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { settled = true; reject(Object.assign(new Error('aborted'), { code: 'cancelled' })); }, { once: true });
      started();
    }) });
    const installing = service.install(target); const rejection = assert.rejects(installing, { code: 'cancelled' });
    await ready; await service.dispose(); await rejection; assert.equal(settled, true);
    assert.throws(() => service.status(), { code: 'cancelled' });
  });
  await test('dismissal survives another service and is independent of package version', async () => {
    await make().dismiss(); assert.equal((await make().status()).dismissed, true);
  });
  await test('owner-only Connection routes validate their envelopes; missing service is optional', async () => {
    let teardown, removed = 0; const routes = [];
    registerCompanion({ inject(names, cb) {
      assert.deepEqual(names, ['connection']);
      teardown = cb({ connection: { fetch: { register(route) { routes.push(route); return async () => { removed++; }; } } } });
    } }, { home, discover });
    assert.equal(routes.length, 4); assert.equal(routes[0].path, '/api/dsh-acp-door-companion/status');
    assert.equal(routes[0].requestBody, 'buffered'); assert.deepEqual(routes[0].methods, ['POST']);
    const request = body => new Request('http://localhost' + routes[0].path, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await routes[0].fetch(request({}))).status, 400);
    assert.equal((await routes[0].fetch(request({ type: 'client-request', rpcId: 'one', method: 'install' }))).status, 400);
    const reply = await (await routes[0].fetch(request({ type: 'client-request', rpcId: 'one', method: 'dsh-acp-door-companion/status', payload: {} }))).json();
    assert.equal(reply.result.ok, true); assert.equal(reply.rpcId, 'one');
    await teardown(); assert.equal(removed, 4);
    registerCompanion({ inject(_, cb) { assert.equal(cb({ connection: {} }), undefined); } });
  });

  let client;
  vm.runInNewContext(await fs.readFile(new URL('../lib/companion/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(definition) { assert.equal(definition.id, 'dsh-acp-door'); client = definition.factory(() => ({})); } } },
    AbortController, setTimeout, clearTimeout,
  });
  function mockRpc({ dismissed = false, installed = false, editors = [editor], fail = false } = {}) {
    const calls = [];
    return { calls, async call(channel, endpoint, params) {
      assert.equal(channel, CHANNEL); assert(endpoint.startsWith('dsh-acp-door-companion/'));
      endpoint = endpoint.split('/')[1]; calls.push({ endpoint, params });
      if (fail && endpoint === 'install') return { ok: false, error: { message: '网络不可用' } };
      if (endpoint === 'status') return { ok: true, value: { dismissed, editors } };
      if (endpoint === 'check') return { ok: true, value: { installed, version: installed ? '0.18.2' : null } };
      if (endpoint === 'dismiss') dismissed = true;
      if (endpoint === 'install') { assert.equal(params.confirmed, true); installed = true; }
      return { ok: true, value: { installed, version: installed ? '0.18.2' : null } };
    } };
  }
  await test('first run offers installation but never installs automatically', async () => {
    const rpc = mockRpc(), model = client.createController(rpc);
    await model.refresh(true); assert.equal(model.getSnapshot().prompt, true);
    assert.deepEqual(rpc.calls.map(x => x.endpoint), ['status', 'check']);
    await model.install(); assert.equal(model.getSnapshot().installed.installed, true);
    await model.dismiss(); assert.equal(model.getSnapshot().prompt, false); model.dispose();
  });
  await test('already installed or previously dismissed suppresses first-run notice', async () => {
    for (const options of [{ installed: true }, { dismissed: true }]) {
      const rpc = mockRpc(options), model = client.createController(rpc);
      await model.refresh(true); assert.equal(model.getSnapshot().prompt, false);
      if (options.dismissed) assert.equal(rpc.calls.length, 1);
      model.dispose();
    }
  });
  await test('no editor and failed installation retain fallback and retry state', async () => {
    const missing = mockRpc({ editors: [] }), empty = client.createController(missing);
    await empty.refresh(true); await empty.install(); assert.equal(empty.getSnapshot().prompt, true);
    assert(!missing.calls.some(x => x.endpoint === 'install')); empty.dispose();
    const failed = client.createController(mockRpc({ fail: true }));
    await failed.refresh(true); await failed.install(); assert.equal(failed.getSnapshot().error, '网络不可用');
    assert.equal(failed.getSnapshot().installed.installed, false); failed.dispose();
  });
  await test('client registration is local-only and owns its request lifecycle', async () => {
    client.apply({ connection: { isLoopback: false } });
    const slots = [], rpc = mockRpc({ dismissed: true }); let dispose;
    client.apply({ connection: { isLoopback: true, rpc }, effect(fn) { dispose = fn(); }, slots: {
      inject(name, cb) { return cb(); }, register(options) { slots.push(options); return () => {}; },
    } });
    assert.deepEqual(slots.map(x => x.name), ['shell.overlay', 'settings.section']); dispose();
  });
  await test('a failed preference write cannot trap the user in the modal', async () => {
    const rpc = mockRpc(); const original = rpc.call;
    rpc.call = async (channel, endpoint, payload) => endpoint.endsWith('/dismiss')
      ? { ok: false, error: { message: '保存失败' } } : original(channel, endpoint, payload);
    const model = client.createController(rpc);
    await model.refresh(true); assert.equal(model.getSnapshot().prompt, true);
    await model.dismiss(); assert.equal(model.getSnapshot().prompt, false);
    assert.match(model.getSnapshot().error, /下次可能再次提示/); model.dispose();
  });
  console.log(`PASS companion installation: ${count} scenarios`);
} finally {
  await Promise.all(services.map(service => service.dispose()));
  await fs.rm(home, { recursive: true, force: true });
}
