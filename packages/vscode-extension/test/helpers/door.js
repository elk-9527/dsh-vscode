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
/** 测试档的名字。**只允许改这一个档** —— 见 syncDoor 的说明。 */
const TEST_PROFILE = 'dshdoor';

/** 装进某个档之后它在哪。 */
function installedDoorPath(profile) {
  return path.join(
    process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh'),
    'profiles',
    profile,
    'node_modules',
    'dsh-acp-door',
  );
}

/** 测试档里那份门在哪（下面这些检查都对着它）。 */
const DOOR_INSTALLED = installedDoorPath(TEST_PROFILE);

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
 * 确保**测试档**里装的那份门跟源码一致（不一致就重新装一次）。
 *
 * 走 remove + add 而不是直接拷：那是用户真会走的安装路径，装出来的东西才
 * 跟生产一致。之所以要先 remove，是因为 pnpm 的缓存/硬链接会让「add」变成
 * 空操作（实测：内容变了它还报 added 0）。
 *
 * 实测还发现**光靠 remove + add 也不够**：改过 `package.json` 的版本号之后，
 * remove + add 装回来的可能还是旧版本（pnpm 复用缓存）。所以最后有一道兜底：
 * 真要还是不一致，就按文件直接同步过去。
 *
 * ⚠️ 这个函数**只动测试档**（dshdoor），别的档一律不碰。
 * 教训（真踩过）：早先它拿 `profile` 参数去装、却对着写死的 dshdoor 路径做比对，
 * 于是 `DSH_PANEL_PROFILE=desktop` 跑测试时，它把**用户生产档**的依赖从
 * `file:…tgz` 换成了源码目录 —— 换了形态、还比不出结果。现在：
 *   - 目标档不是测试档 → 只**检查**、只**报告**，不修改，并明确说清该怎么装。
 *
 * @returns {{synced: boolean, drift: string[], copied: string[], skipped?: boolean}}
 */
function syncDoor({ log = () => {}, command = process.env.DSH_PANEL_DSH || 'dsh' } = {}) {
  const drift = doorDrift();
  if (drift.length === 0) {
    log('info', '门插件跟源码一致，不用重装');
    return { synced: false, drift, copied: [] };
  }
  log('info', `门插件跟源码不一致（${drift.join('、')}），重新装一次`);
  try {
    runDshSync({ command, args: ['plugin', '--profile', TEST_PROFILE, 'remove', 'dsh-acp-door'] });
  } catch {
    // 本来就没装过 —— 无所谓，接着 add。
  }
  try {
    runDshSync({
      command,
      args: ['plugin', '--profile', TEST_PROFILE, 'add', `file:${DOOR_SRC.replace(/\\/g, '/')}`],
    });
  } catch (error) {
    // pnpm 可能被自己的安全策略拦住（实测：换依赖超过确认阈值时报
    // SAFE_DELETE_BULK_CONFIRM_REQUIRED，非交互环境下没有「确认」这一步）。
    // 依赖本来就在档里装着（版本没变），按文件同步 lib 就够了 —— 往下走兜底。
    log('info', `pnpm 装不上（${String(error && error.message ? error.message : error).split('\n')[0].slice(0, 120)}），按文件直接同步`);
  }

  let left = doorDrift();
  if (left.length === 0) return { synced: true, drift, copied: [] };

  // 兜底：pnpm 缓存不肯换（实测改版本号之后就是这样），直接按文件同步。
  log('info', `pnpm 装回来的还是旧的（${left.join('、')}），按文件直接同步过去`);
  const copied = [];
  for (const rel of doorFiles()) {
    const from = path.join(DOOR_SRC, rel);
    const to = path.join(DOOR_INSTALLED, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!fs.existsSync(to) || !fs.readFileSync(from).equals(fs.readFileSync(to))) {
      fs.copyFileSync(from, to);
      copied.push(rel);
    }
  }
  left = doorDrift();
  if (left.length > 0) {
    throw new Error(`门同步之后还是不一致：${left.join('、')}（源码 ${DOOR_SRC}，装的 ${DOOR_INSTALLED}）`);
  }
  return { synced: true, drift, copied };
}

/**
 * 检查某个档里装的门跟源码一致吗，**只读**。
 *
 * 给「换档跑生产路径验证」用的：那种时候绝不能顺手改用户的档，
 * 只该如实报告「你这个档装的门是哪个版本、跟当前源码一不一样」。
 *
 * @param {string} profile
 * @returns {{installed: boolean, version?: string, drift: string[], path: string}}
 */
function inspectDoor(profile = PROFILE) {
  const base = installedDoorPath(profile);
  const manifest = path.join(base, 'package.json');
  if (!fs.existsSync(manifest)) return { installed: false, drift: [], path: base };
  let version;
  try {
    version = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '')).version;
  } catch {
    version = '（package.json 读不出来）';
  }
  const drift = [];
  for (const rel of doorFiles()) {
    const src = path.join(DOOR_SRC, rel);
    const installed = path.join(base, rel);
    if (!fs.existsSync(installed) || !fs.readFileSync(src).equals(fs.readFileSync(installed))) {
      drift.push(rel);
    }
  }
  return { installed: true, version, drift, path: base };
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
    // 把要用的端口一起给它：门**优先读环境变量**（DSH_ACP_DOOR_PORT），
    // 所以「我说钉在哪个端口」就真的在哪个端口，不用再去糊一份 --patch。
    // 不给的话门就按档里配的来（默认 47821）—— 那正是 47821 这个默认值能用、
    // 而随便挑个空闲端口就等不到门的原因（踩过：等了 120 秒才发现是这）。
    port,
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

module.exports = {
  ensureDoor,
  doorIsUp,
  syncDoor,
  doorDrift,
  inspectDoor,
  HOST,
  PORT,
  PROFILE,
  TEST_PROFILE,
};
