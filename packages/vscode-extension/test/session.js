'use strict';

/**
 * DshSession（src/dsh/session.js）的边界测试 —— 使用一个假的 ACP 接入点插件（dsh-acp-door）客户端。
 *
 * 设立该层的原因：session.js 此前仅在「真 DSH」套件中被测，该套件价值高但耗时较长，
 * 且无法覆盖边界情况 —— 内核不会返回缺少字段的 configOptions，也不会在
 * 用量帧中只提供一半数值。这些少见但会出错的分支只能使用假客户端固定。
 *
 * 此处覆盖的均为实际出现过或接近出现的问题，并非为填充数量而编写。
 *
 * 运行方式：node test/session.js
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DshSession } = require(path.join(__dirname, '..', 'src', 'dsh', 'session.js'));

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────`);
}

/**
 * 假的该插件客户端：仅实现 session.js 使用到的若干能力（均为 EventEmitter）。
 *
 * @param {object} options
 * @param {object} options.newSessionReply session/new 的回复。
 * @param {Function} [options.setConfigReply] 收到 setConfigOption 时返回什么 / 执行什么。
 */
function fakeClient({ newSessionReply, setConfigReply, promptReply } = {}) {
  const client = new EventEmitter();
  client.calls = { newSession: [], prompt: [], setConfigOption: [], respond: [], close: [] };
  client.newSession = async (cwd, options) => {
    client.calls.newSession.push({ cwd, options });
    return newSessionReply || { sessionId: 's-1', configOptions: [] };
  };
  client.prompt = async (sessionId, blocks, options) => {
    client.calls.prompt.push({ sessionId, blocks, options });
    if (typeof promptReply === 'function') return promptReply(sessionId, blocks, options);
    return { stopReason: 'end_turn' };
  };
  client.setConfigOption = async (sessionId, configId, value) => {
    client.calls.setConfigOption.push({ sessionId, configId, value });
    if (typeof setConfigReply === 'function') return setConfigReply(sessionId, configId, value);
    return { configOptions: [] };
  };
  client.respond = (requestId, result) => client.calls.respond.push({ requestId, result });
  client.close = async () => client.calls.close.push(true);
  return client;
}

function modelOption(currentValue) {
  return {
    id: 'model',
    name: '模型',
    currentValue,
    options: [
      { value: '["opencode-go","deepseek-v4.1-flash"]', name: 'deepseek-v4.1-flash' },
      { value: '["opencode-go","deepseek-v4.1"]', name: 'deepseek-v4.1' },
    ],
  };
}

const A = '["opencode-go","deepseek-v4.1-flash"]';
const B = '["opencode-go","deepseek-v4.1"]';

