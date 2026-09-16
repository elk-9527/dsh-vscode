'use strict';

/**
 * 测试用的「门」保障：没开就自己拉起一个后台 DSH，开着的就直接用。
 *
 * 为什么需要：面板层测试和端到端测试都要有一个 DSH 在 47821 上开门，
 * 以前得先手动起内核、跑完可能还留着。现在测试自己负责起、也负责收，
 * 于是「一条命令从头跑到尾」成立，也不会留下孤儿进程。
 */

const fs = require('node:fs');
const path = require('node:path');

const { probePort, waitForPort, spawnBackgroundDsh, runDshSync } = require('../../src/door/locate');

const HOST = process.env.DSH_PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_PANEL_PORT || 47821);
const PROFILE = process.env.DSH_PANEL_PROFILE || 'dshdoor';

/** 门插件在仓库里的源码目录。 */
const DOOR_SRC = path.resolve(__dirname, '..', '..', '..', 'dsh-door');
/** 装进测试档之后它在哪。 */
const DOOR_INSTALLED = path.join(
  process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh'),
  'profiles',
  'dshdoor',
  'node_modules',
  'dsh-acp-door',
);

function doorIsUp(host = HOST, port = PORT) {
  return probePort(host, port, 800);
}

/** 列出这个包该有的文件（跟着 package.json 的 files 走，别自己另立一份）。 */
function doorFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(DOOR_SRC, 'package.json'), 'utf8'));
  const entries = Array.isArray(pkg.files) ? pkg.files : ['lib', 'package.json'];
  const out = ['package.json'];
  for (const entry of entries) {
    const full = path.join(DOOR_SRC, entry);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full)) {
        const child = path.join(full, name);
        if (fs.statSync(child).isFile()) out.push(path.join(entry, name));
      }
    } else {
      out.push(entry);
    }
  }
  return [...new Set(out)];
}

/**
 * 装的那份门跟源码一致吗？不一致就列出哪些文件不一样。
 *
 * 为什么非要查这个：`file:` 依赖是**拷贝**（不是符号链接），而且 pnpm 会命中
 * 缓存 —— 源码改了它可能压根不重装（实测：改了门，测试还在测旧代码，全绿，
 * 却什么都没验到）。这种「静默测错东西」是测试里最坏的一种。
 *
 * @returns {string[]} 不一致的文件名（空数组 = 一致）。
 */
function doorDrift() {
  const drift = [];
  for (const rel of doorFiles()) {
    const src = path.join(DOOR_SRC, rel);
    const installed = path.join(DOOR_INSTALLED, rel);
    try {
      if (!fs.existsSync(installed) || !fs.readFileSync(src).equals(fs.readFileSync(installed))) {
        drift.push(rel);
      }
    } catch {
      drift.push(rel);
    }
  }
  return drift;
}

/**
 * 确保测试档里装的那份门跟源码一致（不一致就重新装一次）。
 *
 * 用 remove + add 而不是直接拷：走的是用户真会走的那条安装路径，装出来的
 * 东西才跟生产一致。之所以要先 remove，是因为 pnpm 的缓存/硬链接会让
 * 「add」变成空操作（实测：内容变了它还报 added 0）。
 *
 * @returns {{synced: boolean, drift: string[]}}
 */
function syncDoor({ profile = PROFILE, log = () => {}, command = process.env.DSH_PANEL_DSH || 'dsh' } = {}) {
  const drift = doorDrift();
  if (drift.length === 0) {
    log('info', '门插件跟源码一致，不用重装');
    return { synced: false, drift };
  }
  log('info', `门插件跟源码不一致（${drift.join('、')}），重新装一次`);
  try {
    runDshSync({ command, args: ['plugin', '--profile', profile, 'remove', 'dsh-acp-door'] });
  } catch {
    // 本来就没装过 —— 无所谓，接着 add。
  }
  runDshSync({ command, args: ['plugin', '--profile', profile, 'add', `file:${DOOR_SRC.replace(/\\/g, '/')}`] });
  const left = doorDrift();
  if (left.length > 0) {
    throw new Error(`门重装之后还是跟源码不一致：${left.join('、')}（装的在 ${DOOR_INSTALLED}）`);
  }
  return { synced: true, drift };
}

/**
 * 确保门是开的。
 *
 * @returns {Promise<{started: boolean, stop: () => void}>}
 *   `started` 说明这个内核是本次测试拉起来的（测试结束时要收摊）；
 *   如果是本来就在跑的，`stop()` 是空操作 —— **绝不杀别人的内核**。
 */
async function ensureDoor({ host = HOST, port = PORT, profile = PROFILE, log = () => {}, extraArgs = [] } = {}) {
  if (await doorIsUp(host, port)) {
    log('info', `门已经在 ${host}:${port} 上，直接用它`);
    return { started: false, stop() {} };
  }

  log('info', `门没开，自己拉起一个后台 DSH（profile=${profile}）`);
  const kernel = spawnBackgroundDsh({
    command: process.env.DSH_PANEL_DSH || 'dsh',
    profile,
    log,
    extraArgs,
  });
  const ok = await waitForPort(host, port, { totalMs: 120000 });
  if (!ok) {
    kernel.dispose();
    throw new Error(`后台 DSH 起来了但 ${host}:${port} 一直没开门（profile=${profile}）`);
  }
  return {
    started: true,
    stop() {
      kernel.dispose();
    },
  };
}

module.exports = { ensureDoor, doorIsUp, syncDoor, doorDrift, HOST, PORT, PROFILE };
