'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (file, cwd) => { const rel = path.relative(cwd, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const MAX_FILE = 256 * 1024;

/** Read editor and disk state using the caller's verified workspace scope. */
async function readFileState(vscode, file, cwd, guard) {
    guard();
    const base = await fs.realpath(cwd);
    try {
      const target = await fs.realpath(file);
      if (!inside(target, base)) throw new Error('文件链接指向工作区外部。');
      const stat = await fs.lstat(target, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) return null;
      const handle = await fs.open(target, 'r'); let disk;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_FILE) throw new Error('文件身份已变化。');
        disk = await handle.readFile();
      } finally { await handle.close(); }
      if (disk.length > MAX_FILE || disk.includes(0)) return null;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(disk);
      const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      const document = (vscode.workspace.textDocuments || []).find(doc => doc.uri.scheme === 'file' && identity(doc.uri.fsPath) === identity(file));
      const current = document?.isDirty ? document.getText() : text;
      if (Buffer.byteLength(current) > MAX_FILE || current.includes('\0')) return null;
      if (await fs.realpath(file) !== target || await fs.realpath(cwd) !== base || !inside(await fs.realpath(target), base)) throw new Error('文件位置已变化。');
      guard();
      return { text: current, disk: digest(disk), dirty: Boolean(document?.isDirty), version: document?.version, bytes: Buffer.byteLength(current) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        let parent = path.dirname(file);
        while (inside(parent, cwd)) {
          try { if (!inside(await fs.realpath(parent), base)) throw new Error('文件父目录指向工作区外部。'); return undefined; }
          catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
          const next = path.dirname(parent); if (next === parent) break; parent = next;
        }
        throw new Error('文件位置已失效。');
      }
      throw error;
    }
  }

module.exports = { readFileState, inside };
