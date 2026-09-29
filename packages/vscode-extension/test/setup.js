'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inspectPanelProfile, preparePanelProfile } = require('../src/door/setup');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-panel-setup-'));
const env = { DSH_HOME: path.join(root, '.dsh') };
const profile = 'vscode-panel';
const directory = path.join(env.DSH_HOME, 'profiles', profile);
const calls = [];

function writeManifest(bundles) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles } } }),
  );
}

function fakeRun(options) {
  calls.push(options.args);
  if (options.args.includes('--from-default-profile')) {
    writeManifest(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  }
  if (options.args[0] === 'plugin') {
    const current = inspectPanelProfile(profile, { homedir: root, env }).bundles;
    writeManifest([...current.filter((name) => name !== 'dsh-acp-door'), 'dsh-acp-door']);
  }
  return '';
}

try {
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
  assert.deepEqual(calls[0], [
    '--profile',
    profile,
    '--from-default-profile',
    'web',
    '--dump-config',
  ]);
  assert.deepEqual(calls[1], ['plugin', '--profile', profile, 'add', 'dsh-acp-door']);
  console.log('  PASS  缺少配置集时从 web 模板创建并安装连接组件');

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
  assert.deepEqual(calls[0], ['plugin', '--profile', profile, 'update', 'dsh-acp-door']);
  console.log('  PASS  已有连接组件时执行兼容更新');

  writeManifest(['@deepseek-ai/dsh-base']);
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
