'use strict';

/**
 * 真实编辑器中的自检：扩展是否已安装、是否已激活、面板是否已连接。
 *
 * 设置该脚本的原因：其它测试均使用仿真的 vscode 环境运行（执行快、可断言），
 * 但没有任何一项能够证明真实 VS Code 会加载该扩展。该脚本用于覆盖这一处缺口。
 *
 * 不干扰用户的操作方式：
 * - 使用独立的 `--user-data-dir` 与 `--extensions-dir` 启动隔离窗口，
 *   不接触用户设置、用户扩展以及用户已打开的窗口；
 * - 通过扩展中的自检开关 `DSH_PANEL_AUTOFOCUS=1` 使其在 1.5 秒后自动展开面板
 *   （无人值守时无法点击活动栏图标）；
 * - 验证结束后结束该次启动的进程树，且仅结束启动之后新出现的进程。
 *
 * 判据（缺少任意一条即判定失败，不做模糊处理）：
 * 1. 隔离窗口确实启动（出现新的 Code.exe）；
 * 2. 扩展确实被激活（扩展宿主日志中存在 `_doActivateExtension <publisher>.dsh-panel`）；
 * 3. 面板确实挂载到活动栏（渲染进程日志中存在 `Added views:dshPanel.chat`）；
 * 4. 面板确实展开（扩展自身的日志中存在「面板已打开」）；
 * 5. 确实连接到 DSH（扩展自身的日志中存在「握手完成」与「已建会话」）——
 *    这是端到端最强的一条证据：真 VS Code → 真扩展 → 真内核。
 * 6. 收尾之后不残留窗口、不残留孤儿内核；
 * 7. 用户当时已打开的窗口全程未被影响。
 *
 * 两个已发生的问题记录如下，以避免再次出现：
 * - 必须使用 `--verbose` 启动：未开启详细日志时，输出通道的内容不会写入磁盘上的
 *   `1-DSH Panel.log`，因此扩展自身的日志这条证据无法读取；
 * - 不得以「端口处于监听状态」作为面板已连接的判据：自启的内核按设计使用
 *   `--port 0`（由系统分配一个空闲端口），其目的正是不占用桌面端 ACP 接入点插件（`dsh-acp-door`）的端口。
 *
 * 需要验证「自启模式」（用户最常采用的路径：刚开机、未启动桌面端）而桌面端又已启动时，
 * 可使用 DSH_PANEL_CHECK_PORT / _PROFILE / _DSH 这三个环境变量将该次自检
 * 引导到一个空闲端口，说明见下方 PORT 一段。
 *
 * 默认从用户已安装的扩展目录复制一份到隔离窗口。发布前若要核验刚生成的 VSIX，
 * 可设置 DSH_PANEL_CHECK_EXTENSION_SOURCE 为另一个已解包的扩展目录；该目录只会
 * 被复制到隔离窗口，用户的扩展目录不会被写入或删除。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
/**
 * 验证哪一条连接路径：
 *
 * - 默认为 47821。桌面端已启动时该端口存在 ACP 接入点插件（`dsh-acp-door`），此时验证接入模式；否则验证自启模式。
 * - 需要在桌面端 ACP 接入点插件进程仍运行的情况下也验证「自启」时，改用其它空闲端口：
 *
 *     $env:DSH_PANEL_CHECK_PORT = '47830'
 *     $env:DSH_PANEL_CHECK_PROFILE = 'dshdoor'          # 测试档，请勿改动用户的 desktop
 *     $env:DSH_PANEL_CHECK_DSH = "node <bin.js> --patch <将 ACP 接入点插件绑定到 47830 的 patch>"
 *
 *   这几个环境变量会写入隔离窗口自身的 settings.json（隔离的 user-data-dir
 *   中的那一份），因此只影响该次自检，不涉及用户设置。
 *
 *   端口的对齐方式（2026-09-19 发生变化，此前必须依赖 `--patch`）：
 *   当前面板在启动内核时会将其需要连接的端口写入环境变量 `DSH_ACP_DOOR_PORT`，
 *   该插件优先读取该变量（见 dsh-door/lib/port.js），因此自检无需再自行构造 patch：
 *   设置 DSH_PANEL_CHECK_PORT 之后，面板与该插件均使用该端口。
 *   档中的该插件若为旧版本（不识别该变量），面板会同时监听两个端口，仍可连接，
 *   这条兼容路径在此处也被真实执行一次。
 *
 *   还有一种组合需要两个端口不同：所连接的那台无法切换权限时，面板会改用自身
 *   启动的那台（2026-09-20 用户报告「切不了权限」的修复方式）。验证该路径使用
 *
 *     $env:DSH_PANEL_CHECK_PORT = '47821'       # 存在现成的 ACP 接入点插件（桌面端那个旧组件）
 *     $env:DSH_PANEL_CHECK_SELF_PORT = '47832'  # 空闲端口，供自启的实例使用
 *
 *   两个端口相同时，「换内核」会切换到同一端口上的实例（等同于未切换）；这属于设置的边界，
 *   不属于该路径的缺陷。
 */
