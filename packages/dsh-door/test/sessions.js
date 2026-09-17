/**
 * 门的「历史会话」读取测试。
 *
 * 不依赖真内核：自己用 zlib.zstdCompressSync 造一份**多帧**会话文件
 * （事件形状按实测逆向的 v3 格式抄），把解码、名片、回放、按 id 取全部过一遍。
 *
 * 跑法：node test/sessions.js（Node 没有 zstd 时退出码 2 = 环境不满足）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  decodeSessionFile,
  getSession,
  hasZstdSupport,
  listSessions,
  resolveSessionsRoot,
  sessionTranscript,
  summarizeSession,
} from '../lib/sessions.js';
import {
  DOOR_SESSIONS_PREFIX,
  doorSessionsError,
  doorSessionsMethod,
  doorSessionsResult,
  isDoorSessionsRequest,
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

if (!hasZstdSupport()) {
  console.log('当前 Node 没有 zlib.zstd 支持，跳过（这不是失败，但也没测到东西）');
  process.exit(2);
}

/** 造一个会话文件：把若干批事件各自压成一帧再拼接 —— 模拟内核的多帧写法。 */
function writeSession(root, group, dirName, batches) {
  const dir = path.join(root, group, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.concat(
    batches.map((batch) =>
      zlib.zstdCompressSync(batch.map((event) => JSON.stringify(event)).join('\n') + '\n'),
    ),
  );
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  fs.writeFileSync(file, buf);
  return file;
}

const base = Date.now();

/** 一段内容完整的假会话（覆盖：标题、插件噪音、思考、工具、坏帧）。 */
function sampleEvents({ id = 'session-abc123', turnTime = base, withTool = true } = {}) {
  const events = [
    { type: 'session', version: 3, id, createdAt: turnTime, cwd: 'D:\\demo', agentPreset: 'standard' },
    { type: 'session/title', seq: 1, time: turnTime + 1, data: { title: '测试会话', source: { kind: 'fallback' } } },
    { type: 'turn/start', seq: 2, time: turnTime + 2, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 3,
      time: turnTime + 3,
      data: { content: [{ type: 'text', text: '帮我看看这个文件' }], source: { kind: 'user' }, role: 'user' },
    },
    {
      type: 'user/message',
      seq: 4,
      time: turnTime + 4,
      data: { content: [{ type: 'text', text: '（系统提示）' }], source: { kind: 'plugin', plugin: 'x' }, role: 'user' },
    },
    {
      type: 'assistant/message',
      seq: 5,
      time: turnTime + 5,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先想想' },
            { type: 'text', text: '我来看看。' },
          ],
        },
      },
    },
  ];
  if (withTool) {
    events.push(
      { type: 'tool/call', seq: 6, time: turnTime + 6, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } },
      {
        type: 'tool/result',
        seq: 7,
        time: turnTime + 7,
        data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '文件内容' }] }] } },
      },
      {
        type: 'assistant/message',
        seq: 8,
        time: turnTime + 8,
        data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '文件说的是……' }] } },
      },
    );
  }
  events.push({ type: 'turn/end', seq: 9, time: turnTime + 9, data: { turn: 1 } });
  return events;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-test-'));

// ─────────────────────────────────────────────────────────────
section('1. resolveSessionsRoot：与内核同一套 DSH_HOME 判定');
equal('DSH_HOME 优先', resolveSessionsRoot({ env: { DSH_HOME: 'D:\\x' }, homedir: 'H' }), 'D:\\x\\sessions');
equal('缺省落主目录', resolveSessionsRoot({ env: {}, homedir: '/home/u' }), path.join('/home/u', '.dsh', 'sessions'));
equal('空白 DSH_HOME 当没填', resolveSessionsRoot({ env: { DSH_HOME: '  ' }, homedir: 'H' }), path.join('H', '.dsh', 'sessions'));

section('2. decodeSessionFile：多帧拼接全解');
{
  const file = writeSession(root, 'g1', 'session-abc123', [
    sampleEvents({ withTool: true }).slice(0, 4),
    sampleEvents({ withTool: true }).slice(4),
  ]);
  const { events, frames, error } = decodeSessionFile(file);
  equal('帧数=2', frames, 2);
  equal('事件数=10', events.length, 10);
  equal('没有坏帧', error, undefined);
  const broken = path.join(root, 'g1', 'broken.zstd');
  fs.writeFileSync(broken, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]));
  const bad = decodeSessionFile(broken);
  check('坏帧不致命（得到 0 事件 + 说明）', bad.events.length === 0 && typeof bad.error === 'string', JSON.stringify(bad));
  const missing = decodeSessionFile(path.join(root, 'no-such.zstd'));
  check('文件不存在给出人话', Boolean(missing.error));
}

section('3. summarizeSession：名片字段');
{
  const file = path.join(root, 'g1', 'session-abc123', 'session.v3.jsonl.zstd');
  const { events } = decodeSessionFile(file);
  const card = summarizeSession(events, { mtime: 123, size: 456 });
  equal('id', card.id, 'session-abc123');
  equal('标题', card.title, '测试会话');
  equal('cwd', card.cwd, 'D:\\demo');
  equal('预设', card.preset, 'standard');
  equal('回合数', card.turns, 1);
  equal('用户消息数（插件噪音不算）', card.userMessages, 1);
  check('兜底标题取用户第一句话', card.fallbackTitle.includes('帮我看看这个文件'));
  equal('lastTime 取最后一个事件', card.lastTime, base + 9);
}

