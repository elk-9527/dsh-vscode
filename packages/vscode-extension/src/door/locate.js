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

/** 按 Windows 命令行的规则给参数加引号（只在需要时加）。 */
function quoteArg(value) {
  const text = String(value);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
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
  const parts = splitCommand(command);
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
   */
  const child =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
          windowsHide: true,
          stdio: 'ignore',
          detached: false,
        })
      : spawn(splitCommand(command)[0], [...splitCommand(command).slice(1), ...args], {
          stdio: 'ignore',
          detached: false,
        });

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
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        killTree(child);
        log('info', '已停掉本扩展拉起的后台 DSH');
      } catch (error) {
        log('warn', `停后台 DSH 失败：${error.message}`);
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
      return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoted], {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const parts = splitCommand(command);
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

module.exports = {
  probePort,
  waitForPort,
  spawnBackgroundDsh,
  runDshSync,
  delay,
  quoteArg,
  splitCommand,
  commandLine,
  dshCommandCandidates,
};