async function main() {
  console.log('DSH Panel · 会话层边界（假客户端）');

  // ── 1. 切模型：以内核返回值为准 ────────────────────────────
  section('1. 切模型时信内核，不信自己');
  {
    // 内核把请求归一化为其他值（实际可能：同名不同服务商、被降级）。
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [modelOption(A)] },
      setConfigReply: () => ({ configOptions: [modelOption(A)] }),
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    await session.setModel(B);
    const now = session.configOptions.find((o) => o.id === 'model').currentValue;
    check('内核回什么就记什么（不是记我请求的那个）', now === A, `记成了 ${now}`);
    check('还是把最新的配置广播给界面了',
      session.configOptions.length === 1 && session.configOptions[0].id === 'model');
  }
  {
    // 旧版内核不返回 configOptions 时，退回修改本地副本（否则下拉框会卡住）。
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [modelOption(A)] },
      setConfigReply: () => ({}),
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    await session.setModel(B);
    const now = session.configOptions.find((o) => o.id === 'model').currentValue;
    check('内核没回配置时退回本地记请求值', now === B, `记成了 ${now}`);
  }
  {
    // 内核未提供 model 项：不得抛出异常，也不得记录为已切换。
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [] },
      setConfigReply: () => ({ configOptions: [] }),
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    let threw = null;
    try {
      await session.setModel(B);
    } catch (error) {
      threw = error;
    }
    check('内核不给 model 配置项时不抛错（只是没得切）', threw === null, threw && threw.message);
    check('也确实没去调内核切一个不存在的项', client.calls.setConfigOption.length === 1);
  }
  {
    // 无会话时切换模型：须明确报错，不得静默。
    const session = new DshSession({ client: fakeClient({}), log: () => {} });
    let message = '';
    try {
      await session.setModel(B);
    } catch (error) {
      message = error.message;
    }
    check('还没有会话时切模型会明确报错', message.includes('还没有会话'), message);
  }

  // ── 2. 启动时按配置切换模型 ──────────────────────────
  section('2. 启动时套用配置里的模型');
  {
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [modelOption(A)] },
      setConfigReply: () => ({ configOptions: [modelOption(B)] }),
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x', provider: 'opencode-go', model: 'deepseek-v4.1' });
    check('建完会话就去切模型了', client.calls.setConfigOption.length === 1,
      JSON.stringify(client.calls.setConfigOption));
    check('传的是内核清单里的那个 value（不是自己拼的）',
      client.calls.setConfigOption[0].value === B, client.calls.setConfigOption[0].value);
  }
  {
    // 已经是该模型：不应重复切换（每次切换都可能需要重启 agent）。
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [modelOption(B)] },
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x', provider: 'opencode-go', model: 'deepseek-v4.1' });
    check('已经是这个模型就不重复切', client.calls.setConfigOption.length === 0);
  }
  {
    // 配置指定了内核不存在的模型：不得切换，避免破坏会话。
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [modelOption(A)] },
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x', provider: 'nope', model: 'ghost-model' });
    check('配置里的模型不在清单里时不动手', client.calls.setConfigOption.length === 0);
  }

  // ── 3. 用量帧：只提供一半数值时也须可用 ──────────────────
  section('3. 上下文用量（帧里只有一半数字时）');
  {
    const client = fakeClient({ newSessionReply: { sessionId: 's-1', configOptions: [] } });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    const seen = [];
    session.on('usage', (payload) => seen.push(payload));

    client.emit('update', 's-1', { sessionUpdate: 'usage_update', used: 1000, size: 200000 });
    check('第一次就给出完整数字', seen.length === 1 && seen[0].used === 1000 && seen[0].size === 200000,
      JSON.stringify(seen));

    // 内核有时只上报 used（size 不变）。
    client.emit('update', 's-1', { sessionUpdate: 'usage_update', used: 1500 });
    check('只报 used 时 size 沿用上一次', seen.length === 2 && seen[1].used === 1500 && seen[1].size === 200000,
      JSON.stringify(seen[1]));

    // 只上报 size（切换模型导致窗口变化）。
    client.emit('update', 's-1', { sessionUpdate: 'usage_update', size: 128000 });
    check('只报 size 时 used 沿用上一次', seen[2].used === 1500 && seen[2].size === 128000,
      JSON.stringify(seen[2]));

    // 两者均无：该帧无效，不应广播（否则界面会短暂显示 0）。
    const before = seen.length;
    client.emit('update', 's-1', { sessionUpdate: 'usage_update' });
    check('一个数字都没有的用量帧被忽略', seen.length === before, `多广播了 ${seen.length - before} 次`);

    // 其他会话的帧：必须忽略（否则打开多个面板会产生串扰）。
    client.emit('update', 's-OTHER', { sessionUpdate: 'usage_update', used: 9, size: 9 });
    check('别的会话的用量帧被忽略', seen.length === before);
  }

  // ── 4. 帧的归属与合并 ───────────────────────────────────
  section('4. 流式帧的归属与合并');
  {
    const client = fakeClient({ newSessionReply: { sessionId: 's-1', configOptions: [] } });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    session.messages.set('m1', { id: 'm1', role: 'assistant', text: '', thinking: '', tools: [] });

    const texts = [];
    session.on('text', (payload) => texts.push(payload));
    client.emit('update', 's-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '甲' } });
    client.emit('update', 's-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '乙' } });
    check('两片增量都到了', texts.length === 2 && texts[0].delta === '甲' && texts[1].delta === '乙',
      JSON.stringify(texts));
    check('助手消息里累加成了完整文本', session.messages.get('m1').text === '甲乙',
      session.messages.get('m1').text);

    // 内核会重复发送相同的工具帧：必须幂等合并，不得生成两张卡片。
    const tools = [];
    session.on('tool', (payload) => tools.push(payload.tool));
    client.emit('update', 's-1', { sessionUpdate: 'tool_call', toolCallId: 't1', title: '读文件', kind: 'read', status: 'pending' });
    client.emit('update', 's-1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'text', text: 'ok' }] });
    check('同一个工具调用只合并成一张卡片', session.tools.size === 1, `有 ${session.tools.size} 张`);
    check('状态被更新成完成', session.tools.get('t1').status === 'completed');
    check('标题没被后一帧的空值抹掉', session.tools.get('t1').title === '读文件');
    check('正文被填上了', Array.isArray(session.tools.get('t1').content));

    // 空增量不应广播（会导致界面无效果地重排一次）。
    const before = texts.length;
    client.emit('update', 's-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } });
    check('空增量不广播', texts.length === before);
  }

  // ── 5. 空发送与中断 ─────────────────────────────────────
  section('5. 没内容不发送 / 没回合可中断');
  {
    const client = fakeClient({ newSessionReply: { sessionId: 's-1', configOptions: [] } });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    const result = await session.send('   ');
    check('只有空白字符时不发', client.calls.prompt.length === 0, JSON.stringify(client.calls.prompt));
    check('返回 empty 而不是假装跑过了', result && result.stopReason === 'empty', JSON.stringify(result));

    const stopped = session.stop();
    check('没有回合可中断时返回 false，不抛错', stopped === false, String(stopped));
  }
  {
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [] },
      promptReply: async () => { throw new Error('模拟回合失败'); },
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    const errors = [];
    const done = [];
    session.on('error', (payload) => errors.push(payload));
    session.on('done', (payload) => done.push(payload));
    let thrown;
    try {
      await session.send('触发失败');
    } catch (error) {
      thrown = error;
    }
    check('回合失败只向调用方抛出，不再额外广播 error', errors.length === 0 && /模拟回合失败/.test(thrown && thrown.message), JSON.stringify(errors));
    check('回合失败仍发送一次 done(error) 以结束界面状态', done.length === 1 && done[0].status === 'error', JSON.stringify(done));
  }

  // ── 6. 断线 ─────────────────────────────────────────────
  section('6. 该插件断开时');
  {
    const client = fakeClient({ newSessionReply: { sessionId: 's-1', configOptions: [] } });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    const disconnects = [];
    const errors = [];
    session.on('disconnect', (payload) => disconnects.push(payload));
    session.on('error', (payload) => errors.push(payload));
    client.emit('close', '内核退出了');
    check('断线只广播 disconnect，不重复广播 error', disconnects.length === 1 && errors.length === 0, JSON.stringify({ disconnects, errors }));
    check('断线事件里带着原因', String(disconnects[0].reason).includes('内核退出了'), disconnects[0].reason);
  }

  console.log('\n════════════════════════════════════════════════════════');
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项检查`);
  } else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const name of failures) console.log(`   - ${name}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('测试自身发生异常：', error);
  process.exit(1);
});
