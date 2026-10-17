'use strict';

/**
 * 定位 ACP 接入点插件（`dsh-acp-door`）；未找到时在后台启动一个 DSH。
 *
 * 桌面端正在运行时直接连接同一个内核；未运行时启动一个
 * 后台 DSH —— 该进程与桌面端**共用同一份 `$DSH_HOME`**，因此记忆、会话记录与
 * 配置文件均为同一份，不产生第二份数据。
 *
 * 接入已有桌面端时使用设置中的端口；面板自行启动时传入独立端口，避免与桌面端竞争。
 * 两条路径都只连接或监听回环地址。
 */

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
// `$DSH_HOME` 的判定只有一处（sessions.js），此处复用它以避免两处规则不一致。
const { resolveSessionsRoot } = require('../dsh/sessions');

/** `$DSH_HOME`（环境变量优先，否则 `~/.dsh`）。 */
function dshHome(homedir, env = process.env) {
  return path.dirname(resolveSessionsRoot({ homedir, env }));
}

/** 探测某个端口是否可连接（不进行握手，仅探测 TCP）。 */
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

/** 等待端口就绪，直到超时。 */
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

/*
 * 内核输出会进入 VS Code 日志和错误详情。网页地址、认证头或环境变量中的访问凭据
 * 不应落盘，因此仅隐藏敏感参数的值，保留参数名称和其余诊断信息。
 *
 * 此处不试图识别所有保密内容；覆盖的是 DSH 启动时已观察到的 URL 参数，以及常见的
 * JSON、HTTP 头和环境变量表达方式。调用方仍不得主动把凭据作为普通日志内容传入。
 */
