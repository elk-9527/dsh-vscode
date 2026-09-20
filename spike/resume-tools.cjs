'use strict';

/**
 * 试验台：断线重连之后，会话的工具能力是否保留。
 *
 * 背景：ACP 接入点插件（`dsh-acp-door`）建立的会话，记录中**没有** agentPreset（桌面端建立的会话有，
 * 因为桌面端在建立会话时即写入预设）。resume 一条既有会话时，该插件一端的补挂操作会被内核
 * 拒绝（agent-preset/locked，属于预期行为），因此该会话最终使用的预设完全取决于
 * 内核**从记录中重建**的结果。若重建出的 agent 没有预设，则该会话
 * 仅能进行对话，没有任何工具可用。
 *
 * 本试验台执行两件事：先在新建的会话中执行一条命令（验证工具是否可用），
 * 再断线、resume、再次执行（验证工具是否仍然可用）。
 *
 * 用法：node spike/resume-tools.cjs <端口>
 */

const { DoorClient } = require('../packages/vscode-extension/src/door/client');
const { DshSession } = require('../packages/vscode-extension/src/dsh/session');

const PORT = Number(process.argv[2] || 47821);
const CWD = 'D:\\dsh-vscode';

/**
 * 执行一个回合，收集工具调用与正文。
 *
 * 此处使用 DshSession（与面板同一层）而非直接使用 DoorClient：
 * 工具与正文由 DshSession 解析 ACP 通知得到，直接监听 client 无法获取
 * （client 仅发出 'update'/'notification' 等原始事件）。
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
  // 主动断线时该事件报告连接中断，此处不作处理（不监听该事件时 Node 会直接抛出）。
  session.on('error', (payload) => console.log(`  [session error] ${payload.message}`));
  return turn;
}

function describe(turn) {
  const names = turn.tools.map((tool) => tool.title || tool.kind || '?').slice(0, 3);
  return `${turn.tools.length} 次工具调用 [${names.join(', ')}] 正文 ${turn.answer.trim().length} 字`;
}

async function main() {
  console.log(`连接该插件 127.0.0.1:${PORT}`);

  const first = new DoorClient({ host: '127.0.0.1', port: PORT, log: () => {} });
  await first.connect();
  const sessionA = new DshSession({ client: first, log: () => {} });
  const turnA = attach(sessionA);
  await sessionA.start({ cwd: CWD, preset: 'standard' });
  const sessionId = sessionA.sessionId;
  console.log(`新建会话 ${sessionId}`);
  await sessionA.send('用 shell 跑一下 node -v，把版本号原样告我，别做别的。');
  console.log(`断线前：${describe(turnA)}`);

  // 模拟断线（面板关闭 / 内核重启 / 网络波动）
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
  console.log(`试验台发生异常：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
