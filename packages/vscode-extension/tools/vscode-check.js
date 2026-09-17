'use strict';

/**
 * 真编辑器里的自检：装上了吗、激活了吗、面板真的连上了吗。
 *
 * 为什么需要这个：其它测试都是用「假 vscode」跑的（快、能断言），但**没有一条
 * 能证明真 VS Code 会加载这个扩展**。这一步专门补那个洞。
 *
 * 怎么做到不打扰用户：
 * - 用**自己的** `--user-data-dir` 和 `--extensions-dir` 开一个隔离窗口 ——
 *   你的设置、你的扩展、你正开着的那个窗口，一概不碰；
 * - 靠扩展里的自检开关 `DSH_PANEL_AUTOFOCUS=1` 让它 1.5 秒后自己展开面板
 *   （无人值守时点不了活动栏图标）；
 * - 验完把它自己的进程树收掉，只收**启动之后新出现**的那些。
 *
 * 判据（缺一条都算失败，不会含糊过去）：
 * 1. 隔离窗口真的起来了（出现新的 Code.exe）；
 * 2. 扩展真的被激活了（扩展宿主日志里有 `_doActivateExtension local.dsh-panel`）；
 * 3. 面板真的挂进了活动栏（渲染进程日志里有 `Added views:dshPanel.chat`）；
 * 4. 面板真的展开了（扩展自己的日志里有「面板已打开」）；
 * 5. 真的连上了 DSH（扩展自己的日志里有「握手完成」和「已建会话」）——
 *    这是端到端最硬的一条：真 VS Code → 真扩展 → 真内核。
 * 6. 收摊之后不留窗口、不留孤儿内核；
 * 7. 你自己正开着的窗口从头到尾没被动过。
 *
 * 两个踩过的坑，写在这里免得下次再撞：
 * - 必须用 `--verbose` 启动：不开详细日志时，输出通道的内容不会落到磁盘上的
 *   `1-DSH Panel.log`，于是"扩展自己的日志"这条证据根本读不到；
 * - **不能拿 47821 有没有被监听当判据**：兜底拉起来的内核是按设计用 `--port 0`
 *   （系统随便给一个空闲端口），就是为了不去抢你桌面端那个门的端口。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 47821;
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const timeoutIndex = args.indexOf('--timeout');
const timeoutSec = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 75;

/**
 * 可执行文件和命令行分开记：
 *
 * 必须直接起 **Code.exe**，不能走 `bin\code.cmd`。踩过：code.cmd 会把命令行
 * 转发给你**正在跑的那个实例**，于是"隔离窗口"根本不会出现（也验不了任何东西），
 * 表现是一句含糊的"新 PID 无"。带上自己的 `--user-data-dir` 直接起 exe，
 * VS Code 才会当成另一个实例、开一个真正独立的窗口。
 */
const CODE_EXE_CANDIDATES = [
  'D:\\Microsoft VS Code\\Code.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
];
// 安装目录名跟着清单版本走（local.dsh-panel-<version>），提版本号时这里不用改。
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXT_DIR_NAME = `local.dsh-panel-${MANIFEST.version}`;
const INSTALLED = path.join(os.homedir(), '.vscode', 'extensions', EXT_DIR_NAME);

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

/** 跑一条命令，拿回 stdout（失败不抛）。 */
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    ...options,
  });
  return { out: `${result.stdout || ''}${result.stderr || ''}`, code: result.status };
}

/** 某个端口上有没有人在听（用来判断是"接入模式"还是"兜底拉起模式"）。 */
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
 * 所有进程的 PID、名字、父 PID、命令行。
 *
 * 收摊要靠它：只收「启动之后新出现的**我们自己的**」进程。
 * 宁可多花一秒枚举，也不能靠猜名字去 taskkill —— 那是会误伤别人进程的做法。
 *
 * 为什么还要看名字和父进程（这一夜踩到的）：**用户自己的 DSH Desktop 拉起的内核
 * 命令行里一样有 `--no-open`** —— 只按命令行匹配，就会把"用户正在用的内核"
 * 当成"我们拉的"，轻则误报，重则把它杀掉。所以下面还要排除
 * 「祖先是 DSH Desktop.exe」以及「我们自己的 shell/node」这两类。
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

/** 往上找几层，看这个进程是不是桌面端（用户自己的 DSH Desktop）的后代。 */
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
 * 这个新进程是不是「扩展/测试拉起来的 DSH」。
 *
 * 现场长这样（实测看来的，别再猜）：
 *   cmd.exe /d /s /c "dsh --profile desktop --no-open --host 127.0.0.1 --port 0"
 * 后面才是真正的内核 `DSH Desktop.exe`（它的命令行里反而没有 --profile/--no-open，
 * 所以认那个 cmd.exe 才是最可靠的信号 —— 一开始我按进程名排除 cmd.exe，结果
 * 自己拉起来的那个永远认不出来）。
 *
 * 排除两类，都是为了不误伤：
 * - 我们自己的 powershell/node（它们的命令行里**写着**过滤条件，会自我匹配）；
 * - 祖先是用户自己的 DSH Desktop 的进程。
 */
