'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ensureProcessAlive } = require('./process');
const PREFIX = 'dsh-door/bridge/';

/** Bridge 共用既有 ACP 客户端，鉴权内容不进入日志。 */
class BridgeClient extends EventEmitter {
  constructor({ client, status, clientId = randomUUID(), home, now = Date.now }) {
    super(); this.client = client; this.status = status; this.clientId = clientId; this.now = now;
    this.home = home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.expires = 0; this.authPending = undefined; this.timer = undefined; this.closed = false;
    this.onNotification = (method, params) => {
      if (method === `${PREFIX}event`) this.emit('event', params);
      if (method === `${PREFIX}catalog-changed`) this.emit('catalogChanged', params);
    };
    client.on('notification', this.onNotification);
  }
  get supported() { return this.status?.capabilities?.bridge?.protocolVersion === 1; }
  async auth(force = false) {
    if (!this.supported) throw new Error('当前连接尚未支持插件操作，请更新接入组件。');
    if (!force && this.expires > this.now() + 30000) return;
    if (this.authPending) return this.authPending;
    this.authPending = (async () => {
      if (this.closed) throw new Error('连接已关闭');
      const file = path.join(this.home, 'run', 'dsh-acp-door', `${this.client.port}.json`);
      let record;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
        if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error();
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (record.version !== 1 || record.instanceId !== this.status.instanceId || record.port !== this.client.port || !Number.isInteger(record.pid)) throw new Error();
        await ensureProcessAlive(record.pid);
      } catch {
        this.expires = 0; this.emit('authExpired');
        throw Object.assign(new Error('无法确认本机接入点身份，请重新连接或查看日志。'), { code: -32052 });
      }
      const result = await this.client.request(`${PREFIX}auth`, {
        instanceId: this.status.instanceId, bootstrapToken: record.bootstrapToken, clientId: this.clientId,
      });
      this.expires = Date.parse(result.expiresAt);
      if (this.closed) return;
      this.emit('authReady');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.auth(true).catch(() => { this.expires = 0; this.emit('authExpired'); }), 720000);
      this.timer.unref?.();
    })().finally(() => { this.authPending = undefined; });
    return this.authPending;
  }
  async catalog() {
    if (!this.supported) return { protocolVersion: 0, revision: 0, capabilities: [] };
    return this.client.request(`${PREFIX}catalog`, {});
  }
  async request(method, params) {
    await this.auth();
    try { return await this.client.request(`${PREFIX}${method}`, params); }
    catch (error) {
      // 仅鉴权失败可以续期重试；业务失败及超时不得重复启动有副作用的操作。
      if (error.code !== -32041) throw error;
      await this.auth(true);
      return this.client.request(`${PREFIX}${method}`, params);
    }
  }
  dispose() { this.closed = true; clearTimeout(this.timer); this.client.off('notification', this.onNotification); this.removeAllListeners(); }
}
module.exports = { BridgeClient, PREFIX };
