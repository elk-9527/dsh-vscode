'use strict';

/**
 * ACP 接入点的客户端目标必须是本机回环地址。
 *
 * 该插件没有鉴权，因此不能把「可配置的连接地址」当作远程连接能力。
 * 即使用户设置或工作区设置写入了其它地址，扩展也不得向该地址建立连接，
 * 更不能发送会话、编辑器上下文或权限请求。
 */

const LOOPBACK_HOST = '127.0.0.1';

/**
 * 规范化并判定一个客户端连接地址。
 *
 * `localhost` 仅作为兼容写法接受，但会在真正建立连接前规范化为 IPv4 回环地址，
 * 不依赖操作系统 hosts 文件的解析结果。
 *
 * @param {unknown} value 设置中的地址。
 * @returns {{host: string, accepted: boolean}}
 */
function resolveLoopbackHost(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return {
    host: LOOPBACK_HOST,
    accepted: text === '' || text === LOOPBACK_HOST || text === 'localhost',
  };
}

/**
 * 取得可安全使用的客户端地址；其它地址在构造连接客户端时立即拒绝。
 *
 * @param {unknown} value 设置中的地址。
 * @returns {string}
 */
function requireLoopbackHost(value) {
  const resolved = resolveLoopbackHost(value);
  if (!resolved.accepted) throw new Error('连接地址仅支持本机回环地址');
  return resolved.host;
}

module.exports = { LOOPBACK_HOST, resolveLoopbackHost, requireLoopbackHost };
