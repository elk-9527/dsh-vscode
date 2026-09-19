'use strict';
/*
 * 后台 DSH 内核的"谁在用它、什么时候该收掉"。
 *
 * 为什么要把这件事从面板视图里拿出来（2026-09-19）：
 * 原来 `extension.js` 给 VS Code 的 disposer 直接调 `view.dispose()`，
 * 而 `view.dispose()` 会 **killTree 掉后台内核**。于是"视图没了"就等于
 * "内核死了" —— 可视图太容易没了：折叠侧边栏、把面板拖到另一个位置、
 * Reset View Locations、Reload Window、另一个窗口关掉……每一次都变成
 * 「杀内核 → 重连 → 重挂上下文」。用户报的"聊两句就断"、
 * 以及窗口日志里"每个自启内核都活 35 秒"那种节奏，这是最像的成因之一。
 *
 * 现在的规矩：
 * - 内核属于**扩展**，不属于某个视图。视图只是它的一个使用者。
 * - 视图销毁 = 释放引用；**引用归零后还有一段宽限**（默认 10 分钟），
 *   这期间重新打开面板会**继续用同一个内核**（不用重启、不用 resume）。
 * - 只有三种情况真的收掉它：宽限到期、窗口关闭（扩展 deactivate）、
 *   用户显式执行「DSH：停掉后台内核」。
 * - 只收**本扩展自己拉起来的**那些（表里登记的），绝不碰桌面端那个内核。
 */

/** 一个内核从"没人用"到"被收掉"之间的默认宽限。 */
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

class KernelManager {
  /**
   * @param {object} options
   * @param {(level: string, message: string) => void} [options.log]
   * @param {Function} [options.spawn] 起进程的函数（默认真实现，测试可注入）
   * @param {number} [options.idleMs] 没人用之后的宽限毫秒数；0 = 立刻收（测试用）
   * @param {Function} [options.setTimer] 计时器（测试可注入）
   * @param {Function} [options.clearTimer]
   */
  constructor({ log = () => {}, spawn, idleMs = DEFAULT_IDLE_MS, setTimer, clearTimer } = {}) {
    this.log = log;
    // 延迟取，避免测试里循环 require。
    this.spawnImpl = spawn || require('../door/locate.js').spawnBackgroundDsh;
    this.idleMs = idleMs;
    this.setTimer = setTimer || setTimeout;
    this.clearTimer = clearTimer || clearTimeout;
    /** @type {Map<string, object>} host:port → 登记项 */
    this.entries = new Map();
  }

  key(host, port) {
    return `${host}:${port}`;
  }

  /**
   * 改"没人用之后还能活多久"（来自设置 dshPanel.kernelIdleMinutes）。
   * 0 = 面板一关就收。改这个不影响已经登记着的内核，只影响下一轮 release。
   */
  setIdleMs(ms) {
    if (Number.isFinite(ms) && ms >= 0) this.idleMs = ms;
    return this.idleMs;
  }

