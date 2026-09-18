'use strict';

/**
 * 两份「历史会话读取」实现的**一致性测试**。
 *
 * 为什么需要它：这份读取逻辑现在有两份实现 —— 门的 `packages/dsh-door/lib/sessions.js`
 * （ESM，给门的旁路方法用）和面板的 `packages/vscode-extension/src/dsh/sessions.js`
 * （CommonJS，给「门太旧 / 门在别的机器上」时自己读盘用）。扩展必须零依赖、
 * 只能是 CJS，没法直接 require 门那份 ESM，所以只能各留一份。
 *
 * 两份各改各的，就是两个会慢慢跑偏的真相 —— 所以这里把**同一批会话文件**
 * 喂给两份实现，逐项比对输出必须完全一致。谁改了一边忘了另一边，这条先炸。
 *
 * 跑法：node test/sessions-parity.js
 * （当前 Node 没有 zstd 时退出码 2 = 环境不满足，不算失败）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const EXT = require('../src/dsh/sessions.js');
const DOOR_FILE = path.resolve(__dirname, '..', '..', 'dsh-door', 'lib', 'sessions.js');

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
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, same ? undefined : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

/** 两份实现（下面统一用这个对象里的函数）。 */
let DOOR;

/** 造一个多帧会话文件：每批事件压成一帧再拼接，模拟内核的写法。 */
function writeSession(root, group, dirName, batches) {
  const dir = path.join(root, group, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.concat(
    batches.map((batch) =>
      zlib.zstdCompressSync(batch.map((event) => JSON.stringify(event)).join('\n') + '\n'),
    ),
  );
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), buf);
}

const base = 1760000000000;

/** 一段内容完整的假会话：标题、插件噪音、思考、工具调用+结果、坏帧都有。 */
function sampleBatches(id) {
  return [
    [
      { type: 'session', version: 3, id, createdAt: base, cwd: 'D:\\demo 目录', agentPreset: 'ptc' },
      { type: 'session/title', seq: 1, time: base + 1, data: { title: '带空格的 标题', source: { kind: 'fallback' } } },
      { type: 'turn/start', seq: 2, time: base + 2, data: { turn: 1 } },
    ],
    [
      {
        type: 'user/message',
        seq: 3,
        time: base + 3,
        data: { content: [{ type: 'text', text: '帮我看看这个文件\n第二行' }], source: { kind: 'user' }, role: 'user' },
      },
      {
        type: 'user/message',
        seq: 4,
        time: base + 4,
        data: { content: [{ type: 'text', text: '（插件塞进来的）' }], source: { kind: 'plugin', plugin: 'x' }, role: 'user' },
      },
      {
        type: 'assistant/message',
        seq: 5,
        time: base + 5,
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [
              { type: 'reasoning', text: '先读文件' },
              { type: 'text', text: '好的，我读一下。' },
              { type: 'tool-call', id: 'c1', name: 'read_file' },
            ],
          },
        },
      },
    ],
    [
      { type: 'tool/call', seq: 6, time: base + 6, data: { callId: 'c1', name: 'read_file', arguments: '{"file_path":"D:\\\\demo 目录\\\\a.ts"}' } },
      {
        type: 'tool/result',
        seq: 7,
        time: base + 7,
        data: {
          message: {
            source: { callId: 'c1' },
            content: [{ type: 'tool-result', content: [{ type: 'text', text: '文件内容在此' }] }],
          },
        },
      },
      { type: 'turn/end', seq: 8, time: base + 8, data: { turn: 1, reason: 'end_turn' } },
    ],
  ];
}

/** 只有一次工具调用、没有结果（中断），回放里不该出现那张卡。 */
function danglingToolBatches(id) {
  return [
    [
      { type: 'session', version: 3, id, createdAt: base - 5000, cwd: 'D:\\demo 目录' },
      { type: 'turn/start', seq: 1, time: base - 4999, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 2,
        time: base - 4998,
        data: { content: [{ type: 'text', text: '问一句' }], source: { kind: 'user' } },
      },
      { type: 'tool/call', seq: 3, time: base - 4997, data: { callId: 'c9', name: 'bash', arguments: '不是 JSON' } },
    ],
  ];
}

