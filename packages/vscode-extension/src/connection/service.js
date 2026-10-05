'use strict';
const { EventEmitter } = require('node:events');
const { DoorClient } = require('../door/client');
const { DshSession } = require('../dsh/session');
const { BridgeClient } = require('../bridge/client');
const { randomUUID } = require('node:crypto');

/** 扩展级连接所有权；视图只持有引用，不自行创建 socket。 */
class DshConnectionService extends EventEmitter {
  constructor({ log = () => {}, clientId = randomUUID(), makeClient = options => new DoorClient(options) } = {}) {
    super(); this.log = log; this.clientId = clientId; this.makeClient = makeClient;
    this.client = undefined; this.pending = undefined; this.bridge = undefined; this.sessions = new Map();
    this.consumers = new Set(); this.closed = false; this.driver = undefined; this.state = { state: 'disconnected' };
  }
  emit(name, ...args) {
    if (name === 'state') this.state = { ...args[0] };
    return super.emit(name, ...args);
  }
  snapshot() {
    const entry = this.currentEntry?.();
    const owned = entry && entry.key === this.key;
    return { connected: Boolean(this.client?.isConnected), host: this.client?.host, port: this.client?.port,
      instanceId: this.client?.isConnected ? this.status?.instanceId : undefined,
      version: this.client?.isConnected ? this.status?.version : undefined,
      supported: Boolean(this.client?.isConnected && this.bridge?.supported),
      authorized: Boolean(this.client?.isConnected && this.bridge?.expires > Date.now()),
      profile: owned ? entry.profile : undefined, state: this.state.state };
  }
  async connect({ host, port }) {
    if (this.closed) throw new Error('连接服务已关闭');
    const key = `${host}:${port}`;
    if (this.client && this.key === key && this.client.isConnected) return this.client;
    if (this.pending) { await this.pending; if (this.key === key && this.client?.isConnected) return this.client; }
    this.disconnect(); this.key = key; this.emit('state', { state: 'connecting', host, port });
    this.pending = (async () => {
      const client = this.makeClient({ host, port, log: this.log });
      try { await client.connect(); } catch (error) { client.close(); this.emit('state', { state: 'error' }); throw error; }
      if (this.closed) { client.close(); throw new Error('连接服务已关闭'); }
      this.client = client;
      client.once('close', () => {
        if (this.client !== client) return;
        this.bridge?.dispose(); this.bridge = undefined; this.client = undefined;
        for (const session of this.sessions.values()) session.dispose(); this.sessions.clear();
        this.emit('state', { state: 'disconnected' });
      });
      this.emit('state', { state: 'connected', host, port });
      return client;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  setStatus(status) {
    this.status = status; this.bridge?.dispose();
    this.bridge = new BridgeClient({ client: this.client, status, clientId: this.clientId });
    this.bridge.on('event', event => this.emit('operation', event));
    this.bridge.on('catalogChanged', () => this.emit('catalogChanged'));
    this.bridge.on('authExpired', () => this.emit('state', { state: 'authorization-expired' }));
    this.bridge.on('authReady', () => this.emit('state', { state: 'ready' }));
    this.emit('state', { state: 'ready' });
  }
  bindKernels(kernels, currentEntry) { this.kernels = kernels; this.currentEntry = currentEntry; }
  syncKernel() {
    if (!this.kernels) return;
    const entry = this.currentEntry?.();
    if (this.consumers.size > 0 && entry) this.kernels.acquire(this, entry);
    else this.kernels.release(this);
  }
  acquire(id) { this.consumers.add(id); this.syncKernel(); return { dispose: () => this.release(id) }; }
  release(id) { this.consumers.delete(id); this.syncKernel(); this.emit('consumers', this.consumers.size); }
  async ensure() {
    if (!this.client?.isConnected) await this.driver?.();
    if (!this.client?.isConnected) throw new Error('无法连接，请检查连接状态或查看日志。');
    return this.client;
  }
  setSession(surfaceId, session) { this.sessions.set(surfaceId, session); }
  async sessionFor(surfaceId, cwd, options = {}) {
    await this.ensure();
    const existing = this.sessions.get(surfaceId);
    if (existing?.cwd === cwd && existing.sessionId) return existing;
    if (existing) { if (existing.sessionId) await this.client.closeSession(existing.sessionId); existing.dispose(); }
    const session = new DshSession({ client: this.client, log: this.log });
    try { await session.start({ cwd, ...options }); session.cwd = cwd; this.sessions.set(surfaceId, session); return session; }
    catch (error) { session.dispose(); throw error; }
  }
  disconnect() {
    this.bridge?.dispose(); this.bridge = undefined;
    this.status = undefined;
    for (const session of this.sessions.values()) session.dispose(); this.sessions.clear();
    const client = this.client; this.client = undefined; if (client) client.close();
    this.emit('state', { state: 'disconnected' });
  }
  dispose() { this.closed = true; this.disconnect(); this.consumers.clear(); this.syncKernel(); this.removeAllListeners(); }
}
module.exports = { DshConnectionService };
