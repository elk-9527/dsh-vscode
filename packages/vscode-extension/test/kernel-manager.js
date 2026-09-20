/*
 * 后台内核的"谁在使用、何时回收"（纯逻辑测试，使用假进程 / 假计时器）。
 *
 * 该套件的必要性（2026-09-19）：用户报告"聊两句就 read ECONNRESET"，
 * 查阅日志发现"每个自启动内核存活 35 秒"。其中一项结构性成因是：
 * 面板视图的 disposer 直接对该内核执行 killTree —— 而视图很容易被销毁
 * （折叠侧边栏、拖动面板、Reload Window、关闭另一个窗口）。
 * 该套件用于固定新规则：
 *
 *   视图销毁 = 释放引用（内核仍在运行）→ 宽限期内重新打开面板 = 继续使用同一个
 *   → 仅在宽限到期 / 窗口关闭 / 用户显式停止时真正回收。
 *
 * 真实进程部分见 test/fallback.js §6（真实启动内核、真实销毁视图、真实检查 pid）。
 */
const { KernelManager } = require('../src/panel/kernel-manager.js');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `（${detail}）` : ''}`);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ───────────────────────────────────────`);
}

/** 假进程：可模拟"运行/退出"状态，并记录 dispose 是否被调用。 */
function fakeBackground(pid = 1001) {
  const listeners = new Map();
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) || []), handler]);
      return this;
    },
  };
  const background = {
    child,
    disposed: 0,
    stderrTail: () => '',
    dispose() {
      this.disposed += 1;
      child.exitCode = 0;
      for (const handler of listeners.get('exit') || []) handler(0, null);
    },
  };
  /** 模拟"该进程自行退出"（非由本模块回收）。 */
  background.dieByItself = (code = 1) => {
    child.exitCode = code;
    for (const handler of listeners.get('exit') || []) handler(code, null);
  };
  return background;
}

/** 假计时器：手动触发到期，不依赖真实时间。 */
function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms, canceled: false });
      return { id, unref() {} };
    },
    clearTimer(handle) {
      const item = timers.get(handle.id);
      if (item) item.canceled = true;
    },
    /** 使所有仍有效的计时器到期（模拟"宽限到期"）。 */
    fireAll() {
      const items = [...timers.values()].filter((item) => !item.canceled);
      for (const item of items) item.fn();
      return items.length;
    },
    pending() {
      return [...timers.values()].filter((item) => !item.canceled).length;
    },
    lastMs() {
      const items = [...timers.values()].filter((item) => !item.canceled);
      return items.length ? items[items.length - 1].ms : undefined;
    },
  };
}

