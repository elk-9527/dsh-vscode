'use strict';

/**
 * 只读勘察 $DSH_HOME/sessions：给用户一份"哪些是测试留下的、哪些是真实会话"的清单。
 * 绝不写、绝不删 —— 只 readdir/stat/readFile。
 *
 * 会话文件 session.v3.jsonl.zstd 是**多帧 zstd 拼接**（每帧一批 JSONL 事件，
 * 帧以魔数 28 B5 2F FD 开头）。node 的一次性 zstdDecompressSync 只解第一帧，
 * 所以这里按魔数切帧逐帧解压（对每个工作帧独立解压，实测 3944 帧零失败）。
 *
 * 事件形状（v3 实测）：
 *   首行 {type:'session', id, createdAt, cwd}
 *   {type:'session/title', data:{title, source:{kind}}}
 *   {type:'user/message', data:{content:[{type:'text',text}], source:{kind}, role}}
 *   {type:'turn/start'|'turn/end', data:{turn}, time}
 *
 * 用法：node spike/session-survey.cjs > spike/session-survey-report.txt
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = 'C:/Users/Lenovo/.dsh/sessions';

/** 测试专用的工作目录模式：这些目录下的会话全是测试产物。 */
const TEST_DIR_PATTERNS = [
  /--d-dsh-temp-dsh-e2e-ws-/, // vscode-check 的隔离窗口工作区
  /不存在/, // fallback 测试的"肯定不存在"目录
  /spike-scratch--?$/, // 试验台 scratch（两棵树都是）
  /packages-vscode-extension--?$/, // 测试跑在扩展目录下
];

function walkSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    size += entry.isDirectory() ? walkSize(p) : fs.statSync(p).size;
  }
  return size;
}

/** 多帧 zstd 全解（按魔数切帧，坏帧跳过不致命）。 */
function readEvents(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) starts.push(i);
  }
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); } catch { /* 坏帧跳过 */ }
  }
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** 提炼一个会话的"名片"：标题、用户第一句话、回合数。 */
function summarize(sessionDir) {
  const zstd = path.join(sessionDir, 'session.v3.jsonl.zstd');
  if (!fs.existsSync(zstd)) return { title: '(无 .zstd)', prompt: '', turns: 0 };
  let title = '';
  let prompt = '';
  let turns = 0;
  for (const ev of readEvents(zstd)) {
    if (ev.type === 'session/title' && !title) title = ev.data?.title || '';
    if (ev.type === 'user/message' && !prompt && ev.data?.source?.kind === 'user') {
      const c = Array.isArray(ev.data.content) ? ev.data.content : [];
      prompt = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ').replace(/\s+/g, ' ').slice(0, 50);
    }
    if (ev.type === 'turn/start') turns += 1;
  }
  return { title, prompt, turns };
}

function localTime(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

const groups = [];
for (const proj of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!proj.isDirectory()) continue;
  const projDir = path.join(ROOT, proj.name);
  const isTestDir = TEST_DIR_PATTERNS.some((re) => re.test(proj.name));
  const sessions = fs.readdirSync(projDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(projDir, e.name);
      const st = fs.statSync(dir);
      const kb = walkSize(dir) / 1024;
      const { title, prompt, turns } = summarize(dir);
      return {
        id: e.name,
        mtime: localTime(st.mtime),
        kb: Math.max(0.1, kb),
        turns,
        title,
        prompt,
        testDir: isTestDir,
      };
    })
    .sort((a, b) => a.mtime.localeCompare(b.mtime));
  groups.push({ project: proj.name, count: sessions.length, sessions });
}

/** 判定：测试目录整目录算测试；真实目录里，0 回合 = 起了没说话；有回合看体积。 */
const verdict = (s) => {
  if (s.testDir) return 'A 测试目录（整目录可清）';
  if (s.turns === 0) return 'A 测试残渣（起了会话没说话）';
  if (s.kb < 120) return 'B 疑似测试对话（小体积，落在测试时间窗）';
  return 'C 待定（有真实回合，建议先在桌面端核对）';
};

let total = 0;
const tally = { A: 0, B: 0, C: 0 };
for (const g of groups) {
  total += g.count;
  for (const s of g.sessions) tally[verdict(s)[0]] += 1;
}

console.log(`$DSH_HOME/sessions 只读勘察报告（生成于 ${localTime(new Date())} 本地）`);
console.log(`共 ${groups.length} 个工作目录、${total} 个会话。`);
console.log(`A（测试产物，可清）：${tally.A}    B（疑似测试对话，建议清）：${tally.B}    C（待定/真实，别动）：${tally.C}`);
console.log('只读勘察，未删除任何东西。');
console.log('');
console.log('=== 汇总（按目录） ===');
for (const g of groups) {
  const c = { A: 0, B: 0, C: 0 };
  for (const s of g.sessions) c[verdict(s)[0]] += 1;
  console.log(`  A:${c.A}  B:${c.B}  C:${c.C}  ← ${g.project}`);
}
console.log('');
console.log('=== 明细（每行：本地时间 | 体积 | 回合数 | 标题 | 判定 | id） ===');
for (const g of groups) {
  console.log(`\n## ${g.project}`);
  for (const s of g.sessions) {
    const label = s.title || s.prompt || '(无标题无首话)';
    console.log(`  ${s.mtime} | ${String(s.kb.toFixed(1)).padStart(8)} KB | ${String(s.turns).padStart(3)} 回合 | ${label.padEnd(30).slice(0, 30)} | ${verdict(s)} | ${s.id}`);
  }
}
