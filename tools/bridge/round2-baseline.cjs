'use strict';
/** 保存第二轮源码基线；只读安装元数据与运行目录，不记录接入凭据。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { DoorClient } = require('../../packages/vscode-extension/src/door/client');
const ROOT = path.resolve(__dirname, '../..');
async function run() {
  const stamp = process.argv[2];
  if (!/^[\w-]+$/.test(stamp || '')) throw new Error('需要唯一的基线名称');
  const backup = path.join(ROOT, 'backup', 'functional-round2-' + stamp);
  if (fs.existsSync(backup)) throw new Error('基线已存在');
  fs.mkdirSync(backup, { recursive: true });
  const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
  const files = [], absent = [];
  for (const rel of new Set(list)) {
    const source = path.resolve(ROOT, rel);
    if (!source.startsWith(ROOT + path.sep)) throw new Error('源码路径超出仓库');
    if (!fs.existsSync(source)) { absent.push(rel); continue; }
    if (!fs.lstatSync(source).isFile()) continue;
    const target = path.join(backup, 'source', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    files.push({ file: rel, sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') });
  }
  fs.writeFileSync(path.join(backup, 'working-tree.patch'), execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }));
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const installed = [];
  for (const profile of ['desktop', 'vscode-panel']) {
    for (const name of ['dsh-acp-door', '@michengai/dsh-code-review', '@linxin666/dsh-client-ui-skill-explorer']) {
      const file = path.join(home, 'profiles', profile, 'node_modules', name, 'package.json');
      let version;
      try { version = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).version; } catch {}
      installed.push({ profile, name, installed: Boolean(version), version });
    }
  }
  const extensions = path.join(os.homedir(), '.vscode/extensions');
  for (const name of fs.readdirSync(extensions).filter(x => /^elk-ydy\.dsh-acp-panel-/i.test(x))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensions, name, 'package.json'), 'utf8'));
    installed.push({ extension: pkg.name, version: pkg.version });
  }
  const running = [], directory = path.join(home, 'run/dsh-acp-door');
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
    if (!/^\d+\.json$/.test(name)) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); process.kill(record.pid, 0); } catch { continue; }
    const client = new DoorClient({ host: '127.0.0.1', port: record.port, timeoutMs: 3000 });
    try {
      await client.connect(); const status = await client.doorStatus();
      const catalog = status.capabilities?.bridge ? await client.request('dsh-door/bridge/catalog', {}) : { capabilities: [] };
      running.push({ port: record.port, version: status.version, instanceId: status.instanceId,
        capabilities: catalog.capabilities.map(x => x.id) });
    } catch { running.push({ port: record.port, status: 'unreachable' }); }
    finally { client.close(); }
  }
  const record = { clientDate: '2026-10-04', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(),
    files, absent, installed, running, stages: [], backup: path.relative(ROOT, backup).replace(/\\/g, '/') };
  fs.writeFileSync(path.join(backup, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ backup: record.backup, files: files.length, installed, running }, null, 2));
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
