'use strict';

/**
 * 读取仅允许由用户设置控制的值。
 *
 * 面板可以启动本机 DSH，并读取本机的会话、记忆和插件。因此工作区设置不能决定
 * 启动命令、配置集、端口、模型或工作目录；否则打开一个不受信任的仓库即可改变
 * 本地 DSH 的运行方式。清单中的 `scope: machine` 是第一层约束，本文再明确忽略
 * VS Code 返回的工作区值，作为运行时兜底。
 *
 * @param {{get?: (key: string) => unknown, inspect?: (key: string) => object}} configuration
 * @param {string} key 设置键名（不含 `dshPanel.` 前缀）。
 * @param {unknown} fallback 未设置时使用的默认值。
 * @returns {unknown}
 */
function readUserSetting(configuration, key, fallback) {
  if (!configuration) return fallback;
  if (typeof configuration.inspect === 'function') {
    const details = configuration.inspect(key);
    if (!details || typeof details !== 'object') return fallback;
    if (details.globalValue !== undefined) return details.globalValue;
    if (details.defaultValue !== undefined) return details.defaultValue;
    return fallback;
  }
  // 命令行单元测试中的最小 vscode 替身不实现 inspect()；此处保留该兼容分支。
  if (typeof configuration.get !== 'function') return fallback;
  const value = configuration.get(key);
  return value === undefined ? fallback : value;
}

module.exports = { readUserSetting };