  /** 登记项里的进程是不是还活着。 */
  #alive(entry) {
    const child = entry && entry.background && entry.background.child;
    if (!child) return false;
    return child.exitCode === null && child.signalCode === null;
  }

  /**
   * 端口上那个"我们自己起的、还活着"的内核（没有就返回 undefined）。
   *
   * 这是**跨视图复用**的关键：面板重新打开时先问这一句，能复用就复用，
   * 不要动不动又拉一个新的。
   */
  live(host, port) {
    const key = this.key(host, port);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.#alive(entry)) return entry;
    // 死透了：摘掉，别让下一次复用一个尸体。
    this.entries.delete(key);
    if (entry.timer) this.clearTimer(entry.timer);
    return undefined;
  }

  /**
   * 起一个新的并登记。参数与 `spawnBackgroundDsh` 一致，另加 host/port
   * （host 用来登记身份，port 会原样传下去 —— 门要按它开，
   * 见 dsh-door/lib/port.js）。
   *
   * @returns {object} 登记项；`entry.background` 就是原来的那个句柄。
   */
  spawn({ host, port, ...rest }) {
    const existing = this.live(host, port);
    if (existing) {
      this.log('info', `端口 ${this.key(host, port)} 上已经有本扩展起的后台 DSH，直接用它`);
      return existing;
    }
    const key = this.key(host, port);
    const entry = {
      key,
      host,
      port,
      consumers: new Set(),
      timer: null,
      background: undefined,
      // 记着是哪条命令、哪个档起起来的：重开面板复用它时要在日志/对话流里说清。
      command: rest.command,
      profile: rest.profile,
    };
    entry.background = this.spawnImpl({ ...rest, port });
    this.entries.set(key, entry);
    // 它自己死了（不是我们收的）→ 立刻从表里摘掉，免得下次复用到尸体。
    if (entry.background && entry.background.child && entry.background.child.on) {
      entry.background.child.on('exit', () => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
          if (entry.timer) this.clearTimer(entry.timer);
        }
      });
    }
    return entry;
  }

  /**
   * 某个使用者（一个面板视图）开始用这个内核。
   * 同一个使用者重复调用只算一次；会顺手取消"宽限到期"的计时。
   */
  acquire(consumer, entry) {
    if (!entry) return entry;
    entry.consumers.add(consumer);
    if (entry.timer) {
      this.clearTimer(entry.timer);
      entry.timer = null;
      this.log('info', '面板又用上这个后台 DSH 了，原本要收它的计时取消');
    }
    return entry;
  }

  /**
   * 某个使用者不再用它（视图销毁、面板关闭）。
   * 引用归零 **不立刻杀** —— 按 idleMs 宽限，期间重开面板还能接着用。
   */
  release(consumer) {
    for (const [key, entry] of this.entries) {
      if (!entry.consumers.delete(consumer)) continue;
      if (entry.consumers.size > 0) continue;
      if (this.idleMs <= 0) {
        this.stop(key, '没有面板用它了');
        continue;
      }
      const minutes = Math.max(1, Math.round(this.idleMs / 60000));
      this.log('info', `没有面板用这个后台 DSH 了，${minutes} 分钟后收掉（这期间重新打开面板会继续用它）`);
      entry.timer = this.setTimer(() => this.stop(key, '闲置到期'), this.idleMs);
      // 别让这个计时器把 Node 事件循环钉住（扩展宿主退出时不该被它拖住）。
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    }
  }

  /** 真的收掉一个（宽限到期 / 窗口关闭 / 用户点了停）。 */
  stop(key, reason) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    if (entry.timer) this.clearTimer(entry.timer);
    if (!this.#alive(entry)) {
      // 已经自己退了：不用再杀，也别在日志里吓人。
      this.log('info', `后台 DSH（${key}）已经不在了（${reason}）`);
      return true;
    }
    this.log('info', `停掉后台 DSH（${key}，${reason}）`);
    entry.background.dispose();
    return true;
  }

  /** 窗口关了：把本扩展起过的全收掉（不留孤儿）。 */
  disposeAll(reason = '窗口关闭') {
    const keys = [...this.entries.keys()];
    for (const key of keys) this.stop(key, reason);
    return keys.length;
  }

  /** 当前登记着几个（测试/诊断用）。 */
  size() {
    return this.entries.size;
  }

  /** 那个内核的 pid（诊断用）。 */
  pidOf(host, port) {
    const entry = this.live(host, port);
    const child = entry && entry.background && entry.background.child;
    return child ? child.pid : undefined;
  }
}

/*
 * 扩展宿主里只需要一个：内核是进程级资源，跟"哪个视图在用它"无关。
 * 日志用第一个进来的那个（同一个扩展只有一个输出通道，路由到哪都一样）。
 */
let singleton = null;

/** 拿到（或第一次创建）全局的那个 manager。 */
function kernelManager(log) {
  if (!singleton) singleton = new KernelManager({ log });
  return singleton;
}

/** 测试用：换个干净的 manager。 */
function resetKernelManager(options) {
  if (singleton) singleton.disposeAll('测试重置');
  singleton = new KernelManager(options);
  return singleton;
}

module.exports = { KernelManager, kernelManager, resetKernelManager, DEFAULT_IDLE_MS };
