'use strict';

/**
 * 自启内核的集成测试：端口上什么都没有时，扩展要自己把内核拉起来。
 *
 * 这是**最常见的路径**（刚开机、或者用户根本没开桌面端），所以必须单独测：
 * 拉起 → 等到门开 → 握手 → 建会话 → 跑一个真回合 →
 * 收摊时把内核进程真的杀干净（不留孤儿进程占着端口）。
 *
 * 端口：默认 47821（和面板默认一致）。但桌面端开着的时候那个端口上已经有门了，
 * 这个测试就没法做「从零拉起」。所以端口可以用环境变量换：
 *
 *     $env:DSH_PANEL_TEST_PORT = '47830'; node test/fallback.js
 *
 * 换了端口之后测试会给内核挂一个 `--patch`，把门**钉**到那个端口上
 * （门那一行的 config 是整段替换的，所以 patch 里必须把每个字段都写全）。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const SCRATCH = path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch');

/** 测哪个端口：默认跟面板默认一致，可用 DSH_PANEL_TEST_PORT 换一个空的。 */
const PORT = Number(process.env.DSH_PANEL_TEST_PORT || 47821);

/**
 * 把门钉到 PORT 上的那个 `--patch` 文件。
 *
 * 只在换了端口时才需要：门那一行的 config 是**整段替换**的（实测：
 * 只写 port 的话 host/provider/model/preset 会一起消失），所以这里把
 * 每个字段都照抄一遍。47821 时返回 null —— 档里本来就是那个端口，不用补。
 */
