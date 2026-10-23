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
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const withUi = args.includes('--ui') || args.includes('--all');
const withDsh = args.includes('--all');
const strict = args.includes('--strict');

const suites = [
  { name: '流式 Markdown 尾部缓存与完整渲染一致', file: 'test/stream-markdown.js', always: true },
  { name: '候选归档安装逐字节核验', file: '../../tools/bridge/test-installed-candidate.cjs', always: true },
  { name: '支持矩阵与候选发现分类', file: '../../tools/compat/test-discovery.cjs', always: true },
  { name: '无工具文本生成与失败边界', file: '../dsh-door/test/text-generation.js', always: true },
  { name: '隔离验收资源与预算', file: '../../tools/run-resources.test.cjs', always: true },
  { name: '测试临时目录归属与清理', file: '../../tools/test-workspace.test.cjs', always: true },
  { name: '初始仓库快照与取消', file: 'test/repository-snapshot.js', always: true },
  { name: '未保存编辑的审查范围', file: 'test/review-scope.js', always: true },
  { name: '本机与远程环境边界', file: 'test/runtime-support.js', always: true },
  { name: 'Webview 消息信封', file: 'test/webview-protocol.js', always: true },
  { name: '待发送队列持久恢复', file: 'test/queue-recovery.js', always: true },
  { name: '候选包回归入口隔离', file: 'test/candidate-regression.js', always: true },
  { name: '断线历史范围与格式降级', file: 'test/history-offline.js', always: true },
  { name: '草稿持久写入合并', file: 'test/draft-persistence.js', always: true },
  { name: '技能恢复全局时间排序', file: '../dsh-bridge-sdk/test/skill-recovery.js', always: true },
  { name: '客户端传输预算与背压', file: 'test/transport-budget.js', always: true },
  { name: '异步命令、超时与进程归属', file: 'test/async-command.js', always: true },
  { name: 'Bridge 实际执行生命周期', file: '../dsh-door/test/bridge-lifecycle.js', always: true },
  { name: 'Bridge 未停止执行的内核归属', file: 'test/bridge-kernel-lifetime.js', always: true },
  { name: 'ACP SDK 大载荷与 v1 入口', file: '../dsh-door/test/acp-sdk.js', always: true },
  { name: 'DSH MCP 客户端依赖链', file: '../dsh-door/test/mcp-sdk.js', always: true },
  { name: '服务端传输预算与权限归属', file: '../dsh-door/test/transport-budgets.js', always: true },
  { name: 'Git 变更与问题诊断上下文', file: 'test/workspace-context.js', always: true },
  { name: '审查子 Agent 内核接口兼容', file: '../../tools/bridge/test-review-runtime.cjs', always: true },
  { name: '文件句柄身份与链接切换边界', file: 'test/file-state.js', always: true },
  { name: '完整报告持久化与多窗口存储边界', file: 'test/report-store.js', always: true },
  { name: '审查独立验证与多次执行记录', file: 'test/review-verification.js', always: true },
  { name: '消息排队、历史隔离与模式生效边界', file: 'test/panel-usability.js', always: true },
  { name: '本轮改动与真实测试任务边界', file: 'test/workflow.js', always: true },
  { name: '输入框文件、选区与技能快捷引用', file: 'test/composer-context.js', always: true },
  { name: '连接竞态、权限传递与恢复记录边界', file: 'test/audit-boundaries.js', always: true },
  { name: '安装包与正式发布的内容校验', file: 'test/packaging.js', always: true },
  { name: '模型配置、草稿恢复、审查预算与历史缓存', file: 'test/upgrade-controls.js', always: true },
  { name: '文件引用、历史查询导出与审查修复', file: 'test/feature-updates.js', always: true },
  { name: 'Provider SDK 与技能写入恢复', file: '../dsh-bridge-sdk/test/contracts.js', always: true },
  { name: '公共会话 API 与取消边界', file: 'test/public-api.js', always: true },
  { name: '原生 Chat 与面板联动', file: 'test/native-chat.js', always: true },
  { name: '技能草稿预览与确认', file: 'test/skill-management.js', always: true },
  { name: 'Bridge 运行与鉴权', file: '../dsh-door/test/bridge.js', always: true },
  { name: '共享连接与审查投影', file: 'test/bridge-service.js', always: true },
  { name: '配置诊断与精确版本安装', file: 'test/bridge-profiles.js', always: true },
  { name: '运行记录恢复与清理', file: 'test/bridge-operations.js', always: true },
  { name: '原生命令与重试边界', file: 'test/bridge-views.js', always: true },
  { name: '内置与文件技能正文读取', file: '../../tools/bridge/test-skill-provider.cjs', always: true },
  { name: '编辑器账号目录与进程隔离', file: 'test/editor-isolation.js', always: true },
  { name: '静态契约', file: 'test/static.js', always: true },
  { name: '该插件的帧解析（纯函数）', file: '../dsh-door/test/frames.js', always: true },
  { name: '该插件的会话读取（纯函数）', file: '../dsh-door/test/sessions.js', always: true },
  { name: '该插件的端口判定（纯函数）', file: '../dsh-door/test/port.js', always: true },
  { name: '该插件的模型选择与状态（纯函数）', file: '../dsh-door/test/model-status.js', always: true },
  // ACP 接入点插件（dsh-acp-door）的权限预设旁路方法（0.0.12 版）：清单来自用户可配置的档，形状不能假设。
  { name: '该插件的权限预设方法（纯函数）', file: '../dsh-door/test/permission.js', always: true },
  { name: '该插件的内核兼容适配器（纯函数）', file: '../dsh-door/test/kernel-adapters.js', always: true },
  { name: '该插件的连接生命周期（纯函数）', file: '../dsh-door/test/lifecycle.js', always: true },
  // 面板侧把内核的清单转换为中文界面（标签与桌面端逐字一致）。
  { name: '权限预设的界面翻译（纯函数）', file: 'test/permission.js', always: true },
  // 两份「历史会话读取」实现（该插件的 ESM 版 + 面板的 CJS 版）必须逐项一致 ——
  // 见 test/sessions-parity.js 的说明：只修改其中一边，该断言首先失败。
  { name: '两份会话读取实现是否一致', file: 'test/sessions-parity.js', always: true },
  { name: 'Markdown 渲染器', file: 'test/markdown.js', always: true },
  { name: '编辑器上下文拼块（纯函数）', file: 'test/blocks.js', always: true },
  { name: '会话层边界（假客户端）', file: 'test/session.js', always: true },
  { name: 'ACP 客户端超时（真实 TCP）', file: 'test/client-timeout.js', always: true },
  { name: 'DSH 0.2 实时输出与去重（纯函数）', file: 'test/live-stream.js', always: true },
  { name: '面板生命周期（假视图）', file: 'test/panel-lifecycle.js', always: true },
  { name: '本机边界与设置来源（纯函数）', file: 'test/security-boundaries.js', always: true },
  { name: '后台内核的归属与回收（假进程）', file: 'test/kernel-manager.js', always: true },
  { name: '自启配置准备与修复（假 CLI）', file: 'test/setup.js', always: true },
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
  // 面板层会同步测试插件并启动真实 DSH。它属于完整验收，而不是不依赖 DSH 的快速套件。
  {
    name: '面板层（模拟 vscode + 真实运行的该插件）',
    file: 'test/panel.js',
    always: false,
    needs: withDsh,
    hint: '加 --all 才跑（会写入专用测试档）',
  },
  { name: '端到端（真 DSH）', file: 'test/smoke.js', always: false, needs: withDsh, hint: '加 --all 才跑' },
];