const PORT = Number(process.env.DSH_PANEL_CHECK_PORT || 47821);
/** 自启内核使用的端口（默认与 PORT 一致；见写设置那一段的注释）。 */
const SELF_PORT = Number(process.env.DSH_PANEL_CHECK_SELF_PORT || PORT);
const CHECK_PROFILE = process.env.DSH_PANEL_CHECK_PROFILE || '';
const CHECK_DSH = process.env.DSH_PANEL_CHECK_DSH || '';
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const timeoutIndex = args.indexOf('--timeout');
const timeoutSec = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 75;

/**
 * 可执行文件与命令行分开记录：
 *
 * 必须直接启动 **Code.exe**，不得经由 `bin\code.cmd`。已发生的问题：code.cmd 会把命令行
 * 转发给正在运行的实例，导致隔离窗口不会出现（也无法验证任何内容），
 * 表现为含义不明的「新 PID 无」。携带自身的 `--user-data-dir` 直接启动 exe 时，
 * VS Code 才会将其视为另一个实例并打开一个真正独立的窗口。
 */
const CODE_EXE_CANDIDATES = [
  'D:\\Microsoft VS Code\\Code.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
];
/*
 * 安装目录名 = `<publisher>.<name>-<version>`（VS Code 采用该命名方式）。
 * 不得固定写为 `local.`：0.1.3 起 publisher 更换为市场使用的那个 ID，
 * 固定写入的结果是扩展已安装而自检报告找不到。
 * 大小写同样不做假设：市场规定 publisher 只能为小写，若被手工修改，则按实际存在的目录查找。
 */
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXTENSIONS_DIR = path.join(os.homedir(), '.vscode', 'extensions');
const EXT_ID = `${MANIFEST.publisher}.${MANIFEST.name}`;
const EXT_DIR_NAME = `${EXT_ID}-${MANIFEST.version}`;
const INSTALLED = (() => {
  const exact = path.join(EXTENSIONS_DIR, EXT_DIR_NAME);
  if (fs.existsSync(exact)) return exact;
  const found = fs.existsSync(EXTENSIONS_DIR)
    ? fs.readdirSync(EXTENSIONS_DIR).find((name) => name.toLowerCase() === EXT_DIR_NAME.toLowerCase())
    : undefined;
  return found ? path.join(EXTENSIONS_DIR, found) : exact;
})();
const EXTENSION_SOURCE = process.env.DSH_PANEL_CHECK_EXTENSION_SOURCE || INSTALLED;

let CODE_EXE = CODE_EXE_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}${detail ? `  （${detail}）` : ''}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

/** 执行一条命令并返回 stdout（失败时不抛出异常）。 */
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    ...options,
  });
  return { out: `${result.stdout || ''}${result.stderr || ''}`, code: result.status };
}

/** 某个端口是否处于监听状态（用于判断是接入模式还是后备拉起模式）。 */
function portIsUp(port) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 当前所有 Code.exe 的 PID。 */
function codePids() {
  const { out } = run('tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/FO', 'CSV', '/NH']);
  const pids = new Set();
  for (const line of out.split('\n')) {
    const match = /^"Code\.exe","(\d+)"/.exec(line.trim());
    if (match) pids.add(Number(match[1]));
  }
  return pids;
}

