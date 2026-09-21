/**
 * ACP 接入点选择新会话初始模型时使用的纯函数。
 *
 * DSH 0.1.5 起由 `agentDefaultModel.currentSelection()` 保存用户在 DSH 界面中
 * 实际选择的默认模型。接入点若继续把某一台开发机上的 provider/model 写死在
 * 安装包中，新用户即使已在 DSH 中选好模型，ACP 会话仍会走错误的服务商。
 *
 * 本模块不依赖 DSH 内核，便于用普通 Node 进程覆盖新旧版本兼容分支。
 */

/** 去掉空白并只接受完整的 provider/model 对。 */
export function normalizeModelSelection(value) {
  if (!value || typeof value !== 'object') return undefined;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model) return undefined;
  return { provider, model };
}

/**
 * 决定一条新 ACP 连接使用的初始模型。
 *
 * 优先级：
 *   1. 插件显式配置了完整的 provider + model；
 *   2. 当前 DSH 的默认模型服务（新版 DSH）；
 *   3. 缺失 —— 由调用方给出明确诊断，不能拼接半套配置。
 *
 * @param {object} config 插件配置。
 * @param {object|undefined} service DSH 的 agentDefaultModel 服务。
 * @returns {{source: 'config'|'dsh-default'|'missing', selection?: {provider:string, model:string}, partialConfig?: boolean, error?: string}}
 */
export function resolveInitialModel(config = {}, service) {
  const configured = normalizeModelSelection(config);
  if (configured) return { source: 'config', selection: configured };

  const hasProvider = typeof config.provider === 'string' && Boolean(config.provider.trim());
  const hasModel = typeof config.model === 'string' && Boolean(config.model.trim());
  const partialConfig = hasProvider !== hasModel;

  try {
    const current =
      service && typeof service.currentSelection === 'function'
        ? normalizeModelSelection(service.currentSelection())
        : undefined;
    if (current) return { source: 'dsh-default', selection: current, partialConfig };
  } catch (error) {
    return {
      source: 'missing',
      partialConfig,
      error: error && error.message ? error.message : String(error),
    };
  }

  return { source: 'missing', partialConfig };
}

