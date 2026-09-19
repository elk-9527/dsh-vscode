'use strict';

/**
 * 找到「门」，找不到就在后台拉起一个 DSH。
 *
 * 这是用户批准的兜底路径：桌面端在跑就连它（同一个内核）；没在跑就起一个
 * 后台 DSH —— 它和桌面端**共用同一份 `$DSH_HOME`**，所以记忆、会话记录、
 * 配置文件都是同一份，不是另立门户。
 *
 * 为什么端口是固定的 47821：门插件在自己的 cordis.patch.yml 里写死了端口。
 * 两个内核不可能同时占它，所以「连不上 = 桌面端没在跑」，判断很干净。
 */

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
// `$DSH_HOME` 的判定只有一处（sessions.js），这里借它省得两条规则漂移。
const { resolveSessionsRoot } = require('../dsh/sessions');

/** `$DSH_HOME`（环境变量优先，否则 `~/.dsh`）。 */
function dshHome(homedir, env = process.env) {
  return path.dirname(resolveSessionsRoot({ homedir, env }));
}

/** 探测一个端口是否能连上（不握手，只探 TCP）。 */
function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 等端口起来，直到超时。 */
async function waitForPort(host, port, { totalMs = 90000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probePort(host, port, Math.min(intervalMs * 2, 1000))) return true;
    await delay(intervalMs);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 兜底拉起要依次尝试的命令清单。
 *
 * ── 为什么不止试一个 ──────────────────────────────────────────────
 * 设置里 `dshCommand` 的默认值是裸的 `dsh`，而本机 `dsh` 多半不在 VS Code
 * 进程看得见的 PATH 上（实测：用户面板里报「后台 DSH 刚启动就退出了
 * （命令：「dsh」）」）。只试一个，失败就死 —— 于是用户被迫「先开桌面端
 * 才能用面板」，这不该是必要条件。
 *
 * 所以这里给出一串候选：
 *   1. 设置里填的命令（用户明确指定的，永远最优先）；
 *   2. `<主目录>/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`
 *      用 `node` 跑 —— 这是 DSH 自装目录里的入口（存在才加进去），
 *      实测就是测试配方里验证过的那条启动命令。
 *
 * 纯函数：给测试直接喂参数，不碰文件系统以外的任何东西。
 *
 * @param {object} options
 * @param {string} options.dshCommand 设置里的 dshPanel.dshCommand。
 * @param {string} options.homedir 用户主目录。
 * @returns {string[]} 去重后的候选清单（可能为空）。
 */
function dshCommandCandidates({ dshCommand, homedir }) {
  const list = [];
  const configured = String(dshCommand || '').trim();
  if (configured) list.push(configured);
  const bin = path.join(
    String(homedir || ''),
    '.dsh',
    'profiles',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  if (bin && fs.existsSync(bin)) list.push(`node ${bin}`);
  return [...new Set(list)];
}

/**
 * 在后台拉起一个 DSH。
 *
 * 用 `--no-open`（别弹浏览器）和 `--port 0`（网页界面端口让系统随便挑，
 * 反正我们走的是门，不用它的网页界面）。stdio 全部丢掉：这是后台进程，
 * 它的输出对用户没有意义，也不该污染扩展的输出通道。
 *
 * @param {object} options
 * @param {string} options.command dsh 程序名或完整路径。
 * @param {string} options.profile profile 名（里面要装好门插件）。
 * @param {(level: string, message: string) => void} options.log
 * @returns {{child: import('node:child_process').ChildProcess, dispose: () => void}}
 */
/** profile 名只允许这些字符 —— 它会进命令行，不能有注入的空间。 */
const SAFE_PROFILE = /^[A-Za-z0-9._-]+$/;

/**
 * 按 **cmd.exe 的引号规则**给一段加引号（只在需要时加）。
 *
 * 为什么内部**不**做反斜杠转义：cmd.exe 不认 `\"`。以前这里写的是
 * `text.replace(/"/g, '\\"')`，然后整条命令行又被 Node 的 argv 规则转义了一遍
 * （Node 会把内嵌的 `"` 变成 `\"`），cmd 看到的是 `\"C:\Program Files\…` ——
 * 它把 `\` 当普通字符、引号配错，于是报「不是内部或外部命令」。
 * 现在有两道保证：① 这里只按 cmd 的规矩包引号；② 调用 spawn 时带
 * `windowsVerbatimArguments: true`，让 Node **原样**传，不再动手。
 * 实测（`node build/repro-locate.cjs`）：修之前带空格的路径「裸写」「加引号」
 * 两种都起不来，修之后两种都能起来。
 */
function quoteArg(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return '""';
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 去掉整串外层成对的引号（用户可能写成 `"C:\…\dsh.cmd"`）。 */
function stripOuterQuotes(text) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s.length >= 2) {
    const first = s[0];
    if ((first === '"' || first === "'") && s[s.length - 1] === first) return s.slice(1, -1);
  }
  return s;
}

/** 这个路径上真的有东西吗（不存在、或路径里有非法字符都算「没有」）。 */
function existsAsFile(candidate) {
  try {
    return Boolean(candidate) && fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * 把被空格劈开的片段**重新粘回**成「真的存在的那一段」。
 *
 * 为什么需要：`splitCommand` 只会按空白硬拆，面对
 * `C:\…\DSH Desktop\…\dsh.cmd --profile desktop` 这种「路径里有空格」的写法，
 * 它会把程序名劈成两半。但光靠「整串是不是文件」不够 —— 用户也可能在带空格的
 * 路径后面再写参数（本机真实场景：dsh 就装在 `…\DSH Desktop\…` 下面）。
 * 所以这里做一遍贪心回接，**只在拼出来的东西真的存在于磁盘上时才粘**：
 *
 *   `node C:\x y\bin.js`   → ['node', 'C:\x y\bin.js']   （脚本路径粘回去）
 *   `C:\x y\dsh.cmd --v`   → ['C:\x y\dsh.cmd', '--v']   （程序名粘回去）
 *   `dsh --profile a b`    → 原样（没有任何前缀真的存在，绝不乱粘）
 *
 * 只会**少拆**、不会**多粘**：粘的依据是磁盘上真有那个文件，不是猜。
 *
 * @param {string[]} parts
 * @returns {string[]}
 */
function rejoinExisting(parts) {
  const out = [];
  const has = (text) => Boolean(text) && existsAsFile(text);
  let i = 0;
  while (i < parts.length) {
    let joined = parts[i];
    let j = i;
    // 当前这段不是文件时，往后吞词，直到拼出一个真的存在的路径。
    while (!has(joined) && j + 1 < parts.length) {
      j += 1;
      joined += ` ${parts[j]}`;
    }
    if (has(joined)) {
      out.push(joined);
      i = j + 1;
    } else {
      out.push(parts[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * 把设置里的命令解析成「程序 + 它自带的参数」。
 *
 * 规则（按优先级）：
 *   1. **整串本身就是一个存在的文件** → 它就是程序，一个参数都不带
 *      （Windows 上 dsh 的真实路径里就带空格：`…\DSH Desktop\…\dsh.cmd`）；
 *   2. 整串是 `"…"` 这样整体加引号的 → 剥掉引号再看第 1 条；
 *   3. 否则按空白拆，再把「拆坏了的、磁盘上真实存在的那一段」粘回去
 *      （见 {@link rejoinExisting}）。
 *
 * 为什么不能只按空白拆：`dshPanel.dshCommand` 的说明和面板自己的报错文案
 * 都让用户「把完整路径填进设置」，用户照做填的是**裸路径**；只按空白拆会把
 * 它劈成两段 —— 实测 cmd 的原话是
 * `'C:\Users\…\Roaming\DSH' is not recognized as an internal or external command`
 * （面板会把它翻成中文人话再给用户看，见 `src/dsh/errors.js`）。
 * 用户不该为了填个路径还要先学引号规则。
 *
 * @param {string} command
 * @returns {string[]} 程序 + 自带参数；空数组表示命令是空的。
 */
function resolveCommand(command) {
  const text = String(command === undefined || command === null ? '' : command).trim();
  if (!text) return [];
  const bare = stripOuterQuotes(text);
  if (existsAsFile(bare)) return [bare];
  const parts = splitCommand(text);
  if (parts.length <= 1) return parts;
  return rejoinExisting(parts);
}

/**
 * 把设置里的 `dshCommand` 拆成「程序 + 它自带的参数」。
 *
 * 为什么要拆：`dshCommand` 允许写成**带参数的完整命令**，最典型的是
 * `node D:\...\@deepseek-ai\dsh\lib\bin.js` —— 本机 `dsh` 不在 PATH 上时
 * 就得这么写。而把整串当成一个程序名加引号丢给 cmd.exe，cmd 会去找一个
 * 名字里带空格的程序，直接以退出码 1 失败（实测：
 * `"...\node.exe ...\bin.js" --version` 报「不是内部或外部命令」）。
 * 所以先按空白拆开，再逐段加引号。
 *
 * 支持用双引号或单引号把带空格的整段括起来（例如
 * `"C:\Program Files\DSH\dsh.cmd"`）。
 */
function splitCommand(command) {
  const text = String(command === undefined || command === null ? '' : command).trim();
  if (!text) return [];
  const parts = [];
  let current = '';
  let quote = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * 把「程序 + 它自带的参数 + 本次要传的参数」拼成一整条命令行，每段各自加引号。
 *
 * @throws {Error} 命令为空时 —— 早点说清楚，别让用户对着「正在启动…」等两分钟。
 */
function commandLine(command, args = []) {
  const parts = resolveCommand(command);
  if (parts.length === 0) {
    throw new Error('dsh 命令是空的：请检查设置 dshPanel.dshCommand');
  }
  return [...parts, ...args].map(quoteArg).join(' ');
}

function spawnBackgroundDsh({ command, profile, log, extraArgs = [] }) {
  if (!SAFE_PROFILE.test(String(profile))) {
    throw new Error(`profile 名不合法：${profile}（只允许字母、数字、点、下划线、连字符）`);
  }

  // `--host 127.0.0.1` 是兜底加固：确保它的网页界面也只绑回环地址。
  // `--port 0` 让系统随便挑一个网页端口 —— 我们走的是门，不用那个界面。
  // `extraArgs` 给测试用（例如 `--patch <临时覆盖文件>` 把门指到别的端口上，
  // 这样测试不必去抢 47821）；生产路径不传它，参数一律走 quoteArg。
  const args = [
    '--profile',
    profile,
    ...extraArgs.map(String),
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ];
  // 先拼命令行：命令写错时在这里就抛，别拖到进程起来之后。
  const line = commandLine(command, args);
  log('info', `后台拉起 DSH：${line}`);

  /*
   * 为什么不直接用 `spawn(command, args, { shell: true })`：
   * Windows 上 dsh 是个 .cmd 垫片，确实需要一层 shell 才找得到，但
   * 「shell:true + 参数数组」在 Node 里已经废弃（DEP0190），因为它只是把
   * 参数拼成字符串、并不转义 —— profile 名来自设置项，那就是一个注入点。
   * 这里改成显式调用 cmd.exe，并且参数自己加引号。
   *
   * `windowsVerbatimArguments: true` 是**必须的**，不是可选项：不加这一条，
   * Node 会拿上面那条标准 cmd 命令行当普通参数再转义一遍（内嵌的 `"` 变 `\"`），
   * cmd 于是解析错乱 —— 这就是「命令路径带空格时后台 DSH 起不来」的根因，
   * 而且它**两种写法都中招**（裸路径被 splitCommand 劈开、加引号被 Node 转义）。
   * 外面再包一层引号是给 cmd `/s` 用的：`/s` 会剥掉最外层的一对引号，
   * 剩下的原样执行（这样路径自身的引号才能活下来）。
   */
  const winArgs = ['/d', '/s', '/c', `"${line}"`];
  const child =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', winArgs, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: false,
          windowsVerbatimArguments: true,
        })
      : (() => {
          const parts = resolveCommand(command);
          return spawn(parts[0], [...parts.slice(1), ...args], {
            stdio: ['ignore', 'ignore', 'pipe'],
            detached: false,
          });
        })();

  /*
   * 收着内核的 stderr —— **它退出的真实原因就写在这里**。
   *
   * 2026-09-19 踩到的：这一行原来是 `stdio: 'ignore'`，把内核的话全扔了。
   * 于是用户看到的是面板**猜**出来的原因（"多半是 dsh 不在 PATH 里"），
   * 而内核其实明明白白说了 `error: profile "desktop" is managed exclusively
   * by the Electron application` —— 跟 PATH 一点关系都没有，用户按那句建议
   * 去改 dshCommand 只会越改越远。现在留末尾 2000 字，够放一段错误加上下文。
   */
  let stderrTail = '';
  if (child.stderr) {
    if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    // 管道自己出错（极少见）不该把扩展带崩，也不该变成未捕获异常。
    child.stderr.on('error', () => {});
  }

  let disposed = false;
  child.on('error', (error) => {
    log('error', `后台 DSH 起不来：${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (disposed) return;
    log('warn', `后台 DSH 退出了（code=${code} signal=${signal}）`);
  });

  return {
    child,
    /** 内核自己打的最后一段 stderr（可能为空）。 */
    stderrTail() {
      return stderrTail.trim();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 它自己已经退了的时候（自启失败那条路就是这样），这次收摊多半什么也杀不到，
      // taskkill 会报"找不到进程"。那不是故障，别在日志里吓人 —— 但仍然要试一次：
      // 壳退了、底下的内核还活着（Windows 上 dsh 是垫片，这种情形真实存在）。
      const alreadyExited = child.exitCode !== null || child.signalCode !== null;
      try {
        killTree(child);
        log(
          'info',
          alreadyExited
            ? '后台 DSH 已经自己退了，顺手清一下可能残留的子孙进程'
            : '已停掉本扩展拉起的后台 DSH',
        );
      } catch (error) {
        log(alreadyExited ? 'info' : 'warn', `停后台 DSH 失败：${error.message}`);
      }
    },
  };
}

/**
 * 杀掉整棵进程树。
 *
 * 为什么不能只用 `child.kill()`：Windows 上 `dsh` 是个 .cmd 垫片，
 * shell:true 会多包一层 cmd.exe，而后台真正干活的是它下面的
 * 「DSH Desktop.exe」。`child.kill()` 只杀得到外壳，真正的内核会变成
 * 孤儿进程继续占着端口和内存 —— 用户看不见，但确实还在跑。
 * 所以这里按 pid 连子孙一起杀。
 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    require('node:child_process').execFileSync(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', timeout: 10000 },
    );
    return;
  }
  child.kill('SIGTERM');
}

/**
 * 同步跑一条 `dsh` 命令，拿回它的输出（成功才返回；失败抛错，带 stderr）。
 *
 * 给测试用的（例如把门插件重装一遍）。跟 spawnBackgroundDsh 走同一套
 * Windows 处理：`dsh` 是个 .cmd 垫片，得显式通过 cmd.exe 调，
 * 而且参数自己加引号（`shell:true` + 参数数组在 Node 里已废弃，见上面的说明）。
 *
 * @returns {string} stdout
 */
function runDshSync({ command, args = [], timeoutMs = 120000 }) {
  const quoted = commandLine(command, args);
  try {
    if (process.platform === 'win32') {
      // 和 spawnBackgroundDsh 同一套：自己拼命令行 + 原样传递给 cmd.exe。
      // 少任何一半，带空格的命令路径都会起不来。
      return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
      });
    }
    const parts = resolveCommand(command);
    return execFileSync(parts[0], [...parts.slice(1), ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} 失败：${detail || error.message}`);
  }
}

/**
 * 内核刚退出时，先读它自己说了什么，再决定给用户什么建议。
 *
 * 为什么要有这一步（2026-09-19 的教训）：内核退出原因五花八门，而面板原来
 * 一律猜"dsh 不在 PATH 里"。最典型的一次是 `--profile desktop`：
 * DSH 回的是 `profile "desktop" is managed exclusively by the Electron
 * application` —— **那个档命令行根本起不来**，用户按面板的建议去改
 * dshCommand 是白费力气。所以：认得出来的原因就照实说，认不出来才回退到猜，
 * 而且原文一字不删地附在后面。
 *
 * @returns {{kind: string, reason: string, advice: string}} kind 为 'unknown' 时
 *   reason/advice 可能为空，调用方自己兜底。
 */
function explainKernelFailure({ profile, stderr }) {
  const text = String(stderr || '');
  if (/managed exclusively by the Electron application/i.test(text)) {
    return {
      kind: 'app-managed-profile',
      reason: `档「${profile}」只能由 DSH 桌面端启动，命令行起不来`,
      advice:
        `把 dshPanel.fallbackProfile 换成面板能自己启动的档（例如 vscode-panel），` +
        '或者先打开 DSH 桌面端 —— 面板会直接连它，不用自己启动。',
    };
  }
  if (/unknown option/i.test(text)) {
    return {
      kind: 'wrong-app-flags',
      reason: `档「${profile}」不接受面板的启动参数（--no-open/--host/--port）`,
      advice:
        '这个档多半是给别的入口用的（比如 ACP 那种走标准输入输出的档）。' +
        '把 dshPanel.fallbackProfile 换成一个网页档（bundles 里有 @deepseek-ai/dsh-web-app 的）。',
    };
  }
  if (/ENOENT|not recognized|not found|不是内部或外部命令|系统找不到/i.test(text)) {
    return {
      kind: 'missing-command',
      reason: '找不到 dsh 命令',
      advice: '把 dshPanel.dshCommand 填成完整启动命令，或者确认 dsh 在 PATH 里。',
    };
  }
  if (/EADDRINUSE|address already in use|address in use/i.test(text)) {
    return {
      kind: 'port-in-use',
      reason: '门要用的端口被别的进程占着',
      advice: '把占用那个端口的进程关掉再重连；或者改 dshPanel.port 和门插件里的 port。',
    };
  }
  return { kind: 'unknown', reason: '', advice: '' };
}

/**
 * 面板能自己启动的档：目录里装了门插件、而且 bundles 里有网页那套
 * （`@deepseek-ai/dsh-web-app`）—— 只有网页档才接受 `--no-open/--host/--port`
 * 并把门开在 TCP 上。
 *
 * 用户设置的那个永远排第一（他明确指定了就尊重他）；后面是按目录**扫**出来的
 * 备选，用于"设置里那个起不来"时自动换一个 —— 这样插件在别的机器上也能自己
 * 找到活路，而不是死在一个写死的档名上。
 *
 * 已知的坑：`desktop` 档被桌面端独占，命令行起不来。它照样会被扫出来（文件名
 * 上没有任何标记），所以**不靠名字排除**，而是靠内核自己回的那句错误
 * （见 {@link explainKernelFailure}）—— 试一次、秒退、换下一个，代价很小。
 */
function panelProfileCandidates({
  configured,
  homedir = require('node:os').homedir(),
  env = process.env,
} = {}) {
  const list = [];
  const push = (name) => {
    const value = String(name || '').trim();
    if (value && SAFE_PROFILE.test(value) && !list.includes(value)) list.push(value);
  };
  push(configured);

  const root = path.join(dshHome(homedir, env), 'profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const capable = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = fs.readFileSync(path.join(root, entry.name, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw);
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
      const list0 = Array.isArray(bundles) ? bundles.map(String) : [];
      const hasDoor = list0.some((name) => /dsh-acp-door/.test(name));
      const hasWebApp = list0.some((name) => /@deepseek-ai\/dsh-web-app/.test(name));
      // 插件多的一般更能干（用户的档就是这种），所以按 bundles 数量从多到少。
      if (hasDoor && hasWebApp) capable.push({ name: entry.name, weight: list0.length });
    } catch {
      // 读不动/不是 profile 的目录，跳过就是了，不影响别的候选。
    }
  }
  capable.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  for (const item of capable) push(item.name);
  // 最多试三个：再多样基本上都是同一个原因在重复失败，白等用户时间。
  return list.slice(0, 3);
}

module.exports = {
  probePort,
  waitForPort,
  spawnBackgroundDsh,
  runDshSync,
  delay,
  quoteArg,
  splitCommand,
  stripOuterQuotes,
  resolveCommand,
  commandLine,
  dshCommandCandidates,
  explainKernelFailure,
  panelProfileCandidates,
};
