'use strict';

/**
 * 定位 ACP 接入点插件（`dsh-acp-door`）；未找到时在后台启动一个 DSH。
 *
 * 这是用户批准的后备路径：桌面端正在运行时直接连接它（同一个内核）；未运行时启动一个
 * 后台 DSH —— 该进程与桌面端**共用同一份 `$DSH_HOME`**，因此记忆、会话记录与
 * 配置文件均为同一份，不产生第二份数据。
 *
 * 端口固定为 47821 的原因：该插件在自己的 cordis.patch.yml 中硬编码了端口。
 * 同一时刻只有一个内核可以占用该端口，因此「连接失败 = 桌面端未运行」，判据没有歧义。
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

/**
 * 后备启动时依次尝试的命令清单。
 *
 * ── 提供多个候选的原因 ─────────────────────────────────────────────
 * 设置项 `dshCommand` 的默认值为直接给出的命令 `dsh`，而本机的 `dsh` 通常不在 VS Code
 * 进程可见的 PATH 中（实测：用户面板中报告「后台 DSH 刚启动就退出了
 * （命令：「dsh」）」）。仅尝试一个候选时，失败即终止 —— 这使得用户被迫
 * 「先启动桌面端才能使用面板」，而该条件不应成为必要条件。
 *
 * 因此此处给出若干候选：
 *   1. 设置项中填写的命令（由用户明确指定，始终最优先）；
 *   2. `<主目录>/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`
 *      通过 `node` 运行 —— 这是 DSH 自动安装目录中的入口（存在时才加入），
 *      实测即为测试配方中验证过的启动命令。
 *
 * 纯函数：测试可直接传入参数，除文件系统之外不依赖任何外部状态。
 *
 * @param {object} options
 * @param {string} options.dshCommand 设置项 dshPanel.dshCommand。
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
 * 在后台启动一个 DSH。
 *
 * 使用 `--no-open`（不打开浏览器）与 `--port 0`（网页界面端口由系统任意分配，
 * 本扩展使用该插件提供的接入点，不使用其网页界面）。stdio 全部丢弃：该进程为
 * 后台进程，其输出对用户没有意义，也不应污染扩展的输出通道。
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
 * 按 **cmd.exe 的引号规则**为一段文本添加引号（仅在需要时添加）。
 *
 * 该函数内部**不**进行反斜杠转义的原因：cmd.exe 不识别 `\"`。以前这里写的是
 * `text.replace(/"/g, '\\"')`，随后整条命令行又被 Node 的 argv 规则转义一次
 * （Node 会将内嵌的 `"` 变成 `\"`），cmd 实际收到的是 `\"C:\Program Files\…` ——
 * 该程序将 `\` 视为普通字符，引号配对错误，从而报告「不是内部或外部命令」。
 * 当前有两项保证：① 此处仅按 cmd 的规则添加引号；② 调用 spawn 时传入
 * `windowsVerbatimArguments: true`，由 Node **原样**传递，不再修改。
 * 实测（`node build/repro-locate.cjs`）：修复前，带空格的路径在「不加引号」
 * 与「加引号」两种写法下均无法启动；修复后两种写法均可启动。
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
 * 将被空格分隔的片段**重新合并**为「磁盘上确实存在的那一段」。
 *
 * 需要该处理的原因：`splitCommand` 仅按空白拆分，面对
 * `C:\…\DSH Desktop\…\dsh.cmd --profile desktop` 这种「路径里有空格」的写法，
 * 会将程序名拆成两段。但仅依据「整串是否为文件」并不充分 —— 用户也可能在含空格的
 * 路径之后继续写参数（本机实际场景：dsh 安装在 `…\DSH Desktop\…` 下面）。
 * 因此此处执行一次贪心回接，**仅在拼接结果确实存在于磁盘上时才合并**：
 *
 *   `node C:\x y\bin.js`   → ['node', 'C:\x y\bin.js']   （脚本路径被合并）
 *   `C:\x y\dsh.cmd --v`   → ['C:\x y\dsh.cmd', '--v']   （程序名被合并）
 *   `dsh --profile a b`    → 原样（不存在任何真实存在的前缀，不进行合并）
 *
 * 该处理只**减少拆分**，不**增加合并**：合并依据是磁盘上存在该文件，而非推测。
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
 * 将设置项中的命令解析为「程序 + 其自带的参数」。
 *
 * 规则（按优先级）：
 *   1. **整串本身即为一个存在的文件** → 该串就是程序，不携带任何参数
 *      （Windows 上 dsh 的真实路径中包含空格：`…\DSH Desktop\…\dsh.cmd`）；
 *   2. 整串以 `"…"` 整体加引号 → 去除引号后按第 1 条处理；
 *   3. 否则按空白拆分，再将「被拆开但磁盘上确实存在的那一段」合并回去
 *      （见 {@link rejoinExisting}）。
 *
 * 不能仅按空白拆分的原因：`dshPanel.dshCommand` 的说明与面板自身的报错文案
 * 均提示用户「将完整路径填入设置项」，用户据此填写的是**未加引号的路径**；
 * 仅按空白拆分会把该路径拆成两段 —— 实测 cmd 的原话为
 * `'C:\Users\…\Roaming\DSH' is not recognized as an internal or external command`
 * （面板会将其转换为中文表述后展示给用户，见 `src/dsh/errors.js`）。
 * 用户不应为了填写一个路径而必须先了解引号规则。
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
 * 将设置项中的 `dshCommand` 拆分为「程序 + 其自带的参数」。
 *
 * 需要拆分的原因：`dshCommand` 允许写成**带参数的完整命令**，最典型的形式为
 * `node D:\...\@deepseek-ai\dsh\lib\bin.js` —— 本机 `dsh` 不在 PATH 上时
 * 需要采用该写法。若将整串当作一个程序名并加引号传给 cmd.exe，cmd 会查找一个
 * 名称中包含空格的程序，直接以退出码 1 失败（实测：
 * `"...\node.exe ...\bin.js" --version` 报「不是内部或外部命令」）。
 * 因此先按空白拆分，再逐段添加引号。
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

function spawnBackgroundDsh({ command, profile, log, extraArgs = [], port }) {
  if (!SAFE_PROFILE.test(String(profile))) {
    throw new Error(`配置名不合法：${profile}（只允许字母、数字、点、下划线、连字符）`);
  }

  /*
   * 接入点监听的端口：**由启动内核的一方（面板）决定**，不依赖档中的配置。
   *
   * 2026-09-19：端口原先仅写在档的配置中，面板只能假设它与设置项一致；
   * 不一致时表现为「内核已启动，但接入点未监听在面板等待的端口上」，用户将在
   * 「正在启动…」状态下等待两分钟。此外，面板自行启动的内核会占用桌面端使用的
   * 47821 端口。现在将端口写入环境变量，由该插件读取（优先级最高，
   * 见 packages/dsh-door/lib/port.js 的 resolveDoorPort）。
   * 档中安装的是较低版本的该插件、不识别该变量时也不会失败：扩展会同时监视
   * 两个端口，任一端口上的接入点可用即采用（见 view.js 的 waitForFallbackDoor）。
   */
  const doorPort = Number(port);
  const env =
    Number.isInteger(doorPort) && doorPort >= 0 && doorPort <= 65535
      ? { ...process.env, DSH_ACP_DOOR_PORT: String(doorPort) }
      : process.env;

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
    `后台拉起 DSH：${line}${env === process.env ? '' : `（接入点端口固定为 ${doorPort}，通过 DSH_ACP_DOOR_PORT 传入）`}`,
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
   * 2026-09-19：内核启动时会向 **stdout** 输出一行 `dsh web: http://127.0.0.1:…/?token=…`，
   * 崩溃时也可能向 stdout 输出；仅接收 stderr 时这些内容均不可见。
   * 两路输出均接收，面板日志已限量（见下面的 forward）。
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
   * 收集内核的 stderr —— **内核退出的真实原因记录在此**。
   *
   * 2026-09-19 发现的问题：此处原先为 `stdio: 'ignore'`，内核的输出被全部丢弃。
   * 因此用户看到的是面板**推测**的原因（"多半是 dsh 不在 PATH 里"），
   * 而内核实际明确输出了 `error: profile "desktop" is managed exclusively
   * by the Electron application` —— 与 PATH 无关，用户按该提示
   * 修改 dshCommand 只会偏离原因。当前保留末尾 2000 字，足以容纳一段错误信息及其上下文。
   *
   * 同日第二次发现的问题：**仅保留而不输出**等同于未保留。用户随后报告
   * read ECONNRESET"，查阅 VS Code 的面板日志时只能看到
   * `后台 DSH 退出了（code=1）` —— 内核的退出原因没有任何记录（该段
   * stderr 仅保存在内存中，随进程结束而丢失）。因此当前两路输出均
   * **转发到面板日志**（输出 → DSH Panel，VS Code 会将其写入文件），
   * 故障现场可直接查阅。同时进行限量：单个内核最多记录 120 行 / 12KB，
   * 避免某个插件输出过多导致日志超出上限。
   */
  const OUTPUT_LINE_CAP = 120;
  const OUTPUT_CHAR_CAP = 12 * 1024;
  let forwardedLines = 0;
  let forwardedChars = 0;
  let droppedOutput = 0;
  let pendingStdout = '';
  let stderrTail = '';

  /** 将内核某一路输出按行转发到面板日志（超出上限时停止并说明）。 */
  const forward = (which, chunk, isTail) => {
    const text = isTail ? chunk : (pendingStdout += chunk);
    const parts = text.split(/\r?\n/);
    if (!isTail) pendingStdout = parts.pop();
    for (const line of parts) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      if (forwardedLines >= OUTPUT_LINE_CAP || forwardedChars >= OUTPUT_CHAR_CAP) {
        droppedOutput += 1;
        continue;
      }
      forwardedLines += 1;
      forwardedChars += trimmed.length;
      log('info', `内核[${which}] ${trimmed}`);
    }
  };

  const attach = (stream, which, isTail) => {
    if (!stream) return;
    if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const text = String(chunk);
      if (isTail) stderrTail = (stderrTail + text).slice(-2000);
      forward(which, text, isTail);
    });
    // 管道自身出错（极少见）不应导致扩展崩溃，也不应产生未捕获异常。
    stream.on('error', () => {});
  };

  attach(child.stdout, 'out', false);
  attach(child.stderr, 'err', true);

  let disposed = false;
  child.on('error', (error) => {
    log('error', `后台 DSH 启动失败：${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (disposed) return;
    if (droppedOutput > 0) {
      log('warn', `后台 DSH 的输出还有 ${droppedOutput} 行没记（超过 ${OUTPUT_LINE_CAP} 行了，只留了前面这些）`);
    }
    // 并非由本扩展回收 —— 该进程自行退出。此类情形需要排查。
    log('warn', `后台 DSH 自己退出了（code=${code} signal=${signal}）`);
    const tail = stderrTail.trim();
    if (tail) {
      const last = tail.split(/\r?\n/).filter((line) => line.trim()).slice(-8);
      log('warn', `它退之前最后说的话：\n${last.join('\n')}`);
    } else {
      log('warn', '它一个字都没说就退了（stderr 是空的）—— 通常是外面有人把它杀了，不是它自己崩的');
    }
  });

  return {
    child,
    /** 内核自行输出的最后一段 stderr（可能为空）。 */
    stderrTail() {
      return stderrTail.trim();
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
        log(alreadyExited ? 'info' : 'warn', `停止后台 DSH 失败：${error.message}`);
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
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} 失败：${detail || error.message}`);
  }
}

/**
 * 内核刚退出时，先读取其自身输出，再决定向用户提供何种建议。
 *
 * 需要该步骤的原因（2026-09-19 的经验）：内核退出原因有多种，而面板原先
 * 一律推测为"dsh 不在 PATH 里"。最典型的一次是 `--profile desktop`：
 * DSH 回的是 `profile "desktop" is managed exclusively by the Electron
 * application` —— **该档无法通过命令行启动**，用户按面板的建议修改
 * dshCommand 无效果。因此：可识别的原因如实说明，无法识别时才回退到推测，
 * 并将原文完整附于其后，不作删减。
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
      // 插件数量较多的档通常能力更强（用户的档即属此类），因此按 bundles 数量降序排列。
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
  dshCommandCandidates,
  explainKernelFailure,
  panelProfileCandidates,
};
