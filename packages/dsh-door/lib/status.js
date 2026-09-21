/** 该版本同时作为客户端兼容诊断信息；测试会核对它与 package.json 一致。 */
export const DOOR_VERSION = '0.0.15';

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
export function doorStatusPayload({ model, permissionAvailable = false } = {}) {
  const selection = model && model.selection;
  return {
    version: DOOR_VERSION,
    model: {
      ready: Boolean(selection),
      source: model?.source || 'missing',
      ...(selection ? { provider: selection.provider, model: selection.model } : {}),
      ...(model?.partialConfig ? { partialConfig: true } : {}),
    },
    capabilities: {
      presets: true,
      history: true,
      permissionPresets: Boolean(permissionAvailable),
    },
  };
}

export function doorStatusResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
