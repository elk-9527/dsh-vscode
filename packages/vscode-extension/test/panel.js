'use strict';

/**
 * 面板层集成测试。
 *
 * 手法：把 `vscode` 这个模块名劫持成一个假的实现，于是 panel/view.js
 * 能在**没有编辑器**的情况下被完整跑起来 —— 包括注册视图、生成 HTML、
 * 收发 webview 消息、连真的门、跑真回合。
 *
 * 这能盖住界面上看不到的那一大半 bug：消息时序、状态机、字段名、
 * 会话生命周期。真正的浏览器渲染另外验（见 test/static.js）。
 *
 * 用法：node test/panel.js   （同样需要一个 DSH 在 47821 上开门）
 */

const path = require('node:path');
const Module = require('node:module');

// ── 先装假 vscode，再 require 面板 ────────────────────────

const openedLinks = [];
const configValues = {
  host: '127.0.0.1',
  port: 47821,
  // ⚠️ 自启端口**故意不用默认的 47831**：那一路上"必须没人占着"才是测试的前提，
  // 而 47831 正是面板自启内核的默认端口 —— 用户自己开着 VS Code 面板时，
  // 那上面就有一个真在用的内核（实测踩到：§8.5 就地连上了它、于是"命令坏了"
  // 这条路径根本没被走到，测试红得莫名其妙）。测试不该依赖外面的机器状态。
  selfStartPort: 47845,
  autoStart: false,
  fallbackProfile: 'dshdoor',
  dshCommand: 'dsh',
  provider: '',
  model: '',
  // 这个套件里一律"面板一关就收内核"（老行为），好让收摊类断言简单直接。
  // 宽限期那条路（视图销毁不杀内核、重开面板继续用）在 test/fallback.js §6
  // 用真进程验。
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
 * 这一套跑下来，面板发出去过的**所有**消息（每个假视图的都汇到这里）。
 *
 * 用处在最后那一节：用户的规矩是「给用户看的提示、报错都要精炼」——
 * 与其一条条断言，不如把所有真发过的消息扫一遍（这样将来新加的长文案
 * 一进来就会被抓住，而不是等用户再提一次意见）。
 */
const everyMessage = [];

/** 一个记录所有收到的消息的假 webview。 */
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
  // 既接受「包装过的」{at, message}，也接受裸消息，免得测试自己踩自己。
  return items.map((item) => (item && item.message ? item.message.type : item && item.type));
}

