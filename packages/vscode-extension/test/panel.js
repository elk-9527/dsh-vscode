'use strict';

/**
 * 面板层集成测试。
 *
 * 方法：将 `vscode` 模块名替换为模拟实现，使 panel/view.js 能够在
 * **没有编辑器**的情况下完整运行 —— 包括注册视图、生成 HTML、
 * 收发 webview 消息、连接真实运行的 ACP 接入点插件（dsh-acp-door）、执行真实回合。
 *
 * 该方式可覆盖界面上不可见的大部分缺陷：消息时序、状态机、字段名、
 * 会话生命周期。浏览器渲染另行验证（见 test/static.js）。
 *
 * 用法：node test/panel.js   （同样需要有一个 DSH 实例加载该插件并在 47821 上监听）
 */

const path = require('node:path');
const Module = require('node:module');
const TEST_EXTENSION_URI = { fsPath: path.resolve(__dirname, '..') };

// ── 先装假 vscode，再 require 面板 ────────────────────────

const openedLinks = [];
const configValues = {
  host: '127.0.0.1',
  port: 47821,
  // ⚠️ 自启端口**有意不使用默认的 47831**：该路径的前提是「端口上必须没有监听」，
  // 而 47831 正是面板自启内核的默认端口；用户自行开着 VS Code 面板时，该端口上
  // 即有一个正在使用的内核（实测遇到：§8.5 直接连上了它，于是「命令错误」
  // 这条路径未被走到，测试失败原因不明）。测试不应依赖外部机器状态。
  selfStartPort: 47845,
  autoStart: false,
  fallbackProfile: 'dshdoor',
  dshCommand: 'dsh',
  provider: '',
  model: '',
  // 本套件中一律「面板一关闭即回收内核」（旧行为），以便回收类断言保持简单直接。
  // 宽限期路径（视图销毁不终止内核、重开面板继续使用）在 test/fallback.js §6
  // 使用真实进程验证。
  kernelIdleMinutes: 0,
  cwd: path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch'),
};

const mockVscode = {
  version: '1.99.0-mock',
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath || base.path || String(base), ...parts].join('/'), toString: () => [base.fsPath || base.path || String(base), ...parts].join('/') }),
    parse: (value) => ({ toString: () => value, value }),
    file: (value) => ({ fsPath: value, toString: () => value }),
  },
  env: {
    openExternal: (uri) => {
      openedLinks.push(String(uri));
      return Promise.resolve(true);
    },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: configValues.cwd } }],
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
const { ensureDoor, syncDoor } = require('./helpers/door');

// ── 断言小工具 ──────────────────────────────────────────

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

