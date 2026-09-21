'use strict';

/**
 * 测试用的 ACP 接入点插件（dsh-acp-door）保障：未运行时自行启动后台 DSH，已运行时直接使用。
 *
 * 设立该模块的原因：面板层测试与端到端测试都要求 47821 上存在一个已开放接入点的 DSH，
 * 此前需要手动启动内核，运行结束后可能仍有残留。现在由测试自行启动并负责回收，
 * 因此「一条命令完成全部流程」成立，也不会留下孤儿进程。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  probePort,
  spawnBackgroundDsh,
  runDshSync,
  dshCommandCandidates,
} = require('../../src/door/locate');

const HOST = process.env.DSH_PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_PANEL_PORT || 47821);
const PROFILE = process.env.DSH_PANEL_PROFILE || 'dshdoor';

/** 该插件在仓库中的源码目录。 */
const DOOR_SRC = path.resolve(__dirname, '..', '..', '..', 'dsh-door');
/** 测试档的名称。仅允许修改这一个档 —— 见 syncDoor 的说明。 */
const TEST_PROFILE = 'dshdoor';

/** 安装到某个档之后的所在路径。 */
function installedDoorPath(profile) {
  return path.join(
    process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh'),
    'profiles',
    profile,
    'node_modules',
    'dsh-acp-door',
  );
}

/** 测试档中该插件的所在路径（下文各项检查均针对该路径）。 */
const DOOR_INSTALLED = installedDoorPath(TEST_PROFILE);

let cachedDshCommand;

/**
 * 找到这台机器上真实可执行的 DSH 命令。
 *
 * 测试原先直接使用 `dsh`，但 VS Code/非交互终端常常看不到用户 npm 的 PATH；
 * 面板生产代码早已支持默认安装目录，测试帮助器却没有复用，结果根目录 `npm test`
 * 会在每个真 DSH 套件中白等两分钟。此处逐项执行只读的 `--version`，成功者缓存。
 */
function resolveTestDshCommand({ command, log = () => {} } = {}) {
  if (command) return command;
  if (cachedDshCommand) return cachedDshCommand;
  const candidates = dshCommandCandidates({
    dshCommand: process.env.DSH_PANEL_DSH || 'dsh',
    homedir: os.homedir(),
  });
  const failures = [];
  for (const candidate of candidates) {
    try {
      runDshSync({ command: candidate, args: ['--version'], timeoutMs: 10000 });
      cachedDshCommand = candidate;
      log('info', `测试使用的 DSH 命令：${candidate}`);
      return candidate;
    } catch (error) {
      failures.push(String(error && error.message ? error.message : error).split('\n')[0]);
    }
  }
  throw new Error(`找不到可执行的 DSH：${failures.join('；')}`);
}

function doorIsUp(host = HOST, port = PORT) {
  return probePort(host, port, 800);
}

/** 列出该包应包含的文件（依据 package.json 的 files 字段，不另行维护一份）。 */
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
 * 核对已安装的该插件是否与源码一致；不一致时列出不同的文件。
 *
 * 需要检查该内容的原因：`file:` 依赖是拷贝（而非符号链接），且 pnpm 会命中
 * 缓存 —— 修改源码后可能不会重新安装（实测：修改了该插件，测试仍在测试旧代码，
 * 全部通过，却未验证任何内容）。这种静默测试错误对象的情况是测试中最严重的一类。
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
 * 确保测试档中安装的该插件与源码一致（不一致时重新安装一次）。
 *
 * 采用 remove + add 而不直接拷贝：这是用户实际会执行的安装路径，安装结果才
 * 与生产环境一致。需要先执行 remove 的原因是 pnpm 的缓存与硬链接会使「add」变为
 * 空操作（实测：内容已变化，仍报告 added 0）。
 *
 * 实测还发现仅依靠 remove + add 并不充分：修改 `package.json` 的版本号之后，
 * remove + add 装回的仍可能是旧版本（pnpm 复用缓存）。因此最后设置一道后备措施：
 * 若仍不一致，则按文件直接同步。
 *
 * ⚠️ 该函数仅操作测试档（dshdoor），其他档一律不修改。
 * 经验（实际出现）：早期实现使用 `profile` 参数安装，却按写死的 dshdoor 路径比对，
 * 因此在以 `DSH_PANEL_PROFILE=desktop` 运行测试时，把用户生产档的依赖从
 * `file:…tgz` 改为源码目录 —— 改变了形态，且无法比对结果。当前行为：
 *   - 目标档不是测试档 → 只检查、只报告，不修改，并明确说明应如何安装。
 *
 * @returns {{synced: boolean, drift: string[], copied: string[], skipped?: boolean}}
 */
