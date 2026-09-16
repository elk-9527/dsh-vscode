'use strict';

/**
 * 试验台：断线接回之后，会话的「手」还在不在？
 *
 * 背景：门建的会话，记录里**没有** agentPreset（桌面端建的有，因为桌面端
 * 建会话时就把预设写进去了）。而 resume 一条老会话时，门那头的补挂会被内核
 * 拒绝（agent-preset/locked，属于正常），于是这次会话用什么预设完全取决于
 * 内核**从记录里重建**出什么。要是重建出来一个没预设的 agent —— 那就是
 * 「有嘴没手」：能聊天，但一个工具都没有。
 *
 * 这个试验台就干两件事：先在新建的会话里让它跑个命令（看有没有手），
 * 再断线、resume、再让它跑一次（看手还在不在）。
 *
 * 用法：node spike/resume-tools.cjs <端口>
 */

const { DoorClient } = require('../packages/vscode-extension/src/door/client');
const { DshSession } = require('../packages/vscode-extension/src/dsh/session');

const PORT = Number(process.argv[2] || 47821);
const CWD = 'D:\\dsh-vscode';

/**
 * 跑一个回合，把工具调用与正文都收集起来。
 *
 * 这里用的是 DshSession（面板用的同一层）而不是裸的 DoorClient ——
 * 工具/正文是它把 ACP 通知解析出来的，直接听 client 是听不到的
 * （client 只发 'update'/'notification' 这种原始事件）。
 */
function attach(session) {
  const turn = { tools: [], answer: '' };
  session.on('tool', (payload) => turn.tools.push(payload.tool || payload));
  session.on('text', (payload) => {
    turn.answer += payload.delta || '';
  });
  session.on('busy', (payload) => {
    if (payload.busy === false) turn.settled = true;
  });
  // 故意断线时它会报「连接断了」，这里不关心（不接这个事件 Node 会直接抛）。
  session.on('error', (payload) => console.log(`  [session error] ${payload.message}`));
  return turn;
}

function describe(turn) {
  const names = turn.tools.map((tool) => tool.title || tool.kind || '?').slice(0, 3);
  return `${turn.tools.length} 次工具调用 [${names.join(', ')}] 正文 ${turn.answer.trim().length} 字`;
}

async function main() {
  console.log(`连门 127.0.0.1:${PORT}`);

  const first = new DoorClient({ host: '127.0.0.1', port: PORT, log: () => {} });
  await first.connect();
  const sessionA = new DshSession({ client: first, log: () => {} });
  const turnA = attach(sessionA);
  await sessionA.start({ cwd: CWD, preset: 'standard' });
  const sessionId = sessionA.sessionId;
  console.log(`新建会话 ${sessionId}`);
  await sessionA.send('用 shell 跑一下 node -v，把版本号原样告我，别做别的。');
  console.log(`断线前：${describe(turnA)}`);

  // 模拟断线（面板被关掉 / 内核重启 / 网络抖一下）
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 800));

  const second = new DoorClient({ host: '127.0.0.1', port: PORT, log: () => {} });
  await second.connect();
  const sessionB = new DshSession({ client: second, log: () => {} });
  const turnB = attach(sessionB);
  try {
    await sessionB.resume(sessionId, CWD);
    console.log('resume 成功');
  } catch (error) {
    console.log(`resume 失败：${error.message}`);
    second.close();
    return;
  }

  await sessionB.send('再来一次：用 shell 跑 echo hello-from-resume，把输出告我。');
  console.log(`接回后：${describe(turnB)}`);
  console.log(`接回后的回答：${turnB.answer.trim().slice(0, 300)}`);
  second.close();

  console.log('');
  console.log(
    turnA.tools.length > 0 && turnB.tools.length > 0
      ? '结论：两边都调了工具 —— 接回之后手还在。'
      : `结论：有问题（断线前 ${turnA.tools.length} 次、接回后 ${turnB.tools.length} 次）——` +
        '得看清楚是模型不想调，还是根本没工具。',
  );
}

main().catch((error) => {
  console.log(`试验台崩了：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
