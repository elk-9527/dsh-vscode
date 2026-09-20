'use strict';

/**
 * 探查内核自身的 ACP `session/list` 实际返回内容。
 * 面板需要实现「历史会话列表」，因此必须确认其真实形状与取舍
 * （结论：该项仅包含 {sessionId, cwd}，没有标题与时间 —— 因此历史列表不由该接口提供，
 *  而由 ACP 接入点插件（dsh-acp-door）的旁路方法或面板自行读取磁盘提供，见 src/dsh/sessions.js）。
 */

const { DoorClient } = require('../src/door/client');

async function main() {
  const client = new DoorClient({ host: '127.0.0.1', port: 47821, log: () => {} });
  await client.connect();

  const listed = await client.listKernelSessions();
  console.log('=== 原始返回 ===');
  console.log(JSON.stringify(listed, null, 2).slice(0, 3000));

  const sessions = listed && Array.isArray(listed.sessions) ? listed.sessions : [];
  console.log(`\n=== 共 ${sessions.length} 个会话 ===`);
  for (const item of sessions.slice(0, 10)) {
    console.log(JSON.stringify(item).slice(0, 300));
  }

  // 再新建一个，检查其是否会立即出现在列表中
  const created = await client.newSession(process.cwd());
  console.log(`\n新建会话：${created.sessionId}`);
  const after = await client.listKernelSessions();
  const afterSessions = after && Array.isArray(after.sessions) ? after.sessions : [];
  const found = afterSessions.find((item) => item.sessionId === created.sessionId);
  console.log(`新会话立刻出现在列表里吗：${found ? '是' : '否'}（列表共 ${afterSessions.length} 个）`);
  if (afterSessions.length > 0) {
    console.log('列表里第一条的字段：' + Object.keys(afterSessions[0]).join(', '));
  }

  client.close();
}

main().catch((error) => {
  console.error('探测失败：', error);
  process.exit(1);
});
