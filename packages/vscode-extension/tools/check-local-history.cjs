'use strict';
// 面板那条「自己读盘」的路，在真机上到底看到了什么？
//
// 为什么需要它：历史会话默认由面板自己读 $DSH_HOME/sessions（门太旧时也走这条）。
// 用户说"历史是空的"或"少了"时，用它区分三种情况：
//   ① 磁盘上就没有 ② 有但解码失败 ③ 有、能读，只是超过了列表上限（DEFAULT_LIST_LIMIT）
//
// 用法：node tools/check-local-history.cjs
// 只读：只读会话文件，不写、不删。
const fs = require('node:fs');
const path = require('node:path');
// 面板真正在用的那份实现（不是在测试里重写一遍）—— 这样看到的才是面板看到的。
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

// 抽一段探一下回放重建（这步最容易在坏帧上炸）。
const first = out.sessions[0];
if (first) {
  const one = s.getSession(root, first.id);
  const kinds = {};
  for (const e of one.entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log(`\n回放（${first.id.slice(0, 20)}）= ${one.entries.length} 条 `, kinds, ' 截断:', one.truncated);
}
