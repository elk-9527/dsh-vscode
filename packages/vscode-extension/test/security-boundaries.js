'use strict';

/**
 * 本机边界与设置来源的回归测试。
 *
 * 面板会启动本机 DSH，也会把编辑器上下文交给 ACP。因此两条约束必须同时成立：
 * 连接目标不能是远程地址，且工作区设置不能控制启动参数。二者只靠文档约定均不充分。
 */

const path = require('node:path');
const { resolveLoopbackHost } = require('../src/door/endpoint');
const { DoorClient } = require('../src/door/client');
const { readUserSetting } = require('../src/panel/settings');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `（${detail}）` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` → ${detail}` : ''}`);
  }
}

console.log('\n── 本机边界与设置来源 ─────────────────────────────────');

check(
  '空值、127.0.0.1 与 localhost 都规范化为 IPv4 回环地址',
  ['', '127.0.0.1', 'localhost'].every((host) => {
    const result = resolveLoopbackHost(host);
    return result.accepted && result.host === '127.0.0.1';
  }),
);
check(
  '局域网、全网与 IPv6 地址都会被拒绝',
  ['0.0.0.0', '192.168.1.8', 'example.test', '::1'].every((host) => !resolveLoopbackHost(host).accepted),
);
check(
  '客户端构造时再次拒绝非本机地址',
  (() => {
    try {
      new DoorClient({ host: '192.168.1.8', port: 47821 });
      return false;
    } catch (error) {
      return /仅支持本机回环地址/.test(String(error && error.message));
    }
  })(),
);

const fakeConfiguration = {
  get: () => 'workspace-command',
  inspect: () => ({
    defaultValue: 'default-command',
    globalValue: 'user-command',
    workspaceValue: 'workspace-command',
  }),
};
check(
  '用户设置优先，工作区设置不能覆盖启动设置',
  readUserSetting(fakeConfiguration, 'dshCommand', 'fallback') === 'user-command',
);
check(
  '未写用户设置时使用默认值，不读取工作区覆盖值',
  readUserSetting(
    {
      get: () => 'workspace-command',
      inspect: () => ({ defaultValue: 'default-command', workspaceValue: 'workspace-command' }),
    },
    'dshCommand',
    'fallback',
  ) === 'default-command',
);
check(
  '最小测试替身仍可通过 get() 读取设置',
  readUserSetting({ get: () => 'test-value' }, 'port', 'fallback') === 'test-value',
);

const manifest = require(path.resolve(__dirname, '..', 'package.json'));
const settings = manifest.contributes.configuration.properties;
check(
  '全部面板设置均限定为用户级',
  Object.values(settings).every((setting) => setting.scope === 'machine'),
  Object.entries(settings).filter(([, setting]) => setting.scope !== 'machine').map(([key]) => key).join(', '),
);
check(
  '连接地址设置只允许本机回环写法',
  Array.isArray(settings['dshPanel.host'].enum) &&
    settings['dshPanel.host'].enum.join(',') === '127.0.0.1,localhost',
);

console.log(`\n  ${failed === 0 ? '✅' : '❌'} 本机边界与设置来源：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`);
for (const item of failures) console.log(`     - ${item}`);
process.exit(failed === 0 ? 0 : 1);
