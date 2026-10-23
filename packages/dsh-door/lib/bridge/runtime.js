import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PREFIX, BridgeError, fail, jsonValue, requiredString, checkSchema, capabilityDescriptor, absoluteCwd } from './protocol.js';

const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
/** 内核级能力注册与运行记录；socket 和 Agent 的所有权由连接状态显式传入。 */
export class IdeBridge {
  constructor({ now = Date.now, endpoint, limits = {}, sweepIntervalMs = 60000 } = {}) {
    this.now = now; this.endpoint = endpoint; this.providers = new Map(); this.capabilities = new Map();
    this.operations = new Map(); this.requests = new Map(); this.locks = new Map(); this.connections = new Set(); this.idleWaiters = new Map(); this.revision = 0;
    this.limits = { active: 32, operations: 1000, requests: 1000, requestBytes: 32 * 1024 * 1024, retainedBytes: 64 * 1024 * 1024, ...limits };
    this.disposed = false;
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs); this.sweeper.unref();
  }
  registerProvider(provider) {
    requiredString(provider.id); requiredString(provider.name); requiredString(provider.version);
    if (this.providers.has(provider.id) || typeof provider.invoke !== 'function' || !Array.isArray(provider.capabilities)) fail(-32046, '提供方注册无效');
    const items = provider.capabilities.map(c => capabilityDescriptor(provider, c));
    if (new Set(items.map(c => c.id)).size !== items.length || items.some(c => this.capabilities.has(c.id))) fail(-32046, '能力标识重复');
    this.providers.set(provider.id, provider);
    for (const item of items) this.capabilities.set(item.id, { item, provider });
    this.changed();
    let disposed = false;
    return () => {
      if (disposed) return; disposed = true;
      this.providers.delete(provider.id);
      for (const item of items) this.capabilities.delete(item.id);
      for (const op of this.operations.values()) if (op.providerId === provider.id && !op.settled) {
        // Older clients release their kernel consumer on terminal events. Do
        // not announce completion until even an uncooperative provider stops.
        op.stopReason = 'provider-unloaded'; op.controller.abort();
      }
      this.changed();
    };
  }
  changed() {
    this.revision += 1;
    for (const state of this.connections) if (this.authorized(state)) state.respond({ jsonrpc: '2.0', method: `${PREFIX}catalog-changed`, params: { revision: this.revision } });
  }
  authorized(state) { return Boolean(state.bridgeOwner && state.bridgeLease > this.now()); }
  catalog() { return { protocolVersion: 1, revision: this.revision, capabilities: [...this.capabilities.values()].map(x => x.item) }; }
  activeCount() { return [...this.operations.values()].filter(op => !op.settled).length; }
  requestBytes() { return [...this.requests.values()].reduce((sum, item) => sum + item.bytes, 0); }
  retainedBytes() { return [...this.operations.values()].reduce((sum, op) => sum + op.bytes + (op.resultBytes || 0), 0); }
  sweep() {
    for (const [key, item] of this.requests) if (!item.active && item.expires <= this.now()) this.requests.delete(key);
    for (const [id, op] of this.operations) if (op.settled && op.finishedAt + 1800000 <= this.now()) this.operations.delete(id);
    // Never evict an active execution: forgetting one would release its lock or
    // allow its request ID to execute again while the provider is still running.
    for (const [id, op] of this.operations) {
      if (this.retainedBytes() <= this.limits.retainedBytes && this.operations.size < this.limits.operations) break;
      if (op.settled) this.operations.delete(id);
    }
    for (const item of this.requests.values()) {
      if (this.requestBytes() <= this.limits.requestBytes) break;
      if (!item.active && item.responseBytes) { item.promise = undefined; item.bytes -= item.responseBytes; item.responseBytes = 0; }
    }
  }
  emit(op, type, payload = {}) {
    if (terminal(op.status) && !['completed', 'failed', 'cancelled'].includes(type)) return;
    const event = jsonValue({ operationId: op.id, seq: ++op.seq, type, at: new Date(this.now()).toISOString(), payload });
    op.events.push(event); op.bytes += Buffer.byteLength(JSON.stringify(event));
    while (op.events.length > 200 || op.bytes > 2 * 1024 * 1024) op.bytes -= Buffer.byteLength(JSON.stringify(op.events.shift()));
    // Bound aggregate event retention even while all executions remain active.
    // A snapshot's gap flag and terminal result preserve recovery semantics.
    for (const item of this.operations.values()) {
      while (item.events.length && this.retainedBytes() > this.limits.retainedBytes) {
        item.bytes -= Buffer.byteLength(JSON.stringify(item.events.shift()));
      }
    }
    for (const state of this.connections) if (state.bridgeOwner === op.owner && this.authorized(state)) state.respond({ jsonrpc: '2.0', method: `${PREFIX}event`, params: event });
  }
  finish(op, status, payload) {
    if (terminal(op.status)) return;
    const result = jsonValue(payload);
    if (op.kind !== 'resource') jsonValue({ operationId: op.id, seq: op.seq + 1, type: status, at: new Date(this.now()).toISOString(), payload: result });
    op.status = status; op.finishedAt = this.now(); op.result = result;
    op.resultBytes = Buffer.byteLength(JSON.stringify(result));
    if (op.kind !== 'resource') this.emit(op, status, op.result);
  }
  settle(op) {
    if (op.settled) return;
    op.settled = true;
    if (op.lock && this.locks.get(op.lock) === op.id) this.locks.delete(op.lock);
    // A visible terminal result does not prove cancellation succeeded. Only the
    // provider promise's actual settlement releases the Agent and concurrency.
    op.controller = undefined;
    const scope = op.scope; op.scope = undefined;
    if (scope && ![...this.operations.values()].some(item => item.scope === scope && !item.settled)) {
      for (const resolve of this.idleWaiters.get(scope) || []) resolve(); this.idleWaiters.delete(scope);
    }
    this.sweep();
  }
  snapshot(op, afterSeq = 0) {
    return { operationId: op.id, capabilityId: op.capabilityId, status: op.status, seq: op.seq,
      acceptedAt: new Date(op.acceptedAt).toISOString(), gap: afterSeq < (op.events[0]?.seq ?? op.seq + 1) - 1,
      events: op.events.filter(e => e.seq > afterSeq), ...(terminal(op.status) ? { result: op.result } : {}) };
  }
  operation(state, id) {
    const op = this.operations.get(requiredString(id));
    if (!op || op.owner !== state.bridgeOwner) fail(-32047, '运行记录不存在或已过期');
    return op;
  }
  async request(method, params, state) {
    this.sweep(); jsonValue(params || {});
    if (this.disposed) fail(-32043, '插件运行时已卸载');
    if (method === 'catalog') return this.catalog();
    if (method === 'auth') {
      if (!this.endpoint || params?.instanceId !== this.endpoint.instanceId || !this.endpoint.matches(params?.bootstrapToken)) fail(-32042, '无法确认本机接入点身份');
      const owner = requiredString(params.clientId, 128);
      if (state.bridgeOwner && owner !== state.bridgeOwner) fail(-32042, '连接身份不可变更');
      state.bridgeOwner = owner; state.bridgeLease = this.now() + 900000;
      this.connections.add(state);
      return { protocolVersion: 1, expiresAt: new Date(state.bridgeLease).toISOString() };
    }
    if (!this.authorized(state)) fail(-32041, '插件操作尚未授权或授权已过期');
    if (method === 'operation/get') {
      if (params.afterSeq !== undefined && (!Number.isInteger(params.afterSeq) || params.afterSeq < 0)) fail(-32046, '事件序号无效');
      return this.snapshot(this.operation(state, params.operationId), params.afterSeq || 0);
    }
    if (method === 'cancel') {
      const op = this.operation(state, params.operationId);
      if (!terminal(op.status)) {
        if (!op.supportsCancellation) fail(-32043, '该运行不支持取消');
        op.cancelRequested = true; op.controller.abort();
      }
      return this.snapshot(op);
    }
    if (method !== 'invoke') fail(-32601, '插件操作方法不存在');
    const requestId = requiredString(params.requestId, 128);
    const key = JSON.stringify([state.bridgeOwner, requestId]);
    const fingerprint = JSON.stringify(jsonValue({ capabilityId: params.capabilityId, input: params.input, context: params.context }));
    if (this.requests.has(key)) {
      const saved = this.requests.get(key);
      if (saved.fingerprint !== fingerprint) fail(-32046, '重复请求参数不一致');
      if (!saved.promise) fail(-32047, '该请求结果已超出缓存预算；请查询已有运行记录，不要自动重试写操作');
      return saved.promise;
    }
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(fingerprint);
    if (this.requests.size >= this.limits.requests || this.requestBytes() + bytes > this.limits.requestBytes) fail(-32045, '请求缓存达到上限');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const saved = { fingerprint, promise, bytes, active: true, expires: Infinity };
    this.requests.set(key, saved);
    // Reserve the request before validation can reach provider code. Synchronous
    // registration/validation keeps auth -> invoke in one input chunk ordered.
    let execution;
    try { execution = this.invoke(params, state, saved); }
    catch (error) { this.requests.delete(key); reject(error); return promise; }
    Promise.resolve(execution).then(result => {
      saved.responseBytes = Buffer.byteLength(JSON.stringify(result)); saved.bytes += saved.responseBytes;
      resolve(result); this.sweep();
    }, error => {
      if (!saved.started) this.requests.delete(key);
      else { saved.responseBytes = 0; saved.active = false; saved.expires = this.now() + 600000; }
      reject(error);
    });
    return promise;
  }
  invoke(params, state, saved) {
    const entry = this.capabilities.get(requiredString(params.capabilityId));
    if (!entry || entry.item.availability.state !== 'available') fail(-32043, '插件能力当前不可用');
    const { item, provider } = entry;
    const input = jsonValue(params.input ?? {}); checkSchema(item.inputSchema, input);
    const context = params.context || {};
    const cwd = fs.realpathSync(absoluteCwd(context.cwd));
    if (!fs.statSync(cwd).isDirectory()) fail(-32046, '工作目录无效');
    if (item.riskTier !== 'read' && (context.workspaceTrusted !== true || context.userInitiated !== true)) fail(-32044, '该操作需要受信任工作区和显式启动');
    if (['workspace-write', 'system'].includes(item.riskTier) && context.approved !== true) fail(-32044, '该操作需要确认影响范围');
    if (item.effects.includes('workspace.read') && context.workspaceTrusted !== true) fail(-32044, '受限工作区不能读取项目内容');
    let agent;
    if (item.requiresSession) {
      agent = state.agentsBySession?.get(context.sessionId);
      if (!agent || !state.sessions.has(context.sessionId)) fail(-32046, '会话不属于当前连接');
      const agentCwd = agent.session?.header?.cwd;
      if (!agentCwd || fs.realpathSync(agentCwd) !== cwd) fail(-32046, '会话与工作目录不一致');
    }
    const controller = new AbortController();
    if (this.activeCount() >= this.limits.active || this.operations.size >= this.limits.operations) fail(-32045, '当前运行数量达到上限');
    const lock = agent ? context.sessionId : undefined;
    if (lock && (this.locks.has(lock) || agent.status === 'running')) fail(-32045, '同一会话已有运行');
    const op = { id: randomUUID(), owner: state.bridgeOwner, capabilityId: item.id, providerId: provider.id,
      kind: item.kind, requestId: params.requestId, settled: false, status: 'running', acceptedAt: this.now(), controller, lock, scope: state, supportsCancellation: item.supportsCancellation, seq: 0, events: [], bytes: 0 };
    this.operations.set(op.id, op); if (lock) this.locks.set(lock, op.id);
    saved.started = true;
    if (item.kind !== 'resource') this.emit(op, 'started');
    // 执行脱离请求流；断线不取消运行，新的已鉴权连接可查询相同身份的结果。
    const executing = Promise.resolve().then(() => {
      if (op.stopReason) fail(-32043, '提供方执行已取消');
      return provider.invoke(item.id, input, { cwd, agent, sessionId: context.sessionId,
      clientId: state.bridgeOwner, userInitiated: context.userInitiated === true, approved: context.approved === true, workspaceTrusted: context.workspaceTrusted === true, signal: controller.signal,
      emit: event => { if (!['progress', 'artifact'].includes(event?.type)) fail(-32046, '插件事件无效'); if (item.kind !== 'resource') this.emit(op, event.type, event.payload); },
      });
    }).then(result => {
      if (op.stopReason) fail(-32043, '提供方执行已取消');
      const value = jsonValue(result ?? {});
      this.finish(op, controller.signal.aborted ? 'cancelled' : 'completed', value);
      return { mode: 'immediate', value };
    }, () => {
      const status = op.stopReason && op.stopReason !== 'connection-closed' ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed';
      this.finish(op, status, { reason: op.stopReason || 'provider-failed' });
      fail(-32043, '提供方执行失败');
    }).catch(error => {
      this.finish(op, 'failed', { reason: op.stopReason || 'invalid-output' }); throw error;
    }).finally(() => {
      saved.active = false; saved.expires = this.now() + 600000; this.settle(op);
    });
    if (item.kind === 'resource') return executing;
    void executing.catch(() => {});
    return { mode: 'operation', operationId: op.id, acceptedAt: new Date(op.acceptedAt).toISOString() };
  }
  detach(state) {
    this.connections.delete(state);
    for (const op of this.operations.values()) if (op.scope === state && op.kind === 'resource' && !op.settled) {
      op.stopReason = 'connection-closed'; op.controller.abort();
    }
    void this.idle(state).then(() => state.agentsBySession?.clear());
  }
  idle(state) {
    if (![...this.operations.values()].some(op => op.scope === state && !op.settled)) return Promise.resolve();
    return new Promise(resolve => { const waiters = this.idleWaiters.get(state) || []; waiters.push(resolve); this.idleWaiters.set(state, waiters); });
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true; clearInterval(this.sweeper);
    const waiting = [...new Set([...this.operations.values()].filter(op => !op.settled).map(op => op.scope))].map(scope => this.idle(scope));
    for (const op of this.operations.values()) if (!op.settled) { op.stopReason = 'bridge-unloaded'; op.controller.abort(); }
    this.providers.clear(); this.capabilities.clear();
    this.disposal = Promise.all(waiting).then(() => {
      this.connections.clear(); this.endpoint?.dispose(); this.requests.clear(); this.operations.clear();
    });
    return this.disposal;
  }
  /** Bridge 自身的错误仅返回稳定描述，提供方原始异常和凭据不进入协议。 */
  async handle(frame, state) {
    if (frame?.id === undefined || typeof frame.method !== 'string' || !frame.method.startsWith(PREFIX)) return false;
    try { const result = await this.request(frame.method.slice(PREFIX.length), frame.params || {}, state); state.respond({ jsonrpc: '2.0', id: frame.id, result }); }
    catch (error) { state.respond({ jsonrpc: '2.0', id: frame.id, error: { code: error instanceof BridgeError ? error.code : -32046,
      message: error instanceof BridgeError ? error.message : '插件操作上下文无效' } }); }
    return true;
  }
}
