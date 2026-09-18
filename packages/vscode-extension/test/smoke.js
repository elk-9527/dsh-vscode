'use strict';

/**
 * 端到端集成测试：用手写的连接层 + 会话核心，真刀真枪跑一遍 DSH。
 *
 * 为什么要有这个：面板的界面我很难自动点，但**面板下面那一层**（协议、
 * 会话状态机、工具事件合并、中断、模型切换）才是真正会出错的地方，
 * 而这些全都能在命令行里跑。所以这里把它们逐条钉死。
 *
 * 用法：
 *   node test/smoke.js              # 跑一遍
 *   node test/smoke.js --repeat 5   # 连跑 5 遍（找偶发问题）
 *   node test/smoke.js --fast       # 跳过比较慢的中断/长回复用例
 *
 * 前置：47821 上有一个开了门的 DSH。没有的话测试会自己拉一个
 * （profile=dshdoor，跑完自己收），所以直接 `node test/smoke.js` 就能跑。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DoorClient } = require('../src/door/client');
const { DshSession, flattenChoices } = require('../src/dsh/session');
const { ensureDoor } = require('./helpers/door');

const HOST = '127.0.0.1';
const PORT = Number(process.env.DSH_PANEL_PORT || 47821);
const SCRATCH = path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch');

const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const REPEAT = (() => {
  const index = args.indexOf('--repeat');
  return index >= 0 ? Number(args[index + 1]) || 1 : 1;
})();

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

function log(level, message) {
  if (process.env.DSH_PANEL_TEST_VERBOSE || level === 'error' || level === 'warn') {
    console.log(`     [${level}] ${message}`);
  }
}

function prepareScratch() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const file = path.join(SCRATCH, 'hello.ts');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '/** 给集成测试用的样本文件。 */\nexport const ANSWER = 42;\n', 'utf8');
  }
  return file;
}

