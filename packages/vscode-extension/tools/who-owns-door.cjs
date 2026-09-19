'use strict';
// 47821 上那个门到底是谁开的？桌面端自己的内核，还是测试留下的孤儿？
//
// 为什么需要它：面板有两条路 —— 「接入正在跑的门」和「自己拉一个内核」。
// 排查"为什么没连上""是不是多起了一个内核"时，先看这个端口归谁。
//
// 用法：node tools/who-owns-door.cjs
// 只读：只查进程和端口，不杀任何东西。
const { execFileSync } = require('node:child_process');

const PORT = Number(process.env.DSH_PANEL_PORT || 47821);

function ps(script) {
  return execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
}

const listeners = ps(
  `Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | ` +
    'Select-Object -ExpandProperty OwningProcess -Unique',
)
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

if (listeners.length === 0) {
  console.log(`${PORT} 上没有人在监听（门没开）。`);
  console.log('面板这时会走"兜底"：自己拉起一个后台内核。');
  process.exit(0);
}

for (const pid of listeners) {
  let info = ps(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      `"PID=$($p.ProcessId)"; "NAME=$($p.Name)"; "CMD=$($p.CommandLine)"; "PPID=$($p.ParentProcessId)"`,
  );
  // 往上追四层祖先，看是不是 DSH Desktop.exe 拉起来的。
  const ppid = (/PPID=(\d+)/.exec(info) || [])[1];
  let chain = [];
  let cur = ppid;
  for (let i = 0; i < 4 && cur && cur !== '0'; i += 1) {
    const up = ps(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${cur}"; ` +
        `if ($p) { "$($p.ProcessId)|$($p.Name)|$($p.CommandLine)" } else { "GONE" }`,
    ).trim();
    if (up === 'GONE' || !up.includes('|')) break;
    const [id, name, cmd] = up.split('|');
    chain.push(`      ← ${id} ${name}  ${String(cmd).slice(0, 120)}`);
    const nextPpid = ps(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${id}"; if ($p) { $p.ParentProcessId } else { 0 }`,
    ).trim();
    cur = nextPpid;
  }
  console.log(info.trim().split('\n').map((l) => '  ' + l.trim()).join('\n'));
  console.log('    祖先进程链（从父到祖父）：');
  console.log(chain.join('\n') || '      （追不到）');
  console.log('');
}
