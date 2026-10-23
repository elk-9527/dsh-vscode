'use strict';

/**
 * 测试用的 ACP 接入点插件（dsh-acp-door）保障：未运行时自行启动后台 DSH，已运行时直接使用。
 *
 * 面板层与端到端测试需要可用的 ACP 接入点。测试按需启动专用内核，
 * 并仅回收自身启动的进程，支持一次命令完成测试及清理。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  probePort,
  spawnBackgroundDsh,
  runDshSync,
  dshCommandCandidates,
  runningDesktopExecutables,
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
let cachedDesktopExecutables = [];

/** Create the dedicated web profile on a fresh machine; never touches desktop. */
function ensureTestProfile({ command, log = () => {} } = {}) {
  command = resolveTestDshCommand({ command, log });
  const manifest = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'profiles',
    TEST_PROFILE,
    'package.json',
  );
  if (fs.existsSync(manifest)) return false;
  log('info', `测试配置集 ${TEST_PROFILE} 不存在，从 web 模板创建`);
  runDshSync({
    command,
    args: ['--profile', TEST_PROFILE, '--from-default-profile', 'web', '--dump-config'],
    timeoutMs: 120000,
  });
  if (!fs.existsSync(manifest)) throw new Error(`DSH 没有创建测试配置集 ${TEST_PROFILE}`);
  return true;
}

/**
 * 解析测试环境中可执行的 DSH 命令。
 *
 * 非交互环境的 PATH 可能不含 DSH。复用生产候选解析，逐项执行只读的
 * --version 探测，并缓存首个成功的命令，避免将命令缺失误判为启动超时。
 */
