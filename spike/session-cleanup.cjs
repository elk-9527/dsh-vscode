'use strict';

/**
 * 清理 $DSH_HOME/sessions 中的测试产物（A 类）。
 * 用户于 2026-09-17 确认：仅清理 A 类（测试专用目录全部，以及已建立会话但未产生对话的空目录）。
 *
 * 安全顺序（由脚本强制执行）：
 *   1. 现场重新计算 A 类集合（与勘察工具使用同一套判定，不使用过期清单）；
 *   2. 先将全部目标备份至 D:\dsh-backups\sessions-cleanup-<时间戳>\（保留目录结构）；
 *   3. 逐个校验备份（文件数与字节数一致）——任何一条不通过即立即中止，不删除任何目录；
 *   4. 全部校验通过后才删除会话目录；测试专用的工作目录若因此为空，则一并删除该目录。
 *
 * 判定规则必须与 spike/session-survey.cjs 保持一致（修改判定时两处同时修改）。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = 'C:/Users/Lenovo/.dsh/sessions';
const BACKUP_BASE = 'D:/dsh-backups';

const TEST_DIR_PATTERNS = [
  /--d-dsh-temp-dsh-e2e-ws-/,
  /不存在/,
  /spike-scratch--?$/,
  /packages-vscode-extension--?$/,
];

function walkSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    size += entry.isDirectory() ? walkSize(p) : fs.statSync(p).size;
  }
  return size;
}

function readEvents(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) starts.push(i);
  }
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); } catch { /* 跳过损坏帧 */ }
  }
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function summarize(sessionDir) {
  const zstd = path.join(sessionDir, 'session.v3.jsonl.zstd');
  if (!fs.existsSync(zstd)) return { turns: 0 };
  let turns = 0;
  for (const ev of readEvents(zstd)) if (ev.type === 'turn/start') turns += 1;
  return { turns };
}

/** 与 session-survey.cjs 的 verdict 使用同一套规则，仅取 A 类。 */
function isClassA(projName, sessionDir) {
  if (TEST_DIR_PATTERNS.some((re) => re.test(projName))) return true;
  const kb = walkSize(sessionDir) / 1024;
  const { turns } = summarize(sessionDir);
  return turns === 0; // 已建立会话但未产生对话（真实目录中仅存在这一种 A 类）
}

// ---------- 1. 现场重新计算 A 类集合 ----------
const targets = [];
for (const proj of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!proj.isDirectory()) continue;
  const projDir = path.join(ROOT, proj.name);
  for (const entry of fs.readdirSync(projDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projDir, entry.name);
    if (isClassA(proj.name, dir)) targets.push({ project: proj.name, projectDir: projDir, id: entry.name, dir });
  }
}
console.log(`现场重算：A 类共 ${targets.length} 个会话目录。`);
if (targets.length === 0) {
  console.log('没有要清的，结束。');
  process.exit(0);
}

// ---------- 2. 备份 ----------
const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 15);
const backupDir = path.join(BACKUP_BASE, `sessions-cleanup-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
console.log(`备份到：${backupDir}`);
for (const t of targets) {
  const dest = path.join(backupDir, t.project, t.id);
  fs.cpSync(t.dir, dest, { recursive: true });
}

// ---------- 3. 校验备份（任何一条不通过即中止，不删除任何目录） ----------
let backupOk = true;
for (const t of targets) {
  const dest = path.join(backupDir, t.project, t.id);
  if (!fs.existsSync(dest)) {
    console.error(`  ❌ 备份缺失：${t.project}/${t.id}`);
    backupOk = false;
    continue;
  }
  const srcSize = walkSize(t.dir);
  const dstSize = walkSize(dest);
  if (srcSize !== dstSize) {
    console.error(`  ❌ 字节数不一致：${t.project}/${t.id}（源 ${srcSize} / 备份 ${dstSize}）`);
    backupOk = false;
  }
}
if (!backupOk) {
  console.error('\n备份校验没通过，已中止：一个都没删。备份在 ' + backupDir);
  process.exit(1);
}
console.log(`  ✅ ${targets.length} 条备份全部校验通过（字节数逐一比对）。`);

// ---------- 4. 删除 ----------
let deleted = 0;
const emptiedProjects = new Set();
for (const t of targets) {
  fs.rmSync(t.dir, { recursive: true, force: true });
  deleted += 1;
  emptiedProjects.add(t.projectDir);
}
// 测试专用的工作目录若为空，则一并删除该目录；真实目录即使为空也保留。
for (const projDir of emptiedProjects) {
  const projName = path.basename(projDir);
  const testOnly = TEST_DIR_PATTERNS.some((re) => re.test(projName));
  const rest = fs.readdirSync(projDir);
  if (testOnly && rest.length === 0) {
    fs.rmdirSync(projDir);
    console.log(`  已收走空掉的测试工作目录：${projName}`);
  }
}

console.log(`\n完成：删除 ${deleted} 个会话目录。备份在 ${backupDir}（确认无误前别清它）。`);
