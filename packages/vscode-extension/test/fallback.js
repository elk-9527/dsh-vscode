'use strict';

/**
 * 自启动内核的集成测试：端口上没有服务时，扩展需要自行启动内核。
 *
 * 这是最常见的路径（刚开机，或用户未启动桌面端），因此需要单独测试：
 * 启动 → 等待 ACP 接入点插件（dsh-acp-door）就绪 → 握手 → 建立会话 → 运行一个真实回合 →
 * 收尾时把内核进程彻底终止（不留孤儿进程占用端口）。
 *
 * 端口：默认 47821（与面板默认值一致）。桌面端运行时该端口上已存在该插件，
 * 因此该测试无法验证「从零启动」。端口可通过环境变量更换：
 *
 *     $env:DSH_PANEL_TEST_PORT = '47830'; node test/fallback.js
 *
 * 更换端口后测试会给内核附加一个 `--patch`，把该插件固定到那个端口上
 * （该插件所在行的 config 是整段替换的，因此 patch 中必须写全每个字段）。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const SCRATCH = path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch');

/** 测试使用哪个端口：默认与面板默认值一致，可用 DSH_PANEL_TEST_PORT 指定一个空闲端口。 */
const PORT = Number(process.env.DSH_PANEL_TEST_PORT || 47821);

/**
 * 把该插件固定到 PORT 上的那个 `--patch` 文件。
 *
 * 仅在更换端口时需要：该插件所在行的 config 是整段替换的（实测：
 * 只写 port 时 host/provider/model/preset 会一并消失），因此此处把
 * 每个字段都完整写出。PORT 为 47821 时返回 null —— 档中本已配置该端口，无需补充。
 */
