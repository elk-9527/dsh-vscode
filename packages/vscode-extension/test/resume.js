'use strict';

/**
 * 断线之后，上下文还能不能回来？
 *
 * 为什么单独测这个：ACP 有 `session/resume` 和 `session/load`，但内核到底实现到
 * 什么程度只能实测。这决定了面板断线后是「悄悄换成一个没记忆的新会话」
 * （用户会以为它还记着上面的对话，实际上忘了 —— 最坏的一种体验），
 * 还是「真的接回原来那个会话」。
 *
 * 测法：让内核记住一个随机数 → 掐断连接 → 新连接重开一个会话 →
 * 看它记不记得（分别验证 resume / load / 新会话三条路）。
 *
 * 用法：node test/resume.js
 */

const path = require('node:path');

const { DoorClient } = require('../src/door/client');
const { ensureDoor, HOST, PORT } = require('./helpers/door');

const SCRATCH = path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch');

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

/** 连上、开一个会话、问一句、收集正文，然后返回。 */
async function ask(client, { sessionId, text, timeoutMs = 120000 }) {
  let answer = '';
  const onUpdate = (id, update) => {
    if (id !== sessionId) return;
    if (update && update.sessionUpdate === 'agent_message_chunk') {
      const content = update.content;
      if (content && content.type === 'text') answer += content.text;
    }
  };
  client.on('update', onUpdate);
  try {
    const result = await client.prompt(sessionId, text, { signal: AbortSignal.timeout(timeoutMs) });
    return { answer: answer.trim(), stopReason: result && result.stopReason };
  } finally {
    client.off('update', onUpdate);
  }
}

const log = () => {};

(async () => {
  const door = await ensureDoor({ log });
  const secret = String(1000 + Math.floor(Math.random() * 8999));

  // ── 1. 第一个连接：建会话、让它记住一个数字 ──────────────
  section('1. 建会话，让它记住一个数字');
  const first = new DoorClient({ host: HOST, port: PORT, log });
  await first.connect();
  const created = await first.newSession(SCRATCH);
  const originalId = created.sessionId;
  console.log(`     会话 ${originalId}，要记的数字 ${secret}`);

  const remembered = await ask(first, {
    sessionId: originalId,
    text: `记住这个数字：${secret}。只回答「已记住」，不要用任何工具。`,
  });
  check('它给出了回应', Boolean(remembered.answer), JSON.stringify(remembered));
  console.log(`     回应：${remembered.answer.slice(0, 60)}`);

  // 同一连接内先确认它真的记得（作为对照基线）。
  const sameConn = await ask(first, {
    sessionId: originalId,
    text: '我刚才让你记住的数字是多少？只回答数字。',
  });
  const baselineOk = sameConn.answer.includes(secret);
  check('同一连接内确实记得（基线）', baselineOk, `回答：${sameConn.answer.slice(0, 80)}`);

  // ── 2. 掐断连接（模拟内核重启/网线掉/面板重载）────────────
  section('2. 掐断连接');
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log('     连接已关闭');

  // ── 3. 新连接：resume 能不能把上下文接回来 ────────────────
  section('3. 新连接里 session/resume');
  const second = new DoorClient({ host: HOST, port: PORT, log });
  await second.connect();

  let resumeOk = false;
  let resumeError = '';
  try {
    const resumed = await second.resumeSession(originalId, SCRATCH);
    resumeOk = true;
    check('session/resume 被内核接受', true, JSON.stringify(resumed).slice(0, 120));
  } catch (error) {
    resumeError = error && error.message ? error.message : String(error);
    check('session/resume 被内核接受', false, `报错：${resumeError}`);
  }

  if (resumeOk) {
    const after = await ask(second, {
      sessionId: originalId,
      text: '我刚才让你记住的数字是多少？只回答数字。',
    });
    const recalled = after.answer.includes(secret);
    check('resume 之后上下文真的还在', recalled, `回答：${after.answer.slice(0, 80)}`);
  }

  // ── 4. 对照组：新开一个会话，它当然不该记得 ──────────────
  section('4. 对照组：全新的会话');
  const fresh = await second.newSession(SCRATCH);
  const freshAnswer = await ask(second, {
    sessionId: fresh.sessionId,
    text: '我刚才让你记住的数字是多少？如果你不知道就回答「不知道」。不要用工具。',
  });
  check(
    '新会话不知道那个数字（说明上一步的记得是真的，不是猜的）',
    !freshAnswer.answer.includes(secret),
    `回答：${freshAnswer.answer.slice(0, 80)}`,
  );

  // ── 5. 结论 ───────────────────────────────────────────────
  section('5. 结论');
  if (resumeOk) {
    console.log('     session/resume 可用 → 面板断线后应该自动 resume，而不是开新会话。');
  } else {
    console.log(`     session/resume 不可用（${resumeError}）→ 面板断线后只能开新会话，`);
    console.log('     但必须明确告诉用户「上下文没了」，不能让他以为还记得。');
  }

  second.close();
  door.stop();

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
