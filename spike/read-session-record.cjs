'use strict';

/**
 * 一次性探针：看看内核的会话记录能不能解开、里面记的 preset 是什么。
 *
 * 为什么要看它：预设这件事是门替内核接出来的，门自己的日志只能证明
 * 「它调了 select()」，而**内核自己记下来的**才是独立证据。
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

/** 递归找所有 .zstd（真实形状是 sessions/<项目目录>/<会话id>/session.v3.jsonl.zstd）。 */
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