function makeManager({ idleMs = 600000, spawns = [] } = {}) {
  const timers = fakeTimers();
  const manager = new KernelManager({
    log: () => {},
    idleMs,
    spawn: (options) => {
      const background = fakeBackground(1000 + spawns.length);
      spawns.push({ options, background });
      return background;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { manager, timers, spawns };
}

section('1. 起一个、登记、复用');
{
  const { manager, spawns } = makeManager();
  const entry = manager.spawn({ host: '127.0.0.1', port: 47831, command: 'node bin.js', profile: 'x' });
  check('起完就登记了', manager.size() === 1);
  check('参数原样传给了 spawn', spawns[0].options.port === 47831 && spawns[0].options.profile === 'x');
  check('live() 能拿到它（重开面板要复用）', manager.live('127.0.0.1', 47831) === entry);
  check('别的端口上没有', manager.live('127.0.0.1', 47899) === undefined);

  const again = manager.spawn({ host: '127.0.0.1', port: 47831, command: 'node bin.js', profile: 'x' });
  check('同一端口再 spawn → 复用，不重复起进程', again === entry && spawns.length === 1);

  manager.disposeAll('测试');
  check('disposeAll 收干净了', manager.size() === 0);
}

section('2. 引用计数：有人用着不收');
{
  const { manager, spawns } = makeManager({ idleMs: 600000 });
  const viewA = { name: 'A' };
  const viewB = { name: 'B' };
  const entry = manager.spawn({ host: '127.0.0.1', port: 47831 });
  manager.acquire(viewA, entry);
  manager.acquire(viewB, entry);
  manager.acquire(viewA, entry); // 同一使用者重复 acquire 仅计数一次
  manager.release(viewA);
  check('还有人在用 → 不收，也不排计时', spawns[0].background.disposed === 0 && manager.size() === 1);
  manager.release(viewB);
  check('引用归零 → **先不杀**，进入宽限（这是这次修复的核心）',
    spawns[0].background.disposed === 0 && manager.size() === 1);
  check('宽限时长按设置来（10 分钟）', manager.entries.get('127.0.0.1:47831').timer !== undefined);
}

section('3. 宽限期内重开面板 → 继续用同一个内核');
{
  const { manager, timers, spawns } = makeManager({ idleMs: 600000 });
  const viewA = { name: 'A' };
  const viewB = { name: 'B' };
  const entry = manager.spawn({ host: '127.0.0.1', port: 47831 });
  manager.acquire(viewA, entry);
  manager.release(viewA);
  check('释放后排上了"要收它"的计时', timers.pending() === 1, String(timers.pending()));
  // 用户重新打开面板：
  const reused = manager.spawn({ host: '127.0.0.1', port: 47831 });
  manager.acquire(viewB, reused);
  check('重开面板拿到的是同一个内核（没有第二次 spawn）',
    reused === entry && spawns.length === 1);
  check('原本要收它的计时被取消', timers.pending() === 0, String(timers.pending()));
  check('到点了也未终止（因为仍在使用）', timers.fireAll() === 0 && spawns[0].background.disposed === 0);
}

section('4. 宽限到期 / 窗口关闭 / 用户显式停 → 真收');
{
  const { manager, timers, spawns } = makeManager({ idleMs: 600000 });
  const view = { name: 'A' };
  const entry = manager.spawn({ host: '127.0.0.1', port: 47831 });
  manager.acquire(view, entry);
  manager.release(view);
  check('排上了计时，时长就是 idleMs', timers.lastMs() === 600000, String(timers.lastMs()));
  timers.fireAll();
  check('到期 → 真的收掉（killTree 走的就是 dispose）',
    spawns[0].background.disposed === 1 && manager.size() === 0);

  const view2 = { name: 'A2' };
  const entry2 = manager.spawn({ host: '127.0.0.1', port: 47831 });
  manager.acquire(view2, entry2);
  check('窗口关闭 → 无条件收（不留孤儿）', manager.disposeAll('窗口关闭') === 1 && spawns[1].background.disposed === 1);

  const entry3 = manager.spawn({ host: '127.0.0.1', port: 47831 });
  check('用户显式停 → 收掉', manager.stop('127.0.0.1:47831', '用户手动停掉') === true && spawns[2].background.disposed === 1);
  check('重复 stop 不报错（幂等）', manager.stop('127.0.0.1:47831', '再来一次') === false);
}

section('5. idleMs = 0（面板一关就收，老行为）');
{
  const { manager, timers, spawns } = makeManager({ idleMs: 0 });
  const view = { name: 'A' };
  const entry = manager.spawn({ host: '127.0.0.1', port: 47831 });
  manager.acquire(view, entry);
  manager.release(view);
  check('立刻收掉，不排计时', spawns[0].background.disposed === 1 && timers.pending() === 0);
}

section('6. 它自己死了（不是我们收的）');
{
  const { manager, spawns } = makeManager();
  const entry = manager.spawn({ host: '127.0.0.1', port: 47831 });
  const view = { name: 'A' };
  manager.acquire(view, entry);
  spawns[0].background.dieByItself(1);
  check('自己死了就从表里摘掉（下次不会复用到尸体）',
    manager.size() === 0 && manager.live('127.0.0.1', 47831) === undefined);
  check('已经死透的内核再收 → 不再调 dispose（免得日志里一句吓人的 taskkill 报错）',
    manager.stop('127.0.0.1:47831', 'x') === false && spawns[0].background.disposed === 0);
}

section('7. 宽限时长来自设置');
{
  const { manager } = makeManager({ idleMs: 600000 });
  check('能改', manager.setIdleMs(1000) === 1000);
  check('非法值忽略（负数/NaN）',
    manager.setIdleMs(-5) === 1000 && manager.setIdleMs(Number.NaN) === 1000);
  check('0 是合法的（立刻收）', manager.setIdleMs(0) === 0);
}

section('8. 不碰别人起的那个内核');
{
  const { manager } = makeManager();
  // 桌面端的那个内核（47821）从未由本模块启动，因此永远不会被回收。
  const stranger = { name: '另一个视图' };
  manager.acquire(stranger, undefined);
  manager.release(stranger);
  check('没登记过的内核：release 不会误杀任何东西', manager.size() === 0);
  check('disposeAll 在空表上安全', manager.disposeAll('窗口关闭') === 0);
}

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