section('4. listSessions：按修改时间排序、limit 截断');
{
  // 第二个会话更晚修改；再放一个没有会话文件的目录（应被无视）。
  const newer = base + 100000;
  writeSession(root, 'g2', 'session-newer', [sampleEvents({ id: 'session-newer', turnTime: newer })]);
  fs.mkdirSync(path.join(root, 'g2', 'not-a-session'), { recursive: true });
  const { sessions, skipped, error } = listSessions(root);
  equal('没有错误', error, undefined);
  equal('数量（空目录不算）', sessions.length, 2);
  equal('新的排前', sessions[0].id, 'session-newer');
  equal('没有截断', skipped, 0);
  const limited = listSessions(root, { limit: 1 });
  equal('limit 生效', limited.sessions.length, 1);
  equal('被截掉的报告出来', limited.skipped, 1);
}

section('5. sessionTranscript：回放重建');
{
  const file = path.join(root, 'g1', 'session-abc123', 'session.v3.jsonl.zstd');
  const { events } = decodeSessionFile(file);
  const { entries, truncated } = sessionTranscript(events);
  equal('不截断', truncated, false);
  equal('条目数：用户+助手+工具+助手', entries.length, 4);
  equal('①用户', entries[0].kind, 'user');
  equal('①文本', entries[0].text, '帮我看看这个文件');
  equal('②助手带思考', entries[1].kind, 'assistant');
  equal('②思考内容', entries[1].thinking, '先想想');
  equal('②正文', entries[1].text, '我来看看。');
  equal('③工具名', entries[2].kind, 'tool');
  equal('③工具名对', entries[2].name, 'read');
  equal('③参数解成对象', entries[2].args, { path: 'a.txt' });
  equal('③输出', entries[2].output, '文件内容');
  equal('④助手', entries[3].text, '文件说的是……');
}

section('6. sessionTranscript：截断保护');
{
  const big = sampleEvents({ withTool: false });
  big.splice(4, 1, {
    type: 'assistant/message',
    seq: 4,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(120) }] } },
  });
  const { entries } = sessionTranscript(big, { maxChars: 50 });
  check('超长文本被截断并注明', entries[1].text.length < 120 && entries[1].text.includes('回放截断'));
  const many = [];
  for (let i = 0; i < 30; i += 1) {
    many.push({
      type: 'user/message',
      seq: i,
      data: { content: [{ type: 'text', text: `第${i}句` }], source: { kind: 'user' }, role: 'user' },
    });
  }
  const capped = sessionTranscript(many, { maxEntries: 10 });
  equal('条数上限生效', capped.entries.length, 10);
  equal('并报告截断', capped.truncated, true);
}

section('7. getSession：按 id 取 + 路径穿越防护');
{
  const { card, entries } = getSession(root, 'session-abc123');
  equal('名片 id', card.id, 'session-abc123');
  check('有回放', entries.length >= 3, String(entries.length));
  // 不带 session- 前缀也认
  const alt = getSession(root, 'abc123');
  equal('前缀可省', alt.card.id, 'session-abc123');
  let threw = '';
  try {
    getSession(root, '..%2F..%2Fevil');
  } catch (error) {
    threw = error.message;
  }
  check('非法 id 被拒', threw.includes('不合法'), threw);
  threw = '';
  try {
    getSession(root, 'session-nope');
  } catch (error) {
    threw = error.message;
  }
  check('找不到说人话', threw.includes('找不到会话'), threw);
}

section('8. frames：门方法的判断与应答构造');
{
  const list = { jsonrpc: '2.0', id: 7, method: 'dsh-door/sessions/list', params: {} };
  const get = { jsonrpc: '2.0', id: 8, method: 'dsh-door/sessions/get', params: { id: 'x' } };
  const prompt = { jsonrpc: '2.0', id: 9, method: 'session/prompt', params: {} };
  check('list 请求认出来', isDoorSessionsRequest(list));
  check('get 请求认出来', isDoorSessionsRequest(get));
  check('session/prompt 不归门', !isDoorSessionsRequest(prompt));
  check('没有 id 的通知不归门', !isDoorSessionsRequest({ jsonrpc: '2.0', method: 'dsh-door/sessions/list' }));
  equal('方法名 list', doorSessionsMethod(list), 'list');
  equal('方法名 get', doorSessionsMethod(get), 'get');
  equal('前缀常量没漂移', DOOR_SESSIONS_PREFIX, 'dsh-door/sessions/');
  const ok = doorSessionsResult(7, { sessions: [] });
  check('成功应答带 id 与 result', ok.id === 7 && Array.isArray(ok.result.sessions) && !ok.error);
  const err = doorSessionsError(7, -32000, '坏了');
  check('错误应答带 code 与 message', err.error.code === -32000 && err.error.message === '坏了');
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n════════════════════════════════════════════════════════`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项检查`);
} else {
  console.log(`❌ ${failures.length} 项失败：`);
  for (const item of failures) console.log(`   - ${item}`);
  process.exit(1);
}
