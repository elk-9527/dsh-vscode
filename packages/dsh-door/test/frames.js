/**
 * 门的「看帧/改帧」纯函数测试。
 *
 * 为什么要有这一层：门本体只能在**真内核**里跑（起进程、连 TCP、等模型），
 * 一次几十秒；而这里这些判断是纯函数，几毫秒就能全测一遍。所以凡是能拿到
 * 外面来的逻辑，都放在 lib/frames.js 里，由这个文件盯着。
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
section('1. parseLine：坏行不能把门搞崩');
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
check('null 不算', !isNewSessionRequest(null));

// ─────────────────────────────────────────────────────────────
section('3. requestedPreset：从 _meta 里读客户端点名');
const meta = (preset) => ({ params: { _meta: { [DOOR_META_KEY]: { preset } } } });
equal('正常点名', requestedPreset(meta('ptc')), 'ptc');
equal('两边空白会去掉', requestedPreset(meta('  cordis  ')), 'cordis');
equal('没带 _meta → undefined', requestedPreset({ params: {} }), undefined);
equal(
  '_meta 里没有本门的键 → undefined',
  requestedPreset({ params: { _meta: { other: { preset: 'ptc' } } } }),
  undefined,
);
equal('preset 不是字符串 → undefined', requestedPreset(meta(123)), undefined);
equal('preset 是空串 → undefined', requestedPreset(meta('')), undefined);
equal('preset 全是空格 → undefined', requestedPreset(meta('   ')), undefined);
equal('preset 是 null → undefined', requestedPreset(meta(null)), undefined);
equal('meta 不是对象也不炸', requestedPreset({ params: { _meta: { [DOOR_META_KEY]: 'ptc' } } }), undefined);
equal('整帧 undefined 也不炸', requestedPreset(undefined), undefined);
equal('本门的键名就是 dsh-door', DOOR_META_KEY, 'dsh-door');

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
equal('兜底清单有 4 个', FALLBACK_PRESETS.length, 4);
check(
  '兜底清单的 id 跟内核自带的对得上',
  FALLBACK_PRESETS.map((p) => p.id).join(',') === 'standard,ptc,minimal,cordis',
  FALLBACK_PRESETS.map((p) => p.id).join(','),
);
check('兜底清单每个都带中文名', FALLBACK_PRESETS.every((p) => typeof p.name === 'string' && p.name));

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
// 一条完整的来回：客户端点名 → 门补清单 → 客户端读
const roundTrip = withPresetMeta(
  { id: 9, result: { sessionId: 's1' } },
  { presets: normalizePresets([{ id: 'minimal', name: '极简模式' }]), current: requestedPreset(meta('minimal')) },
);
equal('点名什么，回来就是什么', readPresetMeta(roundTrip).current, 'minimal');

// ─────────────────────────────────────────────────────────────
// 出站中继是异步管道，放 async 段里测；总结在最后统一打。
async function relayTests() {
  section('8. createOutboundRelay：写进来的行必须真的从 sink 出来');
  const encoder = new TextEncoder();
  // 假 sink：收字节，攒成一个字符串。真 socket 在 web 化之后长这样。
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

  // (2) session/new 的回复：要补上预设清单。
  state.replies.set(8, { request: 8, preset: undefined });
  await writer.write(encoder.encode('{"jsonrpc":"2.0","id":8,"result":{"sessionId":"s1"}}\n'));
  await flushRelay();
  const lines = text(chunks).split('\n').filter(Boolean);
  const decorated = parseLine(lines[lines.length - 1]);
  check('session/new 回复带上了 _meta 清单', Boolean(readPresetMeta(decorated)), text(chunks));
  equal('清单里是兜底四项', readPresetMeta(decorated).presets.length, FALLBACK_PRESETS.length);
  equal('current 报默认预设', readPresetMeta(decorated).current, 'standard');
  equal('sessionId 没被动过', decorated.result.sessionId, 's1');

  // (3) 门自己的旁路应答（state.respond）跟内核回复走**同一个**写出口，
  //     而且先后顺序不乱 —— 两个来源交错写会把一行 JSON 劈成两半。
  chunks.length = 0;
  state.respond(doorSessionsResult(99, { sessions: [], skipped: 0 }));
  await writer.write(encoder.encode('{"jsonrpc":"2.0","id":10,"result":{}}\n'));
  await flushRelay();
  equal('旁路应答与内核回复都从同一出口出来且各占一行',
    text(chunks),
    '{"jsonrpc":"2.0","id":99,"result":{"sessions":[],"skipped":0}}\n{"jsonrpc":"2.0","id":10,"result":{}}\n');

  // (4) 半截行（没有换行）不提前出站；close 时吐出来。
  chunks.length = 0;
  await writer.write(encoder.encode('{"partial":'));
  await flushRelay();
  equal('半截行不出站', text(chunks), '');
  writer.releaseLock();
  await relay.close();
  await flushRelay();
  equal('close 时把半截行吐出来', text(chunks), '{"partial":');

  // (5) 坏行也不炸：装饰抛错就原样放行。
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

console.log(`\n${'═'.repeat(56)}`);
if (failures.length === 0) {
  console.log(`✅ frames.js 全部通过：${passed} 项检查`);
  process.exit(0);
}
console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const label of failures) console.log(`   - ${label}`);
process.exit(1);
