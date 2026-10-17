'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
function queryWindows(pid) {
  if (!Number.isInteger(pid) || pid < 1) return Promise.reject(new Error('内核进程编号无效'));
  return new Promise((resolve, reject) => {
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(command, ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error?.killed) return reject(new Error('查询内核进程超时'));
      if (error && !stdout.trim()) return resolve(false);
      if (error) return reject(new Error('无法查询内核进程'));
      resolve(Number(stdout.trim().replace(/^\uFEFF/, '')) === pid);
    });
  });
}
/** Signal zero only probes existence; restricted Windows hosts use a read-only query. */
async function ensureProcessAlive(pid, { platform = process.platform, kill = (id, signal) => process.kill(id, signal), query = queryWindows } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('内核进程编号无效');
  if (platform !== 'win32') return void kill(pid, 0);
  try { kill(pid, 0); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    if (!await query(pid)) throw new Error('内核进程不存在');
  }
}
module.exports = { ensureProcessAlive, queryWindows };
