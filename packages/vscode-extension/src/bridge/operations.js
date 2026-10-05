'use strict';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unrecoverable']);
const ACTIVE = new Set(['running', 'cancelling', 'pending-restore']);
const LABELS = { running: '进行中', cancelling: '正在取消', 'pending-restore': '等待恢复连接', completed: '已完成', failed: '失败', cancelled: '已取消', unrecoverable: '无法恢复' };
const REASONS = { 'provider-unloaded': '提供方已卸载，本次运行已结束', 'provider-failed': '提供方执行失败', 'invalid-output': '提供方返回的结果格式无效', 'bridge-unloaded': '接入点已卸载，本次运行已结束' };
/** 只保存当前工作区的运行元数据；完整报告和自定义要求不写入持久状态。 */
class OperationStore extends Map {
  constructor({ records = [], deleted = [], limit = 100, onRemove = () => {} } = {}) {
    super(); this.deleted = new Set(deleted.filter(x => typeof x === 'string').slice(-1000)); this.limit = limit; this.onRemove = onRemove;
    for (const record of records) if (record && typeof record.id === 'string' && !this.deleted.has(record.id)) {
      super.set(record.id, { ...record, status: ACTIVE.has(record.status) ? 'pending-restore' : TERMINAL.has(record.status) ? record.status : 'unrecoverable' });
    }
    this.compact();
  }
  set(id, record) { if (!this.deleted.has(id)) super.set(id, record); return this; }
  event(event) {
    if (!event || typeof event.operationId !== 'string' || !Number.isInteger(event.seq) || event.seq < 1 || this.deleted.has(event.operationId)) return false;
    if (!['started', 'progress', 'artifact', 'completed', 'failed', 'cancelled'].includes(event.type)) return false;
    const op = this.get(event.operationId) || { id: event.operationId, status: 'running', seq: 0 };
    if (event.seq <= (op.seq || 0) || TERMINAL.has(op.status)) return false;
    op.seq = event.seq; op.updatedAt = event.at || new Date().toISOString();
    op.startedAt ||= op.updatedAt;
    if (TERMINAL.has(event.type)) { op.status = event.type; op.finishedAt = op.updatedAt; op.result = event.payload; op.reason = REASONS[event.payload?.reason]; }
    else if (op.status !== 'cancelling') op.status = 'running';
    super.set(op.id, op); this.compact(); return true;
  }
  snapshot(id, snapshot) {
    const op = this.get(id);
    if (!op || !Number.isInteger(snapshot?.seq) || snapshot.seq < (op.seq || 0) || !['running', 'completed', 'failed', 'cancelled'].includes(snapshot.status)) return op;
    if (TERMINAL.has(op.status) && op.status !== snapshot.status) return op;
    op.seq = snapshot.seq; op.startedAt ||= snapshot.acceptedAt;
    const last = snapshot.events?.[snapshot.events.length - 1];
    op.updatedAt = last?.at || op.updatedAt || snapshot.acceptedAt;
    if (op.status !== 'cancelling' || snapshot.status !== 'running') op.status = snapshot.status;
    if (TERMINAL.has(op.status)) { op.finishedAt ||= op.updatedAt || new Date().toISOString(); if (snapshot.result !== undefined) { op.result = snapshot.result; op.reason = REASONS[snapshot.result?.reason]; } }
    this.compact(); return op;
  }
  unavailable(id, reason) {
    const op = this.get(id); if (!op || TERMINAL.has(op.status)) return;
    op.status = 'unrecoverable'; op.reason = reason; op.finishedAt = new Date().toISOString(); this.compact();
  }
  remove(id) {
    const op = this.get(id); if (!op || !TERMINAL.has(op.status)) return false;
    super.delete(id); this.deleted.add(id); this.onRemove(op);
    while (this.deleted.size > 1000) this.deleted.delete(this.deleted.values().next().value);
    return true;
  }
  clearFinished() { let count = 0; for (const [id, op] of this) if (TERMINAL.has(op.status) && this.remove(id)) count++; return count; }
  compact() {
    const finished = [...this.values()].filter(op => TERMINAL.has(op.status)).sort((a, b) => (Date.parse(a.finishedAt) || 0) - (Date.parse(b.finishedAt) || 0));
    for (const op of finished.slice(0, Math.max(0, finished.length - this.limit))) this.remove(op.id);
  }
  serialize() {
    this.compact();
    return { deleted: [...this.deleted], records: [...this.values()].map(op => ({
      id: op.id, title: op.title, status: op.status, seq: op.seq, cwd: op.cwd, fingerprint: op.fingerprint,
      instanceId: op.instanceId, clientId: op.clientId, retryOf: op.retryOf, startedAt: op.startedAt, updatedAt: op.updatedAt, finishedAt: op.finishedAt, reason: op.reason,
      input: op.input && ['worktree', 'base', 'commit', 'custom'].includes(op.input.mode) ? { mode: op.input.mode, ...(typeof op.input.ref === 'string' ? { ref: op.input.ref } : {}) } : undefined,
    })) };
  }
}
module.exports = { OperationStore, ACTIVE, TERMINAL, LABELS };