function resolveTestDshCommand({ command, log = () => {} } = {}) {
  if (command) return command;
  if (cachedDshCommand) return cachedDshCommand;
  cachedDesktopExecutables = runningDesktopExecutables();
  const candidates = dshCommandCandidates({
    dshCommand: process.env.DSH_PANEL_DSH || 'dsh',
    homedir: os.homedir(),
    desktopExecutables: cachedDesktopExecutables,
    extensionDir: path.resolve(__dirname, '..', '..'),
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

/** Match extension activation: retain the Desktop path discovered before opening the panel. */
function desktopExecutablesForTest({ log = () => {} } = {}) {
  resolveTestDshCommand({ log });
  return cachedDesktopExecutables.slice();
}

function doorIsUp(host = HOST, port = PORT) {
  return probePort(host, port, 800);
}

/** True when a live-model test reached the provider but this machine has no usable credential. */
function isMissingModelCredentials(value) {
  return /no API key|credentials service|incorrect API key|unauthorized/i.test(
    String(value && value.message ? value.message : value || ''),
  );
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
      const walk = (directory, relative) => {
        for (const name of fs.readdirSync(directory)) {
          const child = path.join(directory, name);
          const rel = path.join(relative, name);
          if (fs.statSync(child).isDirectory()) walk(child, rel);
          else out.push(rel);
        }
      };
      walk(full, entry);
    } else {
      out.push(entry);
    }
  }
  return [...new Set(out)];
}

/**
 * 核对已安装的该插件是否与源码一致；不一致时列出不同的文件。
 *
 * file: 依赖的拷贝和包管理器缓存可能保留旧内容，因此必须逐字节核对
 * 实际安装文件，不能仅依据包版本或安装命令成功判断测试对象。
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
 * 优先执行 remove + add 验证安装路径；若缓存仍保留旧文件，则直接同步后
 * 再逐字节核对。所有安装、拷贝和比对均只针对固定 TEST_PROFILE（dshdoor）。
 * 其他配置集的只读比对由 inspectDoor 提供，不接受它们作为自动同步目标。
 *
 * @returns {{synced: boolean, drift: string[], copied: string[], skipped?: boolean}}
 */
function syncDoor({ log = () => {}, command } = {}) {
  command = resolveTestDshCommand({ command, log });
  let candidate;
  if (process.env.DSH_PANEL_TEST_DOOR_CANDIDATE) {
    const build = path.resolve(DOOR_SRC, '../..', 'build');
    const home = process.env.DSH_HOME && path.resolve(process.env.DSH_HOME);
    if (!home || !home.startsWith(build + path.sep)) throw new Error('候选回归需要 build/ 下的专用 DSH_HOME');
    fs.mkdirSync(home, { recursive: true });
    if (!fs.realpathSync(home).startsWith(fs.realpathSync(build) + path.sep)) throw new Error('候选测试目录不能通过链接指向日常配置');
    candidate = require('../../../../tools/bridge/packages.cjs').verifyCandidate(process.env.DSH_PANEL_TEST_DOOR_CANDIDATE, 'tgz');
  }
  ensureTestProfile({ command, log });
  if (process.env.DSH_PANEL_TEST_PROVIDER_PACKAGE) {
    require('../../../../tools/bridge/test-profile.cjs').prepareTestProvider({
      profile: TEST_PROFILE, packageName: process.env.DSH_PANEL_TEST_PROVIDER_PACKAGE, command, log,
    });
  }
  if (candidate) {
    // 候选验收必须实际安装该归档；安装失败或内容不同不允许用源码覆盖成“通过”。
    runDshSync({ command, args: ['plugin', '--profile', TEST_PROFILE, 'add', `file:${candidate.file.replace(/\\/g, '/')}`] });
    if (require('node:crypto').createHash('sha256').update(fs.readFileSync(candidate.file)).digest('hex') !== candidate.sha256) throw new Error('候选归档在安装期间发生变化');
    const drift = doorDrift();
    if (drift.length) throw new Error(`候选安装后内容不同：${drift.join('、')}`);
    return { synced: true, drift: [], copied: [], candidateSha256: candidate.sha256 };
  }
  const drift = doorDrift();
  if (drift.length === 0) {
    log('info', '该插件与源码一致，无需重新安装');
    return { synced: false, drift, copied: [] };
  }
  log('info', `该插件与源码不一致（${drift.join('、')}），重新安装一次`);
  try {
    runDshSync({ command, args: ['plugin', '--profile', TEST_PROFILE, 'remove', 'dsh-acp-door'] });
  } catch {
    // 未安装时仍可继续执行 add。
  }
  try {
    runDshSync({
      command,
      args: ['plugin', '--profile', TEST_PROFILE, 'add', `file:${DOOR_SRC.replace(/\\/g, '/')}`],
    });
  } catch (error) {
    // 安装失败后仍尝试直接同步；最终内容比对决定该测试配置是否准备成功。
    log('info', `pnpm 装不上（${String(error && error.message ? error.message : error).split('\n')[0].slice(0, 120)}），按文件直接同步`);
  }

  let left = doorDrift();
  if (left.length === 0) return { synced: true, drift, copied: [] };

  // 缓存保留旧内容时按文件同步，并重新核对。
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
 * @returns {Promise<{started: boolean, stop: () => Promise<void>}>}
 *   `started` 表示该内核由本次测试启动（测试结束时需要回收）；
 *   若内核本就在运行，`stop()` 为空操作 —— 不得终止其他进程启动的内核。
 */
async function ensureDoor({ host = HOST, port = PORT, profile = PROFILE, log = () => {}, extraArgs = [] } = {}) {
  if (await doorIsUp(host, port)) {
    log('info', `该插件已在 ${host}:${port} 上，直接使用`);
    const stopped = Promise.resolve();
    return { started: false, stop() { return stopped; } };
  }

  log('info', `该插件未监听，自行启动一个后台 DSH（profile=${profile}）`);
  const command = resolveTestDshCommand({ log });
  const kernel = spawnBackgroundDsh({
    command,
    profile,
    log,
    extraArgs: [...(profile === TEST_PROFILE ? testPatchArgs() : []), ...extraArgs],
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
    await kernel.dispose();
    throw new Error(
      `后台 DSH 未能在 ${host}:${port} 建立监听（profile=${profile}）` +
        (tail ? `：${tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}` : ''),
    );
  }
  return {
    started: true,
    stop() {
      return kernel.dispose();
    },
  };
}

function testPatchArgs() {
  const file = process.env.DSH_PANEL_TEST_PATCH;
  if (!file) return [];
  if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('测试覆盖文件需要有效的绝对路径。');
  return ['--patch', file];
}

/** Each model-facing test gets a fresh directory containing generated files only. */
function createTestWorkspace(label) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid test workspace label.');
  const base = process.env.DSH_PANEL_TEST_WORK ? path.resolve(process.env.DSH_PANEL_TEST_WORK) : path.resolve(__dirname, '../../build/fixtures');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, `${label}-`));
  fs.writeFileSync(path.join(directory, 'README.md'), 'Generated DSH integration test fixture.\n');
  return directory;
}

module.exports = {
  createTestWorkspace,
  testPatchArgs,
  ensureDoor,
  doorIsUp,
  syncDoor,
  doorDrift,
  inspectDoor,
  isMissingModelCredentials,
  desktopExecutablesForTest,
  HOST,
  PORT,
  PROFILE,
  TEST_PROFILE,
  ensureTestProfile,
  resolveTestDshCommand,
};
