'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { DshSession } = require('../dsh/session');
const { redactSensitiveOutput } = require('../door/locate');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (message, code = -32046) => { throw Object.assign(new Error(message), { code }); };
const cancelled = () => fail('请求已取消', -32800);

/** 公开边界只返回会话描述和声明性事件，不返回客户端或端点对象。 */
class PublicApi {
  constructor({ vscode, context, connections, panel, views }) {
    Object.assign(this, { vscode, context, connections, panel, views });
    this.sessions = new Map(); this.operations = new Map(); this.disposed = false;
    this.onOperation = event => { if (['completed', 'failed', 'cancelled'].includes(event.type)) this.releaseOperation(event.operationId); };
    connections.on('operation', this.onOperation);
    const event = (name, shape) => listener => {
      const receive = value => { try { listener(copy(shape(value))); } catch {} };
      connections.on(name, receive);
      const disposable = { dispose: () => connections.off(name, receive) };
      context.subscriptions.push(disposable); return disposable;
    };
    const invoke = fn => async (...args) => {
      if (this.disposed) fail('扩展 API 已关闭');
      try { return await fn(...args); }
      catch (error) { throw Object.assign(new Error(redactSensitiveOutput(error?.message || 'DSH 操作失败')), { code: error?.code }); }
    };
    this.exports = Object.freeze({
      apiVersion: 1, apiRevision: 2,
      features: Object.freeze(['sessions', 'prompt-stream', 'capability-invoke', 'cancellation', 'events', 'panel-handoff']),
      listCapabilities: invoke(async () => copy(await views.refresh())),
      getConnectionStatus: invoke(async () => { const client = await connections.ensure(); const status = await client.doorStatus(); return copy({ version: status?.version, model: status?.model, capabilities: status?.capabilities, runtime: status?.runtime, ...connections.snapshot(), connectionCount: status?.connectionCount }); }),
      review: invoke(async request => { this.signal(request?.signal); const result = await views.reviewRequest({ ...request, userInitiated: request?.userInitiated === true }); return result ? copy(result) : result; }),
      createSession: invoke(request => this.create(request)),
      restoreSession: invoke(request => this.create(request, true)),
      getPanelSession: invoke(async () => { const session = await panel.ensureConnection(); if (!session) fail('对话未连接'); return this.remember(session, this.cwd(session.cwd || panel.workdir()), 'panel'); }),
      prompt: invoke((handle, text, options) => this.prompt(handle, text, options)),
      closeSession: invoke(handle => this.close(handle)),
      invokeCapability: invoke(request => this.capability(request)),
      getOperation: invoke(id => this.operation(id, 'operation/get')),
      cancel: invoke(target => this.cancel(target)),
      openPanel: invoke(handle => this.openPanel(handle)),
      onDidChangeConnection: event('state', () => connections.snapshot()),
      onDidChangeCapabilities: event('catalogChanged', () => ({ changed: true })),
      onDidChangeOperation: event('operation', value => ({ operationId: value.operationId, seq: value.seq, type: value.type, at: value.at })),
    });
  }
  cwd(value, execute = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('需要工作区的绝对目录');
    let cwd; try { cwd = fs.realpathSync.native(value); } catch { fail('工作目录不存在'); }
    if (!fs.statSync(cwd).isDirectory() || !this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(cwd))) fail('目录不在当前工作区');
    if (execute && !this.vscode.workspace.isTrusted) fail('该操作需要受信任工作区', -32044);
    return cwd;
  }
  explicit(request) { if (request?.userInitiated !== true) fail('该操作需要显式启动', -32044); }
  signal(signal) { if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('取消信号无效'); }
  describe(record) {
    const { id, cwd, sessionId, preset } = record;
    return Object.freeze({ id, cwd, sessionId, preset, instanceId: record.instanceId });
  }
  remember(session, cwd, surface) {
    const existing = [...this.sessions.values()].find(record => record.session === session && record.sessionId === session.sessionId && record.cwd === cwd);
    if (existing) return this.describe(existing);
    if (this.sessions.size >= 64) fail('会话数量达到上限，请关闭旧会话', -32045);
    const id = randomUUID(), record = { id, cwd, surface, session, sessionId: session.sessionId, preset: this.panel.wantedPreset(), instanceId: this.connections.snapshot().instanceId };
    this.sessions.set(id, record); this.connections.acquire('api:' + id);
    return this.describe(record);
  }
  async create(request, restore = false) {
    this.explicit(request); const cwd = this.cwd(request?.cwd, true);
    for (const [id, record] of this.sessions) if (record.session.sessionId !== record.sessionId || record.session.client !== this.connections.client || record.instanceId !== this.connections.snapshot().instanceId) { this.sessions.delete(id); this.connections.release('api:' + id); }
    if (this.sessions.size >= 64) fail('会话数量达到上限，请关闭旧会话', -32045);
    await this.connections.ensure(); this.cwd(cwd, true);
    if (restore && (typeof request.sessionId !== 'string' || !request.sessionId || request.sessionId.length > 512)) fail('会话标识无效');
    const matched = [...this.sessions.values()].find(record => restore && record.sessionId === request.sessionId && record.session.sessionId === record.sessionId && record.cwd === cwd && record.session.client === this.connections.client && record.instanceId === this.connections.snapshot().instanceId);
    if (matched) return this.describe(matched);
    if (restore && this.panel.session?.sessionId === request.sessionId && this.panel.session.client === this.connections.client && this.cwd(this.panel.session.cwd || this.panel.workdir()) === cwd) return this.remember(this.panel.session, cwd, 'panel');
    const session = new DshSession({ client: this.connections.client, log: this.connections.log });
    const config = this.panel.config(), preset = request.preset || this.panel.wantedPreset();
    try {
      if (restore) await session.resume(request.sessionId, cwd, { preset });
      else await session.start({ cwd, preset, provider: config.provider, model: config.model });
      this.cwd(cwd, true);
      const handle = this.remember(session, cwd, 'api:' + randomUUID());
      const record = this.sessions.get(handle.id); record.preset = preset;
      this.connections.setSession(record.surface, session);
      return this.describe(record);
    } catch (error) { if (session.sessionId) await session.client.closeSession(session.sessionId).catch(() => {}); session.dispose(); throw error; }
  }
  record(handle) {
    const record = this.sessions.get(typeof handle === 'string' ? handle : handle?.id);
    if (!record) fail('会话不属于当前 API 调用', -32047);
    this.cwd(record.cwd, true);
    if (record.session.sessionId !== record.sessionId || record.session.client !== this.connections.client || record.instanceId !== this.connections.snapshot().instanceId) fail('连接已变化，请恢复原会话', -32047);
    return record;
  }
  async prompt(handle, text, options = {}) {
    this.explicit(options); const record = this.record(handle);
    if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) fail('提示文本无效或过大');
    this.signal(options.signal);
    if (options.signal?.aborted) cancelled();
    const session = this.panel.session?.sessionId === record.session.sessionId ? this.panel.session : record.session;
    return this.connections.runSession(session, async () => {
      this.record(handle); if (options.signal?.aborted) cancelled();
      const receive = [], pendingPermissions = new Set(); let finished = false;
      for (const name of ['text', 'thinking', 'tool', 'usage', 'done']) {
        const listener = value => { try { options.onEvent?.(copy({ type: name, ...value })); } catch {} };
        session.on(name, listener); receive.push([name, listener]);
      }
      const stop = () => { session.stop(); for (const cancelPermission of pendingPermissions) cancelPermission(); }; options.signal?.addEventListener('abort', stop, { once: true });
      const permission = async (id, params) => {
        if (params?.sessionId !== session.sessionId) return;
        let answer, cancelPermission;
        const cancellation = new Promise(resolve => { cancelPermission = () => resolve(undefined); pendingPermissions.add(cancelPermission); });
        try { answer = await Promise.race([Promise.resolve().then(() => options.onPermission?.(copy(params))), cancellation]); } catch {}
        pendingPermissions.delete(cancelPermission);
        if (finished || options.signal?.aborted || !this.vscode.workspace.isTrusted || !params.options?.some(item => item.optionId === answer)) answer = undefined;
        if (session.client.isConnected) session.answerPermission(id, answer);
      };
      session.externalPermissionHandler = true; session.client.on('permission', permission);
      try { return { ...(await session.send(text, { attachments: options.attachments || [] })), session: this.describe(record) }; }
      finally {
        finished = true; for (const cancelPermission of pendingPermissions) cancelPermission();
        options.signal?.removeEventListener('abort', stop); session.client.off('permission', permission);
        session.externalPermissionHandler = false; for (const [name, listener] of receive) session.off(name, listener);
      }
    });
  }
  async capability(request) {
    const consumer = 'api-request:' + randomUUID(); this.connections.acquire(consumer);
    try {
    const cwd = this.cwd(request?.cwd); await this.connections.ensure(); this.cwd(cwd);
    const bridge = this.connections.bridge; if (!bridge?.supported) fail('当前接入点不支持插件能力', -32042);
    const catalog = await bridge.catalog(), capability = catalog.capabilities.find(item => item.id === request.capabilityId);
    if (!capability) fail('插件能力不可用', -32043);
    if (capability.riskTier !== 'read') { this.explicit(request); this.cwd(cwd, true); }
    const handle = request.session ? this.record(request.session) : undefined;
    if (handle && handle.cwd !== cwd) fail('会话和操作目录不一致');
    const result = await bridge.request('invoke', { requestId: randomUUID(), capabilityId: request.capabilityId, input: request.input ?? {},
      context: { cwd, sessionId: handle?.session.sessionId, workspaceTrusted: this.vscode.workspace.isTrusted, userInitiated: request.userInitiated === true, approved: request.approved === true } });
    if (result.mode === 'operation') {
      this.operations.set(result.operationId, { cwd, instanceId: this.connections.snapshot().instanceId, active: true });
      this.connections.acquire('api-operation:' + result.operationId);
      this.views.retain(result.operationId);
      const state = await bridge.request('operation/get', { operationId: result.operationId });
      if (['completed', 'failed', 'cancelled'].includes(state.status)) this.releaseOperation(result.operationId);
    }
    return copy(result);
    } finally { this.connections.release(consumer); }
  }
  releaseOperation(id) { const operation = this.operations.get(id); if (operation?.active) { operation.active = false; this.connections.release('api-operation:' + id); this.views.release(id); } }
  async operation(id, method) {
    if (!this.operations.has(id) && !this.views.operations.has(id)) fail('运行不属于当前 API 调用', -32047);
    await this.connections.ensure();
    const operation = this.operations.get(id);
    if (method === 'operation/get') { const cwd = operation?.cwd || this.views.operations.get(id)?.cwd; if (cwd) this.cwd(cwd, true); }
    if (operation && operation.instanceId !== this.connections.snapshot().instanceId) { this.releaseOperation(id); fail('运行所属内核已变化', -32047); }
    const result = await this.connections.bridge.request(method, { operationId: id });
    if (['completed', 'failed', 'cancelled'].includes(result.status)) this.releaseOperation(id);
    return copy(result);
  }
  async cancel(target) {
    if (target?.kind === 'operation') return this.operation(target.id, 'cancel');
    const record = this.record(target?.id || target);
    const session = this.panel.session?.sessionId === record.session.sessionId ? this.panel.session : record.session;
    return session.stop();
  }
  async close(handle) {
    const record = this.record(handle); if (record.session.busy || this.connections.turns.has(record.session.sessionId)) fail('会话正在使用中', -32045);
    if (this.panel.session?.sessionId !== record.session.sessionId) await record.session.client.closeSession(record.session.sessionId);
    if (record.session !== this.panel.session) record.session.dispose();
    for (const [surface, session] of this.connections.sessions) if (session === record.session && (surface !== 'panel' || session !== this.panel.session)) this.connections.sessions.delete(surface);
    this.sessions.delete(record.id); this.connections.release('api:' + record.id); return true;
  }
  async openPanel(handle) {
    const record = this.record(handle);
    if (this.panel.session?.busy || this.connections.turns.has(record.session.sessionId)) fail('会话正在使用中', -32045);
    const previous = this.panel.session;
    if (previous && this.connections.turns.has(previous.sessionId)) fail('会话正在使用中', -32045);
    await this.panel.reveal(); await this.panel.adoptSession(record.session, { cwd: record.cwd, preset: record.preset });
    if (previous && previous !== record.session) {
      if ([...this.sessions.values()].some(item => item.session === previous)) this.connections.setSession('api-retired:' + previous.sessionId, previous);
      else { await previous.client.closeSession(previous.sessionId).catch(() => {}); previous.dispose(); }
    }
    if (this.panel.session?.sessionId !== record.session.sessionId) fail('面板未能恢复指定会话');
    return this.describe(record);
  }
  dispose() { this.disposed = true; this.connections.off('operation', this.onOperation); for (const id of this.operations.keys()) this.releaseOperation(id);
    for (const record of this.sessions.values()) { record.session.stop(); if (record.surface !== 'panel') { record.session.dispose(); this.connections.sessions.delete(record.surface); } this.connections.release('api:' + record.id); } this.sessions.clear(); }
}
module.exports = { PublicApi };
