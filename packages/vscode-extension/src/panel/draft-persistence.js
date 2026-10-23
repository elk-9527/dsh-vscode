'use strict';
const { draftKey } = require('./drafts');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); void promise.catch(() => {}); return { promise, resolve, reject }; };

/** Latest draft stays in memory immediately; one pending write per directory. */
class DraftPersistence {
  constructor(storage, { delayMs = 150, onError = () => {} } = {}) {
    this.storage = storage; this.delayMs = delayMs; this.onError = onError;
    this.values = new Map(); this.pending = new Map(); this.timers = new Map(); this.ready = new Set();
    this.writes = 0; this.maxPending = 0;
  }
  read(cwd) { const key = draftKey(cwd); return this.values.has(key) ? this.values.get(key) : this.storage?.get(key); }
  set(draft) {
    const key = draftKey(draft.cwd), value = structuredClone(draft); this.values.set(key, value);
    let held = this.pending.get(key);
    if (held) held.value = value;
    else { held = { value, ...deferred() }; this.pending.set(key, held); }
    this.maxPending = Math.max(this.maxPending, this.pending.size);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.flush(draft.cwd).catch(this.onError); }, this.delayMs));
    return held.promise;
  }
  flush(cwd) {
    const keys = cwd === undefined ? [...this.pending.keys()] : [draftKey(cwd)];
    for (const key of keys) { clearTimeout(this.timers.get(key)); this.timers.delete(key); if (this.pending.has(key)) this.ready.add(key); }
    // A saved revision's promise can enqueue another revision before the old
    // drain's finally runs. Recheck after that drain instead of losing a flush
    // whose timer has already been cleared.
    if (this.running) return this.running.then(() => this.flush(cwd), () => this.flush(cwd));
    if (!this.ready.size) return Promise.resolve();
    this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }
  async drain() {
    let failure;
    while (this.ready.size) {
      const key = this.ready.values().next().value; this.ready.delete(key);
      const held = this.pending.get(key); if (!held) continue;
      this.pending.delete(key);
      try { this.writes++; await this.storage.update(key, held.value); held.resolve(); }
      catch (error) { held.reject(error); failure ||= error; if (!this.pending.has(key)) this.pending.set(key, { value: held.value, ...deferred() }); }
    }
    if (failure) throw failure;
  }
}
module.exports = { DraftPersistence };