function writeDoorPortPatch() {
  if (PORT === 47821) return null;
  const file = path.join(os.tmpdir(), `dsh-panel-test-door-${PORT}.yml`);
  const body = [
    '# 测试用：把门钉到这个端口上（test/fallback.js 生成，可随时删）。',
    '# 门那一行的 config 是整段替换的，所以每个字段都要写全。',
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
  autoStart: true, // ← 本次测试的主角
  // 生产默认是 desktop（用户自己那一档）。测试里刻意用 dshdoor：
  // 让测试去拉起用户的真实配置，会往他的档和记忆里写东西 —— 测试不该有这个权力。
  fallbackProfile: 'dshdoor',
  dshCommand: 'dsh',
  provider: '',
  model: '',
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
  /** 所有日志行（给测试自己看：失败时能看出它到底试了哪几条路）。 */
  const logLines = [];
  const log = (level, message) => {
    logLines.push(`[${level}] ${message}`);
    if (level !== 'info') console.log(`     [${level}] ${message}`);
    else if (process.env.DSH_PANEL_TEST_VERBOSE) console.log(`     [info] ${message}`);
  };

  section('0. 前置：端口必须是空的');
  const alreadyUp = await probePort('127.0.0.1', PORT, 800);
  if (alreadyUp) {
    // 这不是失败，是「现在没法测」：这个测试要验证「从零拉起一个内核」，
    // 而这个端口上已经有一个在跑了（比如桌面端 DSH，或者你的 VS Code 正开着）。
    // 用退出码 2 表示跳过，让上层能和真失败区分开。
    console.log(`  ⏭  ${PORT} 上已经有一个 DSH 在跑，这个测试现在没法做。`);
    console.log('     它验证的是「从零拉起」，需要端口空着。两个办法：');
    console.log('     ① 关掉桌面端 DSH（或手工起的试验台）再跑；');
    console.log(`     ② 换个空端口跑：$env:DSH_PANEL_TEST_PORT = '47830'; node test/fallback.js`);
    console.log('     —— 按「跳过」处理，不算失败。');
    process.exit(2);
  }
  console.log(`  ✅ ${PORT} 是空的，可以测自启内核这条路了${PATCH ? `（门钉在 ${PORT}，patch：${PATCH}）` : ''}`);

  section('1. 打开面板 → 应该自己把内核拉起来');
  const panel = new DshPanelView({
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    log,
    // 换了端口时，把门也指过去（生产路径不传这个）。
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
    '顶栏说的是短状态（没有把「正在后台启动 DSH（档：…）」塞进顶栏）',
    statuses.every((s) => String(s.detail || '').length <= 24 && !/\n/.test(String(s.detail || ''))),
    JSON.stringify(statuses.map((s) => s.detail)),
  );
  check(
    '「正在启动内核」这件事说在对话流里',
    notices.some((text) => /正在启动一个/.test(text)),
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
    // 目标里写的是"内核由插件自己按需拉起**并可复用**"。复用有两种：
    //   ① 桌面端已经开着 → 直接接它的（vscode-check 的接入模式那 11 项验的就是这条）；
    //   ② 自己拉起来的那个还在跑 → 断线重连时**接着用它**，别再拉一个。
    // ② 以前没有测试盯着，而它最容易坏的地方是「重连时又 spawn 一个」——
    // 那种 bug 在界面上看不出来（照样能用），只会在进程列表里越堆越多。
    const pidBefore = panel.background && panel.background.child && panel.background.child.pid;
    const backgroundBefore = panel.background;

    // 掐断客户端连接，等价于内核那边网络抖了一下 / DSH 重启了。
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
    check('重连后照样能干活', resumeMessages.some((item) => item.type === 'done'),
      JSON.stringify(resumeMessages.map((i) => i.type)));
    check('重连过程没有报错', !resumeMessages.some((item) => item.type === 'error'),
      JSON.stringify(resumeMessages.filter((i) => i.type === 'error').map((i) => i.message)));
  }

  section('4. 收摊必须杀干净（Windows 上最容易漏）');
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
     * 用户当天的原话：面板报「没能启动 DSH 内核」，档是 desktop。
     * 真因是内核回了 `profile "desktop" is managed exclusively by the Electron
     * application` —— **那个档命令行起不来**（桌面端独占），而它恰好是当时的默认值。
     * 结果就是：桌面端没开的时候面板必然起不来，而面板自己起来恰恰是那时候最需要的。
     *
     * 这一节用**真的** desktop 档跑一遍（它秒退、不改任何状态），验证：
     *   ① 设置里那个档排第一（尊重用户）；
     *   ② 扫出来的备选里有能用的档；
     *   ③ 真的换过去、并且连上了、建出了会话；
     *   ④ 全程没有把错误甩到对话流里（因为最后成功了）。
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
       * 逼它走「普通命令行」这条路：`dshCommand` 指到 bin.js，不碰 PATH 上那个
       * `dsh`。为什么必须这样（2026-09-19 查清楚的）：
       *
       * PATH 上的 `dsh` 是**桌面端自己的垫片**（DSH Desktop.exe 带
       * ELECTRON_RUN_AS_NODE 跑 desktop-cli.js），它反而**能**把 desktop 档跑起来。
       * 但那个垫片住在 `…\host-commands\desktop\generations\<哈希>\bin\` 这种
       * 一次性的目录里 —— 桌面端每次换代都换路径。所以一个**开得早**的 VS Code
       * 进程，PATH 里可能还指着已经被删掉的那一代：`dsh` 找不到，而 `node bin.js`
       * 又会拒绝 desktop 档（"managed exclusively by the Electron application"）。
       * **两条路一起死**，就是用户当天看到的样子。
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

      // 记住它到底用了哪个档（spawnFallback 的返回值里带着）。
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
      const attempts = mine.filter((line) => /试着启动/.test(line)).map((line) => line.replace(/^\[info\] /, ''));
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
            attempts.filter((line) => /档：desktop/.test(line)).length === 0,
          JSON.stringify(said));
        check('它先试了 desktop，然后才换档',
          attempts.some((line) => /档：desktop/.test(line)) &&
            attempts.some((line) => !/档：desktop/.test(line)),
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

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('💥 测试崩了：', error.stack || error.message);
  process.exit(1);
});
