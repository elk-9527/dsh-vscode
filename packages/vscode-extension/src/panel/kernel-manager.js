'use strict';
/*
 * 后台 DSH 内核的"使用方与回收时机"。
 *
 * 将该项职责从面板视图中分离的原因（2026-09-19）：
 * 原实现中 `extension.js` 提供给 VS Code 的 disposer 直接调用 `view.dispose()`，
 * 而 `view.dispose()` 会 **killTree 终止后台内核**。因此"视图销毁"等同于
 * "内核终止" —— 而视图的销毁条件很常见：折叠侧边栏、把面板拖到另一个位置、
 * Reset View Locations、Reload Window、另一个窗口关闭……每一次都变成
 * 「终止内核 → 重连 → 重新挂载上下文」。用户报告的"对话进行数次后即断开"、
 * 以及窗口日志中"每个自启内核存活约 35 秒"这种规律，是最接近的成因之一。
 *
 * 现行规则：
 * - 内核属于**扩展**，不属于某个视图。视图只是它的一个使用者。
 * - 视图销毁 = 释放引用；**引用归零后仍保留一段宽限期**（默认 10 分钟），
 *   该期间重新打开面板会**继续使用同一个内核**（不需要重启、不需要 resume）。
 * - 仅三种情况实际回收内核：宽限期到期、窗口关闭（扩展 deactivate）、
 *   用户显式执行「DSH：停止后台内核」。
 * - 仅回收**本扩展启动的内核**（表中登记者），不操作桌面端的内核。
 */

/** 内核从"无使用方"到"被回收"之间的默认宽限期。 */
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

class KernelManager {
  /**
   * @param {object} options
   * @param {(level: string, message: string) => void} [options.log]
   * @param {Function} [options.spawn] 启动进程的函数（默认为真实实现，测试可注入）
   * @param {number} [options.idleMs] 无使用方之后的宽限期毫秒数；0 = 立即回收（测试用）
   * @param {Function} [options.setTimer] 计时器（测试可注入）
   * @param {Function} [options.clearTimer]
   */
  constructor({ log = () => {}, spawn, idleMs = DEFAULT_IDLE_MS, setTimer, clearTimer } = {}) {
    this.log = log;
    // 延迟获取，避免测试中出现循环 require。
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
   * 修改"无使用方之后的存活时长"（来自配置项 dshPanel.kernelIdleMinutes）。
   * 0 = 面板关闭时立即回收。修改该值不影响已登记的内核，只影响下一轮 release。
   */
  setIdleMs(ms) {
    if (Number.isFinite(ms) && ms >= 0) this.idleMs = ms;
    return this.idleMs;
  }

  /** 登记项中的进程是否仍在运行。 */
  #alive(entry) {
    const child = entry && entry.background && entry.background.child;
    if (!child) return false;
    return child.exitCode === null && child.signalCode === null;
  }

  /**
   * 查询端口上"由本扩展启动且仍在运行"的内核（不存在时返回 undefined）。
   *
   * 这是**跨视图复用**的关键：面板重新打开时先查询该项，能够复用时即复用，
   * 不应频繁启动新的进程。
   */
  live(host, port) {
    const key = this.key(host, port);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.#alive(entry)) return entry;
    // 进程已终止：从表中移除，避免下一次复用到已终止的内核。
    this.entries.delete(key);
    if (entry.timer) this.clearTimer(entry.timer);
    return undefined;
  }

  /**
   * 启动一个新的内核并登记。参数与 `spawnBackgroundDsh` 一致，另加 host/port
   * （host 用于登记标识，port 原样传递下去 —— 接入点按该端口监听，
   * 见 dsh-door/lib/port.js）。
   *
   * @returns {object} 登记项；`entry.background` 即原有的进程句柄。
   */
  spawn({ host, port, ...rest }) {
    const existing = this.live(host, port);
    if (existing) {
      this.log('info', `端口 ${this.key(host, port)} 上已存在本扩展启动的后台 DSH，直接使用该进程`);
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
      // 记录使用的命令与配置集：重新打开面板复用该内核时需要在日志或对话流中说明。
      command: rest.command,
      profile: rest.profile,
    };
    entry.background = this.spawnImpl({ ...rest, port });
    this.entries.set(key, entry);
    // 进程自行终止（非本模块回收）→ 立即从表中移除，避免下一次复用到已终止的内核。
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
   * 某个使用者（一个面板视图）开始使用该内核。
   * 同一个使用者重复调用只计一次；同时取消"宽限期到期"的计时器。
   */
  acquire(consumer, entry) {
    if (!entry) return entry;
    entry.consumers.add(consumer);
    if (entry.timer) {
      this.clearTimer(entry.timer);
      entry.timer = null;
      this.log('info', '面板再次使用该后台 DSH，原定的回收计时取消');
    }
    return entry;
  }

  /**
   * 某个使用者不再使用该内核（视图销毁、面板关闭）。
   * 引用归零时**不立即终止** —— 按 idleMs 保留宽限期，该期间重新打开面板仍可继续使用。
   */
  release(consumer) {
    for (const [key, entry] of this.entries) {
      if (!entry.consumers.delete(consumer)) continue;
      if (entry.consumers.size > 0) continue;
      if (this.idleMs <= 0) {
        this.stop(key, '已无面板使用该内核');
        continue;
      }
      const minutes = Math.max(1, Math.round(this.idleMs / 60000));
      this.log('info', `已无面板使用该后台 DSH，${minutes} 分钟后回收（该期间重新打开面板会继续使用该内核）`);
      entry.timer = this.setTimer(() => this.stop(key, '宽限期到期'), this.idleMs);
      // 不应使该计时器占用 Node 事件循环（扩展宿主退出时不应因其延迟）。
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    }
  }

  /** 实际回收一个内核（宽限期到期 / 窗口关闭 / 用户执行停止命令）。 */
  stop(key, reason) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    if (entry.timer) this.clearTimer(entry.timer);
    if (!this.#alive(entry)) {
      // 已自行退出：不需要再次终止，日志中也不应输出警示性内容。
      this.log('info', `后台 DSH（${key}）已不存在（${reason}）`);
      return true;
    }
    this.log('info', `停止后台 DSH（${key}，${reason}）`);
    entry.background.dispose();
    return true;
  }

  /** 窗口关闭：回收本扩展启动的全部内核（不遗留孤儿进程）。 */
  disposeAll(reason = '窗口关闭') {
    const keys = [...this.entries.keys()];
    for (const key of keys) this.stop(key, reason);
    return keys.length;
  }

  /** 当前登记的内核数量（测试或诊断用）。 */
  size() {
    return this.entries.size;
  }

  /** 该内核的 pid（诊断用）。 */
  pidOf(host, port) {
    const entry = this.live(host, port);
    const child = entry && entry.background && entry.background.child;
    return child ? child.pid : undefined;
  }
}

/*
 * 扩展宿主中只需要一个实例：内核是进程级资源，与"哪个视图在使用它"无关。
 * 日志使用最先传入的那个（同一个扩展只有一个输出通道，路由目标没有区别）。
 */
let singleton = null;

/** 获取（或首次创建）全局的 manager 实例。 */
function kernelManager(log) {
  if (!singleton) singleton = new KernelManager({ log });
  return singleton;
}

/** 测试用：替换为新的 manager 实例。 */
function resetKernelManager(options) {
  if (singleton) singleton.disposeAll('测试重置');
  singleton = new KernelManager(options);
  return singleton;
}

module.exports = { KernelManager, kernelManager, resetKernelManager, DEFAULT_IDLE_MS };