/**
 * 所有进程的 PID、名称、父 PID、命令行。
 *
 * 收尾依赖该数据：仅结束「启动之后新出现的、由本脚本启动的」进程。
 * 即使枚举需要多耗一秒，也不得按名称推测并调用 taskkill，该做法会误终止其它进程。
 *
 * 还需要读取名称与父进程的原因（当夜出现的问题）：用户自身的 DSH Desktop 启动的内核
 * 命令行中同样包含 `--no-open`；若仅按命令行匹配，会把「用户正在使用的内核」
 * 判定为「本脚本启动的」，轻则误报，重则将其终止。因此下方还需要排除
 * 「祖先是 DSH Desktop.exe」以及「本脚本自身的 shell/node」这两类。
 */
function allProcesses() {
  const { out } = run('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }',
  ]);
  const list = [];
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const pid = Number(parts[0].trim());
    if (!Number.isFinite(pid) || pid <= 0) continue;
    list.push({
      pid,
      ppid: Number(parts[1].trim()),
      name: parts[2].trim(),
      cmdline: parts.slice(3).join('\t').trim(),
    });
  }
  return list;
}

/** 启动之后新出现的进程。 */
function newProcesses(beforePids) {
  return allProcesses().filter((item) => !beforePids.has(item.pid));
}

/** 向上逐层查找，判断该进程是否为桌面端（用户自身的 DSH Desktop）的后代。 */
function belongsToDesktopApp(item, all) {
  const byPid = new Map(all.map((entry) => [entry.pid, entry]));
  let current = item;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current) return false;
    if (/^DSH Desktop\.exe$/i.test(current.name)) return true;
    current = byPid.get(current.ppid);
  }
  return false;
}

/**
 * 判断该新进程是否为「扩展或测试启动的 DSH」。
 *
 * 实际命令行如下（来源于实测结果，无需推测）：
 *   cmd.exe /d /s /c "dsh --profile desktop --no-open --host 127.0.0.1 --port 0"
 * 其后才是真正的内核 `DSH Desktop.exe`（其命令行中没有 --profile/--no-open，
 * 因此识别该 cmd.exe 是最可靠的信号；最初按进程名排除 cmd.exe 时，
 * 自行启动的进程始终无法被识别）。
 *
 * 排除以下两类，目的均为避免误终止：
 * - 本脚本自身的 powershell/node（其命令行中写有过滤条件，会匹配到自身）；
 * - 祖先是用户自身 DSH Desktop 的进程。
 */
function isOurKernel(item, all) {
  const cmd = item.cmdline;
  if (!cmd) return false;
  if (/^(powershell|pwsh|node)\.exe$/i.test(item.name)) return false;
  if (!/--no-open/.test(cmd)) return false;
  if (!/--profile\s+\S+/.test(cmd)) return false;
  /*
   * 「命令行中运行 dsh」存在两种写法，均需识别：
   *   ① 直接命令         dsh --profile desktop --no-open …
   *   ② node 启动该脚本  node C:\…\@deepseek-ai\dsh\lib\bin.js --profile desktop …
   * ② 是本机常态（`dsh` 不在 PATH 上时 `dshPanel.dshCommand` 需要按此填写，见交接文档第八节
   * 第 13 条）；2026-09-19 第一次使用 ② 运行自启模式时，该匹配仅识别 ①，
   * 结果是内核已启动、握手已完成，此处却报告「没找到内核」（假阴性）。
   * 匹配的是 cmd.exe 这一层外壳：真正的内核进程名为 node.exe，已被上一条按名称排除，
   * 而其外壳（cmd /d /s /c "…"）才是稳定信号，说明见下面这一段。
   */
  const runsDsh =
    /(^|[\s"'\\/])dsh(\.cmd)?["'\s]/.test(cmd) || /[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(cmd);
  if (!runsDsh) return false;
  if (belongsToDesktopApp(item, all)) return false;
  return true;
}

/** 找出本次新启动的内核。 */
function ourKernels(beforePids) {
  const all = allProcesses();
  return all.filter((item) => !beforePids.has(item.pid) && isOurKernel(item, all));
}

/** 在隔离目录中查找某个日志文件（日志目录带时间戳，因此需要递归查找）。 */
function findLog(userData, name) {
  const root = path.join(userData, 'logs');
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

/** 扩展自身的输出通道日志（文件名形如 `1-DSH Panel.log`）。 */
function findPanelLog(userData) {
  const root = path.join(userData, 'logs');
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/DSH Panel\.log$/.test(entry.name)) return full;
    }
  }
  return null;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { windowsHide: true });
}

