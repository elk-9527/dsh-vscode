'use strict';

/**
 * 会话记录中写入 agentPreset 的时机：
 * 扫描全部记录，按「是否包含 agentPreset」分类统计，并对比若干具体会话。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');

function eachRecord(visit) {
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const file = path.join(projectDir, session.name, 'session.v3.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      visit({ id: session.name, project: project.name, file });
    }
  }
}

const stats = { total: 0, withPreset: 0, withoutPreset: 0, unreadable: 0 };
const samples = [];
eachRecord(({ id, project, file }) => {
  stats.total += 1;
  let text;
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
  } catch {
    stats.unreadable += 1;
    return;
  }
  const hit = text.match(/"agentPreset":"([^"]*)"/);
  if (hit) {
    stats.withPreset += 1;
    if (samples.length < 8) samples.push(`${id}  预设=${hit[1]}  行数=${text.split('\n').filter(Boolean).length}  项目=${project}`);
  } else {
    stats.withoutPreset += 1;
  }
});

console.log('会话记录统计：', JSON.stringify(stats));
console.log('有 agentPreset 的样本：');
for (const line of samples) console.log('  ' + line);

console.log('\n被问到的那几个：');
for (const id of process.argv.slice(2)) {
  eachRecord((item) => {
    if (item.id !== id) return;
    const text = zlib.zstdDecompressSync(fs.readFileSync(item.file)).toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    const hit = text.match(/"agentPreset":"([^"]*)"/);
    console.log(`  ${id}: ${lines.length} 行, agentPreset=${hit ? hit[1] : '（没有）'}`);
    console.log(`    第一行: ${lines[0].slice(0, 220)}`);
    if (lines.length > 1) console.log(`    第二行: ${lines[1].slice(0, 220)}`);
  });
}