const SENSITIVE_QUERY_VALUE =
  /([?&#](?:access[_-]?token|api[_-]?key|authorization|token|key|secret|password)=)([^&#\s"']+)/gi;
const SENSITIVE_JSON_VALUE =
  /("(?:access[_-]?token|api[_-]?key|authorization|token|key|secret|password)"\s*:\s*")([^"]*)/gi;
const SENSITIVE_ENV_VALUE =
  /(\b(?:VSCE_PAT|NODE_AUTH_TOKEN|NPM_TOKEN|GITHUB_TOKEN|ACCESS[_-]?TOKEN|API[_-]?KEY|SECRET|PASSWORD)\s*[=:]\s*)([^\s'"]+)/gi;
const SENSITIVE_AUTH_HEADER = /(\bauthorization\s*:\s*(?:bearer|basic|token)\s+)([^\s,;]+)/gi;
const SENSITIVE_BEARER_VALUE = /(\bbearer\s+)([^\s,;]+)/gi;

/** 隐藏可能写入日志或错误详情的访问凭据值。 */
function redactSensitiveOutput(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(SENSITIVE_QUERY_VALUE, '$1[已隐藏]')
    .replace(SENSITIVE_JSON_VALUE, '$1[已隐藏]')
    .replace(SENSITIVE_ENV_VALUE, '$1[已隐藏]')
    .replace(SENSITIVE_AUTH_HEADER, '$1[已隐藏]')
    .replace(SENSITIVE_BEARER_VALUE, '$1[已隐藏]');
}

/**
 * 后备启动候选按指定命令、可用桌面端运行时和 DSH 安装目录依次查找并去重。
 * 仅添加磁盘上存在的安装入口，避免依赖 VS Code 的 PATH。
 * @param {object} options
 * @returns {string[]} 候选启动命令。
 */
function dshCommandCandidates({ dshCommand, homedir, desktopExecutables = [], extensionDir } = {}) {
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
  if (bin && fs.existsSync(bin)) list.push(`node ${quoteArg(bin)}`);
  for (const executable of desktopExecutables) {
    // rc.2 的官方命令可直接按完整路径运行，无需注册 PATH 或修改用户环境。
    const bundledCli = path.join(path.dirname(executable), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (process.platform === 'win32' && existsAsFile(bundledCli)) list.push(quoteArg(bundledCli));
    const desktopCommand = desktopDshCommand(executable, { extensionDir });
    if (desktopCommand) list.push(desktopCommand);
  }
  return [...new Set(list)];
}

/**
 * 从一个桌面端安装目录构造可持续运行的 dsh CLI 命令。
 *
 * DSH Desktop 0.2 将 CLI 放进 app.asar，不再生成旧版的全局 dsh.cmd。直接设置
 * `ELECTRON_RUN_AS_NODE=1` 执行该脚本时，Electron 44 会在脚本初始化后退出，即使
 * 内核仍持有监听句柄。这里改用桌面端随附的真正 Node 运行一个很小的代理；代理以
 * IPC fork 启动 Electron/Node 子进程，IPC 通道会维持其生命周期。这样既不复制
 * app.asar，也不依赖用户另外安装 Node 或把 dsh 放进 PATH。
 */
function desktopDshCommand(executable, { extensionDir } = {}) {
  const exe = String(executable || '').trim();
  if (process.platform !== 'win32' || !existsAsFile(exe)) return undefined;
  const installDir = path.dirname(exe);
  const resources = path.join(installDir, 'resources');
  const appAsar = path.join(resources, 'app.asar');
  const node = path.join(
    resources,
    'runtime',
    'primary-runtime',
    'dependencies',
    'node',
    'bin',
    'node.exe',
  );
  const proxy = path.join(
    extensionDir || path.resolve(__dirname, '..', '..'),
    'src',
    'door',
    'desktop-cli-host.cjs',
  );
  if (!existsAsFile(appAsar) || !existsAsFile(node) || !existsAsFile(proxy)) return undefined;
  const cli = path.join(appAsar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return [node, proxy, exe, cli].map(quoteArg).join(' ');
}

/**
 * 找出当前机器上的 DSH Desktop 可执行文件。
 *
 * 先查明确环境变量和标准安装目录；若桌面端正在运行，再只读查询进程路径，以覆盖
 * `D:\\programs\\...` 这类自定义目录。查询失败不会影响普通 dsh 候选。
 */
function runningDesktopExecutables({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const list = [];
  const push = (candidate) => {
    const value = String(candidate || '').trim();
    if (
      value &&
      /deepseek harness\.exe$/i.test(value) &&
      existsAsFile(value) &&
      !list.some((item) => item.toLowerCase() === value.toLowerCase())
    ) {
      list.push(value);
    }
  };

  push(env.DEEPSEEK_HARNESS_EXECUTABLE);
  for (const root of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root) push(path.join(root, 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  }
  if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));

  try {
    const powershell = env.SystemRoot
      ? path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const output = execFileSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }; " +
        "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } | ForEach-Object { Join-Path $_.InstallLocation 'DeepSeek Harness.exe' }",
      ],
      // A cold PowerShell start can exceed 2.5 seconds on Windows.  Missing this
      // result is costly (the panel falls back to a non-existent PATH command),
      // so allow one short startup-sized window for this read-only probe.
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const line of String(output || '').split(/\r?\n/)) push(line);
  } catch {
    // PowerShell 不可用或进程路径不可读：保留已经发现的标准安装目录即可。
  }
  return list;
}

/**
 * 在后台启动一个 DSH。
 *
 * 使用 `--no-open`（不打开浏览器）与 `--port 0`（网页界面端口由系统任意分配，
 * 本扩展使用该插件提供的接入点，不使用其网页界面）。标准输出和错误输出会限量写入
 * 扩展日志，便于定位内核退出原因；其中的访问凭据会在写入前隐藏。
 *
 * @param {object} options
 * @param {string} options.command dsh 程序名或完整路径。
 * @param {string} options.profile profile 名（其中需要安装该插件）。
 * @param {(level: string, message: string) => void} options.log
 * @returns {{child: import('node:child_process').ChildProcess, dispose: () => void}}
 */
/** profile 名只允许以下字符 —— 该值会进入命令行，不允许存在注入空间。 */
const SAFE_PROFILE = /^[A-Za-z0-9._-]+$/;

/**
 * 按 cmd.exe 规则引用参数，不做 Node argv 的反斜杠转义。
 * 调用 spawn 时配合 windowsVerbatimArguments，防止引号被二次转义。
 */
function quoteArg(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return '""';
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 去除整串外层成对的引号（用户可能写成 `"C:\…\dsh.cmd"`）。 */
function stripOuterQuotes(text) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s.length >= 2) {
    const first = s[0];
    if ((first === '"' || first === "'") && s[s.length - 1] === first) return s.slice(1, -1);
  }
  return s;
}

/** 判断该路径是否存在（文件不存在或路径包含非法字符均视为「不存在」）。 */
function existsAsFile(candidate) {
  try {
    return Boolean(candidate) && fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * 贪心合并被空格分开的路径；只有拼接结果是磁盘上的文件时才合并。
 * 程序路径和脚本路径均可包含空格，普通参数保持原来的拆分。
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
    // 当前片段不是文件时，向后依次合并后续片段，直到拼出确实存在的路径。
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
 * 解析程序与自带参数。整串是现存文件时优先采用；否则去除外层引号，
 * 按空白拆分，再通过 rejoinExisting 合并现存文件路径。
 * @param {string} command
 * @returns {string[]} 程序与参数；空数组表示命令为空。
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
 * 将设置项中的 `dshCommand` 拆分为「程序 + 其自带的参数」。
 *
 * `dshCommand` 允许带参数，例如 `node …/@deepseek-ai/dsh/lib/bin.js`。
 * 不能把整串当成一个程序名传给 cmd.exe；应分别解析并引用程序和各个参数。
 *
 * 支持使用双引号或单引号将含空格的整段括起（例如
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
 * 将「程序 + 其自带的参数 + 本次传入的参数」拼接为一条完整命令行，每段分别加引号。
 *
 * @throws {Error} 命令为空时 —— 尽早说明原因，避免用户在「正在启动…」状态下等待两分钟。
 */
function commandLine(command, args = []) {
  const parts = resolveCommand(command);
  if (parts.length === 0) {
    throw new Error('dsh 命令为空：请检查设置 dshPanel.dshCommand');
  }
  return [...parts, ...args].map(quoteArg).join(' ');
}

function spawnBackgroundDsh({ command, profile, log, extraArgs = [], port, ownedIdleMs }) {
  if (!SAFE_PROFILE.test(String(profile))) {
    throw new Error(`配置名不合法：${profile}（只允许字母、数字、点、下划线、连字符）`);
  }

  /*
    * 面板通过环境变量指定自启内核的接入点端口，避免配置不同步与端口争用。
    * 旧插件不识别该变量时，同时监测配置端口（见 view.js 的 waitForFallbackDoor）。
   */
  const doorPort = Number(port);
  const env =
    Number.isInteger(doorPort) && doorPort >= 0 && doorPort <= 65535
      ? { ...process.env, DSH_ACP_DOOR_PORT: String(doorPort) }
      : { ...process.env };
  if (Number.isFinite(ownedIdleMs) && ownedIdleMs >= 1000) {
    env.DSH_BRIDGE_OWNED_IDLE_MS = String(Math.round(ownedIdleMs));
  }

  // `--host 127.0.0.1` 为后备加固：确保其网页界面仅绑定回环地址。
  // `--port 0` 表示由系统任意分配网页端口 —— 本扩展使用接入点，不使用该界面。
  // `extraArgs` 供测试使用（例如 `--patch <临时覆盖文件>` 将接入点指向其他端口，
  // 使测试不必占用 47821）；生产路径不传入该参数，参数一律经 quoteArg 处理。
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
  // 先拼接命令行：命令有误时在此处即抛出，不推迟到进程启动之后。
  const line = commandLine(command, args);
  log(
    'info',
    `后台拉起 DSH：${redactSensitiveOutput(line)}${env === process.env ? '' : `（接入点端口固定为 ${doorPort}，通过 DSH_ACP_DOOR_PORT 传入）`}`,
  );

  /*
   * 不使用 `spawn(command, args, { shell: true })` 的原因：
   * Windows 上 dsh 是 .cmd 垫片，确实需要一层 shell 才能定位，但
   * 「shell:true + 参数数组」在 Node 中已废弃（DEP0190），因为该形式仅将
   * 参数拼接为字符串，并不进行转义 —— profile 名来自设置项，构成注入点。
   * 此处改为显式调用 cmd.exe，并由本文件为参数添加引号。
   *
   * `windowsVerbatimArguments: true` 是**必需的**，不是可选项：缺少该项时，
   * Node 会将上述标准 cmd 命令行当作普通参数再次转义（内嵌的 `"` 变 `\"`），
   * 导致 cmd 解析错误 —— 这是「命令路径包含空格时后台 DSH 无法启动」的根因，
   * 且**两种写法均受影响**（未加引号的路径被 splitCommand 拆开、加引号的路径被 Node 转义）。
   * 外层再包一层引号是供 cmd `/s` 使用：`/s` 会去除最外层的一对引号，
   * 其余部分原样执行（这样路径自身的引号才能保留）。
   */
  /*
   * stdout 同样需要接收 —— 不能只接收 stderr。
   *
   * 内核启动时会向 stdout 输出网页地址，崩溃时也可能向 stdout 输出；仅接收 stderr
   * 时这些内容均不可见。两路输出均接收并限量转发；访问凭据会在转发前隐藏。
   */
  const winArgs = ['/d', '/s', '/c', `"${line}"`];
  const child =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', winArgs, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          windowsVerbatimArguments: true,
          env,
        })
      : (() => {
          const parts = resolveCommand(command);
          return spawn(parts[0], [...parts.slice(1), ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            env,
          });
        })();

  /*
    * 保存 stderr 末尾 2000 字供启动失败分类，并限量转发两路输出到面板日志。
    * 单个内核最多转发 120 行 / 12KB，避免插件输出无限增长。
   */
  const OUTPUT_LINE_CAP = 120;
  const OUTPUT_CHAR_CAP = 12 * 1024;
  let forwardedLines = 0;
  let forwardedChars = 0;
  let droppedOutput = 0;
  const pendingOutput = { out: '', err: '' };
  let stderrTail = '';

  const safeStderrTail = () => redactSensitiveOutput(stderrTail).slice(-2000).trim();

  /** 将已经完整的一行内核输出转发到面板日志（超出上限时停止并说明）。 */
  const forwardLine = (which, line) => {
    const trimmed = redactSensitiveOutput(line.trimEnd());
    if (!trimmed) return;
    if (forwardedLines >= OUTPUT_LINE_CAP || forwardedChars >= OUTPUT_CHAR_CAP) {
      droppedOutput += 1;
      return;
    }
    forwardedLines += 1;
    forwardedChars += trimmed.length;
    log('info', `内核[${which}] ${trimmed}`);
  };

  /**
   * 按行处理两路输出。不能逐块脱敏：访问凭据可能恰好被流切成两段，逐块处理会漏掉
   * 后半段。末尾没有换行的一段在进程退出时再转发。
   */
  const forward = (which, chunk) => {
    const text = pendingOutput[which] + chunk;
    const parts = text.split(/\r?\n/);
    pendingOutput[which] = parts.pop();
    for (const line of parts) forwardLine(which, line);
  };

  const flushPending = (which) => {
    if (!pendingOutput[which]) return;
    forwardLine(which, pendingOutput[which]);
    pendingOutput[which] = '';
  };

  const attach = (stream, which, isTail) => {
    if (!stream) return;
    if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const text = String(chunk);
      if (isTail) stderrTail = (stderrTail + text).slice(-8192);
      forward(which, text);
    });
    // 管道自身出错（极少见）不应导致扩展崩溃，也不应产生未捕获异常。
    stream.on('error', () => {});
  };

  attach(child.stdout, 'out', false);
  attach(child.stderr, 'err', true);

  let disposed = false;
  child.on('error', (error) => {
    log('error', `后台 DSH 启动失败：${redactSensitiveOutput(error.message)}`);
  });
  child.on('exit', (code, signal) => {
    if (disposed) return;
    flushPending('out');
    flushPending('err');
    if (droppedOutput > 0) {
      log('warn', `后台 DSH 的输出还有 ${droppedOutput} 行没记（超过 ${OUTPUT_LINE_CAP} 行了，只留了前面这些）`);
    }
    // 并非由本扩展回收 —— 该进程自行退出。此类情形需要排查。
    log('warn', `后台 DSH 自己退出了（code=${code} signal=${signal}）`);
    const tail = safeStderrTail();
    if (tail) {
      const last = tail.split(/\r?\n/).filter((line) => line.trim()).slice(-8);
      log('warn', `它退之前最后说的话：\n${last.join('\n')}`);
    } else {
      log('warn', '它一个字都没说就退了（stderr 是空的）—— 通常是外面有人把它杀了，不是它自己崩的');
    }
  });

  return {
    child,
    /** 内核自行输出的最后一段 stderr；访问凭据已隐藏（可能为空）。 */
    stderrTail() {
      return safeStderrTail();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 进程已自行退出时（自启动失败路径即属此类），此次清理通常不会终止任何进程，
      // taskkill 会报告"找不到进程"。该情况不是故障，日志中不应作为异常记录 ——
      // 但仍需尝试一次：外壳进程已退出、底层内核仍在运行（Windows 上 dsh 为垫片）的情形确实存在。
      const alreadyExited = child.exitCode !== null || child.signalCode !== null;
      try {
        killTree(child);
        log(
          'info',
          alreadyExited
            ? '后台 DSH 已自行退出，同时清理可能残留的子孙进程'
            : '已停止本扩展启动的后台 DSH',
        );
      } catch (error) {
        log(alreadyExited ? 'info' : 'warn', `停止后台 DSH 失败：${redactSensitiveOutput(error.message)}`);
      }
    },
  };
}

