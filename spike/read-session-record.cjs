'use strict';

/**
 * 一次性探针：检查内核的会话记录能否解压，以及其中记录的 preset 取值。
 *
 * 检查该记录的原因：预设由 ACP 接入点插件（`dsh-acp-door`）代为内核设置，
 * 该插件自身的日志只能证明「它调用了 select()」，而**内核自身记录的**内容才是独立证据。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

console.log('node', process.version);
console.log('zstdDecompressSync:', typeof zlib.zstdDecompressSync);

const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
const entries = fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory());
console.log('第一层目录：', entries.map((item) => item.name).join(', '));

/** 递归查找所有 .zstd 文件（实际结构为 sessions/<项目目录>/<会话id>/session.v3.jsonl.zstd）。 */
function findAll(dir, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...findAll(full, depth + 1));
    else if (item.name.endsWith('.zstd')) {
      const stat = fs.statSync(full);
      out.push({ full, size: stat.size, mtime: stat.mtimeMs, id: path.basename(path.dirname(full)) });
    }
  }
  return out;
}
const recent = findAll(root);
console.log('会话记录文件数：', recent.length);
recent.sort((a, b) => b.mtime - a.mtime);
console.log('最近 5 个会话记录：');
for (const item of recent.slice(0, 5)) {
  console.log(`  ${item.id}  ${item.size} 字节  ${new Date(item.mtime).toISOString()}`);
}

if (typeof zlib.zstdDecompressSync !== 'function') {
  console.log('\n这个 Node 解不了 zstd —— 换个办法看（例如内核自己的 session 读取接口）。');
  process.exit(0);
}

const newest = recent[0];
const text = zlib.zstdDecompressSync(fs.readFileSync(newest.full)).toString('utf8');
console.log(`\n解开最新那个：${text.length} 字节`);
const lines = text.split('\n').filter(Boolean);
console.log(`JSONL 行数：${lines.length}`);
const hits = lines.filter((line) => /preset/i.test(line));
console.log(`提到 preset 的行：${hits.length}`);
for (const line of hits.slice(0, 4)) {
  console.log('  ' + line.slice(0, 300));
}