const results = [];
const resources = require('../../../tools/run-resources.cjs').createRunResources({ label: 'suite', keep: args.includes('--keep-work') });
const browser = require('../tools/chrome.cjs').findChrome();
const childEnv = resources.childEnv({ ...process.env, ...(browser ? { DSH_PANEL_CHROME: browser } : {}) });

try {
for (const suite of suites) {
  if (!suite.always && !suite.needs) {
    console.log(`\n⏭  跳过「${suite.name}」（${suite.hint}）`);
    continue;
  }
  console.log(`\n${'█'.repeat(3)} ${suite.name} ${'█'.repeat(3)}`);
  resources.check();
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, suite.file)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...childEnv, ...suite.env },
    windowsHide: true,
    timeout: Math.min(Number(process.env.DSH_TEST_SUITE_MS || 600000), resources.remainingMs()),
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
if (bad.length === 0 && skipped.length === 0) {
  console.log(
    `\n✅ 全部套件通过（共 ${results.length} 个${skipped.length ? `，其中 ${skipped.length} 个跳过` : ''}）`,
  );
} else if (bad.length === 0) {
  console.log(`\n${strict ? '❌ 严格验收未完成' : '⏭ 验收未完成'}：${results.length - skipped.length} 个套件通过，${skipped.length} 个因环境条件跳过`);
} else {
  console.log(`\n❌ ${bad.length} 个套件失败`);
}
process.exitCode = bad.length === 0 && (!strict || skipped.length === 0) ? 0 : 1;
} finally {
  resources.close().then(result => { if (result.status !== 'passed' || result.abort) { console.error(result); process.exitCode = 1; } });
}
