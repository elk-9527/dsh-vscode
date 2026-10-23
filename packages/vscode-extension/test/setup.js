'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  desktopProfilePatchArgs,
  inspectPanelProfile,
  planPanelPluginSync,
  preparePanelProfile,
} = require('../src/door/setup');

const fixtures = path.resolve(__dirname, '../../../build/test-setup'); fs.mkdirSync(fixtures, { recursive: true });
const root = fs.mkdtempSync(path.join(fixtures, 'dsh-panel-setup-'));
const env = { DSH_HOME: path.join(root, '.dsh') };
const profile = 'vscode-panel';
const sourceProfile = 'desktop';
const profilesRoot = path.join(env.DSH_HOME, 'profiles');
const calls = [];

function directoryOf(name) {
  return path.join(profilesRoot, name);
}

function writeManifest(name, bundles, dependencies = {}) {
  const directory = directoryOf(name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${name}`,
      dsh: { profile: { bundles } },
      dependencies,
    }),
  );
}

function writeInstalled(name, packageName, version) {
  const directory = path.join(directoryOf(name), 'node_modules', ...packageName.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageName, version }));
}

function parseRegistryArgument(argument) {
  const at = argument.lastIndexOf('@');
  if (at <= 0) throw new Error(`测试收到无法识别的包参数：${argument}`);
  return { name: argument.slice(0, at), version: argument.slice(at + 1) };
}

async function fakeRun(options) {
  await new Promise(resolve => setImmediate(resolve));
  calls.push(options.args);
  if (options.args.includes('--from-default-profile')) {
    writeManifest(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    return '';
  }
  if (options.args[0] !== 'plugin') return '';

  const target = options.args[2];
  const packageArguments = options.args.slice(4);
  const state = inspectPanelProfile(target, { homedir: root, env });
  const bundles = [...state.bundles];
  const dependencies = { ...state.dependencies };
  for (const argument of packageArguments) {
    if (argument === 'dsh-acp-door') {
      if (!bundles.includes(argument)) bundles.push(argument);
      dependencies[argument] = '0.1.1';
      writeInstalled(target, argument, '0.1.1');
      continue;
    }
    const item = parseRegistryArgument(argument);
    if (!bundles.includes(item.name)) bundles.push(item.name);
    dependencies[item.name] = item.version;
    writeInstalled(target, item.name, item.version);
  }
  writeManifest(target, bundles, dependencies);
  return '';
}

(async () => { try {
  writeManifest(
    sourceProfile,
    [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-experimental-auto-review',
      '@deepseek-ai/dsh-experimental-schedule-bundle',
      '@demo/alpha',
      'beta-plugin',
      'local-plugin',
      'unresolved-manual-bundle',
      'dsh-acp-door',
    ],
    {
      '@demo/alpha': '^1.0.0',
      'beta-plugin': '2.0.0',
      'local-plugin': 'file:C:/private/local-plugin.tgz',
      'inactive-plugin': '9.0.0',
      'dsh-acp-door': 'file:C:/private/dsh-acp-door.tgz',
    },
  );
  writeInstalled(sourceProfile, '@demo/alpha', '1.2.3');
  writeInstalled(sourceProfile, 'beta-plugin', '2.0.0');
  writeInstalled(sourceProfile, 'local-plugin', '3.0.0');
  const desktopPatch = path.join(directoryOf(sourceProfile), 'cordis.patch.yml');
  fs.writeFileSync(desktopPatch, '- id: llm-pi-ai\n  config: {}\n');

  assert.deepEqual(
    desktopProfilePatchArgs({ profile, sourceProfile, homedir: root, env }),
    ['--patch', desktopPatch],
  );
  assert.deepEqual(
    desktopProfilePatchArgs({ profile: 'custom-web', sourceProfile, homedir: root, env }),
    [],
  );
  console.log('  PASS  自启 vscode-panel 只读叠加 desktop 配置文件，不改写目标文件');

  assert.equal(inspectPanelProfile(profile, { homedir: root, env }).exists, false);
  const created = await preparePanelProfile({
    command: 'fake-dsh',
    profile,
    run: fakeRun,
    homedir: root,
    env,
  });
  assert.equal(created.created, true);
  assert.equal(created.action, 'add');
  assert.equal(created.hasDoor, true);
  assert.deepEqual(created.syncedPlugins, [
    '@demo/alpha',
    'beta-plugin',
    '@deepseek-ai/dsh-experimental-auto-review',
    '@deepseek-ai/dsh-experimental-schedule-bundle',
  ]);
  assert.deepEqual(created.skippedPlugins.map((item) => item.name), ['local-plugin']);
  assert.deepEqual(calls[0], [
    '--profile',
    profile,
    '--from-default-profile',
    'web',
    '--dump-config',
  ]);
  assert.deepEqual(calls[1], ['plugin', '--profile', profile, 'add', 'dsh-acp-door']);
  assert.deepEqual(calls[2], [
    'plugin',
    '--profile',
    profile,
    'add',
    '@demo/alpha@1.2.3',
    'beta-plugin@2.0.0',
  ]);
  console.log('  PASS  创建自启配置时安装连接组件，并同步注册表插件与 DSH 运行时 bundle');

  const target = inspectPanelProfile(profile, { homedir: root, env });
  assert.equal(target.dependencies['@demo/alpha'], '1.2.3');
  assert.equal(target.dependencies['beta-plugin'], '2.0.0');
  assert.equal(target.bundles.includes('@deepseek-ai/dsh-experimental-auto-review'), true);
  assert.equal(target.bundles.includes('@deepseek-ai/dsh-experimental-schedule-bundle'), true);
  assert.equal(target.bundles.includes('local-plugin'), false);
  assert.equal(target.bundles.includes('inactive-plugin'), false);
  assert.equal(target.bundles.includes('unresolved-manual-bundle'), false);
  console.log('  PASS  同步固定到实际安装版本，跳过本地来源、未启用依赖与无法解析的手工 bundle');

  calls.length = 0;
  const updated = await preparePanelProfile({
    command: 'fake-dsh',
    profile,
    run: fakeRun,
    homedir: root,
    env,
  });
  assert.equal(updated.created, false);
  assert.equal(updated.action, 'update');
  assert.deepEqual(updated.syncedPlugins, []);
  assert.deepEqual(calls, [['plugin', '--profile', profile, 'update', 'dsh-acp-door']]);
  console.log('  PASS  插件版本一致时不重复安装，连接组件仍执行兼容更新');

  const beforeDrift = inspectPanelProfile(profile, { homedir: root, env });
  writeInstalled(profile, 'beta-plugin', '1.0.0');
  writeManifest(
    profile,
    beforeDrift.bundles,
    { ...beforeDrift.dependencies, 'beta-plugin': '1.0.0' },
  );
  const drift = planPanelPluginSync({ profile, sourceProfile, homedir: root, env });
  assert.deepEqual(drift.install.map((item) => item.argument), ['beta-plugin@2.0.0']);
  console.log('  PASS  桌面端插件升级后，自启前能识别版本漂移');

  writeManifest(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']); calls.length = 0;
  const failedRun = async options => {
    if (options.args.includes('@demo/alpha@1.2.3')) {
      await fakeRun({ ...options, args: options.args.slice(0, 5) });
      throw Object.assign(new Error('registry unavailable'), { code: 'EPROCESS' });
    }
    return fakeRun(options);
  };
  await assert.rejects(preparePanelProfile({ command: 'fake-dsh', profile, run: failedRun, homedir: root, env }), error => {
    assert.equal(error.setupState.hasDoor, true); assert.deepEqual(error.setupState.synced, ['@demo/alpha']);
    assert.deepEqual(error.setupState.pending, ['beta-plugin', '@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-schedule-bundle']); assert.match(error.message, /已完成的更改已保留/); return true;
  });
  assert(inspectPanelProfile(profile, { homedir: root, env }).bundles.includes('@demo/alpha'));
  calls.length = 0;
  await preparePanelProfile({ command: 'fake-dsh', profile, run: fakeRun, homedir: root, env });
  assert.deepEqual(calls[1], ['plugin', '--profile', profile, 'add', 'beta-plugin@2.0.0'], 'Retry installs only the remaining plugin');
  const abort = new AbortController(); abort.abort(); const beforeCancel = calls.length;
  await assert.rejects(preparePanelProfile({ command: 'fake-dsh', profile, run: fakeRun, homedir: root, env, signal: abort.signal }), error => error.code === 'ECANCELLED');
  assert.equal(calls.length, beforeCancel);
  console.log('  PASS  部分安装失败保留实际状态，重试仅安装缺失项，提前取消不执行命令');

  writeManifest(profile, ['@deepseek-ai/dsh-base']);
  await assert.rejects(
    () => preparePanelProfile({ command: 'fake-dsh', profile, run: fakeRun, homedir: root, env }),
    /不是可由面板自启的 web 配置集/,
  );
  console.log('  PASS  不覆盖同名的非 web 配置集');

  await assert.rejects(
    () => preparePanelProfile({ command: 'fake-dsh', profile: '../bad', run: fakeRun, homedir: root, env }),
    /名称不合法/,
  );
  console.log('  PASS  配置集名称不能逃出 profiles 目录');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch(error => { console.error(error); process.exitCode = 1; });
