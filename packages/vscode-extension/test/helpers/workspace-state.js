'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** A workspace-scoped Memento whose update resolves only after file persistence. */
function createWorkspaceState(file) {
  let entries = new Map();
  try {
    entries = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let writes = Promise.resolve();
  return {
    get(key, fallback) {
      return entries.has(key) ? structuredClone(entries.get(key)) : fallback;
    },
    keys() { return [...entries.keys()]; },
    update(key, value) {
      const snapshot = value === undefined ? undefined : structuredClone(value);
      writes = writes.catch(() => {}).then(async () => {
        const next = new Map(entries);
        if (snapshot === undefined) next.delete(key);
        else next.set(key, snapshot);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        await fs.promises.writeFile(temporary, JSON.stringify(Object.fromEntries(next)), 'utf8');
        await fs.promises.rename(temporary, file);
        entries = next;
      });
      return writes;
    },
  };
}

module.exports = { createWorkspaceState };
