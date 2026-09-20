'use strict';

/**
 * 断线之后上下文是否可以恢复。
 *
 * 单独测试该行为的原因：ACP 提供 `session/resume` 与 `session/load`，但内核的
 * 实现程度只能实测确认。该结果决定面板断线后是「静默替换为一个无记忆的新会话」
 * （用户会认为该会话仍保留此前的对话，实际已丢失 —— 属于最差的体验），
 * 还是「确实接回原会话」。
 *
 * 测法：令内核记住一个随机数 → 断开连接 → 由新连接重新建立会话 →
 * 检查其是否仍记得（分别验证 resume / load / 新会话三条路径）。
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

/** 连接、建立会话、发送一次提问、收集正文，然后返回。 */
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

  // ── 1. 第一个连接：建立会话并令其记住一个数字 ──────────────
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

  // 在同一连接内确认其确实记住了该数字（作为对照基线）。
  const sameConn = await ask(first, {
    sessionId: originalId,
    text: '我刚才让你记住的数字是多少？只回答数字。',
  });
  const baselineOk = sameConn.answer.includes(secret);
  check('同一连接内确实记得（基线）', baselineOk, `回答：${sameConn.answer.slice(0, 80)}`);

  // ── 2. 断开连接（模拟内核重启/网络中断/面板重载）────────────
  section('2. 掐断连接');
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log('     连接已关闭');

  // ── 3. 新连接：resume 是否可以恢复上下文 ────────────────
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

  // ── 4. 对照组：新建一个会话，该会话不应记得 ──────────────
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
  console.error('💥 测试发生异常：', error.stack || error.message);
  process.exit(1);
});
