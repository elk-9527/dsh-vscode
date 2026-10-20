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
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { DshSession } = require(path.join(__dirname, '..', 'src', 'dsh', 'session.js'));
const { DoorClient } = require('../src/door/client');

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

/** 用内存 socket 驱动真实客户端的逐行帧解析器。 */
async function withMemoryDoor(run) {
  const socket = new EventEmitter();
  const requests = [];
  socket.writable = true;
  socket.setNoDelay = () => {};
  const receive = (...frames) => socket.emit('data', Buffer.from(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'));
  socket.write = (line) => {
    const frame = JSON.parse(line);
    requests.push(frame);
    if (frame.method === 'initialize') queueMicrotask(() => receive({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } }));
    return true;
  };
  socket.destroy = () => { socket.writable = false; socket.emit('close'); };
  const connect = net.connect;
  const client = new DoorClient({ host: '127.0.0.1', port: 1, log: () => {} });
  try {
    net.connect = () => { queueMicrotask(() => socket.emit('connect')); return socket; };
    const connected = client.connect();
    net.connect = connect;
    await connected;
    await run({ client, requests, receive });
  } finally {
    net.connect = connect;
    client.close();
  }
}

const configFrame = (sessionId, configOptions) => ({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions } },
});
const configState = (...values) => [{ ...modelOption(values[0]), options: values.map(value => ({ value, name: value })) }];
const configValues = options => options[0]?.options.map(option => option.value) || [];

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
    // 旧版内核不回读设置时，明确未确认且保留最后确认值。
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [modelOption(A)] },
      setConfigReply: () => ({}),
    });
    const session = new DshSession({ client, log: () => {} });
    await session.start({ cwd: 'D:\\x' });
    let message = '';
    try { await session.setModel(B); } catch (error) { message = error.message; }
    const now = session.configOptions.find((o) => o.id === 'model').currentValue;
    check('内核没回配置时保留最后确认值', now === A, `记成了 ${now}`);
    check('内核没回配置时明确未确认', /未返回设置回读/.test(message), message);
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
    check('内核未公布的模型配置项会明确拒绝', /清单/.test(threw?.message), threw && threw.message);
    check('不向内核发送未公布的配置值', client.calls.setConfigOption.length === 0);
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

  section('7. 更换会话清除旧会话状态');
  {
    const client = fakeClient();
    const session = new DshSession({ client });
    await session.start({ cwd: 'D:\\x' });
    await session.send('old'); session.usage = { used: 10, size: 100 }; session.availableCommands = [{ name: 'old' }];
    session.tools.set('old', {}); session.doorMeta = { current: 'old' };
    await session.start({ cwd: 'D:\\x' });
    check('新会话不保留旧消息、工具和用量', session.messages.size === 0 && session.tools.size === 0 && session.usage === null);
    check('新会话不保留旧命令', session.availableCommands.length === 0);
    await session.send('another'); session.doorMeta = { current: 'old' }; session.usage = { used: 20, size: 100 };
    client.resumeSession = async () => ({});
    await session.resume('history', 'D:\\x');
    check('历史恢复不保留旧转录或旧预设', session.messages.size === 0 && session.usage === null && session.doorMeta === undefined);
    session.dispose();
  }

  section('8. 异步模型目录更新');
  {
    const delayedModel = '["delayed-provider","available-model"]';
    const initial = [{ ...modelOption(A), options: [{ value: A, name: '默认模型' }] }];
    const refreshed = [{
      ...modelOption(A),
      options: [
        { group: 'default', options: [{ value: A, name: '默认模型' }] },
        { group: 'delayed-provider', options: [{ value: delayedModel, name: '延迟就绪的模型' }] },
      ],
    }, {
      id: 'reasoning_effort', currentValue: 'high', options: [{ value: 'high', name: 'High' }],
    }];
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: initial },
      setConfigReply: (_sessionId, _configId, value) => ({
        configOptions: [{ ...refreshed[0], currentValue: value }, refreshed[1]],
      }),
    });
    const session = new DshSession({ client });
    await session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
    check('冷启动首次目录只含已就绪的默认模型', session.configOptions[0].options.length === 1);
    const configs = [];
    const chatEvents = [];
    session.on('config', (payload) => configs.push(payload));
    for (const name of ['user', 'assistant', 'text', 'thinking', 'tool', 'done', 'busy', 'usage', 'commands']) {
      session.on(name, () => chatEvents.push(name));
    }
    // 提供器在建会话后的下一轮事件循环才发布完整目录。
    await new Promise((resolve) => setImmediate(() => {
      client.emit('update', 's-1', { sessionUpdate: 'config_option_update', configOptions: refreshed });
      resolve();
    }));
    check('延迟就绪后原会话收到完整模型和推理配置',
      JSON.stringify(session.configOptions) === JSON.stringify(refreshed));
    check('完整目录通过 config 事件传给界面一次', configs.length === 1
      && JSON.stringify(configs[0].configOptions) === JSON.stringify(refreshed));
    check('空闲目录更新不创建助手消息或改变回合状态', chatEvents.length === 0
      && session.messages.size === 0 && session.tools.size === 0 && session.usage === null
      && session.busy === false && session.currentAbort === null);
    check('目录更新无需新建会话、调用模型或主动切换配置',
      client.calls.newSession.length === 1 && client.calls.prompt.length === 0 && client.calls.setConfigOption.length === 0);
    let selectionError;
    try { await session.setModel(delayedModel); } catch (error) { selectionError = error; }
    check('原会话可以选择延迟出现的模型', !selectionError
      && client.calls.setConfigOption.length === 1
      && client.calls.setConfigOption[0].sessionId === 's-1'
      && client.calls.setConfigOption[0].value === delayedModel,
      selectionError && selectionError.message);
    session.dispose();
  }
  {
    let finishPrompt;
    const pendingReply = new Promise((resolve) => { finishPrompt = resolve; });
    const client = fakeClient({
      newSessionReply: { sessionId: 's-1', configOptions: [modelOption(A)] },
      promptReply: () => pendingReply,
    });
    const session = new DshSession({ client });
    await session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
    const pendingTurn = session.send('read fixture');
    const controller = session.currentAbort;
    const entry = [...session.messages.values()][0];
    const before = JSON.stringify(entry);
    const configs = [];
    const chatEvents = [];
    session.on('config', (payload) => configs.push(payload));
    for (const name of ['assistant', 'text', 'thinking', 'tool', 'done', 'busy', 'usage']) {
      session.on(name, () => chatEvents.push(name));
    }
    const refreshed = [modelOption(B)];
    client.emit('update', 's-1', {
      sessionUpdate: 'config_option_update', configOptions: refreshed,
      content: { type: 'text', text: 'configuration metadata' },
    });
    check('执行回合时同样接收权威配置并广播', configs.length === 1
      && JSON.stringify(configs[0].configOptions) === JSON.stringify(refreshed)
      && session.configOptions[0].currentValue === B);
    check('配置通知不追加助手文本或发送聊天事件', chatEvents.length === 0
      && session.messages.size === 1 && JSON.stringify(entry) === before);
    check('配置通知保持正在执行的回合和中断控制器', session.busy
      && session.currentAbort === controller && !controller.signal.aborted);
    finishPrompt({ stopReason: 'end_turn' });
    await pendingTurn;
    check('目录更新后原回合仍正常完成一次', entry.status === 'done'
      && !session.busy && session.currentAbort === null
      && JSON.stringify(chatEvents) === JSON.stringify(['done', 'busy']));
    session.dispose();
  }
  {
    const initial = [modelOption(A)];
    const client = fakeClient({ newSessionReply: { sessionId: 's-1', configOptions: initial } });
    const session = new DshSession({ client });
    const beforeStart = session.configOptions;
    client.emit('update', null, { sessionUpdate: 'config_option_update', configOptions: [modelOption(B)] });
    check('未建立会话时不接受目录通知', session.configOptions === beforeStart);
    await session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
    const configs = [];
    session.on('config', (payload) => configs.push(payload));
    client.emit('update', 's-other', { sessionUpdate: 'config_option_update', configOptions: [modelOption(B)] });
    check('其他会话目录不能覆盖或广播当前配置', session.configOptions === initial && configs.length === 0);
    for (const configOptions of [undefined, null, {}, { 0: modelOption(B), length: 1 }, 'invalid', 42]) {
      client.emit('update', 's-1', { sessionUpdate: 'config_option_update', configOptions });
    }
    check('非数组目录负载保留当前配置且不广播', session.configOptions === initial && configs.length === 0);
    client.emit('update', 's-1', { sessionUpdate: 'config_option_update', configOptions: [] });
    check('合法空目录清除过期配置并广播', session.configOptions.length === 0
      && configs.length === 1 && configs[0].configOptions.length === 0);
    const beforeDispose = session.configOptions;
    let disposedConfigs = 0;
    // EventEmitter 已取得的监听器快照可能在移除订阅后继续调用。
    client.prependOnceListener('update', () => {
      session.dispose();
      session.on('config', () => { disposedConfigs += 1; });
    });
    client.emit('update', 's-1', { sessionUpdate: 'config_option_update', configOptions: [modelOption(B)] });
    check('分发途中销毁会话也不会写入配置或广播', session.configOptions === beforeDispose && disposedConfigs === 0);
    client.emit('update', 's-1', { sessionUpdate: 'config_option_update', configOptions: [modelOption(B)] });
    check('销毁后解除订阅且后续通知无效', client.listenerCount('update') === 0
      && session.configOptions === beforeDispose && disposedConfigs === 0);
    session.dispose();
  }

  section('9. 同一数据块的回复与配置通知按帧顺序生效');
  await withMemoryDoor(async ({ client, requests, receive }) => {
    const session = new DshSession({ client });
    const configs = [];
    const chatEvents = [];
    session.on('config', payload => configs.push(configValues(payload.configOptions)));
    for (const name of ['assistant', 'text', 'thinking', 'tool', 'done', 'busy']) session.on(name, () => chatEvents.push(name));
    const pending = session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
    receive(
      configFrame('new-session', configState(B)),
      { jsonrpc: '2.0', id: requests.at(-1).id, result: { sessionId: 'new-session', configOptions: configState(A) } },
      configFrame('other-session', configState(B)),
      configFrame('new-session', configState(A, B)),
      configFrame('new-session', {}),
      configFrame('new-session', configState(B)),
      configFrame('new-session', null),
    );
    await pending;
    check('真实解析器同块建立会话后保留最后有效目录', JSON.stringify(configValues(session.configOptions)) === JSON.stringify([B]));
    check('建立回复与随后有效通知按实际帧顺序广播', JSON.stringify(configs) === JSON.stringify([[A], [A, B], [B]]));
    check('同块其他会话及非数组负载不产生额外配置事件', configs.length === 3);
    check('同块配置交接不创建聊天回合或助手消息', chatEvents.length === 0 && session.messages.size === 0
      && !session.busy && session.currentAbort === null);
    session.dispose();
  });
  for (const target of ['s-1', 'history-session']) {
    await withMemoryDoor(async ({ client, requests, receive }) => {
      const session = new DshSession({ client });
      const started = session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
      receive({ jsonrpc: '2.0', id: requests.at(-1).id, result: { sessionId: 's-1', configOptions: configState(A) } });
      await started;
      session.messages.set('old', { id: 'old', role: 'assistant', text: 'old', thinking: '', tools: [] });
      session.tools.set('old', {}); session.usage = { used: 1, size: 10 };
      const configs = [];
      session.on('config', payload => configs.push(configValues(payload.configOptions)));
      const pending = session.resume(target, path.resolve(__dirname, 'fixtures', 'session-config'));
      receive(
        configFrame(target, configState(B)),
        { jsonrpc: '2.0', id: requests.at(-1).id, result: { configOptions: configState(A) } },
        configFrame('other-session', configState(B)),
        configFrame(target, configState(A, B)),
      );
      await pending;
      const expected = target === 's-1' ? [[B], [A], [A, B]] : [[A], [A, B]];
      check(`恢复${target === 's-1' ? '同一' : '不同'}会话保留同块后续目录`, session.sessionId === target
        && JSON.stringify(configValues(session.configOptions)) === JSON.stringify([A, B]));
      check(`恢复${target === 's-1' ? '同一' : '不同'}会话遵循回复前后帧顺序`, JSON.stringify(configs) === JSON.stringify(expected));
      check('恢复配置交接仍清除旧转录、工具和用量', session.messages.size === 0 && session.tools.size === 0 && session.usage === null);
      session.dispose();
    });
  }
  for (const replyFirst of [false, true]) {
    await withMemoryDoor(async ({ client, requests, receive }) => {
      const session = new DshSession({ client });
      const started = session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
      receive({ jsonrpc: '2.0', id: requests.at(-1).id, result: { sessionId: 's-1', configOptions: configState(A, B) } });
      await started;
      const configs = [];
      session.on('config', payload => configs.push(payload.configOptions[0].currentValue));
      const pending = session.setModel(B);
      const reply = { jsonrpc: '2.0', id: requests.at(-1).id, result: { configOptions: configState(B) } };
      const notification = configFrame('s-1', configState(A));
      receive(...(replyFirst ? [reply, notification] : [notification, reply]));
      await pending;
      const expected = replyFirst ? [B, A] : [A, B];
      check(`${replyFirst ? '回复后' : '回复前'}设置通知保持最新帧的权威值`, session.configOptions[0].currentValue === expected.at(-1));
      check('设置回复与通知的 config 事件不被 Promise 续体重排', JSON.stringify(configs) === JSON.stringify(expected));
      session.dispose();
    });
  }
  for (const restore of [false, true]) {
    await withMemoryDoor(async ({ client, requests, receive }) => {
      const session = new DshSession({ client });
      if (restore) {
        const started = session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
        receive({ jsonrpc: '2.0', id: requests.at(-1).id, result: { sessionId: 's-1', configOptions: configState(A) } });
        await started;
      }
      const before = session.configOptions;
      const beforeId = session.sessionId;
      const pending = restore
        ? session.resume('history-session', path.resolve(__dirname, 'fixtures', 'session-config'))
        : session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
      const openingId = requests.at(-1).id;
      session.dispose();
      let error;
      const completed = pending.catch(caught => { error = caught; });
      receive(
        { jsonrpc: '2.0', id: openingId, result: { sessionId: 'new-session', configOptions: configState(B) } },
        configFrame(restore ? 'history-session' : 'new-session', configState(A, B)),
      );
      await completed;
      check(`销毁后的${restore ? '恢复' : '建立'}回复与同块通知不覆写配置`, session.configOptions === before && session.sessionId === beforeId);
      check('已销毁会话的异步建立请求明确取消', error?.code === -32800);
    });
  }

  await withMemoryDoor(async ({ client, requests, receive }) => {
    const session = new DshSession({ client });
    const started = session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
    receive({ jsonrpc: '2.0', id: requests.at(-1).id, result: { sessionId: 's-1', configOptions: configState(A, B) } });
    await started;
    const configs = [];
    session.on('config', payload => configs.push(payload));
    let error;
    const setting = session.setModel(B).catch(caught => { error = caught; });
    const settingId = requests.at(-1).id;
    const restoring = session.resume('history-session', path.resolve(__dirname, 'fixtures', 'session-config'));
    receive(
      { jsonrpc: '2.0', id: requests.at(-1).id, result: { configOptions: configState(A) } },
      { jsonrpc: '2.0', id: settingId, result: { configOptions: configState(B) } },
      configFrame('s-1', configState(B)),
    );
    await Promise.all([setting, restoring]);
    check('旧会话的设置回复不能覆盖已恢复会话', session.sessionId === 'history-session'
      && session.configOptions[0].currentValue === A && configs.length === 1);
    check('旧会话设置回读明确报告会话已更换', /会话已更换/.test(error?.message));
    session.dispose();
  });
  await withMemoryDoor(async ({ client, requests, receive }) => {
    const session = new DshSession({ client });
    const started = session.start({ cwd: path.resolve(__dirname, 'fixtures', 'session-config') });
    receive({ jsonrpc: '2.0', id: requests.at(-1).id, result: { sessionId: 's-1', configOptions: configState(A, B) } });
    await started;
    const before = session.configOptions;
    let error;
    const setting = session.setModel(B).catch(caught => { error = caught; });
    session.dispose();
    let configs = 0;
    session.on('config', () => { configs += 1; });
    receive(
      { jsonrpc: '2.0', id: requests.at(-1).id, result: { configOptions: configState(B) } },
      configFrame('s-1', configState(B)),
    );
    await setting;
    check('销毁后的设置回复与同块通知不覆盖或广播配置', session.configOptions === before && configs === 0);
    check('已销毁会话的设置回读明确失败', /已销毁/.test(error?.message));
    session.dispose();
  });

  console.log('\n════════════════════════════════════════════════════════');
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项检查`);
  } else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const name of failures) console.log(`   - ${name}`);
    process.exit(1);
  }
}

let completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('会话套件尚有未完成检查'); process.exitCode = 1; } });
main().then(() => { completed = true; }).catch((error) => {
  console.error('测试自身发生异常：', error);
  process.exit(1);
});
