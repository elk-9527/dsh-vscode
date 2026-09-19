/*
 * 门该监听哪个端口 —— 单独一个纯模块，好测，也不用把整个门（它要 import 内核）
 * 拉起来才能验。
 *
 * 优先顺序：环境变量 `DSH_ACP_DOOR_PORT` > 档里配的 `port` > 默认 47821。
 *
 * 为什么让环境变量赢（2026-09-19）：起内核的那一方（VS Code 面板）比档更清楚
 * "我打算连哪个端口"。以前端口只写在档里，两边不一致时面板只能干等超时，
 * 而且面板自启的内核会去抢桌面端那个 47821 —— 两个内核抢一个端口没有任何好处。
 * 现在面板启动内核时把端口钉进环境变量：**端口归用它的人定**。
 *
 * 传 0 合法（让系统挑空闲端口），所以判定用 >= 0。
 */

/** 档里没配、环境变量也没有时用的端口（和桌面端一致，方便"有门就接"）。 */
export const DEFAULT_PORT = 47821;

/**
 * 把一个"可能是数字、也可能是空/垃圾"的值转成合法端口，不合法返回 undefined。
 *
 * 为什么要防空串：`Number('')` 是 **0**，而 0 在这里是**合法值**（让系统挑
 * 端口）。也就是说环境变量被设成空串时，门会跑去监听一个随机端口，而且
 * 一声不响 —— 这是这个函数第一版真踩到的坑（`test/port.js` 抓到的）。
 */
function toPort(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return port;
}

/**
 * @param {object} config 门的配置（看 `port` 字段）
 * @param {object} env 环境变量表（默认 process.env）
 * @returns {number} 端口号
 */
export function resolveDoorPort(config = {}, env = {}) {
  const fromEnv = toPort(env.DSH_ACP_DOOR_PORT);
  if (fromEnv !== undefined) return fromEnv;
  const fromConfig = toPort(config.port);
  if (fromConfig !== undefined) return fromConfig;
  return DEFAULT_PORT;
}