function isOurKernel(item, all) {
  const cmd = item.cmdline;
  if (!cmd) return false;
  if (/^(powershell|pwsh|node)\.exe$/i.test(item.name)) return false;
  if (!/--no-open/.test(cmd)) return false;
  if (!/--profile\s+\S+/.test(cmd)) return false;
  if (!/(^|[\s"'\\/])dsh(\.cmd)?["'\s]/.test(cmd)) return false;
  if (belongsToDesktopApp(item, all)) return false;
  return true;
}

/** 找出这次新拉起的内核。 */
function ourKernels(beforePids) {
  const all = allProcesses();
  return all.filter((item) => !beforePids.has(item.pid) && isOurKernel(item, all));
}

/** 在隔离目录里找某个日志文件（日志目录带时间戳，所以得递归找）。 */
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

/** 扩展自己的输出通道日志（文件名形如 `1-DSH Panel.log`）。 */
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
    console.log('  ⏭  找不到 VS Code 的 Code.exe（这台机器上没法做这一步）');
    process.exit(2);
  }
  if (!fs.existsSync(INSTALLED)) {
    console.log(`  ⏭  找不到已安装的扩展：${INSTALLED}（先装一次再跑）`);
    process.exit(2);
  }

  // 先看 47821 上有没有门在跑，决定这次是验哪条路：
  // - 有人在听 → 「接入模式」：面板该直接连上它，**不该**另起内核（这是主用例：
  //   一个进程、一个大脑、同一份记忆）；
  // - 没人在听 → 「兜底模式」：面板该自己拉一个 desktop 档内核起来。
  const attached = await portIsUp(PORT);
  console.log(`  47821 ${attached ? '上有门在跑 → 验「接入模式」' : '上没人 → 验「兜底拉起模式」'}`);

  const before = codePids();
  const beforePids = new Set(allProcesses().map((item) => item.pid));
  console.log(`  启动前：${before.size} 个 VS Code 进程、共 ${beforePids.size} 个进程（这些一个都不会碰）`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sandbox = path.join(os.tmpdir(), `dsh-vscode-e2e-${stamp}`);
  const userData = path.join(sandbox, 'user-data');
  const extensions = path.join(sandbox, 'extensions');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-ws-'));
  fs.mkdirSync(userData, { recursive: true });
  copyDir(INSTALLED, path.join(extensions, EXT_DIR_NAME));
  console.log(`  隔离目录：${sandbox}`);
  console.log(`  扩展目录里只放这一份：${fs.readdirSync(extensions).join(', ')}`);

  // 启动隔离窗口。DSH_PANEL_AUTOFOCUS=1 是扩展里的自检开关，只在这个进程里生效。
  // --verbose 是必须的：不然输出通道的内容不会写到磁盘上的日志文件里。
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

  // 等：新窗口出现 + 扩展自己的日志里出现「已建会话」（端到端成功的标志）。
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

  console.log('');
  check('隔离窗口真的起来了（出现新的 VS Code 进程）', newPids.length > 0, `新 PID ${newPids.join(', ') || '无'}`);

  const exthost = findLog(userData, 'exthost.log');
  const exthostText = exthost ? fs.readFileSync(exthost, 'utf8') : '';
  check('扩展真的被激活了（扩展宿主日志里有它）',
    /_doActivateExtension local\.dsh-panel/.test(exthostText),
    exthost ? '看过扩展宿主日志' : '没有扩展宿主日志');
  // 命令清单从清单文件里读，别在这里再抄一份 —— 抄一份就会漏掉后加的
  // （「打开面板」就是这么被漏掉的：这正是早上"找不到入口"的那个坑）。
  const declaredCommands = require('../package.json').contributes.commands.map((item) => item.command);
  check(`六个命令都注册上了（${declaredCommands.length} 个）`,
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

  // 拉起内核这件事：接入模式下必须**没有**新内核，兜底模式下必须有。
  const kernel = ourKernels(beforePids)[0];
  if (attached) {
    check('接入模式：连着正在跑的门，没有另起内核（一个进程、一个大脑）', !kernel,
      kernel ? `却拉起了 PID ${kernel.pid}` : '没有新内核');
  } else {
    // 找不到时把「所有像内核的进程」列出来，方便一眼看出是漏判还是真没起。
    const suspects = newProcesses(beforePids)
      .filter((item) => /--no-open/.test(item.cmdline))
      .map((item) => `${item.pid}(${item.name}: ${item.cmdline.slice(0, 70)})`);
    check('兜底模式：自己拉起了 DSH 内核（继承你的插件与记忆）', Boolean(kernel),
      kernel ? `PID ${kernel.pid}（${kernel.cmdline.slice(0, 80)}）`
        : `没找到；现场有 ${suspects.length} 个 --no-open 进程：${suspects.join(' / ') || '一个都没有'}`);
    if (kernel) fs.writeFileSync(path.join(sandbox, 'kernel-cmdline.txt'), kernel.cmdline, 'utf8');
  }

  // 收摊：只收这次新出现的进程，只收自己拉起来的内核。
  if (keep) {
    console.log(`\n  --keep：窗口留着，自己关。PID：${newPids.join(', ') || '（没起来）'}`);
  } else {
    for (const pid of newPids) run('taskkill', ['/PID', String(pid), '/T', '/F']);
    // 只收"我开的那一个隔离窗口"。**一个内核都不杀**：
    // 你自己的 DSH Desktop 也用它自己的内核，命令行长得跟扩展拉起来的很像，
    // 靠名字/参数去分辨、然后 taskkill，是有可能误伤你正在用的内核的 ——
    // 这种事一次都不该发生。扩展本来就会在自己 dispose 时收掉它拉的内核
    // （test/fallback.js 专门验过），所以这里只需要**报告**有没有剩。
    sleep(3000);
    const stillThere = [...codePids()].filter((pid) => !before.has(pid));
    check('收摊后没留下窗口', stillThere.length === 0, stillThere.join(', ') || '干净');
    const orphans = ourKernels(beforePids);
    check('收摊后没留下孤儿内核（扩展自己收的）', orphans.length === 0,
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
  console.error('自检自己炸了：', error);
  process.exit(1);
});