/**
 * 终止整棵进程树。
 *
 * 不能仅使用 `child.kill()` 的原因：Windows 上 `dsh` 是 .cmd 垫片，
 * shell:true 会额外包一层 cmd.exe，实际在后台运行的是其下的
 * 「DSH Desktop.exe」。`child.kill()` 只能终止外壳进程，真正的内核会成为
 * 孤儿进程并继续占用端口与内存 —— 用户不可见，但该进程确实仍在运行。
 * 因此此处按 pid 连同子孙进程一并终止。
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
 * 同步执行一条 `dsh` 命令并获取其输出（仅在成功时返回；失败时抛出异常，附带 stderr）。
 *
 * 供测试使用（例如重新安装该插件）。与 spawnBackgroundDsh 采用同一套
 * Windows 处理方式：`dsh` 是 .cmd 垫片，需要显式通过 cmd.exe 调用，
 * 且由本文件为参数添加引号（`shell:true` + 参数数组在 Node 中已废弃，见上文的说明）。
 *
 * @returns {string} stdout
 */
function runDshSync({ command, args = [], timeoutMs = 120000 }) {
  const quoted = commandLine(command, args);
  try {
    if (process.platform === 'win32') {
      // 与 spawnBackgroundDsh 采用同一套方式：自行拼接命令行 + 原样传递给 cmd.exe。
      // 缺少其中任何一项，含空格的命令路径均无法启动。
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
    const detail = redactSensitiveOutput([error.stdout, error.stderr].filter(Boolean).join('\n').trim());
    const safeCommand = redactSensitiveOutput(`${command} ${args.join(' ')}`);
    throw new Error(`${safeCommand} 失败：${detail || redactSensitiveOutput(error.message)}`);
  }
}

/**
 * 按内核输出区分配置集独占、命令缺失等启动失败，给出对应建议。
 *
 * @returns {{kind: string, reason: string, advice: string}} kind 为 'unknown' 时
 *   reason/advice 可能为空，由调用方提供后备。
 *
 * ⚠️ reason/advice 会**原样显示在错误卡片上（面向用户）**，因此只使用通用表述：
 * 不出现「接入点插件」「档名」「包名」「设置项全名」。档名、命令与包名等细节在其后的
 * 原文（`human.raw` 的 tail）中完整保留，位于折叠区域内。
 */
function explainKernelFailure({ profile, stderr }) {
  const text = String(stderr || '');
  if (/incompatible with dsh|installation rejected:[\s\S]*peerDependencies/i.test(text)) {
    return {
      kind: 'plugin-incompatible',
      reason: '连接组件与当前版本不兼容',
      advice: '更新连接组件并重启后，再重新连接。',
    };
  }
  if (/managed exclusively by the Electron application/i.test(text)) {
    return {
      kind: 'app-managed-profile',
      reason: '该配置只能由桌面端启动',
      advice: '需要先启动桌面端，或在设置中更换其他配置。',
    };
  }
  if (/unknown option/i.test(text)) {
    return {
      kind: 'wrong-app-flags',
      reason: '该配置不接受面板的启动参数',
      advice: '需要在设置中更换其他配置。',
    };
  }
  if (/ENOENT|not recognized|not found|不是内部或外部命令|系统找不到/i.test(text)) {
    return {
      kind: 'missing-command',
      reason: '未找到 DSH 的启动命令',
      advice: '需要在设置中将 DSH 的位置填写为完整路径。',
    };
  }
  if (/EADDRINUSE|address already in use|address in use/i.test(text)) {
    return {
      kind: 'port-in-use',
      reason: '需要使用的端口已被其他程序占用',
      advice: '需要关闭占用该端口的程序，或在设置中更换端口。',
    };
  }
  return { kind: 'unknown', reason: '', advice: '' };
}

/**
 * 面板可以自行启动的档：目录中安装了该插件，且 bundles 中包含网页组件
 * （`@deepseek-ai/dsh-web-app`）—— 只有网页档才接受 `--no-open/--host/--port`
 * 并将接入点监听在 TCP 上。
 *
 * 用户设置项中指定的档始终排在首位（用户已明确指定，予以尊重）；其后为按目录**扫描**得到的
 * 备选档，用于在"设置项中指定的档无法启动"时自动替换 —— 使该插件在其他机器上也能自行
 * 找到可用档，而不局限于一个硬编码的档名。
 *
 * 已知问题：`desktop` 档由桌面端独占，无法通过命令行启动。该档仍会被扫描出来（文件名
 * 上没有任何标记），因此**不按名称排除**，而是依据内核返回的错误信息
 * （见 {@link explainKernelFailure}）—— 尝试一次、快速退出、换用下一个，代价很小。
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
      // 按 bundles 数量降序选择候选配置集，再以名称稳定排序。
      if (hasDoor && hasWebApp) capable.push({ name: entry.name, weight: list0.length });
    } catch {
      // 无法读取或不是 profile 的目录直接跳过，不影响其他候选。
    }
  }
  capable.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  for (const item of capable) push(item.name);
  // 最多尝试三个：更多候选通常因同一原因重复失败，只会增加用户等待时间。
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
  redactSensitiveOutput,
  dshCommandCandidates,
  desktopDshCommand,
  runningDesktopExecutables,
  explainKernelFailure,
  panelProfileCandidates,
};
