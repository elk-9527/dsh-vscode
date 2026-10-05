'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
function queryWindows(pid) {
  if (!Number.isInteger(pid) || pid < 1) return Promise.reject(new Error('内核进程编号无效'));
  return new Promise((resolve, reject) => {
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(command, ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error && !stdout.trim()) return resolve(false);
      if (error) return reject(new Error('无法查询内核进程'));
      resolve(Number(stdout.trim().replace(/^\uFEFF/, '')) === pid);
    });
  });
}
/** Windows 使用只读 PID 查询，避免旧宿主对信号探测的限制。 */
async function ensureProcessAlive(pid, { platform = process.platform, kill = (id, signal) => process.kill(id, signal), query = queryWindows } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('内核进程编号无效');
  if (platform === 'win32') { if (!await query(pid)) throw new Error('内核进程不存在'); }
  else kill(pid, 0);
}
module.exports = { ensureProcessAlive, queryWindows };