function writeDoorPortPatch() {
  if (PORT === 47821) return null;
  const file = path.join(os.tmpdir(), `dsh-panel-test-door-${PORT}.yml`);
  const body = [
    '# 测试用：把该插件固定到这个端口上（test/fallback.js 生成，可随时删）。',
    '# 该插件那一行的 config 是整段替换的，所以每个字段都要写全。',
    '- id: acp-door',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${PORT}`,
    '    provider: opencode-go',
    '    model: deepseek-v4.1-flash',
    '    preset: standard',
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const PATCH = writeDoorPortPatch();

const configValues = {
  host: '127.0.0.1',
  port: PORT,
  // 面板自启动的内核把该插件固定在这个端口上（环境变量 DSH_ACP_DOOR_PORT）。
  // 此处令其与 PORT 一致：前面的 --patch 也固定同一个端口，两条路径不冲突。
  selfStartPort: PORT,
  autoStart: true, // ← 本套件验证的配置项
  // 生产默认值是 desktop（用户自身的档）。测试中刻意改用 dshdoor：
  // 以测试身份启动用户的真实配置会写入该用户的档与记忆 —— 测试不应具有该权限。
  fallbackProfile: 'dshdoor',
  dshCommand: 'dsh',
  provider: '',
  model: '',
  // 前几节验证的是"收尾必须彻底"，因此此处统一为"面板关闭即回收"（旧行为）。
  // 宽限期路径（销毁不终止、重新打开继续使用）在 §6 单独调大后再验证。
  kernelIdleMinutes: 0,
  cwd: SCRATCH,
};

const mockVscode = {
  version: '1.99.0-mock',
  Uri: {
    joinPath: (base, ...parts) => ({
      fsPath: [base.fsPath || String(base), ...parts].join('/'),
      toString: () => [base.fsPath || String(base), ...parts].join('/'),
    }),
    parse: (value) => ({ toString: () => value }),
    file: (value) => ({ fsPath: value, toString: () => value }),
  },
  env: { openExternal: () => Promise.resolve(true) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: SCRATCH } }],
    getConfiguration: () => ({ get: (key) => configValues[key] }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-mock';
  return originalResolve.call(this, request, ...rest);
};
require.cache['vscode-mock'] = {
  id: 'vscode-mock',
  filename: 'vscode-mock',
  loaded: true,
  exports: mockVscode,
  children: [],
  paths: [],
};

const { DshPanelView } = require('../src/panel/view');
const { probePort } = require('../src/door/locate');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
}

function makeFakeView() {
  const messages = [];
  return {
    messages,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://mock',
      asWebviewUri: (uri) => ({ toString: () => `https://webview.local/${uri.toString()}` }),
      onDidReceiveMessage: (callback) => {
        return { dispose() {} };
      },
      postMessage: async (message) => {
        messages.push({ at: Date.now(), message });
        return true;
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
}

function waitFor(predicate, { totalMs = 200000, intervalMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + totalMs;
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('等待超时'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

(async () => {
  /** 全部日志行（供测试自身使用：失败时可确认实际尝试了哪些路径）。 */
  const logLines = [];
  const log = (level, message) => {
    logLines.push(`[${level}] ${message}`);
    if (level !== 'info') console.log(`     [${level}] ${message}`);
    else if (process.env.DSH_PANEL_TEST_VERBOSE) console.log(`     [info] ${message}`);
  };

  section('0. 前置：端口必须是空的');
  const alreadyUp = await probePort('127.0.0.1', PORT, 800);
  if (alreadyUp) {
    // 这不属于失败，而是「当前无法测试」：该测试要验证「从零启动一个内核」，
    // 而该端口上已有进程在运行（例如桌面端 DSH，或用户正在使用的 VS Code）。
    // 用退出码 2 表示跳过，使上层能与真实失败区分。
    console.log(`  ⏭  ${PORT} 上已有一个 DSH 在运行，当前无法执行该测试。`);
    console.log('     该套件验证的是「从零启动」，要求端口空闲。两种处理方式：');
    console.log('     ① 关闭桌面端 DSH（或手工启动的试验实例）后重新运行；');
    console.log(`     ② 换一个空闲端口：$env:DSH_PANEL_TEST_PORT = '47830'; node test/fallback.js`);
    console.log('     —— 按「跳过」处理，不计为失败。');
    process.exit(2);
  }
  console.log(`  ✅ ${PORT} 是空的，可以测自启内核这条路了${PATCH ? `（该插件固定在 ${PORT}，patch：${PATCH}）` : ''}`);

  section('1. 打开面板 → 应该自己把内核拉起来');
  const panel = new DshPanelView({
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    log,
    // 更换端口时，把该插件也指向该端口（生产路径不传此参数）。
    spawnArgs: PATCH ? ['--patch', PATCH] : [],
  });
  const view = makeFakeView();
  panel.resolveWebviewView(view);

  const started = Date.now();
  await panel.onWebviewMessage({ type: 'ready' });
  const took = Date.now() - started;

  const statuses = view.messages
    .filter((item) => item.message.type === 'status')
    .map((item) => item.message);
  const notices = view.messages
    .filter((item) => item.message.type === 'notice')
    .map((item) => item.message.text);
  console.log(`     状态序列：${statuses.map((s) => `${s.state}/${s.detail}`).join(' → ')}`);
  console.log(`     对话流提示：${notices.join(' ｜ ') || '（无）'}`);

  check(
    '顶栏说的是短状态（没有把「正在后台启动 DSH（档：…）」放进顶栏）',
    statuses.every((s) => String(s.detail || '').length <= 24 && !/\n/.test(String(s.detail || ''))),
    JSON.stringify(statuses.map((s) => s.detail)),
  );
  check(
    '「正在启动 DSH」这件事说在对话流里',
    notices.some((text) => /正在启动 DSH/.test(text)),
    JSON.stringify(notices),
  );
  // 用户曾对这条路径上的文案提出意见（原话：认为"没有现成的内核，正在启动一个
  // （档：vscode-panel）。第一次会慢一点…"过长）。自启动路径最容易产生长句，
  // 因此在此固定一条约束：自身生成的文案要短，引用行可略长。
  check(
    '自启这条路上的提示也都短（第一行 ≤32 字，引用行 ≤80 字，最多三行）',
    notices.every((text) => {
      const lines = String(text || '').split('\n');
      if (lines.length > 3) return false;
      return lines.every((line, index) => {
        const quoted = index > 0 && /^(原因|内核原话)：/.test(line);
        return line.length <= (quoted ? 80 : 32);
      });
    }),
    JSON.stringify(notices),
  );
  check('最终连上了', statuses.some((s) => s.state === 'ready'), JSON.stringify(statuses.at(-1)));
  check('拿到了会话', Boolean(panel.session && panel.session.sessionId), String(panel.session && panel.session.sessionId));
  check('确实是由本扩展拉起的（记着那个后台进程）', Boolean(panel.background), 'panel.background 是空的');
  console.log(`     从零到可用耗时 ${(took / 1000).toFixed(1)}s`);

  section('2. 自己拉起来的连接也能干活');
  const before = view.messages.length;
  await panel.onWebviewMessage({
    type: 'send',
    text: '用一句话回答：你现在连的是哪个模型？不要用工具。',
  });
  const after = view.messages.slice(before).map((item) => item.message);
  check('收到正文', after.some((item) => item.type === 'text' && item.delta), JSON.stringify(after.map((i) => i.type)));
  check('回合正常结束', after.some((item) => item.type === 'done'));
  check('没有错误', !after.some((item) => item.type === 'error'), JSON.stringify(after.filter((i) => i.type === 'error')));

  section('3. 自己拉起来的那个内核要能复用，不能每连一次就多起一个');
  {
    // 目标中写明"内核由插件按需启动并可复用"。复用有两种情形：
    //   ① 桌面端已启动 → 直接连接该内核（vscode-check 的接入模式那 11 项验证的就是这条）；
    //   ② 自行启动的内核仍在运行 → 断线重连时继续使用它，不再启动新的内核。
    // 情形 ② 此前没有测试覆盖，而它最容易出现的缺陷是「重连时再次 spawn」——
    // 该类缺陷在界面上无法观察（功能仍可用），只会在进程列表中不断累积。
    const pidBefore = panel.background && panel.background.child && panel.background.child.pid;
    const backgroundBefore = panel.background;

    // 断开客户端连接，等价于内核侧网络抖动或 DSH 重启。
    panel.client.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    check('断线后会话被放掉了（下次发送会重连）', !panel.session, String(panel.session));
    check('断线不会把自启的那个内核收掉（留着复用）', Boolean(panel.background), 'background 没了');

    const resumeIndex = view.messages.length;
    await panel.onWebviewMessage({ type: 'send', text: '断线重连之后，回一句话确认你还活着。' });
    const resumeMessages = view.messages.slice(resumeIndex).map((item) => item.message);

    const pidAfter = panel.background && panel.background.child && panel.background.child.pid;
    check('重连时复用了同一个内核（没有另起一个）',
      pidBefore === pidAfter && panel.background === backgroundBefore,
      `pid ${pidBefore} → ${pidAfter}`);
    check('重连后仍可正常工作', resumeMessages.some((item) => item.type === 'done'),
      JSON.stringify(resumeMessages.map((i) => i.type)));
    check('重连过程没有报错', !resumeMessages.some((item) => item.type === 'error'),
      JSON.stringify(resumeMessages.filter((i) => i.type === 'error').map((i) => i.message)));
  }

  section('4. 关闭面板必须回收干净（Windows 上最容易漏）');
  const childPid = panel.background && panel.background.child && panel.background.child.pid;
  console.log(`     后台 DSH 的 pid：${childPid}`);
  panel.dispose();

  let portFreed = false;
  try {
    await waitFor(async () => !(await probePort('127.0.0.1', PORT, 400)), {
      totalMs: 30000,
      intervalMs: 600,
    });
    portFreed = true;
  } catch {
    portFreed = false;
  }
  check('端口被释放了（后台 DSH 真的被杀了）', portFreed, portFreed ? '' : '30s 内端口还占着，可能留了孤儿进程');

  if (childPid) {
    const { execFileSync } = require('node:child_process');
    let stillThere = false;
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${childPid}`, '/NH'], { encoding: 'utf8' });
      stillThere = out.includes(String(childPid));
    } catch {
      stillThere = false;
    }
    check('进程树上没有残留的 dsh 进程', !stillThere, `pid ${childPid} 还在`);
  }

  section('5. 设置里那个档起不来时，要自己换一个（2026-09-19 用户就是这么挂的）');
  {
    /*
     * 用户当日报告：面板提示「没能启动 DSH 内核」，档为 desktop。
     * 实际原因是内核返回 `profile "desktop" is managed exclusively by the Electron
     * application` —— 该档无法通过命令行启动（桌面端独占），而它恰好是当时的默认值。
     * 结果是：桌面端未启动时面板必然无法启动，而面板自行启动恰恰是此时最需要的。
     *
     * 本节使用真实的 desktop 档运行一遍（该档立即退出、不改变任何状态），验证：
     *   ① 设置中的档排在首位（尊重用户配置）；
     *   ② 扫描出的备选档中存在可用档；
     *   ③ 确实切换过去、连接成功并建立会话；
     *   ④ 全程未向对话流输出错误（因为最终成功）。
     */
    const { panelProfileCandidates } = require('../src/door/locate');
    const realProfiles = panelProfileCandidates({ configured: 'desktop', homedir: os.homedir() });
    console.log(`     这台机器上的候选档：${realProfiles.join(' → ')}`);
    check('候选档：设置里的 desktop 排第一（用户明确指定了就尊重他）',
      realProfiles[0] === 'desktop', realProfiles.join(' | '));
    const spare = realProfiles.filter((name) => name !== 'desktop');
    check('候选档：扫出了别的能自己启动的档（否则没有退路）',
      spare.length > 0, realProfiles.join(' | '));

    if (spare.length > 0) {
      const savedProfile = configValues.fallbackProfile;
      const savedCommand = configValues.dshCommand;
      /*
       * 强制其走「普通命令行」路径：`dshCommand` 指向 bin.js，不使用 PATH 上的
       * `dsh`。采用该方式的依据（2026-09-19 查明）：
       *
       * PATH 上的 `dsh` 是桌面端自身的垫片（DSH Desktop.exe 带
       * ELECTRON_RUN_AS_NODE 运行 desktop-cli.js），该垫片能够启动 desktop 档。
       * 但该垫片位于 `…\host-commands\desktop\generations\<哈希>\bin\` 这类
       * 一次性目录中 —— 桌面端每次换代都会更换路径。因此启动较早的 VS Code
       * 进程，其 PATH 可能仍指向已被删除的那一代：`dsh` 无法找到，而 `node bin.js`
       * 又会拒绝 desktop 档（"managed exclusively by the Electron application"）。
       * 两条路径同时失败，即为用户当日观察到的现象。
       */
      const realBin = path.join(
        os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
      );
      const haveBin = fs.existsSync(realBin);
      configValues.fallbackProfile = 'desktop';
      if (haveBin) configValues.dshCommand = `node ${realBin}`;
      const panel2 = new DshPanelView({
        extensionUri: { fsPath: path.resolve(__dirname, '..') },
        log,
        spawnArgs: PATCH ? ['--patch', PATCH] : [],
      });
      const view2 = makeFakeView();
      panel2.resolveWebviewView(view2);

      // 记录实际使用的档（spawnFallback 的返回值中包含该信息）。
      let chosen = null;
      const realSpawnFallback = panel2.spawnFallback.bind(panel2);
      panel2.spawnFallback = async (cfg) => {
        chosen = await realSpawnFallback(cfg);
        return chosen;
      };

      const logFrom = logLines.length;
      const startedAt = Date.now();
      await panel2.onWebviewMessage({ type: 'ready' });
      const took = Date.now() - startedAt;
      console.log(`     从零到可用耗时 ${(took / 1000).toFixed(1)}s（这里含一次注定失败的 desktop 尝试）`);
      const mine = logLines.slice(logFrom);
      const attempts = mine.filter((line) => /尝试启动/.test(line)).map((line) => line.replace(/^\[info\] /, ''));
      console.log(`     试过的路：${attempts.join(' ｜ ')}`);
      const said = mine.filter((line) => /内核退出原因/.test(line)).map((line) => line.replace(/^\[warn\] /, ''));
      if (said.length) console.log(`     内核自己说的：${said.join(' ｜ ')}`);

      check('换档之后连上了', chosen && chosen.ok === true, JSON.stringify(chosen));
      check('没有死在 desktop 上（普通命令行起不来那个档）',
        Boolean(chosen && chosen.profile && chosen.profile !== 'desktop'),
        `用了 ${chosen && chosen.profile} —— 如果哪天普通命令行也能起 desktop 了，这条断言就该改`);
      if (haveBin) {
        check('内核拒绝 desktop 档的原话被读到了（不再靠猜）',
          said.some((line) => /managed exclusively/i.test(line)) ||
            attempts.filter((line) => /配置集：desktop/.test(line)).length === 0,
          JSON.stringify(said));
        check('先尝试 desktop 配置集，失败后换用其它配置集',
          attempts.some((line) => /配置集：desktop/.test(line)) &&
            attempts.some((line) => !/配置集：desktop/.test(line)),
          attempts.join(' | '));
      }
      check('拿到会话了', Boolean(panel2.session && panel2.session.sessionId),
        String(panel2.session && panel2.session.sessionId));

      const messages2 = view2.messages.map((item) => item.message);
      check('成功了就不该往对话流里甩错误',
        !messages2.some((item) => item.type === 'error'),
        JSON.stringify(messages2.filter((i) => i.type === 'error').map((i) => i.message)));
      const topDetail = messages2.filter((i) => i.type === 'status').map((i) => String(i.detail || ''));
      check('顶栏始终是短状态', topDetail.every((text) => text.length <= 24 && !/\n/.test(text)),
        JSON.stringify(topDetail));

      const child2 = panel2.background && panel2.background.child;
      const pid2 = child2 && child2.pid;
      panel2.dispose();
      let freed2 = false;
      try {
        await waitFor(async () => !(await probePort('127.0.0.1', PORT, 400)), { totalMs: 30000, intervalMs: 600 });
        freed2 = true;
      } catch {
        freed2 = false;
      }
      check('换档拉起的那个内核也被收干净了', freed2, `pid ${pid2} 的端口 30s 内没释放`);
      configValues.fallbackProfile = savedProfile;
      configValues.dshCommand = savedCommand;
    }
  }

  /*
   * §6 视图销毁不等于内核死亡（2026-09-19 "聊两句就断" 的结构性修复）。
   *
   * 使用真实进程验证：启动一个内核 → 销毁面板视图 → 断言内核仍在运行
   * （旧代码在此处执行 killTree，用户观察到的现象是"断线"）→ 再建立面板 →
   * 断言其复用同一个 pid、未启动新进程，且会话直接可用。
   */
  if (!alreadyUp) {
    section('6. 视图销毁不等于内核死亡（重开面板继续用同一个内核）');
    const saved = {
      port: configValues.port,
      selfStartPort: configValues.selfStartPort,
      kernelIdleMinutes: configValues.kernelIdleMinutes,
      autoStart: configValues.autoStart,
      fallbackProfile: configValues.fallbackProfile,
      dshCommand: configValues.dshCommand,
    };
    // 自启动的内核运行在 PORT（§5 末尾刚释放），attach 目标指向一个空闲端口，
    // 强制其走"自行启动"路径。
    //
    // ⚠️ attach 目标不得使用 PORT + 1：面板默认的自启动端口正是 47831，
    // 而用户使用 VS Code 面板时该端口上存在正在使用的内核 —— 此时会
    // "连接到其他内核"，使 A/B 两段（销毁不终止内核、重新打开复用同一个）失去意义
    // （实测已出现）。应选择较远的、未被使用的端口。
    configValues.autoStart = true;
    configValues.port = PORT + 4;
    configValues.selfStartPort = PORT;
    configValues.kernelIdleMinutes = 5; // 宽限 5 分钟：销毁之后内核必须仍在运行
    configValues.fallbackProfile = 'dshdoor';
    if (!configValues.dshCommand || configValues.dshCommand === 'dsh') {
      const realBin = path.join(
        os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
      );
      if (fs.existsSync(realBin)) configValues.dshCommand = `node ${realBin}`;
    }

    const panelA = new DshPanelView({
      extensionUri: { fsPath: path.resolve(__dirname, '..') },
      log,
      spawnArgs: PATCH ? ['--patch', PATCH] : [],
    });
    panelA.resolveWebviewView(makeFakeView());
    await panelA.onWebviewMessage({ type: 'ready' });
    const childA = panelA.background && panelA.background.child;
    const pidA = childA && childA.pid;
    check('A：面板自己把内核拉起来了', Boolean(pidA), String(pidA));
    check('A：该插件监听在"面板自己的端口"上（不是桌面端那个 47821）',
      panelA.targetPort === PORT, `targetPort=${panelA.targetPort}，期望 ${PORT}`);
    check('A：拿到会话了', Boolean(panelA.session && panelA.session.sessionId));

    panelA.dispose(); // ← 该步骤：旧实现会在此处终止内核
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const alive = childA && childA.exitCode === null && childA.signalCode === null;
    check('销毁面板之后，内核**仍在运行**（旧代码至此即中断）', Boolean(alive),
      `pid ${pidA} exitCode=${childA && childA.exitCode}`);
    check('端口还开着', await probePort('127.0.0.1', PORT, 800));
    check('它还在 manager 的表里（等着被复用）', panelA.kernels.size() === 1, String(panelA.kernels.size()));

    // 用户再次打开面板 —— 应继续使用同一个内核，而不是启动新的内核。
    const logFromB = logLines.length;
    const panelB = new DshPanelView({
      extensionUri: { fsPath: path.resolve(__dirname, '..') },
      log,
      spawnArgs: PATCH ? ['--patch', PATCH] : [],
    });
    panelB.resolveWebviewView(makeFakeView());
    await panelB.onWebviewMessage({ type: 'ready' });
    const childB = panelB.background && panelB.background.child;
    /*
     * B 走的是"连接"而不是"重新启动"：先探测 selfStartPort，该插件仍在监听则直接连接。
     * 此时 panelB.background 指向的仍是 A 那个内核的句柄（用于报错与诊断），
     * 并未产生新进程 —— 因此判据是 pid 与表中的那个完全一致。
     */
    const pidB = childB ? childB.pid : panelB.kernels.pidOf(configValues.host, PORT);
    check('B：复用了同一个内核（pid 一样，没有第二个进程）', pidB === pidA, `A=${pidA} B=${pidB}`);
    check('B：manager 里还是只有一个', panelB.kernels.size() === 1, String(panelB.kernels.size()));
    check('B：直接就能用（有会话，不需要等重启）', Boolean(panelB.session && panelB.session.sessionId));
    const linesB = logLines.slice(logFromB);
    check('B：日志说清了"接着用"，没有重新启动内核',
      linesB.some((line) => /接上去|接着用/.test(line)) && !linesB.some((line) => /试着启动/.test(line)),
      JSON.stringify(linesB));
    check('B：原先那个"5 分钟后收掉"的计时被取消了（日志里有原话）',
      linesB.some((line) => /计时取消|又用上/.test(line)), JSON.stringify(linesB));

    panelB.dispose();
    check('用户显式关闭 → 确实回收（不留孤儿）', panelB.kernels.disposeAll('测试收尾') === 1);
    let freed = false;
    try {
      await waitFor(async () => !(await probePort('127.0.0.1', PORT, 400)), { totalMs: 30000, intervalMs: 600 });
      freed = true;
    } catch { freed = false; }
    check('关闭后端口已释放', freed);

    Object.assign(configValues, saved);
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('💥 测试发生异常：', error.stack || error.message);
  process.exit(1);
});
