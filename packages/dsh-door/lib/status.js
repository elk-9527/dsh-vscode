import { createRequire } from 'node:module';
/** 安装清单是诊断版本的唯一来源，避免发布时出现两处版本漂移。 */
export const DOOR_VERSION = createRequire(import.meta.url)('../package.json').version;

/** 该插件自定义的只读状态方法。 */
export const DOOR_STATUS_METHOD = 'dsh-door/status';

/** 仅识别带请求 id 的精确方法名，通知和相似前缀一律不拦截。 */
export function isDoorStatusRequest(frame) {
  return Boolean(frame) && frame.id !== undefined && frame.method === DOOR_STATUS_METHOD;
}

/**
 * 构造不含凭据的接入点状态。
 *
 * `model` 只报告路由名称与来源；API key、环境变量、设置文件位置均不会进入协议。
 */
export function doorStatusPayload({
  model,
  historyKind = 'legacy-v3-disk',
  permissionKind,
  acpVersion,
  bridge,
  instanceId,
  connectionCount,
} = {}) {
  const selection = model && model.selection;
  const normalizedHistory =
    historyKind === 'session-query' ? 'session-query' : historyKind === 'unavailable' ? 'unavailable' : 'legacy-v3-disk';
  return {
    version: DOOR_VERSION,
    ...(instanceId ? { instanceId } : {}),
    ...(Number.isInteger(connectionCount) ? { connectionCount } : {}),
    ...(acpVersion ? { protocolVersion: 1, runtime: { acpVersion } } : {}),
    model: {
      ready: Boolean(selection),
      source: model?.source || 'missing',
      ...(selection ? { provider: selection.provider, model: selection.model } : {}),
      ...(model?.partialConfig ? { partialConfig: true } : {}),
    },
    capabilities: {
      presets: true,
      ...(bridge ? { bridge } : {}),
      history: normalizedHistory !== 'unavailable',
      historyQuery: normalizedHistory !== 'unavailable',
      historyKind: normalizedHistory,
      ...(normalizedHistory === 'unavailable' ? {} : { sessionFormat: normalizedHistory === 'session-query' ? 4 : 3 }),
      permissionPresets: Boolean(permissionKind),
      ...(permissionKind ? { permissionKind } : {}),
    },
  };
}

export function doorStatusResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