async function main() {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    console.log('当前 Node 没有 zlib.zstd 支持，跳过（这不是失败，但也没测到东西）');
    process.exit(2);
  }

  DOOR = await import(pathToFileURL(DOOR_FILE).href);

  section('0. 两份实现的接口对得上');
  for (const name of ['SESSION_FILE', 'DEFAULT_LIST_LIMIT', 'resolveSessionsRoot', 'hasZstdSupport',
    'decodeSessionFile', 'summarizeSession', 'listSessions', 'getSession', 'sessionTranscript']) {
    check(`两边都导出了 ${name}`, EXT[name] !== undefined && DOOR[name] !== undefined);
  }
  equal('SESSION_FILE 一致', EXT.SESSION_FILE, DOOR.SESSION_FILE);
  equal('DEFAULT_LIST_LIMIT 一致', EXT.DEFAULT_LIST_LIMIT, DOOR.DEFAULT_LIST_LIMIT);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-parity-'));
  try {
    section('1. resolveSessionsRoot：$DSH_HOME 与主目录的判定');
    const cases = [
      { env: { DSH_HOME: 'C:\\custom home' }, homedir: 'C:\\Users\\x' },
      { env: { DSH_HOME: '  ' }, homedir: 'C:\\Users\\x' },
      { env: {}, homedir: 'C:\\Users\\x' },
      { env: { DSH_HOME: '/home/x/.dsh' }, homedir: '/home/x' },
    ];
    for (const c of cases) {
      equal(
        `resolveSessionsRoot(${JSON.stringify(c.env)})`,
        EXT.resolveSessionsRoot(c),
        DOOR.resolveSessionsRoot(c),
      );
    }
    equal('hasZstdSupport 一致', EXT.hasZstdSupport(), DOOR.hasZstdSupport());

    section('2. 造会话文件；两份解码结果必须逐字节一致');
    writeSession(root, 'D--demo 目录', 'session-aaa111', sampleBatches('session-aaa111'));
    writeSession(root, 'D--demo 目录', 'session-bbb222', danglingToolBatches('session-bbb222'));
    // 目录名和头部 id 对不上：走「按头部 id 兜底找」那条路。
    writeSession(root, 'other', 'weird-dir-name', sampleBatches('session-ccc333'));
    // 一个不是会话的目录（没有 session.v3.jsonl.zstd），必须被跳过。
    fs.mkdirSync(path.join(root, 'D--demo 目录', 'not-a-session'), { recursive: true });

    const fileA = path.join(root, 'D--demo 目录', 'session-aaa111', 'session.v3.jsonl.zstd');
    const decodedExt = EXT.decodeSessionFile(fileA);
    const decodedDoor = DOOR.decodeSessionFile(fileA);
    equal('decodeSessionFile：事件数一致', decodedExt.events.length, decodedDoor.events.length);
    equal('decodeSessionFile：帧数一致', decodedExt.frames, decodedDoor.frames);
    equal('decodeSessionFile：error 一致', decodedExt.error, decodedDoor.error);
    equal('decodeSessionFile：事件内容完全一致', decodedExt.events, decodedDoor.events);
    check('多帧真的都解出来了（>1 帧）', decodedExt.frames > 1, `frames=${decodedExt.frames}`);

    section('3. summarizeSession / sessionTranscript');
    equal(
      'summarizeSession 一致',
      EXT.summarizeSession(decodedExt.events, { mtime: 123, size: 456 }),
      DOOR.summarizeSession(decodedDoor.events, { mtime: 123, size: 456 }),
    );
    equal(
      'sessionTranscript 一致',
      EXT.sessionTranscript(decodedExt.events),
      DOOR.sessionTranscript(decodedDoor.events),
    );
    equal(
      'sessionTranscript（小上限，截断标记）一致',
      EXT.sessionTranscript(decodedExt.events, { maxEntries: 2, maxChars: 5 }),
      DOOR.sessionTranscript(decodedDoor.events, { maxEntries: 2, maxChars: 5 }),
    );
    const dangling = EXT.decodeSessionFile(path.join(root, 'D--demo 目录', 'session-bbb222', 'session.v3.jsonl.zstd'));
    equal(
      '没有结果的工具调用（中断）两边都不渲染',
      EXT.sessionTranscript(dangling.events),
      DOOR.sessionTranscript(DOOR.decodeSessionFile(path.join(root, 'D--demo 目录', 'session-bbb222', 'session.v3.jsonl.zstd')).events),
    );

    section('4. listSessions');
    const listExt = EXT.listSessions(root);
    const listDoor = DOOR.listSessions(root);
    equal('listSessions：条数一致', listExt.sessions.length, listDoor.sessions.length);
    equal('listSessions：skipped 一致', listExt.skipped, listDoor.skipped);
    equal('listSessions：名片完全一致（含顺序）', listExt.sessions, listDoor.sessions);
    check('不是会话的目录被跳过（只列出 3 段）', listExt.sessions.length === 3, `共 ${listExt.sessions.length}`);
    equal(
      'limit 截断 + skipped 一致',
      EXT.listSessions(root, { limit: 2 }),
      DOOR.listSessions(root, { limit: 2 }),
    );
    equal(
      '会话目录不存在时，两边的说法一致',
      EXT.listSessions(path.join(root, 'nope')),
      DOOR.listSessions(path.join(root, 'nope')),
    );

    section('5. getSession（含 id 合法性）');
    equal('按目录名取：一致', EXT.getSession(root, 'session-aaa111'), DOOR.getSession(root, 'session-aaa111'));
    equal('按目录名取（不带前缀）：一致', EXT.getSession(root, 'aaa111'), DOOR.getSession(root, 'aaa111'));
    equal('按头部 id 兜底取：一致', EXT.getSession(root, 'session-ccc333'), DOOR.getSession(root, 'session-ccc333'));
    for (const bad of ['', '../../etc/passwd', 'a/b', 'a\\b', 'x'.repeat(200), 'no-such-session-zzz']) {
      let extError = '';
      let doorError = '';
      try { EXT.getSession(root, bad); } catch (error) { extError = error.message; }
      try { DOOR.getSession(root, bad); } catch (error) { doorError = error.message; }
      check(`非法/不存在的 id 都抛错，且说法一致：${JSON.stringify(bad.slice(0, 20))}`,
        Boolean(extError) && extError === doorError, `扩展「${extError}」门「${doorError}」`);
    }

    section('6. 坏帧不致命（尾部半截帧）');
    const truncatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-bad-'));
    try {
      const full = Buffer.concat(sampleBatches('session-trunc1').map((b) =>
        zlib.zstdCompressSync(b.map((e) => JSON.stringify(e)).join('\n') + '\n')));
      // 尾巴上再接半帧（内核写到一半被杀的样子）。
      const half = zlib.zstdCompressSync('{"type":"turn/start"}\n').subarray(0, 12);
      const dir = path.join(truncatedRoot, 'g', 'session-trunc1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([full, half]));
      const a = EXT.decodeSessionFile(path.join(dir, 'session.v3.jsonl.zstd'));
      const b = DOOR.decodeSessionFile(path.join(dir, 'session.v3.jsonl.zstd'));
      equal('坏帧两边的处理一致（帧数）', a.frames, b.frames);
      equal('坏帧两边的处理一致（error 文案）', a.error, b.error);
      equal('坏帧前面的内容照样解出来', a.events.length, b.events.length);
      check('确实有一帧是坏的', Boolean(a.error) || a.frames > 3, `error=${a.error} frames=${a.frames}`);
    } finally {
      fs.rmSync(truncatedRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) console.log(`✅ 两份实现完全一致：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`测试自己炸了：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
