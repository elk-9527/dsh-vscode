'use strict';
// 查看面板自行读取磁盘的路径在实际机器上的读取结果。
//
// 设置该工具的原因：历史会话默认由面板自行读取 $DSH_HOME/sessions（ACP 接入点插件（`dsh-acp-door`）版本过低时亦走该路径）。
// 用户报告"历史为空"或"历史条数减少"时，用其区分三种情况：
//   ① 磁盘上不存在 ② 存在但解码失败 ③ 存在且可读，仅超出列表上限（DEFAULT_LIST_LIMIT）
//
// 用法：node tools/check-local-history.cjs
// 只读：仅读取会话文件，不写入、不删除。
const fs = require('node:fs');
const path = require('node:path');
// 面板实际使用的实现（而非在测试中重新实现一遍）—— 以此确保输出与面板所见一致。
const s = require('../src/dsh/sessions.js');

const root = s.resolveSessionsRoot();
console.log('DSH_HOME       =', process.env.DSH_HOME || '(没设，用 ~/.dsh)');
console.log('会话目录        =', root, fs.existsSync(root) ? '（在）' : '（不在）');
console.log('本机 Node       =', process.version, ' zstd:', s.hasZstdSupport());
if (!fs.existsSync(root)) process.exit(0);

let dirs = 0;
for (const g of fs.readdirSync(root, { withFileTypes: true })) {
  if (!g.isDirectory()) continue;
  for (const e of fs.readdirSync(path.join(root, g.name), { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(root, g.name, e.name, s.SESSION_FILE))) dirs += 1;
  }
}
console.log('磁盘上的会话数  =', dirs);

const started = Date.now();
const out = s.listSessions(root);
const ms = Date.now() - started;
console.log(`面板读到的      = ${out.sessions.length} 段（跳过 ${out.skipped} 段，耗时 ${ms}ms）`);
console.log(`                 列表上限是 ${s.DEFAULT_LIST_LIMIT} 段，超过的部分由 skipped 带回界面`);
if (out.error) console.log('error:', out.error);
const noTitle = out.sessions.filter((c) => !c.title && !c.fallbackTitle).length;
const bad = out.sessions.filter((c) => c.decodeError).length;
console.log('没有标题的      =', noTitle, ' 解码有问题的 =', bad);
console.log('\n最近 5 段：');
for (const c of out.sessions.slice(0, 5)) {
  console.log(
    `  ${c.id.slice(0, 20).padEnd(22)} 回合 ${String(c.turns).padStart(3)}  ` +
      `${(c.title || c.fallbackTitle || '（无标题）').slice(0, 30).padEnd(32)} ${c.cwd || ''}`,
  );
}

// 抽取一段验证回放重建（该步骤最容易在损坏的帧上出错）。
const first = out.sessions[0];
if (first) {
  const one = s.getSession(root, first.id);
  const kinds = {};
  for (const e of one.entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log(`\n回放（${first.id.slice(0, 20)}）= ${one.entries.length} 条 `, kinds, ' 截断:', one.truncated);
}
