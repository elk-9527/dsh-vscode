'use strict';
const { capabilityDescriptor, requiredString, checkSchema, jsonValue, fail, absoluteCwd } = require('./schema');

/** 验证注册与每次调用，返回不含宿主或传输对象的 Provider。 */
function defineProvider(provider) {
  requiredString(provider?.id); requiredString(provider.name); requiredString(provider.version);
  if (typeof provider.invoke !== 'function' || !Array.isArray(provider.capabilities) || !provider.capabilities.length) fail(-32046, '提供方注册无效');
  const capabilities = provider.capabilities.map(capability => capabilityDescriptor(provider, capability));
  if (new Set(capabilities.map(item => item.id)).size !== capabilities.length) fail(-32046, '能力标识重复');
  const definitions = new Map(provider.capabilities.map(item => [item.id, item]));
  for (const item of definitions.values()) if (item.outputSchema) checkSchema(item.outputSchema, undefined, true);
  const call = provider.invoke.bind(provider);
  return { id: provider.id, name: provider.name, version: provider.version, capabilities,
    async invoke(id, input, context) {
      const definition = definitions.get(id); if (!definition) fail(-32043, '能力不存在');
      const value = jsonValue(input ?? {}); checkSchema(definition.inputSchema || {}, value);
      if (context.signal?.aborted) fail(-32800, '操作已取消');
      const result = jsonValue(await call(id, value, context));
      if (definition.outputSchema) checkSchema(definition.outputSchema, result);
      return result;
    },
  };
}
/** 配合 Cordis 生命周期注册；服务卸载时由宿主处理运行取消。 */
function registerProvider(ctx, provider) {
  const checked = defineProvider(provider);
  if (ctx.ideBridge?.registerProvider) return ctx.ideBridge.registerProvider(checked);
  if (typeof ctx.inject !== 'function') fail(-32043, '缺少 ideBridge 服务或依赖注入宿主');
  return ctx.inject(['ideBridge'], injected => injected.ideBridge.registerProvider(checked));
}
/** 离线契约宿主；不替代真实 Bridge 的鉴权、租约和事件验收。 */
function createMockHost() {
  const providers = new Map(), capabilities = new Map();
  const host = {
    registerProvider(provider) {
      const checked = defineProvider(provider);
      if (providers.has(checked.id) || checked.capabilities.some(item => capabilities.has(item.id))) fail(-32046, '提供方或能力重复');
      providers.set(checked.id, checked); for (const item of checked.capabilities) capabilities.set(item.id, { item, provider: checked });
      let disposed = false;
      return () => { if (disposed) return; disposed = true; providers.delete(checked.id); for (const item of checked.capabilities) capabilities.delete(item.id); };
    },
    catalog: () => ({ protocolVersion: 1, capabilities: [...capabilities.values()].map(entry => jsonValue(entry.item)) }),
    async invoke(id, input, context) {
      const entry = capabilities.get(id); if (!entry) fail(-32043, '能力不存在');
      absoluteCwd(context.cwd);
      if (entry.item.riskTier !== 'read' && (!context.workspaceTrusted || !context.userInitiated)) fail(-32044, '执行需要受信任工作区和显式启动');
      if (['workspace-write', 'system'].includes(entry.item.riskTier) && !context.approved) fail(-32044, '写操作需要确认');
      if (entry.item.effects.includes('workspace.read') && !context.workspaceTrusted) fail(-32044, '受限工作区不能读取项目');
      if (entry.item.requiresSession && !context.sessionId) fail(-32046, '需要会话');
      return entry.provider.invoke(id, input, { ...context, signal: context.signal || new AbortController().signal, emit: context.emit || (() => {}) });
    },
  };
  return host;
}
module.exports = { defineProvider, registerProvider, createMockHost, checkSchema, jsonValue };