/** 等一个条件成立，或者超时。 */
function waitFor(predicate, { totalMs = 15000, intervalMs = 50 } = {}) {
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

async function runOnce(round) {
  const sample = prepareScratch();
  console.log(`\n══ 第 ${round} 轮 ══════════════════════════════════════════════`);

  // ── 1. 端口（由 main 里的 ensureDoor 保证已经开着）────
  section('1. 门的端口');
  check(`端口 ${PORT} 可连`, true, '（内核由测试自己按需拉起）');

  // ── 2. 握手 ────────────────────────────────────────
  section('2. ACP 握手');
  const client = new DoorClient({ host: HOST, port: PORT, log });
  const init = await client.connect();
  check('initialize 有回应', Boolean(init));
  check('内核自报家门', Boolean(client.agentInfo && client.agentInfo.name), JSON.stringify(client.agentInfo));
  check('协议版本是 1', init.protocolVersion === 1, `实际 ${init.protocolVersion}`);

  // ── 3. 建会话 ──────────────────────────────────────
  section('3. 建会话');
  const session = new DshSession({ client, log });
  const seen = {
    text: 0,
    thinking: 0,
    tools: new Map(),
    usage: null,
    busyOn: false,
    busyOff: false,
    done: null,
    errors: [],
    /** 这一回合的正文原文（用来查暗号在不在回答里）。 */
    answer: '',
  };
  session.on('text', (payload) => {
    seen.text += payload.delta.length;
    seen.answer += payload.delta;
  });
  session.on('thinking', (payload) => {
    seen.thinking += payload.delta.length;
  });
  session.on('tool', (payload) => seen.tools.set(payload.tool.toolCallId, { ...payload.tool }));
  session.on('usage', (payload) => {
    seen.usage = payload;
  });
  session.on('busy', (payload) => {
    if (payload.busy) seen.busyOn = true;
    else seen.busyOff = true;
  });
  session.on('done', (payload) => {
    seen.done = payload;
  });
  session.on('error', (payload) => seen.errors.push(payload.message));

  const sessionId = await session.start({ cwd: SCRATCH });
  check('拿到 sessionId', typeof sessionId === 'string' && sessionId.length > 0, String(sessionId));
  check('拿到了配置项', session.configOptions.length > 0, `${session.configOptions.length} 项`);

  const modelOption = session.configOptions.find((option) => option && option.id === 'model');
  check('配置项里有 model', Boolean(modelOption));
  const choices = modelOption ? flattenChoices(modelOption) : [];
  check('model 有可选清单', choices.length > 0, `${choices.length} 个`);
  if (modelOption) {
    console.log(`     当前模型：${modelOption.currentValue}`);
  }

  // ── 4. 一个真回合（要求用工具）──────────────────────
  section('4. 跑一个真回合（要求它读文件）');
  const started = Date.now();
  const turn = await session.send(
    `请用你的读文件工具读取 ${sample} 的第一行，然后只把那一行的内容原样回给我，不要多余解释。`,
  );
  const elapsed = Date.now() - started;
  check('回合正常结束', Boolean(turn && turn.stopReason), JSON.stringify(turn));
  check('stopReason 是 end_turn', turn.stopReason === 'end_turn', String(turn.stopReason));
  check('收到了正文', seen.text > 0, `${seen.text} 字`);
  check('收到了工具调用', seen.tools.size > 0, `${seen.tools.size} 个`);
  check('收到了上下文用量', Boolean(seen.usage), JSON.stringify(seen.usage));
  check('busy 先开后关', seen.busyOn && seen.busyOff);
  check('没有报错', seen.errors.length === 0, seen.errors.join(' | '));

  const tools = [...seen.tools.values()];
  if (tools.length > 0) {
    const tool = tools[0];
    console.log(`     工具：${JSON.stringify(tool.rawInput)} → ${tool.status}`);
    check('工具跑完了', tools.every((item) => item.status === 'completed' || item.status === 'failed'));
    check('工具是 completed', tools.some((item) => item.status === 'completed'));
    check('工具有输出内容', tools.some((item) => item.content !== null), '工具卡片会是空的');
  }
  console.log(`     本回合耗时 ${elapsed}ms`);

  // ── 5. 中断 ────────────────────────────────────────
  if (!FAST) {
    section('5. 中断一个正在跑的回合');
    seen.done = null;
    const longTurn = session.send('请从 1 数到 200，每个数字单独一行，不要用工具。');
    await waitFor(() => seen.text > 0, { totalMs: 30000 }).catch(() => {});
    const asked = session.stop();
    check('中断请求发出去了', asked);
    let stopReason = null;
    try {
      const result = await longTurn;
      stopReason = result.stopReason;
    } catch (error) {
      stopReason = `抛错：${error.message}`;
    }
    check('中断后 stopReason 是 cancelled', stopReason === 'cancelled', String(stopReason));
    check('中断后 busy 归位', session.busy === false);
  }

  // ── 6. 切模型 ──────────────────────────────────────
  section('6. 切模型');
  if (choices.length > 1) {
    const original = modelOption.currentValue;
    const other = choices.find((choice) => choice.value !== original);
    if (other) {
      await session.setModel(other.value);
      const now = session.configOptions.find((option) => option.id === 'model').currentValue;
      check('模型确实切过去了', now === other.value, `想要 ${other.value}，实际 ${now}`);
      // 切回去，别把用户的默认值改了。
      await session.setModel(original);
      const back = session.configOptions.find((option) => option.id === 'model').currentValue;
      check('切回原模型', back === original, `想要 ${original}，实际 ${back}`);
    } else {
      check('有第二个模型可切', false, '可选清单里只有一个');
    }
  } else {
    console.log('     （只有一个模型可选，跳过）');
  }

  // ── 7. 内核自己的会话列表（ACP session/list）─────────
  // 实测语义：session/list 只返回**已经落盘**的会话，而且只有
  // {sessionId, cwd} 两个字段（没有标题、没有时间）。刚建的空会话不在里面。
  // 所以这里的断言是「接口形状正确」，而不是「一定能找到刚建的会话」。
  //
  // 注意别把它和「历史会话」混起来：历史会话走的是门的旁路方法
  // （dsh-door/sessions/list，第 7.5 节），两者返回的形状**完全不同**。
  section('7. 内核会话列表（session/list）');
  try {
    const list = await client.listKernelSessions();
    const sessions = list && Array.isArray(list.sessions) ? list.sessions : [];
    check('session/list 有回应', Boolean(list), JSON.stringify(list).slice(0, 120));
    check(
      '列表项形状是 {sessionId, cwd}',
      sessions.length === 0 || sessions.every((item) => typeof item.sessionId === 'string'),
      sessions.length ? JSON.stringify(sessions[0]) : '（列表为空）',
    );
    const found = sessions.some((item) => item.sessionId === sessionId);
    console.log(
      `     列表共 ${sessions.length} 个已落盘会话；刚建的会话在里面吗：${found ? '在' : '不在（实测符合预期：空会话不落盘）'}`,
    );
  } catch (error) {
    check('session/list 能调通', false, error.message);
  }

  // ── 7.5 历史会话（门的旁路方法，需要门 0.0.8+）───────
  // 这一节**允许**环境不满足：门是装在用户档里的插件，而那个档由桌面端自己
  // 管理（实测会把依赖重写回旧版），所以「门太旧」是常态。门旧就让这一节
  // 明确报「跳过」，不算失败 —— 面板那边有自己读盘的兜底（见 panel.js 8.9），
  // 那才是用户能用到的路径。以前这里直接断言成功、门一旧整条套件就红，
  // 而红的原因跟被测代码无关，属于「测试自己错了」。
  section('7.5 历史会话（dsh-door/sessions/list，需要门 0.0.8+）');
  try {
    const history = await client.listHistory();
    const items = history && Array.isArray(history.sessions) ? history.sessions : [];
    check('门的旁路方法有回应', Boolean(history));
    check(
      '历史名片形状是 {id, title?, turns}',
      items.length === 0 || items.every((item) => typeof item.id === 'string'),
      items.length ? JSON.stringify(items[0]).slice(0, 160) : '（列表为空）',
    );
    console.log(`     门报回 ${items.length} 段历史会话，跳过了 ${(history && history.skipped) || 0} 段`);
  } catch (error) {
    const text = error && error.message ? error.message : String(error);
    if (/-32601|method not found/i.test(text)) {
      console.log('     ⏭  这一轮连着的门是 0.0.7（没有旁路方法），跳过这一节；');
      console.log('        面板自己读盘的那条路在「面板层」套件 8.9 里验。');
    } else {
      check('历史会话能调通', false, text);
    }
  }

  // ── 8. 再跑一个回合（多轮上下文）────────────────────
  section('8. 多轮：它还记得上一轮吗');
  seen.text = 0;
  await session.send('我刚才让你读的那个文件叫什么名字？只回答文件名。');
  check('第二轮有正文', seen.text > 0, `${seen.text} 字`);

  // ── 8.5 把编辑器里的东西带进对话 ─────────────────────
  // 这一段是整个「编辑器上下文」功能的真凭实据：
  // 选中的代码是不是真的到了模型眼前（它得念出暗号），
  // 以及 resource_link 到底管不管用（它得自己去把文件读出来）。
  if (!FAST) {
    section('8.5 编辑器上下文：选中的代码 + 带进来的文件');

    // (1) 选中的代码：正文直接随消息过去，模型不看文件也该知道暗号。
    const secret = '紫色河马';
    seen.answer = '';
    seen.tools.clear();
    seen.errors.length = 0;
    await session.send('我选中的这段代码里的暗号是什么？只回答暗号本身，不要引号、不要解释。', {
      attachments: [
        {
          kind: 'selection',
          id: 'fake.ts:1-3',
          name: 'fake.ts',
          uri: `file:///${path.join(SCRATCH, 'fake.ts').replace(/\\/g, '/')}`,
          text: `// 无关的注释\nconst 暗号 = '${secret}';\nexport default 暗号;`,
          language: 'typescript',
          detail: '选中 3 行',
        },
      ],
    });
    check('带选区的回合正常结束', seen.errors.length === 0, seen.errors.join(' | '));
    check(
      '选中的代码真的到了模型眼前（它念出了暗号）',
      seen.answer.includes(secret),
      `回答是：${JSON.stringify(seen.answer.slice(0, 120))}`,
    );

    // (2) 带进来的文件：只给一条 resource_link，模型得自己用工具去读。
    const fileSecret = '蓝色长颈鹿';
    const attachedFile = path.join(SCRATCH, 'door-context.md');
    fs.writeFileSync(attachedFile, `# 门\n\n这个文件里的暗号是：${fileSecret}\n`, 'utf8');

    seen.answer = '';
    seen.tools.clear();
    seen.errors.length = 0;
    await session.send('我带上来的那个文件里的暗号是什么？只回答暗号本身，不要解释。', {
      attachments: [
        {
          kind: 'file',
          id: 'door-context.md',
          name: 'door-context.md',
          uri: `file:///${attachedFile.replace(/\\/g, '/')}`,
          mimeType: 'text/markdown',
          detail: '当前文件',
        },
      ],
    });
    check('带文件的回合正常结束', seen.errors.length === 0, seen.errors.join(' | '));
    check('为读这个文件真的调了工具', seen.tools.size > 0, `${seen.tools.size} 个工具调用`);
    check(
      'resource_link 管用（它自己把文件读出来了）',
      seen.answer.includes(fileSecret),
      `回答是：${JSON.stringify(seen.answer.slice(0, 120))}`,
    );
  }

  session.dispose();
  client.close();
}

(async () => {
  // 内核没开就自己拉一个；用它自己的内核，跑完负责收摊（不留孤儿进程）。
  let door;
  try {
    door = await ensureDoor({ host: HOST, port: PORT, log });
  } catch (error) {
    console.error(`💥 起不来内核：${error.message}`);
    process.exit(1);
  }

  for (let round = 1; round <= REPEAT; round += 1) {
    try {
      await runOnce(round);
    } catch (error) {
      failed += 1;
      failures.push(`第 ${round} 轮崩了：${error.message}`);
      console.log(`\n💥 第 ${round} 轮异常：${error.stack || error.message}`);
    }
  }
  door.stop();

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) {
    console.log(`✅ 全部通过：${passed} 项检查${REPEAT > 1 ? `（${REPEAT} 轮）` : ''}`);
  } else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})();
