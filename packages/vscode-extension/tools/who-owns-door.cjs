'use strict';
// 判定 47821 端口上的 ACP 接入点插件（`dsh-acp-door`）由谁启动：桌面端自身的内核，或测试遗留的孤儿进程。
//
// 设置该工具的原因：面板有两种连接方式 —— 「接入已在运行的该插件」与「自行启动一个内核」。
// 排查"未连接成功""是否多启动了一个内核"时，优先确认该端口的归属。
//
// 用法：node tools/who-owns-door.cjs
// 只读：仅查询进程与端口，不终止任何进程。
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
  console.log(`${PORT} 上没有进程在监听（该插件未启动）。`);
  console.log('面板这时会走后备路径：自行启动一个后台内核。');
  process.exit(0);
}

for (const pid of listeners) {
  let info = ps(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      `"PID=$($p.ProcessId)"; "NAME=$($p.Name)"; "CMD=$($p.CommandLine)"; "PPID=$($p.ParentProcessId)"`,
  );
  // 向上追溯四层祖先进程，判断是否由 DSH Desktop.exe 启动。
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
