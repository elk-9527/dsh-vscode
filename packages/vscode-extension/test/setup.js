'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inspectPanelProfile,
  planPanelPluginSync,
  preparePanelProfile,
} = require('../src/door/setup');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-panel-setup-'));
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

function fakeRun(options) {
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

try {
  writeManifest(
    sourceProfile,
    [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@demo/alpha',
      'beta-plugin',
      'local-plugin',
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

  assert.equal(inspectPanelProfile(profile, { homedir: root, env }).exists, false);
  const created = preparePanelProfile({
    command: 'fake-dsh',
    profile,
    run: fakeRun,
    homedir: root,
    env,
  });
  assert.equal(created.created, true);
  assert.equal(created.action, 'add');
  assert.equal(created.hasDoor, true);
  assert.deepEqual(created.syncedPlugins, ['@demo/alpha', 'beta-plugin']);
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
  console.log('  PASS  创建自启配置时安装连接组件，并同步桌面端已启用的注册表插件');

  const target = inspectPanelProfile(profile, { homedir: root, env });
  assert.equal(target.dependencies['@demo/alpha'], '1.2.3');
  assert.equal(target.dependencies['beta-plugin'], '2.0.0');
  assert.equal(target.bundles.includes('local-plugin'), false);
  assert.equal(target.bundles.includes('inactive-plugin'), false);
  console.log('  PASS  同步固定到实际安装版本，跳过本地来源与未启用依赖');

  calls.length = 0;
  const updated = preparePanelProfile({
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

  writeManifest(profile, ['@deepseek-ai/dsh-base']);
  assert.throws(
    () => preparePanelProfile({ command: 'fake-dsh', profile, run: fakeRun, homedir: root, env }),
    /不是可由面板自启的 web 配置集/,
  );
  console.log('  PASS  不覆盖同名的非 web 配置集');

  assert.throws(
    () => preparePanelProfile({ command: 'fake-dsh', profile: '../bad', run: fakeRun, homedir: root, env }),
    /名称不合法/,
  );
  console.log('  PASS  配置集名称不能逃出 profiles 目录');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
