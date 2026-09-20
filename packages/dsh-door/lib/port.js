/*
 * ACP 接入点插件（dsh-acp-door）应当监听哪个端口。该判定单独构成一个纯模块，便于测试，
 * 也无须为验证它而载入整个插件（该插件需要 import 内核）。
 *
 * 优先顺序：环境变量 `DSH_ACP_DOOR_PORT` > 档中配置的 `port` > 默认 47821。
 *
 * 环境变量优先的原因（2026-09-19）：启动内核的一方（VS Code 面板）比档更清楚
 * 应当连接哪个端口。此前端口只写在档中，两边不一致时面板只能持续等待直至超时，
 * 且面板自启的内核会争用桌面端占用的 47821 端口 —— 两个内核争用一个端口没有收益。
 * 现在面板启动内核时把端口写入环境变量：**端口由使用方决定**。
 *
 * 传 0 合法（由系统分配空闲端口），因此判定条件为 >= 0。
 */

/** 档中未配置且环境变量未设置时使用的端口（与桌面端一致，便于客户端直接连接）。 */
export const DEFAULT_PORT = 47821;

/**
 * 把一个可能为数字、也可能为空值或无效值的输入转换为合法端口；不合法时返回 undefined。
 *
 * 需要单独防御空串的原因：`Number('')` 的结果是 **0**，而 0 在此处是**合法值**（由系统分配
 * 端口）。因此环境变量被设为空串时，该插件会监听一个随机端口，而且
 * 不产生任何提示 —— 这是该函数第一版实际遇到的失败模式（由 `test/port.js` 检出）。
 */
function toPort(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return port;
}

/**
 * @param {object} config 该插件的配置（读取 `port` 字段）
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
