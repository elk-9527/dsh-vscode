/**
 * ACP 接入点插件（`dsh-acp-door`）的帧解析与改写纯函数测试。
 *
 * 设置该层的原因：该插件本体只能在**真实内核**中运行（启动进程、建立 TCP 连接、等待模型响应），
 * 单次执行耗时数十秒；此处覆盖的判断均为纯函数，全部执行耗时数毫秒。因此凡是可以脱离内核
 * 独立测试的逻辑都放在 lib/frames.js 中，由本文件负责验证。
 *
 * 跑法：node test/frames.js
 */

import {
  DOOR_META_KEY,
  FALLBACK_PRESETS,
  createOutboundRelay,
  doorSessionsResult,
  isNewSessionRequest,
  isResponseTo,
  normalizePresets,
  parseLine,
  readPresetMeta,
  requestedPreset,
  sessionCloseTarget,
  waitForMount,
  withPresetMeta,
} from '../lib/frames.js';

let passed = 0;
const failures = [];

function section(title) {
  console.log(`\n── ${title} ──`);
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

function equal(label, actual, expected) {
  const same = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// ─────────────────────────────────────────────────────────────
section('1. parseLine：坏行不得使该插件异常');
equal('正常一帧', parseLine('{"id":1,"method":"session/new"}\n').method, 'session/new');
equal('前后有空白也认', parseLine('  {"id":2}\t').id, 2);
equal('空行 → undefined', parseLine(''), undefined);
equal('只有空白 → undefined', parseLine('   \n'), undefined);
equal('半截 JSON → undefined', parseLine('{"id":1,'), undefined);
equal('不是 JSON → undefined', parseLine('hello world'), undefined);
equal('JSON 但只是个数字 → undefined', parseLine('42'), undefined);
equal('JSON 但是 null → undefined', parseLine('null'), undefined);
equal('JSON 但是数组', Array.isArray(parseLine('[1,2]')), true);
equal('JSON 但是字符串 → undefined', parseLine('"just a string"'), undefined);

// ─────────────────────────────────────────────────────────────
section('2. isNewSessionRequest：只认建会话的请求');
check('正牌 session/new', isNewSessionRequest({ id: 1, method: 'session/new' }));
check('没有 id 不算', !isNewSessionRequest({ method: 'session/new' }));
check('id 是 0 也算（0 是合法 id）', isNewSessionRequest({ id: 0, method: 'session/new' }));
check('别的 method 不算', !isNewSessionRequest({ id: 1, method: 'session/prompt' }));
check('回复（没有 method）不算', !isNewSessionRequest({ id: 1, result: {} }));
check('undefined 不算', !isNewSessionRequest(undefined));

equal('session/close 取出目标 id', sessionCloseTarget({ id: 2, method: 'session/close', params: { sessionId: 's1' } }), 's1');
equal('session/close 缺请求 id 时不跟踪', sessionCloseTarget({ method: 'session/close', params: { sessionId: 's1' } }), undefined);
equal('session/close 缺会话 id 时不跟踪', sessionCloseTarget({ id: 2, method: 'session/close', params: {} }), undefined);
check('null 不算', !isNewSessionRequest(null));

// ─────────────────────────────────────────────────────────────
section('3. requestedPreset：从 _meta 里读客户端点名');
const meta = (preset) => ({ params: { _meta: { [DOOR_META_KEY]: { preset } } } });
equal('正常点名', requestedPreset(meta('ptc')), 'ptc');
equal('两边空白会去掉', requestedPreset(meta('  cordis  ')), 'cordis');
equal('没带 _meta → undefined', requestedPreset({ params: {} }), undefined);
equal(
  '_meta 里没有该插件的键 → undefined',
  requestedPreset({ params: { _meta: { other: { preset: 'ptc' } } } }),
  undefined,
);
equal('preset 不是字符串 → undefined', requestedPreset(meta(123)), undefined);
equal('preset 是空串 → undefined', requestedPreset(meta('')), undefined);
equal('preset 全是空格 → undefined', requestedPreset(meta('   ')), undefined);
equal('preset 是 null → undefined', requestedPreset(meta(null)), undefined);
equal('meta 不是对象也不炸', requestedPreset({ params: { _meta: { [DOOR_META_KEY]: 'ptc' } } }), undefined);
equal('整帧 undefined 也不炸', requestedPreset(undefined), undefined);
equal('该插件的键名就是 dsh-door', DOOR_META_KEY, 'dsh-door');

// ─────────────────────────────────────────────────────────────
section('4. isResponseTo：只认我们等的那几个 id');
const ids = new Set([2, 7]);
check('等着的 id', isResponseTo({ id: 2, result: {} }, ids));
check('没等的 id 不算', !isResponseTo({ id: 3, result: {} }, ids));
check('带 method 的（是请求不是回复）不算', !isResponseTo({ id: 2, method: 'session/update' }, ids));
check('没有 id 不算', !isResponseTo({ result: {} }, ids));
check('空集合一律不算', !isResponseTo({ id: 2, result: {} }, new Set()));
check('Map 也能当集合用（实现里就是这么用的）', isResponseTo({ id: 2, result: {} }, new Map([[2, {}]])));
check('undefined 帧不算', !isResponseTo(undefined, ids));

// ─────────────────────────────────────────────────────────────
section('5. normalizePresets：只留该给客户端看的字段');
const rows = [
  { id: 'standard', name: '标准模式', description: '全能', order: 1, internalToken: 'x', hidden: true },
  { id: 'ptc', name: 'PTC 模式', order: 2 },
  'minimal',
  { name: '没有 id，丢掉' },
  { id: '', name: 'id 是空串，丢掉' },
  null,
  42,
];
const list = normalizePresets(rows);
equal('数量对（7 条里活下来 3 条）', list.length, 3);
equal('第一条 id', list[0].id, 'standard');
equal('第一条中文名', list[0].name, '标准模式');
equal('description 保留', list[0].description, '全能');
equal('order 保留', list[0].order, 1);
check(
  '内核的内部字段没漏出去（这是这个函数存在的理由）',
  !('internalToken' in list[0]) && !('hidden' in list[0]),
  JSON.stringify(list[0]),
);
equal('order 2 原样带过来', list[1].order, 2);
equal('字符串形式也能用', list[2].id, 'minimal');
equal('字符串形式没写 order 就不带 order', 'order' in list[2], false);
check('只有 id、没有多余字段', Object.keys(list[2]).join(',') === 'id', Object.keys(list[2]).join(','));
equal('不是数组 → 空清单', normalizePresets('nope').length, 0);
equal('undefined → 空清单', normalizePresets(undefined).length, 0);
equal('空数组 → 空清单', normalizePresets([]).length, 0);
equal('order 是 NaN 就不带', 'order' in normalizePresets([{ id: 'a', order: Number.NaN }])[0], false);
equal('后备清单有 4 个', FALLBACK_PRESETS.length, 4);
check(
  '后备清单的 id 与内核自带的对得上',
  FALLBACK_PRESETS.map((p) => p.id).join(',') === 'standard,ptc,minimal,cordis',
  FALLBACK_PRESETS.map((p) => p.id).join(','),
);
check('后备清单每个都带中文名', FALLBACK_PRESETS.every((p) => typeof p.name === 'string' && p.name));

// ─────────────────────────────────────────────────────────────
section('6. withPresetMeta：只加 _meta，别的一个不动');
const reply = { jsonrpc: '2.0', id: 2, result: { sessionId: 'abc', configOptions: [{ id: 'model' }] } };
const decorated = withPresetMeta(reply, { presets: list, current: 'standard' });
equal('原有字段一个没少', decorated.result.sessionId, 'abc');
equal('configOptions 原样保留', decorated.result.configOptions.length, 1);
equal('jsonrpc 与 id 没动', `${decorated.jsonrpc}/${decorated.id}`, '2.0/2');
equal('补上了清单', decorated.result._meta[DOOR_META_KEY].presets.length, 3);
equal('补上了当前值', decorated.result._meta[DOOR_META_KEY].current, 'standard');
check('原帧没被就地改（调用方可能还在用）', reply.result._meta === undefined);
check('undefined 的字段不会写进去（JSON 里就是没有这个键）', !('fallback' in readPresetMeta(decorated)));
const withFallback = withPresetMeta(reply, { current: 'standard', requested: 'nope', fallback: true });
equal('fallback=true 会写进去', readPresetMeta(withFallback).fallback, true);
equal('requested 也写进去', readPresetMeta(withFallback).requested, 'nope');
equal(
  '已有的 _meta 不会被冲掉',
  withPresetMeta({ id: 1, result: { _meta: { vendor: 1 } } }, { current: 'x' }).result._meta.vendor,
  1,
);
equal(
  '出错的回复（没有 result）原样返回',
  withPresetMeta({ id: 1, error: { code: -1 } }, { current: 'x' }).error.code,
  -1,
);
check('没有 result 时不硬塞 _meta', !('_meta' in (withPresetMeta({ id: 1, error: {} }, { current: 'x' }) ?? {})));
equal('result 不是对象也原样返回', withPresetMeta({ id: 1, result: 'plain' }, { current: 'x' }).result, 'plain');
equal('帧是 undefined 也不炸', withPresetMeta(undefined, { current: 'x' }), undefined);

// ─────────────────────────────────────────────────────────────
section('7. readPresetMeta：客户端读得回来');
equal('从 result._meta 读', readPresetMeta(decorated).current, 'standard');
equal(
  '从顶层 _meta 也读得回来（通知帧的形状）',
  readPresetMeta({ _meta: { [DOOR_META_KEY]: { current: 'ptc' } } }).current,
  'ptc',
);
equal('没有就 undefined', readPresetMeta({ id: 1, result: {} }), undefined);
equal('坏帧也不炸', readPresetMeta(undefined), undefined);
// 一次完整往返：客户端指定预设名，该插件补全清单，客户端读取
const roundTrip = withPresetMeta(
  { id: 9, result: { sessionId: 's1' } },
  { presets: normalizePresets([{ id: 'minimal', name: '极简模式' }]), current: requestedPreset(meta('minimal')) },
);
equal('点名什么，回来就是什么', readPresetMeta(roundTrip).current, 'minimal');

// ─────────────────────────────────────────────────────────────
// 出站中继是异步管道，因此在 async 段内测试；总结在最后统一输出。
async function relayTests() {
  section('8. createOutboundRelay：写进来的行必须真的从 sink 出来');
  const encoder = new TextEncoder();
  // 模拟 sink：接收字节并累积为一个字符串。真实 socket 在 web 化之后与此相同。
  const chunks = [];
  const sink = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
  });

  function makeState() {
    return {
      pending: new Map(),
      replies: new Map(),
      closes: new Map(),
      applied: new Map(),
      sessionPresets: new Map(),
      defaultPreset: 'standard',
      listPromise: Promise.resolve(FALLBACK_PRESETS),
    };
  }

  const state = makeState();
  const relay = createOutboundRelay(sink, state, () => {});
  const writer = relay.getWriter();

  // (1) 普通回复：原样通过。
  await writer.write(encoder.encode('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n'));
  await flushRelay();
  equal('普通回复一字不改地通过', text(chunks), '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n');

  // (2) session/new 的回复：需要补全预设清单。
  state.replies.set(8, { request: 8, preset: undefined });
  await writer.write(encoder.encode('{"jsonrpc":"2.0","id":8,"result":{"sessionId":"s1"}}\n'));
  await flushRelay();
  const lines = text(chunks).split('\n').filter(Boolean);
  const decorated = parseLine(lines[lines.length - 1]);
  check('session/new 回复带上了 _meta 清单', Boolean(readPresetMeta(decorated)), text(chunks));
  equal('清单里是后备四项', readPresetMeta(decorated).presets.length, FALLBACK_PRESETS.length);
  equal('current 报默认预设', readPresetMeta(decorated).current, 'standard');
  equal('sessionId 没被动过', decorated.result.sessionId, 's1');

  // (3) 该插件自身的旁路应答（state.respond）与内核回复使用**同一个**写出通道，
  //     且先后顺序不会错乱 —— 两个来源交错写入会将一行 JSON 拆成两段。
  chunks.length = 0;
  state.respond(doorSessionsResult(99, { sessions: [], skipped: 0 }));
  await writer.write(encoder.encode('{"jsonrpc":"2.0","id":10,"result":{}}\n'));
  await flushRelay();
  equal('旁路应答与内核回复都从同一出口出来且各占一行',
    text(chunks),
    '{"jsonrpc":"2.0","id":99,"result":{"sessions":[],"skipped":0}}\n{"jsonrpc":"2.0","id":10,"result":{}}\n');

  // (4) 不完整的行（没有换行）不提前出站；close 时输出。
  chunks.length = 0;
  await writer.write(encoder.encode('{"partial":'));
  await flushRelay();
  equal('半截行不出站', text(chunks), '');
  writer.releaseLock();
  await relay.close();
  await flushRelay();
  equal('close 时把半截行吐出来', text(chunks), '{"partial":');

  // (5) 损坏的行不导致失败：装饰抛错时原样放行。
  const state2 = makeState();
  const sink2Chunks = [];
  const relay2 = createOutboundRelay(
    new WritableStream({ write(c) { sink2Chunks.push(c); } }),
    state2,
    () => {},
  );
  const writer2 = relay2.getWriter();
  await writer2.write(encoder.encode('这不是 JSON\n'));
  await flushRelay();
  equal('坏行原样放行不炸', text(sink2Chunks), '这不是 JSON\n');
  writer2.releaseLock();
  await relay2.close();

  // (6) 建会话**失败**时，指定的预设名必须从队列中移除 —— 否则下一次建会话会取到它。
  //     这是一个实际出现过的 bug：预筛条件为 `line.includes('"result"')`，
  //     于是"只有 error、没有 result"的回复完全没有被处理，队列始终不清理。
  const state3 = makeState();
  state3.queue = [];
  state3.resumes = new Map();
  const sink3Chunks = [];
  const relay3 = createOutboundRelay(
    new WritableStream({ write(c) { sink3Chunks.push(c); } }),
    state3,
    () => {},
  );
  const writer3 = relay3.getWriter();

  // 用户指定 ptc 预设建立会话，请求失败。
  const failedAsk = { request: 21, preset: 'ptc' };
  state3.queue.push(failedAsk);
  state3.replies.set(21, failedAsk);
  await writer3.write(encoder.encode('{"jsonrpc":"2.0","id":21,"error":{"code":-32000,"message":"建会话失败"}}\n'));
  await flushRelay();
  equal('出错的回复原样出站（不硬塞 _meta）',
    text(sink3Chunks),
    '{"jsonrpc":"2.0","id":21,"error":{"code":-32000,"message":"建会话失败"}}\n');
  equal('失败的点名已从队列里摘掉', state3.queue.length, 0);
  equal('失败请求也从"等回复"里摘掉了', state3.replies.size, 0);

  // 下一次建会话（本次未指定预设）：不得取到上一次的 ptc。
  const nextAsk = { request: 22, preset: undefined };
  state3.queue.push(nextAsk);
  state3.replies.set(22, nextAsk);
  await writer3.write(encoder.encode('{"jsonrpc":"2.0","id":22,"result":{"sessionId":"s2"}}\n'));
  await flushRelay();
  const lastLine = parseLine(text(sink3Chunks).split('\n').filter(Boolean).pop());
  equal('下一次建会话没有被上一次失败的点名污染',
    readPresetMeta(lastLine).requested, undefined);
  check('成功回复后请求期队列也已清空',
    state3.queue.length === 0,
    `队列 ${state3.queue.map((item) => `${item.request}:${item.preset ?? '-'}`).join(',') || '(空)'}`);

  // session/resume 失败时同理：resumes 中的对应条目同样需要移除。
  const resumeAsk = { request: 23, preset: 'minimal', sessionId: 's9' };
  state3.resumes.set('s9', resumeAsk);
  state3.replies.set(23, resumeAsk);
  await writer3.write(encoder.encode('{"jsonrpc":"2.0","id":23,"error":{"code":-32000,"message":"恢复失败"}}\n'));
  await flushRelay();
  check('恢复失败时 resumes 里那条也摘掉了', !state3.resumes.has('s9'));

  // session/resume 成功时也要清理请求期索引，不能让每次恢复都在连接内永久留一条。
  const successfulResume = { request: 24, preset: 'minimal', sessionId: 's10' };
  state3.resumes.set('s10', successfulResume);
  state3.replies.set(24, successfulResume);
  state3.applied.set('s10', 'minimal');
  await writer3.write(encoder.encode('{"jsonrpc":"2.0","id":24,"result":{"sessionId":"s10"}}\n'));
  await flushRelay();
  check('恢复成功时 resumes 中的请求期索引已清理', !state3.resumes.has('s10'));

  // session/close 成功：释放仅属于当前连接的状态，但保留跨连接的预设记忆（以后仍可 resume）。
  state3.closes.set(25, 's10');
  state3.applied.set('s10', 'minimal');
  state3.pending.set('s10', Promise.resolve());
  state3.resumes.set('s10', successfulResume);
  state3.sessionPresets.set('s10', 'minimal');
  await writer3.write(encoder.encode('{"jsonrpc":"2.0","id":25,"result":{}}\n'));
  await flushRelay();
  check('关闭成功后删除关闭请求索引', !state3.closes.has(25));
  check('关闭成功后释放本连接的会话临时状态',
    !state3.applied.has('s10') && !state3.pending.has('s10') && !state3.resumes.has('s10'));
  equal('关闭成功后保留跨连接预设记忆', state3.sessionPresets.get('s10'), 'minimal');

  // 关闭失败意味着会话仍然有效，不可提前删掉它的状态。
  state3.closes.set(26, 's11');
  state3.applied.set('s11', 'ptc');
  await writer3.write(encoder.encode('{"jsonrpc":"2.0","id":26,"error":{"code":-32000,"message":"关闭失败"}}\n'));
  await flushRelay();
  check('关闭失败只移除请求索引并保留会话状态', !state3.closes.has(26) && state3.applied.get('s11') === 'ptc');

  // 未跟踪过的 id 出错：不改变任何状态，也不产生额外输出。
  state3.replies.clear();
  const before = JSON.stringify([...state3.resumes.keys()]);
  await writer3.write(encoder.encode('{"jsonrpc":"2.0","id":404,"error":{"code":-32601,"message":"未知的方法"}}\n'));
  await flushRelay();
  equal('没跟踪过的出错回复不碰状态', JSON.stringify([...state3.resumes.keys()]), before);
  writer3.releaseLock();
  await relay3.close();

  function text(list) {
    return Buffer.concat(list.map((item) => Buffer.from(item))).toString('utf8');
  }
  async function flushRelay() {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ─────────────────────────────────────────────────────────────
try {
  await relayTests();
} catch (error) {
  failures.push(`出站中继测试自己抛错了：${error && error.message ? error.message : error}`);
  console.error(error);
}

// ─────────────────────────────────────────────────────────────
// waitForMount：入站与出站两处等待共用的「等待，但必须有上限」。
// 其防范的场景是「内核某个服务永不落定 → 消息被永久扣留、静默消失」——
// 此类故障没有报错、没有日志，用户侧的表现只有"发出后没有响应"。
section('9. waitForMount：等挂载，但绝不无限等');

/** 构造一个永不自行落定的 promise，并额外提供用于收尾的 resolve。 */
function makeNever() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

try {
  const never = makeNever();
  const t0 = Date.now();
  const timedOut = await waitForMount(never.promise, 40);
  const waited = Date.now() - t0;
  check('永不落定的挂载：到点放行（返回 false）', timedOut === false, `返回 ${timedOut}`);
  check('确实等满了上限才放行', waited >= 35 && waited < 2000, `等了 ${waited}ms`);
  never.release('late'); // 收尾，避免定时器持续挂起

  equal('正常落定：返回 true', await waitForMount(Promise.resolve('ok'), 1000), true);
  equal(
    '挂载失败也算落定（返回 true，不因为它无限等）',
    await waitForMount(Promise.reject(new Error('挂载失败')), 1000),
    true,
  );
  equal('没有 pending（undefined）：直接放行', await waitForMount(undefined, 1000), true);
  equal('给的不是 promise：也直接放行', await waitForMount({}, 1000), true);
} catch (error) {
  failures.push(`waitForMount 测试自己抛错了：${error && error.message ? error.message : error}`);
  console.error(error);
}

console.log(`\n${'═'.repeat(56)}`);
if (failures.length === 0) {
  console.log(`✅ frames.js 全部通过：${passed} 项检查`);
  process.exit(0);
}
console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const label of failures) console.log(`   - ${label}`);
process.exit(1);
