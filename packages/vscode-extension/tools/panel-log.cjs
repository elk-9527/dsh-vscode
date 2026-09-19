#!/usr/bin/env node
/*
 * 把面板自己的日志（VS Code 的「输出 → DSH Panel」）翻出来看一眼。
 *
 * 为什么单独做一个工具：这个项目里已经吃过两次"面板说的原因跟真因无关"的亏 ——
 * 因为内核的原话被我们扔了。现在内核的 stdout/stderr 会原样转进这条日志，
 * 所以**出问题时的第一现场就是这个文件**，而它埋在 VS Code 的日志目录深处
 * （`%APPDATA%\Code\logs\<时间戳>\window*\exthost\output_logging_*\N-DSH Panel.log`）。
 *
 * 用法：
 *   node tools/panel-log.cjs                # 最新那条，看最后 60 行
 *   node tools/panel-log.cjs --all          # 最新那条，整份
 *   node tools/panel-log.cjs --grep 内核     # 只看匹配的行（可多次给）
 *   node tools/panel-log.cjs --list         # 列出所有窗口的面板日志
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const all = args.includes('--all');
const list = args.includes('--list');
const tailCount = Number(take('--tail', '60'));
const greps = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--grep' && args[i + 1]) greps.push(new RegExp(args[i + 1], 'i'));
}

/** VS Code 的日志根目录（稳定版/预览版都看一眼）。 */
function logRoots() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(roaming, 'Code', 'logs'),
    path.join(roaming, 'Code - Insiders', 'logs'),
    path.join(roaming, 'VSCodium', 'logs'),
  ].filter((dir) => fs.existsSync(dir));
}

/** 按修改时间倒序列出所有面板日志。 */
function panelLogs() {
  const found = [];
  for (const root of logRoots()) {
    for (const day of fs.readdirSync(root)) {
      const dayDir = path.join(root, day);
      let windows;
      try { windows = fs.readdirSync(dayDir); } catch { continue; }
      for (const win of windows) {
        const exthost = path.join(dayDir, win, 'exthost');
        let entries;
        try { entries = fs.readdirSync(exthost); } catch { continue; }
        for (const entry of entries) {
          if (!/^output_logging_/.test(entry)) continue;
          const dir = path.join(exthost, entry);
          for (const file of fs.readdirSync(dir)) {
            if (!/DSH Panel\.log$/.test(file)) continue;
            const full = path.join(dir, file);
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            found.push({ file: full, at: stat.mtimeMs, size: stat.size, window: `${day}/${win}` });
          }
        }
      }
    }
  }
  return found.sort((a, b) => b.at - a.at);
}

const logs = panelLogs();
if (logs.length === 0) {
  console.log('没找到面板日志。要么还没在这个 VS Code 里打开过面板，要么日志被清过了。');
  console.log('（日志位置：%APPDATA%\\Code\\logs\\<日期>\\window*\\exthost\\output_logging_*\\*-DSH Panel.log）');
  process.exit(0);
}

if (list) {
  for (const item of logs) {
    console.log(`  ${new Date(item.at).toLocaleString()}  ${String(item.size).padStart(7)} 字节  ${item.file}`);
  }
  process.exit(0);
}

const newest = logs[0];
console.log(`最新的一条面板日志（${new Date(newest.at).toLocaleString()}，${newest.size} 字节）：`);
console.log(`  ${newest.file}`);
console.log('');

let text = '';
try {
  text = fs.readFileSync(newest.file, 'utf8');
} catch (error) {
  console.log(`读不了：${error.message}`);
  process.exit(1);
}

let lines = text.split(/\r?\n/);
if (greps.length > 0) {
  lines = lines.filter((line) => greps.some((re) => re.test(line)));
  console.log(`匹配 ${greps.map((re) => re.source).join(' / ')} 的行：${lines.length} 行`);
} else if (!all) {
  lines = lines.slice(-tailCount);
  console.log(`最后 ${lines.length} 行（--all 看整份）：`);
} else {
  console.log(`整份 ${lines.length} 行：`);
}
console.log('');
for (const line of lines) console.log(line);