function syncDoor({ log = () => {}, command } = {}) {
  command = resolveTestDshCommand({ command, log });
  const drift = doorDrift();
  if (drift.length === 0) {
    log('info', '该插件与源码一致，无需重新安装');
    return { synced: false, drift, copied: [] };
  }
  log('info', `该插件与源码不一致（${drift.join('、')}），重新安装一次`);
  try {
    runDshSync({ command, args: ['plugin', '--profile', TEST_PROFILE, 'remove', 'dsh-acp-door'] });
  } catch {
    // 此前未安装 —— 不影响后续，继续执行 add。
  }
  try {
    runDshSync({
      command,
      args: ['plugin', '--profile', TEST_PROFILE, 'add', `file:${DOOR_SRC.replace(/\\/g, '/')}`],
    });
  } catch (error) {
    // pnpm 可能被自身安全策略阻止（实测：变更依赖超过确认阈值时报告
    // SAFE_DELETE_BULK_CONFIRM_REQUIRED，非交互环境下不存在「确认」步骤）。
    // 依赖已安装在档中（版本未变），按文件同步 lib 即可 —— 继续执行后备流程。
    log('info', `pnpm 装不上（${String(error && error.message ? error.message : error).split('\n')[0].slice(0, 120)}），按文件直接同步`);
  }

  let left = doorDrift();
  if (left.length === 0) return { synced: true, drift, copied: [] };

  // 后备：pnpm 缓存不更新（实测修改版本号之后即为此情况），直接按文件同步。
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
    throw new Error(`该插件同步之后还是不一致：${left.join('、')}（源码 ${DOOR_SRC}，装的 ${DOOR_INSTALLED}）`);
  }
  return { synced: true, drift, copied };
}

/**
 * 检查某个档中安装的该插件是否与源码一致，只读操作。
 *
 * 供「切换档以验证生产路径」使用：此时不得修改用户的档，
 * 只需如实报告「该档安装的插件版本以及是否与当前源码一致」。
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
 * 确保该插件已开放接入点。
 *
 * @returns {Promise<{started: boolean, stop: () => void}>}
 *   `started` 表示该内核由本次测试启动（测试结束时需要回收）；
 *   若内核本就在运行，`stop()` 为空操作 —— 不得终止其他进程启动的内核。
 */
async function ensureDoor({ host = HOST, port = PORT, profile = PROFILE, log = () => {}, extraArgs = [] } = {}) {
  if (await doorIsUp(host, port)) {
    log('info', `该插件已在 ${host}:${port} 上，直接使用`);
    return { started: false, stop() {} };
  }

  log('info', `该插件未监听，自行启动一个后台 DSH（profile=${profile}）`);
  const command = resolveTestDshCommand({ log });
  const kernel = spawnBackgroundDsh({
    command,
    profile,
    log,
    extraArgs,
    // 同时传入需要使用的端口：该插件优先读取环境变量（DSH_ACP_DOOR_PORT），
    // 因此指定端口即生效，无需再生成一份 --patch。
    // 不传入时该插件按档中配置执行（默认 47821）—— 这正是 47821 这个默认值可用、
    // 而任意空闲端口上等待不到该插件的原因（实际出现：等待 120 秒后才发现该问题）。
    port,
  });
  const deadline = Date.now() + 120000;
  let ok = false;
  while (Date.now() < deadline) {
    if (await doorIsUp(host, port)) {
      ok = true;
      break;
    }
    if (kernel.child.exitCode !== null || kernel.child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ok) {
    const tail = typeof kernel.stderrTail === 'function' ? kernel.stderrTail() : '';
    kernel.dispose();
    throw new Error(
      `后台 DSH 未能在 ${host}:${port} 建立监听（profile=${profile}）` +
        (tail ? `：${tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}` : ''),
    );
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
  resolveTestDshCommand,
};
