'use strict';

/**
 * 一次跑完所有测试。
 *
 * 用法：
 *   node test/run-all.js           # 快速套件（不需要 DSH，不需要浏览器）
 *   node test/run-all.js --ui      # 再加上真浏览器里的界面断言
 *   node test/run-all.js --all     # 再加上需要真 DSH 进程的测试
 *
 * 分层是刻意的：静态与单测秒级、随时能跑；需要外部依赖的放后面，
 * 这样改一行代码能马上知道有没有踩坏东西。
 *
 * 顺序也有讲究：兜底测试要求 47821 是空着的，所以它排在会自己拉起内核的
 * 面板层/端到端之前 —— 那两组用完会把内核收干净，不留孤儿进程。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const withUi = args.includes('--ui') || args.includes('--all');
const withDsh = args.includes('--all');

const suites = [
  { name: '静态契约', file: 'test/static.js', always: true },
  { name: '门的看帧判断（纯函数）', file: '../dsh-door/test/frames.js', always: true },
  { name: 'Markdown 渲染器', file: 'test/markdown.js', always: true },
  { name: '编辑器上下文拼块（纯函数）', file: 'test/blocks.js', always: true },
  { name: '界面（真浏览器）', file: 'tools/uitest.js', always: false, needs: withUi, hint: '加 --ui 才跑' },
  { name: '兜底拉起（真进程）', file: 'test/fallback.js', always: false, needs: withDsh, hint: '加 --all 才跑（要求 47821 空着）' },
  { name: '断线接回（真 DSH）', file: 'test/resume.js', always: false, needs: withDsh, hint: '加 --all 才跑' },
  { name: '预设/模式（真 DSH）', file: 'test/presets.js', always: false, needs: withDsh, hint: '加 --all 才跑（自己挑端口，不抢 47821）' },
  { name: '面板层（假 vscode + 真门）', file: 'test/panel.js', always: true },
  { name: '端到端（真 DSH）', file: 'test/smoke.js', always: false, needs: withDsh, hint: '加 --all 才跑' },
];

const results = [];

for (const suite of suites) {
  if (!suite.always && !suite.needs) {
    console.log(`\n⏭  跳过「${suite.name}」（${suite.hint}）`);
    continue;
  }
  console.log(`\n${'█'.repeat(3)} ${suite.name} ${'█'.repeat(3)}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, suite.file)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const ms = Date.now() - started;
  // 退出码 2 = 套件自己说「现在没法测」（例如端口被占），不算失败，
  // 但要在汇总里单独列出来，不能假装它通过了。
  results.push({ name: suite.name, code: result.status, ms });
}

console.log(`\n${'═'.repeat(56)}`);
console.log('汇总：');
for (const item of results) {
  const mark = item.code === 0 ? '✅' : item.code === 2 ? '⏭ ' : '❌';
  const note = item.code === 2 ? '  （跳过：环境不满足）' : '';
  console.log(`  ${mark} ${item.name}  (${(item.ms / 1000).toFixed(1)}s)${note}`);
}
const bad = results.filter((item) => item.code !== 0 && item.code !== 2);
const skipped = results.filter((item) => item.code === 2);
if (bad.length === 0) {
  console.log(
    `\n✅ 全部套件通过（共 ${results.length} 个${skipped.length ? `，其中 ${skipped.length} 个跳过` : ''}）`,
  );
} else {
  console.log(`\n❌ ${bad.length} 个套件失败`);
}
process.exit(bad.length === 0 ? 0 : 1);
