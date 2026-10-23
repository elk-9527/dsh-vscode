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

const SCRATCH = require('./helpers/door').createTestWorkspace('fallback');
const workspaceState = require('./helpers/workspace-state').createWorkspaceState(path.join(SCRATCH, '.workspace-state.json'));

/** 测试使用哪个端口：默认与面板默认值一致，可用 DSH_PANEL_TEST_PORT 指定一个空闲端口。 */
const PORT = Number(process.env.DSH_PANEL_TEST_PORT || 47821);

/**
 * 把该插件固定到 PORT 上的那个 `--patch` 文件。
 *
 * 仅在更换端口时需要：该插件所在行的 config 是整段替换的，
 * 只写 port 时会清除其他字段，因此此处把
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
    // Do not pin a developer-machine model: DSH 0.2 validates the route during
    // session creation.  Omitting both fields exercises the production default.
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
  dshCommand: process.env.DSH_PANEL_DSH || 'dsh',
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
// Real-process tests must never fall back to a daily configuration set.
DshPanelView.prototype.profilesFor = () => ['dshdoor'];
const { probePort } = require('../src/door/locate');
const {
  desktopExecutablesForTest,
  isMissingModelCredentials,
  syncDoor,
} = require('./helpers/door');

let passed = 0;
let failed = 0;
let modelSkipped = false;
const failures = [];
const testPanels = new Set();
function createPanel(options) {
  const panel = new DshPanelView({ workspaceState, ...options });
  testPanels.add(panel);
  return panel;
}
async function cleanupPanels() {
  const managers = new Set();
  for (const panel of testPanels) { panel.dispose(); managers.add(panel.kernels); }
  for (const manager of managers) manager.disposeAll('测试收尾');
  await Promise.all([...managers].map(manager => manager.waitForCleanup()));
}

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
    const tick = async () => {
      try { if (await predicate()) return resolve(true); }
      catch (error) { return reject(error); }
      if (Date.now() > deadline) return reject(new Error('等待超时'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

let sendSequence = 0;
async function sendMessage(panel, view, text) {
  const requestId = `fallback-${++sendSequence}`;
  const start = view.messages.length;
  await panel.onWebviewMessage({ type: 'send', requestId, text });
  const result = () => view.messages.slice(start).map(item => item.message).find(message => message.requestId === requestId &&
    (message.type === 'sendCompleted' || message.type === 'sendResult' && message.phase === 'rejected'));
  await waitFor(() => Boolean(result()));
  return result();
}

(async () => {
  /** 全部日志行（供测试自身使用：失败时可确认实际尝试了哪些路径）。 */
  const logLines = [];
  const log = (level, message) => {
    logLines.push(`[${level}] ${message}`);
    if (level !== 'info') console.log(`     [${level}] ${message}`);
    else if (process.env.DSH_PANEL_TEST_VERBOSE) console.log(`     [info] ${message}`);
  };

  // A clean DSH 0.2 installation only has the Electron-managed desktop profile.
  // Prepare the hard-coded test profile before exercising the panel's startup path.
  syncDoor({ log });
  const desktopExecutables = desktopExecutablesForTest({ log });

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
    return 2;
  }
  console.log(`  ✅ ${PORT} 是空的，可以测自启内核这条路了${PATCH ? `（该插件固定在 ${PORT}，patch：${PATCH}）` : ''}`);

  section('1. 打开面板 → 应该自己把内核拉起来');
  const panel = createPanel({
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    log,
    desktopExecutables,
    // 更换端口时，把该插件也指向该端口（生产路径不传此参数）。
    spawnArgs: [...require('./helpers/door').testPatchArgs(), ...(PATCH ? ['--patch', PATCH] : [])],
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
  check('启动过程不向对话流插入说明卡片', notices.length === 0, JSON.stringify(notices));
  // 启动提示采用短句；引用的内核诊断允许较长的行。
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
  if (!panel.client || !panel.session?.sessionId) throw new Error('自启内核未建立会话，无法继续模型与复用验收。');

  section('2. 自己拉起来的连接也能干活');
  const before = view.messages.length;
  await sendMessage(panel, view, '用一句话回答：你现在连的是哪个模型？不要用工具。');
  const after = view.messages.slice(before).map((item) => item.message);
  const modelUnavailable = after.some(
    (item) => item.type === 'error' && isMissingModelCredentials(item.message),
  );
  if (modelUnavailable) {
    modelSkipped = true;
    console.log('  ⏭  测试环境没有当前模型的凭据；保留启动/连接断言，跳过正文断言。');
  } else {
    check('收到正文', after.some((item) => item.type === 'text' && item.delta), JSON.stringify(after.map((i) => i.type)));
    check('没有错误', !after.some((item) => item.type === 'error'), JSON.stringify(after.filter((i) => i.type === 'error')));
  }
  check('回合正常结束', after.some((item) => item.type === 'done'));

  section('3. 自己拉起来的那个内核要能复用，不能每连一次就多起一个');
  {
    // 后台内核应按需启动并复用。复用有两种情形：
    //   ① 桌面端已启动 → 直接连接该内核（vscode-check 的接入模式那 11 项验证的就是这条）；
    //   ② 自行启动的内核仍在运行 → 断线重连时继续使用它，不再启动新的内核。
    // 断线重连须复用存活内核，避免连接仍可用但每次重连都累积新进程。
    const pidBefore = panel.background && panel.background.child && panel.background.child.pid;
    const backgroundBefore = panel.background;

    // 断开客户端连接，等价于内核侧网络抖动或 DSH 重启。
    panel.client.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    check('断线后会话被放掉了（下次发送会重连）', !panel.session, String(panel.session));
    check('断线不会把自启的那个内核收掉（留着复用）', Boolean(panel.background), 'background 没了');

    const resumeIndex = view.messages.length;
    if (modelUnavailable) await panel.ensureConnection();
    else await sendMessage(panel, view, '断线重连之后，回一句话确认你还活着。');
    const resumeMessages = view.messages.slice(resumeIndex).map((item) => item.message);

    const pidAfter = panel.background && panel.background.child && panel.background.child.pid;
    check('重连时复用了同一个内核（没有另起一个）',
      pidBefore === pidAfter && panel.background === backgroundBefore,
      `pid ${pidBefore} → ${pidAfter}`);
    if (!modelUnavailable) check('重连后仍可正常工作', resumeMessages.some((item) => item.type === 'done'),
      JSON.stringify(resumeMessages.map((i) => i.type)));
    else check('缺少凭据时仅确认重连建立会话', Boolean(panel.session?.sessionId));
    const resumeModelUnavailable = modelUnavailable || resumeMessages.some(
      (item) => item.type === 'error' && isMissingModelCredentials(item.message),
    );
    if (resumeModelUnavailable) {
      modelSkipped = true;
      console.log('  ⏭  重连已成功；因测试环境缺少模型凭据，跳过回复内容断言。');
    } else {
      check('重连过程没有报错', !resumeMessages.some((item) => item.type === 'error'),
        JSON.stringify(resumeMessages.filter((i) => i.type === 'error').map((i) => i.message)));
    }
  }

  section('4. 关闭面板必须回收干净（Windows 上最容易漏）');
  const childPid = panel.background && panel.background.child && panel.background.child.pid;
  console.log(`     后台 DSH 的 pid：${childPid}`);
  panel.dispose();
  await panel.kernels.waitForCleanup();

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

  section('5. 日常配置集的后备切换不在专用配置测试中执行');
  console.log('  ⏭  未运行日常配置集切换；配置候选与失败后备由离线套件覆盖。');

  /*
   * §6 视图销毁不等于内核死亡：空闲期内允许重开视图复用内核。
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
    // PORT 由前面的清理检查释放；连接目标使用另一个空闲端口，强制进入自启路径。
    // 避开默认自启端口，防止已有内核掩盖视图销毁后复用同一进程的断言。
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

    const panelA = createPanel({
      extensionUri: { fsPath: path.resolve(__dirname, '..') },
      log,
      desktopExecutables,
      spawnArgs: [...require('./helpers/door').testPatchArgs(), ...(PATCH ? ['--patch', PATCH] : [])],
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
    const panelB = createPanel({
      extensionUri: { fsPath: path.resolve(__dirname, '..') },
      log,
      desktopExecutables,
      spawnArgs: [...require('./helpers/door').testPatchArgs(), ...(PATCH ? ['--patch', PATCH] : [])],
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
    check('B：重连取消了空闲回收计时',
      linesB.some((line) => /计时取消|又用上/.test(line)), JSON.stringify(linesB));

    panelB.dispose();
    check('用户显式关闭 → 确实回收（不留孤儿）', panelB.kernels.disposeAll('测试收尾') === 1);
    await panelB.kernels.waitForCleanup();
    let freed = false;
    try {
      await waitFor(async () => !(await probePort('127.0.0.1', PORT, 400)), { totalMs: 30000, intervalMs: 600 });
      freed = true;
    } catch { freed = false; }
    check('关闭后端口已释放', freed);

    Object.assign(configValues, saved);
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) console.log(`${modelSkipped ? '⏭  模型回合未验收；' : '✅ 全部通过：'}${passed} 项检查通过`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  return failed ? 1 : modelSkipped ? 2 : 0;
})().then(async code => {
  await cleanupPanels();
  process.exit(code);
}).catch(async (error) => {
  await cleanupPanels();
  console.error('💥 测试发生异常：', error.stack || error.message);
  process.exit(1);
});
