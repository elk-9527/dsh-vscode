'use strict';

/**
 * 一次运行全部测试套件。
 *
 * 用法：
 *   node test/run-all.js           # 快速套件（不需要 DSH，不需要浏览器）
 *   node test/run-all.js --ui      # 追加真实浏览器中的界面断言
 *   node test/run-all.js --all     # 追加需要真实 DSH 进程的测试
 *
 * 分层结构为有意设计：静态检查与单元测试耗时在秒级，可随时运行；需要外部依赖的
 * 套件排在后面，因此修改一行代码即可立即确认是否破坏其他部分。
 *
 * 套件顺序同样存在约束：后备启动测试要求 47821 处于空闲状态，因此该套件排在会自行启动
 * 内核的面板层与端到端套件之前 —— 后两组套件结束后会回收内核，不留孤儿进程。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const withUi = args.includes('--ui') || args.includes('--all');
const withDsh = args.includes('--all');

const suites = [
  { name: '静态契约', file: 'test/static.js', always: true },
  { name: '该插件的帧解析（纯函数）', file: '../dsh-door/test/frames.js', always: true },
  { name: '该插件的会话读取（纯函数）', file: '../dsh-door/test/sessions.js', always: true },
  { name: '该插件的端口判定（纯函数）', file: '../dsh-door/test/port.js', always: true },
  // ACP 接入点插件（dsh-acp-door）的权限预设旁路方法（0.0.12 版）：清单来自用户可配置的档，形状不能假设。
  { name: '该插件的权限预设方法（纯函数）', file: '../dsh-door/test/permission.js', always: true },
  // 面板侧把内核的清单转换为中文界面（标签与桌面端逐字一致）。
  { name: '权限预设的界面翻译（纯函数）', file: 'test/permission.js', always: true },
  // 两份「历史会话读取」实现（该插件的 ESM 版 + 面板的 CJS 版）必须逐项一致 ——
  // 见 test/sessions-parity.js 的说明：只修改其中一边，该断言首先失败。
  { name: '两份会话读取实现是否一致', file: 'test/sessions-parity.js', always: true },
  { name: 'Markdown 渲染器', file: 'test/markdown.js', always: true },
  { name: '编辑器上下文拼块（纯函数）', file: 'test/blocks.js', always: true },
  { name: '会话层边界（假客户端）', file: 'test/session.js', always: true },
  { name: '后台内核的归属与回收（假进程）', file: 'test/kernel-manager.js', always: true },
  // 「命令路径里有空格」的两个缺陷只在真实进程中暴露（拼接出的字符串表面上正确），
  // 因此必须实际执行一次 spawn —— 见 test/spawn-quote.js 的说明。
  { name: '带空格的命令路径（真进程）', file: 'test/spawn-quote.js', always: true },
  { name: '界面（真浏览器）', file: 'tools/uitest.js', always: false, needs: withUi, hint: '加 --ui 才跑' },
  // 自启动内核：这是最常见的路径（刚开机、未启动桌面端）。该套件自行选择一个空闲端口，
  // 不需要占用 47821 —— 桌面端运行时该端口上已有该插件，无法占用。
  {
    name: '自启内核（真进程）',
    file: 'test/fallback.js',
    always: false,
    needs: withDsh,
    env: { DSH_PANEL_TEST_PORT: '47830' },
    hint: '加 --all 才跑（自己挑端口，不抢 47821）',
  },
  { name: '断线接回（真 DSH）', file: 'test/resume.js', always: false, needs: withDsh, hint: '加 --all 才跑' },
  { name: '预设/模式（真 DSH）', file: 'test/presets.js', always: false, needs: withDsh, hint: '加 --all 才跑（自己挑端口，不抢 47821）' },
  {
    name: '权限预设（真 DSH）',
    file: 'test/permission-live.js',
    always: false,
    needs: withDsh,
    env: { DSH_PANEL_TEST_PORT: '47832' },
    hint: '加 --all 才跑（自己挑端口，不抢 47821）',
  },
  { name: '面板层（模拟 vscode + 真实运行的该插件）', file: 'test/panel.js', always: true },
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
    env: suite.env ? { ...process.env, ...suite.env } : process.env,
  });
  const ms = Date.now() - started;
  // 退出码 2 表示套件自身报告「当前无法测试」（例如端口被占用），不计为失败，
  // 但需在汇总中单独列出，不得记为通过。
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
