import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Windows 上移除文件继承，并把凭据文件权限限定为当前账户及系统账户。 */
function protect(file) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return; }
  const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[\d-]+/)?.[0];
  if (!sid) throw new Error('无法确定当前账户的凭据文件权限');
  execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], { windowsHide: true, stdio: 'pipe' });
}
export function createEndpoint(port, home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const directory = path.join(home, 'run', 'dsh-acp-door');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${port}.json`);
  const temporary = path.join(directory, `.${port}-${randomUUID()}.tmp`);
  const record = { version: 1, instanceId: randomUUID(), port, pid: process.pid,
    startedAt: new Date().toISOString(), bootstrapToken: randomBytes(32).toString('hex') };
  try {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('凭据文件路径无效');
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    protect(temporary);
    fs.renameSync(temporary, file);
  } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  return {
    instanceId: record.instanceId,
    matches(token) {
      if (typeof token !== 'string' || token.length !== record.bootstrapToken.length) return false;
      return timingSafeEqual(Buffer.from(token), Buffer.from(record.bootstrapToken));
    },
    dispose() {
      try { const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current.instanceId === record.instanceId) fs.unlinkSync(file); } catch {}
    },
  };
}
