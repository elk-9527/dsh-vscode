/**
 * 清理该插件仍持有的全部客户端连接。
 *
 * 插件卸载/DSH 重载时不能只拆除 ACP 子插件：若 socket 仍保持连接，客户端会继续
 * 认为接入点可用，却再也收不到回复。逐项捕获错误则保证一个异常连接不会阻断其余连接。
 *
 * @param {Set<{socket?: {destroyed?: boolean, destroy?: () => void}, teardown?: () => void}>} live
 * @param {(phase: 'teardown'|'socket', error: unknown) => void} [onError]
 * @returns {number} 从集合中移除的连接数。
 */
export function disposeLiveConnections(live, onError = () => {}) {
  if (!live || typeof live[Symbol.iterator] !== 'function') return 0;
  let count = 0;
  for (const entry of [...live]) {
    if (typeof live.delete === 'function' && !live.delete(entry)) continue;
    count += 1;
    try {
      entry?.teardown?.();
    } catch (error) {
      onError('teardown', error);
    }
    try {
      const socket = entry?.socket;
      if (socket && !socket.destroyed && typeof socket.destroy === 'function') socket.destroy();
    } catch (error) {
      onError('socket', error);
    }
  }
  return count;
}