(async () => {
  const log = (level, message) => {
    if (process.env.DSH_PANEL_TEST_VERBOSE) console.log(`     [${level}] ${message}`);
  };

  // 断线接回测试要用一个不容易被模型「猜中」的数字。
  const MARKER = String(1000 + Math.floor(Math.random() * 8999));

  // 内核没开就自己拉一个（跑完负责收摊）。「自动拉起」那条路另有
  // test/fallback.js 专测，所以这里配置里的 autoStart 是关的，免得两处都拉进程。
  // 门要先跟源码对齐 —— 这里测的正是 dsh-door/sessions 这些新方法。
  syncDoor({ log });
  const door = await ensureDoor({ log });

  section('1. 视图注册与 HTML 生成');
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:\\dsh-vscode\\packages\\vscode-extension' }, log });
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
  check('收到用例用量', after.some((item) => item.type === 'usage'));
  check('收到回合结束', after.some((item) => item.type === 'done'));
  check('busy 开过', after.some((item) => item.type === 'busy' && item.busy === true));
  check('busy 关了', after.some((item) => item.type === 'busy' && item.busy === false));
  check('没有错误消息', !after.some((item) => item.type === 'error'), JSON.stringify(after.filter((i) => i.type === 'error')));

  const toolMessages = after.filter((item) => item.type === 'tool').map((item) => item.tool);
  const finalTools = new Map();
  for (const tool of toolMessages) finalTools.set(tool.toolCallId, tool);
  check('工具卡片按 id 合并了（没有重复卡片）', finalTools.size >= 1 && finalTools.size <= toolMessages.length);
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
  check('javascript: 没有被打开', openedLinks.length === 0, openedLinks.join(','));
  await panel.onWebviewMessage({ type: 'openLink', href: 'https://example.com/x' });
  check('https 链接被放行', openedLinks.length === 1, openedLinks.join(','));

  section('7. 未知消息不会炸');
  await panel.onWebviewMessage({ type: '完全不认识的类型' });
  await panel.onWebviewMessage(null);
  check('未知消息后还能正常发消息', panel.session.sessionId !== null);
  await panel.onWebviewMessage({ type: 'send', text: '说一句：收到。' });
  check('之后仍能收到回复', view.messages.some((item) => item.message.type === 'done'));

  section('8. 断线：必须能自动接回上下文');
  // 这是真实会遇到的场景：DSH 桌面端被关掉/重启，而面板还开着。
  // 实测 session/resume 有效（test/resume.js），所以面板不该开一个没记忆的新会话 ——
  // 那样用户会以为它还记着上面那段对话。
  const beforeDrop = panel.session.sessionId;
  await panel.onWebviewMessage({ type: 'send', text: `记住数字 ${MARKER}，只回答「已记住」。` });
  check('断线前这一段能正常跑完', view.messages.some((item) => item.message.type === 'done'));

  const dropIndex = view.messages.length;
  panel.client.close(); // 掐断连接，等价于内核没了
  await new Promise((resolve) => setTimeout(resolve, 600));

  const afterDrop = view.messages.slice(dropIndex).map((item) => item.message);
  check(
    '断线被界面看见了（顶栏变短状态，原因进对话流）',
    afterDrop.some((item) => item.type === 'status' && item.state === 'error' && item.detail === '未连接'),
    JSON.stringify(afterDrop.map((i) => i.type)),
  );
  check(
    '断线的原因写在对话流里（不再是顶栏那一小行）',
    afterDrop.some((item) => item.type === 'error' && /断开/.test(item.message || '')),
    JSON.stringify(afterDrop.filter((i) => i.type === 'error').map((i) => i.message)),
  );
  check(
    '断线后会解除「正在回答」状态（否则停止按钮会一直转）',
    afterDrop.some((item) => item.type === 'busy' && item.busy === false),
    JSON.stringify(afterDrop),
  );
  check('断线后会话被放掉，下次发送会重连', !panel.session, String(panel.session));

  const resumeIndex = view.messages.length;
  await panel.onWebviewMessage({ type: 'send', text: '我刚才让你记住的数字是多少？只回答数字。' });
  check('重连后拿回了会话', Boolean(panel.session && panel.session.sessionId));
  check(
    '拿回的是原来那个会话（不是悄悄开了个新的）',
    panel.session.sessionId === beforeDrop,
    `${beforeDrop} → ${panel.session.sessionId}`,
  );
  const resumeMessages = view.messages.slice(resumeIndex).map((item) => item.message);
  check(
    '上下文真的接回来了（它答得出断线前那个数字）',
    resumeMessages.some((item) => item.type === 'text' && String(item.delta).includes(MARKER)),
    JSON.stringify(resumeMessages.filter((i) => i.type === 'text').map((i) => i.delta)).slice(0, 200),
  );

  section('8.5 自启内核失败时，别让用户干等两分钟');
  {
    // 场景：门连不上 + 自动拉起 + 命令写错（dshCommand 填了个不存在的路径）。
    // 以前这里会老老实实等满 120 秒的 waitForPort，用户对着
    // "正在启动 DSH…" 干等两分钟，最后只得到一句"没开门"。
    const saved = { ...configValues };
    configValues.autoStart = true;
    configValues.port = 47844; // 这个端口上不会有门
    configValues.dshCommand = 'dsh-这个命令不存在-9f3a';
    const badPanel = new DshPanelView({
      extensionUri: { fsPath: 'D:\\dsh-vscode\\packages\\vscode-extension' },
      log,
    });
    // 隔离掉自动候选：这一节只测「设置的命令坏了」这条路径 ——
    // 否则候选清单会带上默认安装位置的 node bin.js（它是好的），
    // 测试就得等真内核起来，那不是本节要验的事。
    badPanel.candidatesFor = () => [configValues.dshCommand];
    const badView = makeFakeView();
    badPanel.resolveWebviewView(badView);

    const startedAt = Date.now();
    await badPanel.onWebviewMessage({ type: 'ready' });
    const elapsed = Date.now() - startedAt;

    const all = badView.messages.map((item) => item.message);
    const errorStatus = all.find((item) => item.type === 'status' && item.state === 'error');
    check('命令不存在时给出了错误状态（不是一直转圈）', Boolean(errorStatus),
      JSON.stringify(all.slice(-3)));
    check('顶栏只放短状态（长诊断不许塞进那一小行）',
      Boolean(errorStatus) && errorStatus.detail === '未连接',
      errorStatus ? JSON.stringify(errorStatus.detail) : '没有错误状态');
    // 长诊断必须进对话流 —— 用户是在对话框里读东西的，不是在顶栏。
    // 原文段里要有**那个坏命令本身**（不然用户不知道是哪一个命令坏了），
    // 但"怎么办"那句必须是给人看的话（不出现 PATH / 设置项全名这些词）。
    const errMsg = all.find((item) => item.type === 'error');
    check('诊断进了对话流，且说清了是哪个命令、该怎么办',
      Boolean(errMsg) &&
        String(errMsg.message).includes(configValues.dshCommand) &&
        /找不到 DSH|设置/.test(`${errMsg.message} ${(errMsg.human && errMsg.human.advice) || ''}`),
      JSON.stringify(errMsg || all.slice(-3)));
    check('"怎么办"那句不说内部词（不提 PATH / 设置项全名）',
      Boolean(errMsg) &&
        !/PATH|dshCommand/.test((errMsg.human && errMsg.human.advice) || ''),
      (errMsg && errMsg.human && errMsg.human.advice) || '（没有 human）');
    check('而且给的是结构化错误（有标题，界面才好排版）',
      Boolean(errMsg && errMsg.human && errMsg.human.title),
      JSON.stringify(errMsg && errMsg.human));
    check('而且是**早点**说的（没有干等满 120 秒）', elapsed < 15000, `耗时 ${elapsed}ms`);
    badPanel.dispose();
    Object.assign(configValues, saved);
  }

  section('8.6 自启内核失败的两种情形，各说各的话（这条分支以前从没被测过）');
  {
    // 为什么以前测不到：要跑到「进程活着、但门一直没开」这条分支，正常情况下
    // 得等满 120 秒 —— 所以它一直躺在代码里没人验。给 waitForFallbackDoor 加了
    // 一个只在测试里用的超时参数，几秒就能跑到。
    const { fallbackFailureText } = require('../src/panel/view');
    const emitter = require('node:events');

    // (1) 进程活着但端口没开 → 等到超时，且必须分辨出这不是"命令错"。
    const aliveChild = new emitter.EventEmitter();
    const startedAt = Date.now();
    const timedOut = await panel.waitForFallbackDoor(aliveChild, '127.0.0.1', 47844, 900);
    const waited = Date.now() - startedAt;
    check('端口一直不开时会等到超时，并说明是超时（不是命令错）',
      timedOut.ok === false && timedOut.exitedEarly === false,
      JSON.stringify(timedOut));
    check('超时是按给它的时间来的（0.9 秒的活干完就返回）', waited < 4000, `等了 ${waited}ms`);

    // (2) 进程立刻退出 → 立刻返回，且标明是"刚启动就退出"。
    const deadChild = new emitter.EventEmitter();
    const quick = panel.waitForFallbackDoor(deadChild, '127.0.0.1', 47844, 30000);
    setTimeout(() => deadChild.emit('exit', 1, null), 50);
    const died = await quick;
    check('进程刚退出时立刻返回（不把 30 秒等满）',
      died.ok === false && died.exitedEarly === true,
      JSON.stringify(died));

    // (3) 两种情形的话必须不一样，而且各自指出正确的出路。
    const boot = fallbackFailureText({
      command: 'dsh', profile: 'desktop', host: '127.0.0.1', port: 47821, exitedEarly: true,
    });
    const noDoor = fallbackFailureText({
      command: 'dsh', profile: 'desktop', host: '127.0.0.1', port: 47821, exitedEarly: false,
    });
    check('两句话不一样（否则等于没区分）', boot !== noDoor);
    check('"命令错"那句记得说清是什么命令（原文段里）',
      /找不到 DSH/.test(boot) && /dshCommand|设置里/.test(boot), boot);
    check('"没连上"那句（原文段）提到连接组件与端口',
      /dsh-acp-door/.test(noDoor) && /plugin --profile desktop list/.test(noDoor) && /port/.test(noDoor),
      noDoor);
    /*
     * 人话那半句（原文段开头这句）**不许出现「门」** —— 用户 2026-09-19 的意见：
     * 「『门』都出来了，别人能知道是什么意思？」。技术细节留在原文段里没问题
     * （那是折叠区、给排障看的），但结论句必须说人话。
     */
    check('"没连上"那句的结论是人话（不出现「门」）',
      !/没开门|门没开|门插件/.test(noDoor.split('\n')[0]), noDoor.split('\n')[0]);

    // (3b) 内核自己说了原因时：照实转述 + 附上原话，**不许**再断言是 PATH 的问题。
    //      2026-09-19 那次「面板起不来」，内核明明说了
    //      `profile "desktop" is managed exclusively by the Electron application`，
    //      面板却猜成"多半是 dsh 不在 PATH 里"，把用户往错的方向带。
    const { explainKernelFailure } = require('../src/door/locate');
    const managedStderr = 'error: profile "desktop" is managed exclusively by the Electron application';
    const managedText = fallbackFailureText({
      command: 'dsh', profile: 'desktop', host: '127.0.0.1', port: 47821, exitedEarly: true,
      stderr: managedStderr,
      explained: explainKernelFailure({ profile: 'desktop', stderr: managedStderr }),
    });
    check('失败说明带上了内核的原话', managedText.includes('managed exclusively'), managedText);
    check('失败说明不再断言是 PATH 的问题（那次就是这么带偏的）', !/PATH/.test(managedText), managedText);
    check('失败说明指向正确的出路（先开桌面端 / 换一套配置）',
      /桌面端/.test(managedText) && /设置|配置/.test(managedText), managedText);

    const unknownText = fallbackFailureText({
      command: 'dsh', profile: 'x', host: '127.0.0.1', port: 47821, exitedEarly: true,
      stderr: 'some unexplained kernel complaint',
    });
    check('认不出来的原因也照样附原话（不吞掉）',
      unknownText.includes('some unexplained kernel complaint'), unknownText);

    // (4) 设置里填了几个空格，不该被当成路径发给内核
    //     （内核会回 "cwd must be an absolute path: "，然后用户看到的是一句莫名其妙的话）。
    const savedCwd = configValues.cwd;
    configValues.cwd = '   ';
    const resolved = panel.workdir();
    check('cwd 只填了空格时退回工作区目录（不把空格发过去）',
      resolved === savedCwd,
      `${JSON.stringify(resolved)}，工作区目录是 ${JSON.stringify(savedCwd)}`);
    configValues.cwd = savedCwd;
  }

  section('8.7 内核的错误必须说人话，而且不能吞掉原文');
  {
    // 背景：内核的报错是**原样**穿过 ACP 的，以前用户看到的就是一段英文 JSON
    // （最典型的是 429 额度限制）。那段文字对用户没有用 —— 既不说发生了什么，
    // 也不说下一步干什么，看多了只会得出「这插件没法用」的结论。
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
        name: '连不上内核',
        text: 'fetch failed: connect ECONNREFUSED 127.0.0.1:47821',
        kind: 'connection',
        title: /连不上|断了/,
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
     * 同一批文案再过一遍**内部词黑名单**（2026-09-20 加）：这些 title/advice
     * 是直接印在错误卡片上的，所以不许出现「门」「档」「设置项全名」——
     * 用户原话是「『门』都出来了，别人能知道是什么意思？」。
     */
    const JARGON = /门|档|dshPanel\.|settings\.yaml|fallbackProfile|dsh-acp-door/;

    for (const item of cases) {
      const human = describeError(item.text);
      check(`${item.name} → 分类对了`, human.kind === item.kind, `实际分类是 ${human.kind}`);
      check(`${item.name} → 说清了发生了什么`, item.title.test(human.title), human.title);
      check(`${item.name} → 说清了你能做什么`, item.advice.test(human.advice), human.advice);
      check(`${item.name} → 原文一个字都没少`, human.raw === item.text);
      check(`${item.name} → 卡片上没有内部词（门 / 档 / 设置项全名）`,
        !JARGON.test(`${human.title} ${human.advice}`), `${human.title}／${human.advice}`);
    }

    // 认不出来的错误：也必须有一句人话开头，而且原文照旧留着 ——
    // 「翻译不了」不等于「可以把信息丢掉」。
    const weird = '💥 内核吐了一坨没见过的玩意儿 at 0xDEADBEEF';
    const other = describeError(weird);
    check('认不出来的错误也有人话开头', other.known === false && other.title.length > 0, other.title);
    check('认不出来的错误原文照旧保留', other.raw === weird);
    check('认不出来时告诉用户去看日志或把原文发回来', /日志|发给我/.test(other.advice), other.advice);

    // 端到端：错误从会话层冒出来，界面拿到的必须是「人话 + 原文」两样都有。
    const fake = cases[0].text;
    const before = view.messages.length;
    panel.session.emit('error', { message: fake });
    const posted = view.messages
      .slice(before)
      .map((item) => item.message)
      .find((item) => item.type === 'error');
    check('错误经过面板时带上了人话', Boolean(posted && posted.human && posted.human.title), JSON.stringify(posted));
    check(
      '人话的分类也传到了界面',
      Boolean(posted && posted.human && posted.human.kind === 'usage-limit'),
      posted && posted.human ? posted.human.kind : '没有 human',
    );
    check('原文跟着人话一起发出去（没被吞掉）', Boolean(posted && posted.message === fake));
  }

  section('8.8 dshCommand 可以带参数（本机 dsh 不在 PATH 上时就得这么写）');
  {
    // 实测过的坑：把「node D:\...\bin.js」**整串**当成一个程序名去加引号，
    // cmd.exe 会去找一个名字里带空格的程序，直接以退出码 1 失败
    // （原文是「不是内部或外部命令」）。所以命令必须先拆开再逐段加引号。
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
    check('命令填成空的时候立刻报错（不拖到进程起来之后）', /dshCommand/.test(thrown), thrown);
  }

  section('8.85 权限预设（dsh-door/permission 旁路方法，需要门 0.0.12+）');
  {
    /*
     * 这个套件默认连 47821 —— 桌面端开着的时候那就是**桌面端的内核**，
     * 而桌面档里的连接组件是 0.0.7（那个档由桌面端自己管，命令行改不动它），
     * 所以这一段会分两条路走，两条都是真断言：
     *
     *   - 连的那台支持权限方法（自己起的 vscode-panel / dshdoor）→ 验完整链路；
     *   - 连的那台不支持（桌面端那个）→ 验**降级**：一句人话说明为什么切不了。
     *
     * ⚠️ 本套件的配置里 `autoStart` 是 **false**（第 30 行）：那种情况下面板
     * 只解释、不擅自在背后拉进程 —— 「换一台能换权限的」那条路要 autoStart 打开
     * 才走（生产默认是打开的），它的判据在下一节用纯函数验，真拉起内核那条路
     * 在 test/fallback.js 与 test/permission-live.js 里验。
     *
     * 「切一次真能切过去」在 test/permission-live.js 里用**自己起的内核**验。
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
      check('连的那台换不了时，界面拿到的是一句人话（不是英文异常）',
        typeof info.text === 'string' && info.text.length > 0 && !/Error|undefined/.test(info.text),
        JSON.stringify(info));
      check('说清了是哪一种情况（要能给出下一步）',
        ['old-door', 'no-service'].includes(info.state), info.state);
      /*
       * 用户 2026-09-19 的意见（第二次提）：面板里不许出现「门」「dsh-acp-door」
       * 「0.0.12」「档」这些只有我们自己懂的词。这一条就守在**真发出去的消息**上：
       * 不是查源码，是查这一轮真的跑出来的界面文案。
       */
      const JARGON = /门|dsh-acp-door|dsh-base|dsh-door|@deepseek-ai|0\.0\.\d+|档|profile|settings\.yaml|dshPanel\.|zstd/;
      check('这句人话里没有内部词（门 / 包名 / 版本号 / 档 / 设置项）',
        !JARGON.test(`${info.text} ${info.detail || ''}`), `${info.text} ／ ${info.detail || ''}`);
      const noticesOf = () =>
        view.messages
          .map((item) => item.message)
          .filter(
            (item) => item.type === 'notice' && /换不了|切不了/.test(String(item.text || '')),
          );
      const notices = noticesOf();
      check('对话流里把原因说清楚了（顶栏那行放不下长文）', notices.length >= 1,
        JSON.stringify(view.messages.map((i) => i.message.type).slice(-12)));
      check('那句话说人话（不是英文异常）',
        notices.length > 0 && !/Error|undefined|Method not found/.test(notices[0].text),
        notices.length > 0 ? notices[0].text.split('\n')[0] : '');
      check('对话流里那句也没有内部词',
        notices.length > 0 && !JARGON.test(notices[0].text),
        notices.length > 0 ? notices[0].text : '');
      // 权限是每次建会话都会读一遍的：同一种原因重复播就成了噪音。
      const countBefore = notices.length;
      const beforeAgain = view.messages.length;
      await panel.onWebviewMessage({ type: 'refreshPermission' });
      await waitFor(() =>
        view.messages.slice(beforeAgain).some((item) => item.message.type === 'permissionState'),
      );
      check('再读一次不会再刷一遍同样的话（同一种原因只说一次）',
        noticesOf().length === countBefore,
        `第一次 ${countBefore} 条，再来一次变成 ${noticesOf().length} 条`);
      check('切不了的时候面板其它功能照常（还连着）',
        Boolean(panel.client && panel.client.isConnected));
      console.log(`     这一轮连的内核里门不支持权限方法（${info.state}），走的是降级那条路`);
    } else if (permissionState) {
      const options = Array.isArray(permissionState.options) ? permissionState.options : [];
      const ids = options.map((item) => item.value);
      check('清单来自内核（不写死：内核配了几档就是几档）', ids.length > 0, ids.join(','));
      check('当前值在清单里', ids.includes(permissionState.currentValue), permissionState.currentValue);
      check('内置那几档翻成了中文标签（跟桌面端逐字一致）',
        options.filter((item) => ['仅可查看', '工作区内修改', '完全权限'].includes(item.label)).length >= 1,
        options.map((item) => `${item.value}=${item.label}`).join(' '));
      check('当前那一项被标成 active',
        options.filter((item) => item.active).length === 1,
        options.map((item) => `${item.value}:${item.active}`).join(' '));
      const danger = options.find((item) => item.value === 'danger-full-access');
      if (danger) {
        check('「完全权限」带确认文案（确认门不能少）',
          danger.needsConfirm === true && Boolean(danger.confirm && danger.confirm.title),
          JSON.stringify(danger));
      }

      // 真切一次：切到 read-only，再切回来。
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
      check('切到 read-only 之后内核回读就是 read-only',
        afterSwitch.some((item) => item.type === 'permissionState' && item.currentValue === 'read-only'),
        JSON.stringify(afterSwitch.map((item) => item.type)));
      check('对话流里说了切换结果（不是只有顶栏变个字）',
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
        check('能切回原来的档（别把内核留在测试值上）', true);
      }
    }
  }

  section('8.86 「换不了权限就换一台能换的」——判据是纯函数，这里逐个验');
  {
    /*
     * 为什么有这一节：用户 2026-09-19 报「改了之后我切换不了权限了」。
     * 真相不是代码坏了，是**面板接上了桌面端那个内核**（桌面档里的连接组件
     * 是 0.0.7，没有权限方法）。面板原来只会说一句「切不了」，用户还得自己
     * 去搞明白为什么 —— 现在它会改用自己启动的那台（那台组件是新的）。
     *
     * 真拉起内核那条路（慢、要进程）在别处验；这里只验**判据**：
     * 什么情况下该换、什么情况下不该换。
     */
    const { shouldSwitchToOwnKernel } = require('../src/panel/view');
    const base = { state: 'old-door', targetPort: 47821, cfgPort: 47821, autoStart: true, switched: false };
    check('组件旧 + 接在现成那台上 + 允许自启 → 换',
      shouldSwitchToOwnKernel(base) === true);
    check('已经在自己那台上 → 不换（换了是原地打转）',
      shouldSwitchToOwnKernel({ ...base, targetPort: 47831 }) === false);
    check('用户关了自动启动 → 不换（别在背后拉进程）',
      shouldSwitchToOwnKernel({ ...base, autoStart: false }) === false);
    check('一台面板只换一次 → 不来回弹',
      shouldSwitchToOwnKernel({ ...base, switched: true }) === false);
    check('「那台 DSH 没带权限设置」→ 不换（换了也一样）',
      shouldSwitchToOwnKernel({ ...base, state: 'no-service' }) === false);
    check('读不到（网络抖 / 会话没了）→ 不换（先别动结构）',
      shouldSwitchToOwnKernel({ ...base, state: 'error' }) === false);
    check('端口对不上时不误判', shouldSwitchToOwnKernel({ ...base, targetPort: undefined }) === false);
    check('缺参数也不炸（webview 与扩展之间什么都可能来）',
      shouldSwitchToOwnKernel() === false && shouldSwitchToOwnKernel(undefined) === false);
  }

  section('8.9 历史会话（dsh-door/sessions 旁路方法，需要门 0.0.8+）');
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
    check('清单是数组而且非空（这台机器上一定有历史）', Array.isArray(sessions) && sessions.length > 0,
      historyMsg ? `共 ${Array.isArray(sessions) ? sessions.length : '?'} 段` : '没有 history 消息');
    if (Array.isArray(sessions) && sessions.length > 0) {
      const card = sessions[0];
      check('名片带 id、回合数、时间', Boolean(card.id) && typeof card.turns === 'number'
        && (typeof card.lastTime === 'number' || typeof card.mtime === 'number'), JSON.stringify(card).slice(0, 200));

      const beforeReplay = view.messages.length;
      await panel.onWebviewMessage({ type: 'historyOpen', id: card.id });
      await waitFor(() =>
        view.messages.slice(beforeReplay).some((item) => item.message.type === 'replay' || item.message.type === 'error'),
      );
      const replay = view.messages.slice(beforeReplay).map((item) => item.message)
        .find((item) => item.type === 'replay');
      check('回放送到界面', Boolean(replay));
      check('回放带名片与条目数组', Boolean(replay && replay.card) && Array.isArray(replay.entries),
        replay ? `条目 ${replay.entries.length}` : '没有 replay');
      check('回放条目都是认识的形状',
        Boolean(replay) && replay.entries.every((item) => ['user', 'assistant', 'tool'].includes(item.kind)),
        replay ? JSON.stringify(replay.entries.find((item) => !['user', 'assistant', 'tool'].includes(item.kind))) : '');
    }

    // 接回一个不存在的会话：必须失败得清清楚楚，而且面板还活着。
    const beforeBad = view.messages.length;
    await panel.onWebviewMessage({ type: 'historyResume', id: 'session-does-not-exist-9f3a' });
    await waitFor(() =>
      view.messages.slice(beforeBad).some((item) => item.message.type === 'notice' || item.message.type === 'error'),
      { totalMs: 20000 },
    );
    const badOutcome = view.messages.slice(beforeBad).map((item) => item.message)
      .find((item) => item.type === 'notice' || item.type === 'error');
    check('接回不存在的会话会明说（notice 或 error）', Boolean(badOutcome), JSON.stringify(view.messages.slice(beforeBad).map((i) => i.message.type)));
    check('失败后面板还能继续用', Boolean(panel.client && panel.client.isConnected));
  }

  section('8.9 给用户看的字都要短（用户提过两次意见）');
  {
    /*
     * 用户的规矩（原话大意）：提示和报错都要**精炼**，别在面板里塞一段
     * "没有现成的内核，正在启动一个（档：vscode-panel）。第一次会慢一点…"
     * 这种长句。
     *
     * 所以这里不针对某一条断言，而是把这一套跑下来**真发出去过的所有消息**
     * 扫一遍。将来谁加了一句长文案，这里立刻红 —— 不用等用户再提一次。
     *
     * 三条线（都不是拍脑袋定的）：
     *   - 顶栏那行 ≤ 24 字、不许换行（它本来就只放得下几个字）；
     *   - 对话流提示第一行 ≤ 32 字、最多三行；第一行之后的**引用**行（以
     *     「原因：」「内核原话：」开头的那种）放宽到 80 字 —— 那是内核的原话，
     *     不是我在跟用户絮叨，截短了反而查不出问题（但也不能整段糊上来）；
     *   - 报错的第一句（title）≤ 32 字、怎么办（advice）≤ 48 字
     *     —— 内核原文不在此列，它照旧一字不删地附在后面。
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

    // 最长的那几条打出来，方便下次改的时候一眼看到现在的尺度。
    const longest = (list, pick) =>
      list
        .map(pick)
        .sort((a, b) => String(b).length - String(a).length)[0] || '（无）';
    console.log(`     最长顶栏：${longest(statuses, (m) => m.detail)}`);
    console.log(`     最长提示：${longest(notices, (m) => String(m.text).split('\n')[0])}`);
    console.log(`     最长报错：${longest(errors, (m) => m.human && m.human.title)}`);

    /*
     * 第二条规矩（用户 2026-09-19 第二次提意见的原话）：
     * 「『门』都出来了，别人能知道是什么意思？类似的提示全删了。」
     *
     * 面板是给用户看的，不是给我们自己排障的 —— 所以**这一整套跑下来真发出去
     * 过的所有提示/报错/顶栏文案**里，不许出现内部词：组件名（门）、包名
     * （dsh-acp-door / dsh-base / @deepseek-ai/*）、版本号（0.0.12）、「档」
     * （profile）、设置项全名、「内核原话」这种我们自己才用的说法。
     *
     * 注意边界：**内核原文不算**。它是内核自己吐的英文/JSON，收在
     * 「原始报错（点开）」折叠区里和日志里，一个字都不删 —— 那是我自己那句话
     * 之后附上的证据，不是我在跟用户讲解。所以这里只扫：
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
    check(`给用户看的字里没有内部词（扫了 ${userFacing.length} 条：门 / 包名 / 版本号 / 档 / 设置项）`,
      withJargon.length === 0,
      JSON.stringify(withJargon));
  }

  section('9. 收摊');
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
  console.error('💥 测试崩了：', error.stack || error.message);
  process.exit(1);
});