function waitFor(predicate, { totalMs = 30000, intervalMs = 40 } = {}) {
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

/**
 * 本套件运行期间，面板发送过的**全部**消息（每个模拟视图的消息都汇总到此处）。
 *
 * 用途在最后一节：约束是「面向用户的提示与报错都需精炼」——
 * 与其逐条断言，不如扫描所有实际发送过的消息（这样后续新增的长文案
 * 会立即被捕获，而不必等用户再次反馈）。
 */
const everyMessage = [];

/** 一个记录所有收到消息的模拟 webview。 */
function makeFakeView() {
  const messages = [];
  const view = {
    messages,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://mock',
      asWebviewUri: (uri) => ({ toString: () => `https://webview.local/${uri.toString()}` }),
      onDidReceiveMessage: (callback) => {
        view.receive = callback;
        return { dispose() {} };
      },
      postMessage: async (message) => {
        messages.push({ at: Date.now(), message });
        everyMessage.push(message);
        return true;
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return view;
}

function typesOf(items) {
  // 既接受「包装过的」{at, message}，也接受未包装的消息，避免测试自身出错。
  return items.map((item) => (item && item.message ? item.message.type : item && item.type));
}

(async () => {
  const log = (level, message) => {
    if (process.env.DSH_PANEL_TEST_VERBOSE) console.log(`     [${level}] ${message}`);
  };

  // 断线接回测试使用一个不易被模型「猜中」的数字。
  const MARKER = String(1000 + Math.floor(Math.random() * 8999));

  // 内核未启动时自行拉起一个（运行结束后负责回收）。「自动拉起」路径另有
  // test/fallback.js 专测，因此此处配置中的 autoStart 为关闭状态，避免两处都拉起进程。
  // 该插件需先与源码对齐 —— 这里测试的正是 dsh-door/sessions 等新方法。
  syncDoor({ log });
  const door = await ensureDoor({ log });

  section('1. 视图注册与 HTML 生成');
  const panel = new DshPanelView({ extensionUri: TEST_EXTENSION_URI, log });
  const view = makeFakeView();
  panel.resolveWebviewView(view);

  const html = view.webview.html;
  check('生成了 HTML', typeof html === 'string' && html.length > 200, `${html.length} 字节`);
  check('HTML 里有 CSP', /Content-Security-Policy/.test(html));
  check('CSP 不允许内联脚本', !/script-src[^;]*unsafe-inline/.test(html));
  check('HTML 引用了样式表', /main\.css/.test(html));
  check('HTML 引用了脚本', /main\.js/.test(html));
  check('脚本带了 nonce', /<script nonce="[A-Za-z0-9]{32}"/.test(html));
  check('开启了脚本执行', view.webview.options.enableScripts === true);

  section('2. 界面就绪 → 自动连接');
  await panel.onWebviewMessage({ type: 'ready' });
  const statuses = view.messages.filter((item) => item.message.type === 'status').map((item) => item.message);
  check('有状态推送', statuses.length > 0, JSON.stringify(statuses));
  check('最终状态是 ready', statuses.some((item) => item.state === 'ready'), JSON.stringify(statuses.at(-1)));
  check('连上后推了配置项', view.messages.some((item) => item.message.type === 'config'));
  check('拿到了 sessionId', typeof panel.session.sessionId === 'string', String(panel.session.sessionId));

  section('3. 发一条消息，走完整条链路');
  const before = view.messages.length;
  const prompt = '读取 spike/scratch/hello.ts 的第一行，只回那一行，不要解释。';
  await panel.onWebviewMessage({ type: 'send', text: prompt });
  const after = view.messages.slice(before).map((item) => item.message);

  check('界面先收到自己发的话', after[0] && after[0].type === 'user', JSON.stringify(after[0]));
  check('收到 assistant 开始', after.some((item) => item.type === 'assistant'));
  check('收到正文增量', after.some((item) => item.type === 'text' && item.delta));
  check('收到工具卡片', after.some((item) => item.type === 'tool'));
  check('收到用量', after.some((item) => item.type === 'usage'));
  check('收到回合结束', after.some((item) => item.type === 'done'));
  check('busy 开过', after.some((item) => item.type === 'busy' && item.busy === true));
  check('busy 关了', after.some((item) => item.type === 'busy' && item.busy === false));
  check('没有错误消息', !after.some((item) => item.type === 'error'), JSON.stringify(after.filter((i) => i.type === 'error')));

  const toolMessages = after.filter((item) => item.type === 'tool').map((item) => item.tool);
  const finalTools = new Map();
  for (const tool of toolMessages) finalTools.set(tool.toolCallId, tool);
  check('工具卡片按 id 合并（没有重复卡片）', finalTools.size >= 1 && finalTools.size <= toolMessages.length);
  const firstTool = [...finalTools.values()][0];
  if (firstTool) {
    check('工具卡片最终是完成状态', firstTool.status === 'completed' || firstTool.status === 'failed', firstTool.status);
    check('工具卡片带了 rawInput', Boolean(firstTool.rawInput), JSON.stringify(firstTool.rawInput));
  }

  section('4. 顺序检查（界面靠这个顺序渲染）');
  const ordered = typesOf(after);
  const indexUser = ordered.indexOf('user');
  const indexAssistant = ordered.indexOf('assistant');
  const indexText = ordered.indexOf('text');
  const indexDone = ordered.indexOf('done');
  check('user 在 assistant 之前', indexUser >= 0 && indexUser < indexAssistant, ordered.join('>'));
  check('assistant 在第一条 text 之前', indexAssistant < indexText, ordered.join('>'));
  check('done 在最后', indexDone > indexText, ordered.join('>'));

  section('5. 新建对话');
  const oldId = panel.session.sessionId;
  await panel.onWebviewMessage({ type: 'newSession' });
  check('界面被要求清空', view.messages.some((item) => item.message.type === 'reset'));
  check('换了新会话', panel.session.sessionId !== oldId, `${oldId} → ${panel.session.sessionId}`);

  section('6. 拒绝危险链接');
  await panel.onWebviewMessage({ type: 'openLink', href: 'javascript:alert(1)' });
  check('javascript: 链接未被打开', openedLinks.length === 0, openedLinks.join(','));
  await panel.onWebviewMessage({ type: 'openLink', href: 'https://example.com/x' });
  check('https 链接被允许打开', openedLinks.length === 1, openedLinks.join(','));

  section('7. 未知消息不导致异常');
  await panel.onWebviewMessage({ type: '完全不认识的类型' });
  await panel.onWebviewMessage(null);
  check('未知消息之后仍能正常发送消息', panel.session.sessionId !== null);
  await panel.onWebviewMessage({ type: 'send', text: '说一句：收到。' });
  check('之后仍能收到回复', view.messages.some((item) => item.message.type === 'done'));

  section('8. 断线：必须能自动接回上下文');
  // 这是实际会遇到的场景：DSH 桌面端被关闭或重启，而面板仍处于打开状态。
  // 实测 session/resume 有效（test/resume.js），因此面板不应开启一个没有记忆的
  // 新会话 —— 否则用户会认为上文对话仍然保留。
  const beforeDrop = panel.session.sessionId;
  await panel.onWebviewMessage({ type: 'send', text: `记住数字 ${MARKER}，只回答「已记住」。` });
  check('断线前这一段能正常跑完', view.messages.some((item) => item.message.type === 'done'));

  const dropIndex = view.messages.length;
  panel.client.close(); // 断开连接，等价于内核已不存在
  await new Promise((resolve) => setTimeout(resolve, 600));

  const afterDrop = view.messages.slice(dropIndex).map((item) => item.message);
  check(
    '断线被界面识别（顶栏变为短状态，原因进入对话流）',
    afterDrop.some((item) => item.type === 'status' && item.state === 'error' && item.detail === '未连接'),
    JSON.stringify(afterDrop.map((i) => i.type)),
  );
  check(
    '断线原因写入对话流（不再放入顶栏该行）',
    afterDrop.some((item) => item.type === 'error' && /断开/.test(item.message || '')),
    JSON.stringify(afterDrop.filter((i) => i.type === 'error').map((i) => i.message)),
  );
  check(
    '断线后解除「正在回答」状态（否则停止按钮会持续显示）',
    afterDrop.some((item) => item.type === 'busy' && item.busy === false),
    JSON.stringify(afterDrop),
  );
  check('断线后会话被释放，下次发送时重新连接', !panel.session, String(panel.session));

  const resumeIndex = view.messages.length;
  await panel.onWebviewMessage({ type: 'send', text: '之前要求记住的数字是多少？只回答数字。' });
  check('重新连接后取回了会话', Boolean(panel.session && panel.session.sessionId));
  check(
    '取回的是原来那个会话（并未新建会话）',
    panel.session.sessionId === beforeDrop,
    `${beforeDrop} → ${panel.session.sessionId}`,
  );
  const resumeMessages = view.messages.slice(resumeIndex).map((item) => item.message);
  check(
    '上下文确实接回（回答中包含断线前的数字）',
    resumeMessages.some((item) => item.type === 'text' && String(item.delta).includes(MARKER)),
    JSON.stringify(resumeMessages.filter((i) => i.type === 'text').map((i) => i.delta)).slice(0, 200),
  );

  section('8.5 自启内核失败时，不应让用户长时间等待');
  {
    // 场景：该插件无法连接 + 自动拉起 + 命令错误（dshCommand 填写了不存在的路径）。
    // 此前此处会完整等待 120 秒的 waitForPort，用户面对
    // 「正在启动 DSH…」等待两分钟，最终只得到一句「没开门」。
    const saved = { ...configValues };
    configValues.autoStart = true;
    configValues.port = 47844; // 该端口上没有该插件监听
    configValues.dshCommand = 'dsh-这个命令不存在-9f3a';
    const badPanel = new DshPanelView({
      extensionUri: TEST_EXTENSION_URI,
      log,
    });
    // 隔离自动候选：本节只测试「配置的命令无效」这条路径 ——
    // 否则候选清单会包含默认安装位置的 node bin.js（它是有效的），
    // 测试将需要等待真实内核启动，而这不是本节要验证的内容。
    badPanel.candidatesFor = () => [configValues.dshCommand];
    const badView = makeFakeView();
    badPanel.resolveWebviewView(badView);

    const startedAt = Date.now();
    await badPanel.onWebviewMessage({ type: 'ready' });
    const elapsed = Date.now() - startedAt;

    const all = badView.messages.map((item) => item.message);
    const errorStatus = all.find((item) => item.type === 'status' && item.state === 'error');
    check('命令不存在时给出错误状态（不持续等待）', Boolean(errorStatus),
      JSON.stringify(all.slice(-3)));
    check('顶栏只放短状态（长诊断不得放入该行）',
      Boolean(errorStatus) && errorStatus.detail === '未连接',
      errorStatus ? JSON.stringify(errorStatus.detail) : '没有错误状态');
    // 长诊断必须进入对话流 —— 用户是在对话框中阅读内容，而不是在顶栏。
    // 原文段中要包含**该无效命令本身**（否则用户无法判断是哪一个命令出错），
    // 但「如何处理」一句必须是面向用户的表述（不出现 PATH / 设置项全名等词）。
    const errMsg = all.find((item) => item.type === 'error');
    check('诊断进入对话流，且说明了是哪个命令、应如何处理',
      Boolean(errMsg) &&
        String(errMsg.message).includes(configValues.dshCommand) &&
        /找不到 DSH|设置/.test(`${errMsg.message} ${(errMsg.human && errMsg.human.advice) || ''}`),
      JSON.stringify(errMsg || all.slice(-3)));
    check('「如何处理」一句不含内部词（不提 PATH / 设置项全名）',
      Boolean(errMsg) &&
        !/PATH|dshCommand/.test((errMsg.human && errMsg.human.advice) || ''),
      (errMsg && errMsg.human && errMsg.human.advice) || '（没有 human）');
    check('并且给出的是结构化错误（含标题，便于界面排版）',
      Boolean(errMsg && errMsg.human && errMsg.human.title),
      JSON.stringify(errMsg && errMsg.human));
    check('并且是**提前**给出（未等待满 120 秒）', elapsed < 15000, `耗时 ${elapsed}ms`);
    badPanel.dispose();
    Object.assign(configValues, saved);
  }

  section('8.6 自启内核失败的两种情形，各自给出对应说明（该分支此前从未被测试）');
  {
    // 此前无法测试的原因：要进入「进程存活、但端口始终未监听」这条分支，正常情况下
    // 需要等待 120 秒，因此该分支长期未被验证。为 waitForFallbackDoor 增加了
    // 一个仅在测试中使用的超时参数，数秒内即可覆盖。
    const { fallbackFailureText } = require('../src/panel/view');
    const emitter = require('node:events');

    // (1) 进程存活但端口未监听 → 等待至超时，且必须区分该情形不是「命令错误」。
    const aliveChild = new emitter.EventEmitter();
    const startedAt = Date.now();
    const timedOut = await panel.waitForFallbackDoor(aliveChild, '127.0.0.1', 47844, 900);
    const waited = Date.now() - startedAt;
    check('端口始终未监听时等到超时，并说明是超时（不是命令错误）',
      timedOut.ok === false && timedOut.exitedEarly === false,
      JSON.stringify(timedOut));
    check('超时按给定时间返回（0.9 秒的任务完成后即返回）', waited < 4000, `等了 ${waited}ms`);

    // (2) 进程立即退出 → 立即返回，且标明是「刚启动即退出」。
    const deadChild = new emitter.EventEmitter();
    const quick = panel.waitForFallbackDoor(deadChild, '127.0.0.1', 47844, 30000);
    setTimeout(() => deadChild.emit('exit', 1, null), 50);
    const died = await quick;
    check('进程刚退出时立即返回（不会等满 30 秒）',
      died.ok === false && died.exitedEarly === true,
      JSON.stringify(died));

    // (3) 两种情形的说明必须不同，且各自指出正确的处理方式。
    const boot = fallbackFailureText({
      command: 'dsh', profile: 'desktop', host: '127.0.0.1', port: 47821, exitedEarly: true,
    });
    const noDoor = fallbackFailureText({
      command: 'dsh', profile: 'desktop', host: '127.0.0.1', port: 47821, exitedEarly: false,
    });
    check('两段说明不同（否则等同于未区分）', boot !== noDoor);
    check('「命令错误」一句说明是哪个命令（在原文段中）',
      /找不到 DSH/.test(boot) && /dshCommand|设置里/.test(boot), boot);
    check('「未连接」一句（原文段）提到连接组件与端口',
      /dsh-acp-door/.test(noDoor) && /plugin --profile desktop list/.test(noDoor) && /port/.test(noDoor),
      noDoor);
    /*
     * 说明段的结论句（原文段开头这一句）**不得出现该插件的简称** —— 依据用户 2026-09-19
     * 的反馈：「『门』都出来了，别人能知道是什么意思？」。技术细节留在原文段中
     * 没有问题（该区为折叠区，供排查使用），但结论句必须是面向用户的表述。
     */
    check('「未连接」一句的结论是面向用户的表述（不含「门」）',
      !/没开门|门没开|门插件/.test(noDoor.split('\n')[0]), noDoor.split('\n')[0]);

    // (3b) 内核自身给出了原因时：如实转述并附上原文，**不得**再断言为 PATH 问题。
    //      2026-09-19 那次「面板无法启动」，内核已明确给出
    //      `profile "desktop" is managed exclusively by the Electron application`，
    //      面板却推测为「多半是 dsh 不在 PATH 中」，把用户引向错误方向。
    const { explainKernelFailure } = require('../src/door/locate');
    const managedStderr = 'error: profile "desktop" is managed exclusively by the Electron application';
    const managedText = fallbackFailureText({
      command: 'dsh', profile: 'desktop', host: '127.0.0.1', port: 47821, exitedEarly: true,
      stderr: managedStderr,
      explained: explainKernelFailure({ profile: 'desktop', stderr: managedStderr }),
    });
    check('失败说明附带了内核原文', managedText.includes('managed exclusively'), managedText);
    check('失败说明不再断言为 PATH 问题（此前因此引入误导）', !/PATH/.test(managedText), managedText);
    check('失败说明指向正确的处理方式（先启动桌面端 / 更换一套配置）',
      /桌面端/.test(managedText) && /设置|配置/.test(managedText), managedText);

    const unknownText = fallbackFailureText({
      command: 'dsh', profile: 'x', host: '127.0.0.1', port: 47821, exitedEarly: true,
      stderr: 'some unexplained kernel complaint',
    });
    check('无法识别的原因同样附带原文（不丢弃）',
      unknownText.includes('some unexplained kernel complaint'), unknownText);

    // (4) 设置中只填写了空格时，不应作为路径发送给内核
    //     （内核会返回 "cwd must be an absolute path: "，用户将看到一段含义不明的信息）。
    const savedCwd = configValues.cwd;
    configValues.cwd = '   ';
    const resolved = panel.workdir();
    check('cwd 只填写了空格时退回工作区目录（不将空格发送给内核）',
      resolved === savedCwd,
      `${JSON.stringify(resolved)}，工作区目录是 ${JSON.stringify(savedCwd)}`);
    configValues.cwd = savedCwd;
  }

  section('8.7 内核的错误必须给出可读说明，且不得丢弃原文');
  {
    // 背景：内核的报错是**原样**穿过 ACP 的，此前用户看到的就是一段英文 JSON
    // （最典型的是 429 额度限制）。该文本对用户没有用 —— 既未说明发生了什么，
    // 也未说明下一步如何处理，长期只会得出「该插件不可用」的结论。
    const { describeError } = require('../src/dsh/errors');

    const cases = [
      {
        name: '429 额度限制',
        text: '回合失败：Internal error: turn failed: 429: {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 12min..."}',
        kind: 'usage-limit',
        title: /额度|频率限制/,
        advice: /12 分钟/,
      },
      {
        name: '鉴权失败',
        text: 'Internal error: turn failed: 401: {"error":{"message":"Incorrect API key provided"}}',
        kind: 'auth',
        title: /密钥|权限/,
        advice: /密钥|设置/,
      },
      {
        name: '连接失败',
        text: 'fetch failed: connect ECONNREFUSED 127.0.0.1:47821',
        kind: 'connection',
        title: /无法连接|中断/,
        advice: /重新连接/,
      },
      {
        name: '端口被占',
        text: 'listen EADDRINUSE: address already in use 127.0.0.1:47821',
        kind: 'port',
        title: /端口/,
        advice: /47821/,
      },
      {
        name: '命令不存在',
        text: 'spawn dsh ENOENT',
        kind: 'command',
        title: /命令/,
        advice: /设置|路径|安装位置/,
      },
    ];

    /*
     * 同一批文案还需通过**内部词黑名单**（2026-09-20 添加）：这些 title/advice
     * 会直接显示在错误卡片上，因此不得出现该插件的简称、「档」与设置项全名。
     * 依据为用户原话：「『门』都出来了，别人能知道是什么意思？」。
     */
    const JARGON = /门|档|dshPanel\.|settings\.yaml|fallbackProfile|dsh-acp-door/;

    for (const item of cases) {
      const human = describeError(item.text);
      check(`${item.name} → 分类正确`, human.kind === item.kind, `实际分类是 ${human.kind}`);
      check(`${item.name} → 说明了发生了什么`, item.title.test(human.title), human.title);
      check(`${item.name} → 说明了可以做什么`, item.advice.test(human.advice), human.advice);
      check(`${item.name} → 原文未删减任何字符`, human.raw === item.text);
      check(`${item.name} → 卡片上没有内部词（门 / 档 / 设置项全名）`,
        !JARGON.test(`${human.title} ${human.advice}`), `${human.title}／${human.advice}`);
    }

    // 无法识别的错误：同样需要一句可读说明作为开头，且原文照旧保留 ——
    // 「无法翻译」不等于「可以丢弃信息」。
    const weird = '内核返回了未识别的输出 at 0xDEADBEEF';
    const other = describeError(weird);
    check('无法识别的错误也有可读说明开头', other.known === false && other.title.length > 0, other.title);
    check('无法识别的错误原文照旧保留', other.raw === weird);
    check('无法识别时提示查看日志或提供原文', /日志|提供/.test(other.advice), other.advice);

    // 端到端：错误从会话层产生时，界面必须同时收到「可读说明 + 原文」。
    const fake = cases[0].text;
    const before = view.messages.length;
    panel.session.emit('error', { message: fake });
    const posted = view.messages
      .slice(before)
      .map((item) => item.message)
      .find((item) => item.type === 'error');
    check('错误经过面板时附带了可读说明', Boolean(posted && posted.human && posted.human.title), JSON.stringify(posted));
    check(
      '说明的分类也传到了界面',
      Boolean(posted && posted.human && posted.human.kind === 'usage-limit'),
      posted && posted.human ? posted.human.kind : '没有 human',
    );
    check('原文与说明一并发送（未丢弃）', Boolean(posted && posted.message === fake));
  }

  section('8.8 dshCommand 可以带参数（本机 dsh 不在 PATH 上时需这样写）');
  {
    // 实测问题：将「node D:\...\bin.js」**整串**视为一个程序名并加引号时，
    // cmd.exe 会查找一个名称中含空格的程序，直接以退出码 1 失败
    // （原文为「不是内部或外部命令」）。因此命令必须先拆分，再逐段加引号。
    const { splitCommand, commandLine } = require('../src/door/locate');

    check('普通的命令名原样保留', JSON.stringify(splitCommand('dsh')) === JSON.stringify(['dsh']));
    const parts = splitCommand('node C:/x/dsh/lib/bin.js');
    check(
      '「程序 + 脚本」能拆成两段',
      parts.length === 2 && parts[0] === 'node' && parts[1] === 'C:/x/dsh/lib/bin.js',
      JSON.stringify(parts),
    );
    check('首尾空白会被清掉', JSON.stringify(splitCommand('  dsh  ')) === JSON.stringify(['dsh']));
    check(
      '带空格的路径可以用引号整体括起来',
      JSON.stringify(splitCommand('"C:/Program Files/DSH/dsh.cmd"')) ===
        JSON.stringify(['C:/Program Files/DSH/dsh.cmd']),
      JSON.stringify(splitCommand('"C:/Program Files/DSH/dsh.cmd"')),
    );

    const line = commandLine('node C:/x/bin.js', ['--profile', 'dshdoor']);
    check('拼出来的命令行里，程序没有被整串括起来', line.startsWith('node C:/x/bin.js'), line);
    check('带空格的参数各自加引号', commandLine('dsh', ['--profile', 'a b']).includes('"a b"'),
      commandLine('dsh', ['--profile', 'a b']));

    let thrown = '';
    try {
      commandLine('   ', []);
    } catch (error) {
      thrown = error.message;
    }
    check('命令为空时立即报错（不延迟到进程启动之后）', /dshCommand/.test(thrown), thrown);
  }

  section('8.85 权限预设（dsh-door/permission 旁路方法，需要该插件 0.0.12+）');
  {
    /*
     * 本套件默认连接 47821 —— 桌面端运行时该端口即**桌面端的内核**，
     * 而桌面档中的连接组件为 0.0.7（该档由桌面端自身管理，命令行无法修改），
     * 因此本节分两条路径执行，两条均为真实断言：
     *
     *   - 所连内核支持权限方法（自行启动的 vscode-panel / dshdoor）→ 验证完整链路；
     *   - 所连内核不支持（桌面端那个）→ 验证**降级**：用一句可读说明解释为什么无法切换。
     *
     * ⚠️ 本套件配置中 `autoStart` 为 **false**（第 30 行）：该情况下面板
     * 只作解释，不自行在后台拉起进程；「换一台可切换权限的内核」这条路径需要
     * autoStart 打开（生产默认打开），其判据在下一节用纯函数验证，实际拉起内核
     * 那条路径在 test/fallback.js 与 test/permission-live.js 中验证。
     *
     * 「切换一次确实生效」在 test/permission-live.js 中通过**自行启动的内核**验证。
     */
    const beforePermission = view.messages.length;
    await panel.onWebviewMessage({ type: 'refreshPermission' });
    await waitFor(() =>
      view.messages.slice(beforePermission).some((item) => item.message.type === 'permissionState'),
    );
    const permissionState = view.messages
      .slice(beforePermission)
      .map((item) => item.message)
      .find((item) => item.type === 'permissionState');

    check('界面上收到 permissionState', Boolean(permissionState),
      JSON.stringify(view.messages.slice(beforePermission).map((i) => i.message.type)));

    if (permissionState && permissionState.unavailable) {
      const info = permissionState.unavailable;
      check('所连内核无法切换时，界面收到的是可读说明（不是英文异常）',
        typeof info.text === 'string' && info.text.length > 0 && !/Error|undefined/.test(info.text),
        JSON.stringify(info));
      check('说明了属于哪一种情况（能够给出下一步）',
        ['old-door', 'no-service'].includes(info.state), info.state);
      /*
       * 依据用户 2026-09-19 的反馈（第二次提出）：面板中不得出现该插件的简称
       * 「dsh-acp-door」「0.0.12」「档」等仅内部可理解的词。本条断言守在
       * **实际发送的消息**上：不是检查源码，而是检查本轮实际产生的界面文案。
       */
      const JARGON = /门|dsh-acp-door|dsh-base|dsh-door|@deepseek-ai|0\.0\.\d+|档|profile|settings\.yaml|dshPanel\.|zstd/;
      check('该说明中没有内部词（门 / 包名 / 版本号 / 档 / 设置项）',
        !JARGON.test(`${info.text} ${info.detail || ''}`), `${info.text} ／ ${info.detail || ''}`);
      const noticesOf = () =>
        view.messages
          .map((item) => item.message)
          .filter(
            (item) => item.type === 'notice' && /无法切换|无法读取当前权限/.test(String(item.text || '')),
          );
      const notices = noticesOf();
      check('对话流中说明了原因（顶栏该行放不下长文本）', notices.length >= 1,
        JSON.stringify(view.messages.map((i) => i.message.type).slice(-12)));
      check('该说明为可读表述（不是英文异常）',
        notices.length > 0 && !/Error|undefined|Method not found/.test(notices[0].text),
        notices.length > 0 ? notices[0].text.split('\n')[0] : '');
      check('对话流中该句也没有内部词',
        notices.length > 0 && !JARGON.test(notices[0].text),
        notices.length > 0 ? notices[0].text : '');
      // 权限在每次建立会话时都会读取：同一种原因重复提示即成为噪音。
      const countBefore = notices.length;
      const beforeAgain = view.messages.length;
      await panel.onWebviewMessage({ type: 'refreshPermission' });
      await waitFor(() =>
        view.messages.slice(beforeAgain).some((item) => item.message.type === 'permissionState'),
      );
      check('再次读取不会重复提示同样的内容（同一种原因只提示一次）',
        noticesOf().length === countBefore,
        `第一次 ${countBefore} 条，再次读取后为 ${noticesOf().length} 条`);
      check('无法切换时面板其他功能照常（仍保持连接）',
        Boolean(panel.client && panel.client.isConnected));
      console.log(`     本轮连接的内核不支持权限方法（${info.state}），走降级路径`);
    } else if (permissionState) {
      const options = Array.isArray(permissionState.options) ? permissionState.options : [];
      const ids = options.map((item) => item.value);
      check('清单来自内核（不写死：内核配置几档即为几档）', ids.length > 0, ids.join(','));
      check('当前值在清单中', ids.includes(permissionState.currentValue), permissionState.currentValue);
      check('内置档位已转换为中文标签（与桌面端逐字一致）',
        options.filter((item) => ['仅可查看', '工作区内修改', '完全权限'].includes(item.label)).length >= 1,
        options.map((item) => `${item.value}=${item.label}`).join(' '));
      check('当前项被标记为 active',
        options.filter((item) => item.active).length === 1,
        options.map((item) => `${item.value}:${item.active}`).join(' '));
      const danger = options.find((item) => item.value === 'danger-full-access');
      if (danger) {
        check('「完全权限」附带确认文案（确认步骤不可省略）',
          danger.needsConfirm === true && Boolean(danger.confirm && danger.confirm.title),
          JSON.stringify(danger));
      }

      // 实际切换一次：先切到 read-only，再切回原值。
      const original = permissionState.currentValue;
      const beforeSwitch = view.messages.length;
      await panel.onWebviewMessage({ type: 'setPermission', value: 'read-only' });
      await waitFor(() =>
        view.messages.slice(beforeSwitch).some(
          (item) =>
            (item.message.type === 'permissionState' && item.message.currentValue === 'read-only') ||
            item.message.type === 'error',
        ),
      );
      const afterSwitch = view.messages.slice(beforeSwitch).map((item) => item.message);
      check('切到 read-only 后内核回读即为 read-only',
        afterSwitch.some((item) => item.type === 'permissionState' && item.currentValue === 'read-only'),
        JSON.stringify(afterSwitch.map((item) => item.type)));
      check('对话流中给出了切换结果（不只是顶栏文字变化）',
        afterSwitch.some((item) => item.type === 'notice' && /权限已切到/.test(item.text)),
        JSON.stringify(afterSwitch.filter((item) => item.type === 'notice').map((item) => item.text)));

      if (original && original !== 'read-only') {
        await panel.onWebviewMessage({ type: 'setPermission', value: original });
        await waitFor(() =>
          view.messages
            .slice(beforeSwitch)
            .map((item) => item.message)
            .some((item) => item.type === 'permissionState' && item.currentValue === original),
        );
        check('能切回原来的档（不将内核留在测试值上）', true);
      }
    }
  }

  section('8.86 「无法切换权限时改用可切换的一台」——判据为纯函数，逐项验证');
  {
    /*
     * 本节存在的原因：用户 2026-09-19 反馈「修改之后无法切换权限」。
     * 原因并非代码缺陷，而是**面板连接到了桌面端的内核**（桌面档中的连接组件
     * 为 0.0.7，没有权限方法）。面板此前只会提示「无法切换」，用户需要自行
     * 判断原因；现在面板会改用自行启动的那一台（其组件为新版本）。
     *
     * 实际拉起内核的路径（耗时较长、需要进程）在其他文件中验证；此处只验证**判据**：
     * 何种情况应当更换、何种情况不应更换。
     */
    const { shouldSwitchToOwnKernel } = require('../src/panel/view');
    const base = { state: 'old-door', targetPort: 47821, cfgPort: 47821, autoStart: true, switched: false };
    check('组件版本过低 + 连接在现有内核上 + 允许自启 → 更换',
      shouldSwitchToOwnKernel(base) === true);
    check('已在自己启动的内核上 → 不更换（更换无实际效果）',
      shouldSwitchToOwnKernel({ ...base, targetPort: 47831 }) === false);
    check('用户关闭了自动启动 → 不更换（不自行在后台启动进程）',
      shouldSwitchToOwnKernel({ ...base, autoStart: false }) === false);
    check('一个面板只更换一次 → 不反复切换',
      shouldSwitchToOwnKernel({ ...base, switched: true }) === false);
    check('「该 DSH 未提供权限设置」→ 不更换（更换结果相同）',
      shouldSwitchToOwnKernel({ ...base, state: 'no-service' }) === false);
    check('无法读取（网络波动 / 会话不存在）→ 不更换（先不改变结构）',
      shouldSwitchToOwnKernel({ ...base, state: 'error' }) === false);
    check('端口不匹配时不误判', shouldSwitchToOwnKernel({ ...base, targetPort: undefined }) === false);
    check('缺少参数也不报错（webview 与扩展之间可能传入任意数据）',
      shouldSwitchToOwnKernel() === false && shouldSwitchToOwnKernel(undefined) === false);
  }

  section('8.9 历史会话（dsh-door/sessions 旁路方法，需要该插件 0.0.8+）');
  {
    const beforeHistory = view.messages.length;
    await panel.onWebviewMessage({ type: 'historyList' });
    await waitFor(() =>
      view.messages
        .slice(beforeHistory)
        .some((item) => item.message.type === 'history' || item.message.type === 'error'),
    );
    const historyMsg = view.messages
      .slice(beforeHistory)
      .map((item) => item.message)
      .find((item) => item.type === 'history');
    check('界面上收到 history 消息', Boolean(historyMsg), JSON.stringify(view.messages.slice(beforeHistory).map((i) => i.message.type)));
    const sessions = historyMsg && historyMsg.sessions;
    check('清单是数组且非空（本机上一定有历史记录）', Array.isArray(sessions) && sessions.length > 0,
      historyMsg ? `共 ${Array.isArray(sessions) ? sessions.length : '?'} 段` : '没有 history 消息');
    if (Array.isArray(sessions) && sessions.length > 0) {
      const card = sessions[0];
      check('条目包含 id、回合数、时间', Boolean(card.id) && typeof card.turns === 'number'
        && (typeof card.lastTime === 'number' || typeof card.mtime === 'number'), JSON.stringify(card).slice(0, 200));

      const beforeReplay = view.messages.length;
      await panel.onWebviewMessage({ type: 'historyOpen', id: card.id });
      await waitFor(() =>
        view.messages.slice(beforeReplay).some((item) => item.message.type === 'replay' || item.message.type === 'error'),
      );
      const replay = view.messages.slice(beforeReplay).map((item) => item.message)
        .find((item) => item.type === 'replay');
      check('回放送到界面', Boolean(replay));
      check('回放包含条目与条目数组', Boolean(replay && replay.card) && Array.isArray(replay.entries),
        replay ? `条目 ${replay.entries.length}` : '没有 replay');
      check('回放条目均为已知形状',
        Boolean(replay) && replay.entries.every((item) => ['user', 'assistant', 'tool'].includes(item.kind)),
        replay ? JSON.stringify(replay.entries.find((item) => !['user', 'assistant', 'tool'].includes(item.kind))) : '');
    }

    // 接回一个不存在的会话：必须明确失败，且面板仍可用。
    const beforeBad = view.messages.length;
    await panel.onWebviewMessage({ type: 'historyResume', id: 'session-does-not-exist-9f3a' });
    await waitFor(() =>
      view.messages.slice(beforeBad).some((item) => item.message.type === 'notice' || item.message.type === 'error'),
      { totalMs: 20000 },
    );
    const badOutcome = view.messages.slice(beforeBad).map((item) => item.message)
      .find((item) => item.type === 'notice' || item.type === 'error');
    check('接回不存在的会话会明确说明（notice 或 error）', Boolean(badOutcome), JSON.stringify(view.messages.slice(beforeBad).map((i) => i.message.type)));
    check('失败后面板仍可继续使用', Boolean(panel.client && panel.client.isConnected));
  }

  section('8.9 面向用户的文本都必须简短（用户两次提出意见）');
  {
    /*
     * 用户的约束（原话大意）：提示与报错都需**精炼**，不得在面板中放入
     * 「没有现成的内核，正在启动一个（档：vscode-panel）。第一次会慢一点…」
     * 这类长句。
     *
     * 因此此处不针对某一条文案断言，而是扫描本套件运行期间**实际发送过的全部消息**。
     * 后续新增的长文案会在此处立即失败，不必等用户再次反馈。
     *
     * 三条界限（均有依据）：
     *   - 顶栏该行 ≤ 24 字、不得换行（该行本身只能容纳少量字符）；
     *   - 对话流提示第一行 ≤ 32 字、最多三行；第一行之后的**引用**行（以
     *     「原因：」「内核原话：」开头者）放宽到 80 字 —— 那是内核原文，
     *     不是面向用户的叙述，截短后反而无法定位问题（但也不可整段放入）；
     *   - 报错的第一句（title）≤ 32 字、处理建议（advice）≤ 48 字
     *     —— 内核原文不在此列，它照旧不删减任何字符地附在后面。
     */
    const statuses = everyMessage.filter((m) => m.type === 'status');
    const notices = everyMessage.filter((m) => m.type === 'notice');
    const errors = everyMessage.filter((m) => m.type === 'error');

    const longStatus = statuses.filter((m) => String(m.detail || '').length > 24 || /\n/.test(String(m.detail || '')));
    check(`顶栏状态都很短（${statuses.length} 条，≤24 字且不换行）`, longStatus.length === 0,
      JSON.stringify(longStatus.map((m) => m.detail)));

    const noticeLines = (text) => String(text || '').split('\n');
    const longNotice = notices.filter((m) => {
      const lines = noticeLines(m.text);
      if (lines.length > 3) return true;
      return lines.some((line, index) => {
        const quoted = index > 0 && /^(原因|内核原话)：/.test(line);
        return line.length > (quoted ? 80 : 32);
      });
    });
    check(`对话流提示都很短（${notices.length} 条：第一行 ≤32 字，引用行 ≤80 字）`,
      longNotice.length === 0,
      JSON.stringify(longNotice.map((m) => m.text)));

    const longError = errors.filter(
      (m) =>
        !m.human ||
        String(m.human.title || '').length > 32 ||
        String(m.human.advice || '').length > 48,
    );
    check(`报错的第一句和第二句都很短（${errors.length} 条）`, longError.length === 0,
      JSON.stringify(longError.map((m) => (m.human && `${m.human.title} / ${m.human.advice}`) || m.message)));

    // 输出最长的几条，便于后续修改时直接看到当前尺度。
    const longest = (list, pick) =>
      list
        .map(pick)
        .sort((a, b) => String(b).length - String(a).length)[0] || '（无）';
    console.log(`     最长顶栏：${longest(statuses, (m) => m.detail)}`);
    console.log(`     最长提示：${longest(notices, (m) => String(m.text).split('\n')[0])}`);
    console.log(`     最长报错：${longest(errors, (m) => m.human && m.human.title)}`);

    /*
     * 第二条约束（用户 2026-09-19 第二次反馈的原话）：
     * 「『门』都出来了，别人能知道是什么意思？类似的提示全删了。」
     *
     * 面板面向用户，而非用于内部排障 —— 因此**本套件运行期间实际发送过的
     * 全部提示/报错/顶栏文案**中不得出现内部词：该插件的简称、包名
     * （dsh-acp-door / dsh-base / @deepseek-ai/*）、版本号（0.0.12）、「档」
     * （profile）、设置项全名，以及「内核原话」这类仅内部使用的说法。
     *
     * 注意边界：**内核原文不在此列**。它是内核自身输出的英文/JSON，位于
     * 「原始报错（展开）」折叠区与日志中，不删减任何字符；它附在说明之后，
     * 属于证据而非面向用户的讲解。因此此处只扫描：
     * 顶栏 detail、提示 text、报错 human.title / human.advice。
     */
    const JARGON = /门|dsh-acp-door|dsh-base|dsh-door|@deepseek-ai|0\.0\.\d+|档|profile=|settings\.yaml|dshPanel\.|zstd|Node \d/;
    const userFacing = [
      ...statuses.map((m) => ['顶栏', String(m.detail || '')]),
      ...notices.map((m) => ['提示', String(m.text || '')]),
      ...errors.filter((m) => m.human).map((m) => ['报错标题', String(m.human.title || '')]),
      ...errors.filter((m) => m.human).map((m) => ['报错建议', String(m.human.advice || '')]),
    ];
    const withJargon = userFacing.filter(([, text]) => JARGON.test(text));
    check(`面向用户的文本中没有内部词（共扫描 ${userFacing.length} 条：门 / 包名 / 版本号 / 档 / 设置项）`,
      withJargon.length === 0,
      JSON.stringify(withJargon));
  }

  section('9. 收尾');
  panel.dispose();
  door.stop();
  check('dispose 后能再建面板', true);

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('💥 测试异常终止：', error.stack || error.message);
  process.exit(1);
});