async function main() {
  console.log('DSH Panel · 真 VS Code 里自检');
  console.log(`  （隔离目录，不碰你正开着的窗口；等最多 ${timeoutSec} 秒）\n`);

  if (!CODE_EXE) {
    console.log('  ⏭  找不到 VS Code 的 Code.exe（该机器上无法执行此步骤）');
    process.exit(2);
  }
  if (!fs.existsSync(EXTENSION_SOURCE)) {
    console.log(`  ⏭  找不到用于隔离自检的扩展：${EXTENSION_SOURCE}`);
    console.log('     默认读取用户已安装的版本；也可设置 DSH_PANEL_CHECK_EXTENSION_SOURCE。');
    process.exit(2);
  }
  let sourceManifest;
  try {
    sourceManifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_SOURCE, 'package.json'), 'utf8'));
  } catch (error) {
    console.log(`  ⏭  无法读取隔离扩展的 package.json：${error.message}`);
    process.exit(2);
  }
  const sameIdentity = ['publisher', 'name', 'version'].every((key) => sourceManifest[key] === MANIFEST[key]);
  if (!sameIdentity) {
    console.log('  ⏭  隔离扩展的身份与当前源码不一致，不使用它进行自检。');
    console.log(`     来源：${sourceManifest.publisher}.${sourceManifest.name}@${sourceManifest.version}`);
    console.log(`     当前：${MANIFEST.publisher}.${MANIFEST.name}@${MANIFEST.version}`);
    process.exit(2);
  }

  // 先检查该端口上是否存在运行中的 ACP 接入点插件（`dsh-acp-door`），据此确定本次验证的路径：
  // - 存在监听 → 「接入模式」：面板应当直接连接该实例，不应另起内核（这是主要用例：
  //   一个进程、一个内核、同一份记忆）；
  // - 不存在监听 → 「自启模式」：面板应当自行启动一个内核（用户明确要求：
  //   使用该插件时无需预先启动桌面端）。
  const attached = await portIsUp(PORT);
  console.log(
    `  ${PORT} ${attached ? '上有该插件在运行 → 验「接入模式」' : '上没有进程 → 验「自启模式」'}`,
  );

  const before = codePids();
  const beforePids = new Set(allProcesses().map((item) => item.pid));
  console.log(`  启动前：${before.size} 个 VS Code 进程、共 ${beforePids.size} 个进程（这些一个都不会碰）`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sandbox = path.join(os.tmpdir(), `dsh-vscode-e2e-${stamp}`);
  const userData = path.join(sandbox, 'user-data');
  const extensions = path.join(sandbox, 'extensions');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-ws-'));
  fs.mkdirSync(userData, { recursive: true });
  copyDir(EXTENSION_SOURCE, path.join(extensions, EXT_DIR_NAME));
  console.log(`  隔离目录：${sandbox}`);
  console.log(`  扩展来源：${EXTENSION_SOURCE}`);
  console.log(`  扩展目录里只放这一份：${fs.readdirSync(extensions).join(', ')}`);

  // 仅在设置了覆盖项时才写入设置；写入的是隔离窗口自身的 user settings，
  // 用户设置不会被修改。
  if (CHECK_PROFILE || CHECK_DSH || PORT !== 47821 || SELF_PORT !== PORT) {
    const settings = { 'dshPanel.port': PORT };
    /*
     * 自启的内核将 ACP 接入点插件绑定在「面板自身的端口」上；自检中默认使其与 PORT 一致，
     * 因此「接入」与「自启」两条路径都落在同一个端口上，端口空闲时即采用自启。
     *
     * 但有一条路径需要两者不同：`DSH_PANEL_CHECK_PORT=47821`（桌面端那个
     * 旧连接组件所在的端口）加另一个空闲的自启端口；该路径即「已接入，但该实例无法切换
     * 权限，因此改用自身启动的实例」（2026-09-20 用户报告的情况）。
     * 使用 DSH_PANEL_CHECK_SELF_PORT 指定该端口。
     */
    settings['dshPanel.selfStartPort'] = SELF_PORT;
    if (CHECK_PROFILE) settings['dshPanel.fallbackProfile'] = CHECK_PROFILE;
    if (CHECK_DSH) settings['dshPanel.dshCommand'] = CHECK_DSH;
    const settingsDir = path.join(userData, 'User');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
    console.log(`  这次用隔离设置：${JSON.stringify(settings)}`);
  }

  // 启动隔离窗口。DSH_PANEL_AUTOFOCUS=1 是扩展中的自检开关，仅在该进程中生效。
  // --verbose 为必需项：否则输出通道的内容不会写入磁盘上的日志文件。
  const child = spawn(
    CODE_EXE,
    [
      '--user-data-dir',
      userData,
      '--extensions-dir',
      extensions,
      '--verbose',
      '--new-window',
      workspace,
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, DSH_PANEL_AUTOFOCUS: '1' },
    },
  );
  child.unref();

  // 等待：新窗口出现，且扩展自身的日志中出现「已建会话」（端到端成功的标志）。
  const started = Date.now();
  let newPids = [];
  let panelLog = null;
  let panelText = '';
  while ((Date.now() - started) / 1000 < timeoutSec) {
    sleep(2000);
    newPids = [...codePids()].filter((pid) => !before.has(pid));
    panelLog = findPanelLog(userData);
    panelText = panelLog ? fs.readFileSync(panelLog, 'utf8') : '';
    if (/已建会话/.test(panelText)) break;
  }
  const waited = ((Date.now() - started) / 1000).toFixed(0);

  // 权限那一路是在会话建立之后紧接着读取的（同一毫秒级），而上面那个循环
  // 一看到「已建会话」即跳出，并当场把日志读取为字符串；相差几毫秒就会读到
  // 尚不包含该行的旧快照，导致断言误报（已实际发生：13 项中该项失败，
  // 而日志文件中实际存在该行）。因此此处再等待一小段时间，以等待该行出现；
  // 两者均未出现才属于确实没有结果（该情况正是需要报告的情况）。
  /*
   * 权限那一路：等待出现结论之后再判断。
   *
   * 以下三种结论均视为有结果：读取到清单 / 更换内核之后读取到（同样为「当前权限：」）/
   * 明确说明无法切换（「权限预设读取失败（…）」且日志不再变化）。
   *
   * 不能「一看到「权限预设读取失败」就跳出」的原因：所连接的实例无法切换权限时，面板
   * 会启动自身的内核（耗时十几秒），日志中先出现的是切换之前的那一条；
   * 若一看到该条即跳出，会把「正在切换」判定为「无法切换」（2026-09-20 已实际发生：
   * 断言失败，而日志随后几行即记录「改用面板自己启动的」与「当前权限：」）。
   */
  const accessStart = Date.now();
  let lastLen = -1;
  let stableSince = Date.now();
  while (Date.now() - accessStart < 90000) {
    const file = findPanelLog(userData);
    if (file) panelText = fs.readFileSync(file, 'utf8');
    if (/当前权限：/.test(panelText)) break;
    if (panelText.length !== lastLen) {
      lastLen = panelText.length;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 5000 && /权限预设读取失败（/.test(panelText)) {
      break;
    }
    sleep(700);
  }

  console.log('');
  check('隔离窗口真的起来了（出现新的 VS Code 进程）', newPids.length > 0, `新 PID ${newPids.join(', ') || '无'}`);

  const exthost = findLog(userData, 'exthost.log');
  const exthostText = exthost ? fs.readFileSync(exthost, 'utf8') : '';
  check('扩展真的被激活了（扩展宿主日志里有它）',
    new RegExp(`_doActivateExtension ${EXT_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(exthostText),
    exthost ? `找的是 _doActivateExtension ${EXT_ID}` : '没有扩展宿主日志');
  // 命令清单从清单文件中读取，不得在此处重复复制；重复复制会遗漏后续新增项
  // （「打开面板」即因此被遗漏：这正是当日早晨「找不到入口」问题的成因）。
  const declaredCommands = require('../package.json').contributes.commands.map((item) => item.command);
  check(`清单里的命令都注册上了（${declaredCommands.length} 个）`,
    declaredCommands.every((name) => exthostText.includes(name)),
    declaredCommands.filter((name) => !exthostText.includes(name)).join(', '));

  const renderer = findLog(userData, 'views.log');
  const rendererText = renderer ? fs.readFileSync(renderer, 'utf8') : '';
  check('面板挂进了活动栏（视图注册成功）',
    /Added views:dshPanel\.chat/.test(rendererText),
    renderer ? '看过视图日志' : '没有视图日志');

  if (panelLog) fs.writeFileSync(path.join(sandbox, 'panel.log'), panelText, 'utf8');
  check('面板真的展开了（自检开关生效）', /面板已打开/.test(panelText), '');
  check('真的连上了 DSH（ACP 握手完成）', /握手完成/.test(panelText), '');
  check('真的建出了会话（端到端成功）', /已建会话/.test(panelText),
    panelText ? `等了 ${waited} 秒` : `等了 ${waited} 秒还没读到扩展日志`);

  // 权限选择器：界面部分已在 tools/uitest.js 中用真实浏览器点击验证，此处需要证明
  // 真实窗口中的那份清单同样是从内核读取的（扩展 → DSH → 内核 permissionPresets）。
  // 所连接的实例不支持权限方法时，正确结果为改用面板自身启动的实例
  // （2026-09-20 用户报告「修改之后无法切换权限」的修复方式）；确实无法切换时才采用
  // 「换不了权限」那句解释。三种结果均视为通过，但不允许三者均未出现。
  const accessRead = /当前权限：/.test(panelText);
  const accessUnavailable = /权限预设读取失败（/.test(panelText);
  const switched = /改用面板自己启动的/.test(panelText);
  check('权限那一路有结果（读到清单，或者换了内核，或者明确说清为什么换不了）',
    accessRead || switched || accessUnavailable,
    accessRead ? '读到了清单' : switched ? '换了内核' : accessUnavailable ? '走了「换不了」那条解释' : '三样都没有');
  if (switched) {
    // 更换内核这条路径的完整证据链：先说明原因（old-door），再更换，最后读取到清单。
    const at = panelText.indexOf('改用面板自己启动的');
    const whyBefore = /权限预设读取失败（old-door）/.test(panelText.slice(0, at));
    const readAfter = /当前权限：/.test(panelText.slice(at));
    check('换内核之前说清了原因，换完之后真的读到了权限清单',
      whyBefore && readAfter,
      `换之前有原因=${whyBefore}，换之后读到清单=${readAfter}`);
  }
  if (accessRead) {
    const line = panelText.split('\n').filter((item) => item.includes('当前权限：')).pop() || '';
    check('读到的那一档是个认识的名字（不是 undefined / 空白）',
      /当前权限：.+（[\w-]+）/.test(line), line.trim().slice(0, 90));
  }
  /*
   * 「界面文案中不得出现内部词（ACP 接入点插件 / 包名 / 版本号）」这一条不在此处验证：
   * 输出面板中的日志本身应当包含这些词（该日志用于排障）。该约束作用在
   * 实际发送的消息上：test/panel.js §8.9 扫描了整套流程中发送过的每条提示、
   * 报错标题与建议、顶栏状态，tools/uitest.js 再在真实浏览器中检查渲染结果。
   */

  // 内核启动的情况：接入模式下（且不需要更换内核时）必须没有新内核，自启模式下必须有新内核。
  // 「已接入但更换内核」属于第三种情况：所连接的实例无法切换权限（桌面端那个内核即如此），
  // 面板会改用自身启动的实例；此时必须有新内核，否则权限仍然无法切换。
  const kernel = ourKernels(beforePids)[0];
  const suspects = () =>
    newProcesses(beforePids)
      .filter((item) => /--no-open/.test(item.cmdline))
      .map((item) => `${item.pid}(${item.name}: ${item.cmdline.slice(0, 70)})`);
  if (attached && switched) {
    check('接入但换内核模式：接的那台换不了权限，于是自己起了一台（权限才切得动）',
      Boolean(kernel),
      kernel ? `PID ${kernel.pid}（${kernel.cmdline.slice(0, 80)}）`
        : `没找到；现场有 ${suspects().length} 个 --no-open 进程：${suspects().join(' / ') || '一个都没有'}`);
  } else if (attached) {
    check('接入模式：连接正在运行的该插件，没有另起内核（一个进程、一个大脑）', !kernel,
      kernel ? `却拉起了 PID ${kernel.pid}` : '没有新内核');
  } else {
    // 未找到时列出所有与内核特征相符的进程，便于直接判断属于漏判还是确实未启动。
    check('自启模式：自行启动了 DSH 内核（无需先开桌面端）', Boolean(kernel),
      kernel ? `PID ${kernel.pid}（${kernel.cmdline.slice(0, 80)}）`
        : `没找到；现场有 ${suspects().length} 个 --no-open 进程：${suspects().join(' / ') || '一个都没有'}`);
  }
  if (kernel) fs.writeFileSync(path.join(sandbox, 'kernel-cmdline.txt'), kernel.cmdline, 'utf8');

  /*
   * 等待一段时间后再次检查（DSH_PANEL_CHECK_LINGER=90）。
   *
   * 设置该步骤的原因：2026-09-19 用户报告「聊两句就 read ECONNRESET」，
   * 查日志发现每个内核都在启动约 35 秒后以 code=1 退出；
   * 而该自检此前只观察到「会话已建立」（约 15 秒）即收尾，
   * 因此「内核可以启动但存活时间过短」这类问题在该自检中不可见。
   * 一次全部通过的验证并不等于接下来一分钟内不会出现异常。
   */
  const linger = Number(process.env.DSH_PANEL_CHECK_LINGER || 0);
  if (linger > 0) {
    console.log(`\n  按要求持续观察 ${linger} 秒（观察内核是否自行退出）…`);
    let diedAt = 0;
    let lastText = panelText;
    for (let waited = 0; waited < linger; waited += 3) {
      sleep(3000);
      if (kernel && !allProcesses().some((item) => item.pid === kernel.pid)) {
        diedAt = waited + 3;
        break;
      }
      lastText = panelLog ? fs.readFileSync(panelLog, 'utf8') : lastText;
    }
    check(`持续观察 ${linger} 秒，内核始终在运行（没有"启动 30 秒即自行退出"这种缺陷）`,
      diedAt === 0,
      diedAt ? `PID ${kernel ? kernel.pid : '?'} 在约 ${diedAt} 秒时已退出` : '始终在运行');
    const resetLines = lastText.split('\n').filter((line) => /连接结束|ECONNRESET|后台 DSH 退出了/.test(line));
    check(`盯着的这段时间连接没断过（${linger} 秒）`, resetLines.length === 0,
      resetLines.length ? `面板日志里有 ${resetLines.length} 处断连：\n        ${resetLines.join('\n        ')}` : '一次都没断');
  }

  // 收尾：仅结束本次新出现的进程，仅结束自身启动的内核。
  if (keep) {
    console.log(`\n  --keep：窗口留着，自己关。PID：${newPids.join(', ') || '（没起来）'}`);
  } else {
    for (const pid of newPids) run('taskkill', ['/PID', String(pid), '/T', '/F']);
    // 仅结束本次自检启动的那一个隔离窗口。任何内核均不结束：
    // 用户自身的 DSH Desktop 也使用其自身的内核，命令行与扩展启动的内核高度相似，
    // 若按名称或参数区分后调用 taskkill，存在误终止用户正在使用的内核的可能；
    // 此类情况不应发生。扩展在自身 dispose 时即会结束其启动的内核
    // （test/fallback.js 已覆盖验证），因此此处只需要报告是否存在残留。
    sleep(3000);
    const stillThere = [...codePids()].filter((pid) => !before.has(pid));
    check('退出后没有留下窗口', stillThere.length === 0, stillThere.join(', ') || '干净');
    const orphans = ourKernels(beforePids);
    check('退出后没有留下孤儿内核（扩展自行回收）', orphans.length === 0,
      orphans.length
        ? `${orphans.map((item) => item.pid).join(', ')} 还在（扩展应该自己收掉；这里不替你杀，免得误伤你自己的内核）`
        : '干净');
    const mine = [...codePids()].filter((pid) => before.has(pid));
    check('你自己那个窗口一直没被动过', mine.length === before.size,
      `你的 PID：${mine.join(', ') || '（原本就没有）'}`);
  }

  console.log(`\n  隔离目录留在这里，里面有扩展自己的日志：${sandbox}`);

  console.log('\n════════════════════════════════════════════════════════');
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项检查`);
  } else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const name of failures) console.log(`   - ${name}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('自检自身发生异常：', error);
  process.exit(1);
});
