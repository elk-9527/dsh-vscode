'use strict';

/** 兼容维护工具共用的版本、发行物、脱敏和报告操作。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const semver = require('semver');
const ROOT = path.resolve(__dirname, '..', '..');
const locate = require('../../packages/vscode-extension/src/door/locate');

function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function contentSha256(file) {
  const bytes = fs.readFileSync(file);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let content = bytes;
  if (!bytes.includes(0)) {
    try { content = Buffer.from(text.decode(bytes).replace(/\r\n/g, '\n')); } catch {}
  }
  return crypto.createHash('sha256').update(content).digest('hex');
}
function argsOf(args = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--') continue;
    if (!args[i].startsWith('--')) throw new Error(`无法识别参数：${args[i]}`);
    const [key, inline] = args[i].slice(2).split(/=(.*)/s);
    out[key] = inline ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
  }
  return out;
}
function redact(value) {
  return locate.redactSensitiveOutput(String(value))
    .replace(/(api[_-]?key|access[_-]?token|secret|password)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1$2[已隐藏]')
    .split(os.homedir()).join('<USER>')
    .split(os.homedir().replace(/\\/g, '/')).join('<USER>');
}
function safeObject(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(safeObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:api[_-]?key|access[_-]?token|authorization|password|secret|credentials)$/i.test(key) ? '[已隐藏]' : safeObject(item)]));
  return value;
}
function sourceState() {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const hash = crypto.createHash('sha256');
  // Git 在 Windows 检出时会转换换行；证据指纹采用文本的 LF 形式。
  const content = (file) => {
    const bytes = fs.readFileSync(file);
    return bytes.includes(0) ? bytes : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
  };
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else { hash.update(path.relative(ROOT, file).replace(/\\/g, '/')); hash.update(content(file)); }
    }
  };
  for (const name of ['packages/dsh-door/lib', 'packages/vscode-extension/src', 'packages/vscode-extension/media']) walk(path.join(ROOT, name));
  walk(path.join(ROOT, 'packages/dsh-bridge-sdk/lib'));
  walk(path.join(ROOT, 'packages/dsh-bridge-sdk/examples'));
  walk(path.join(ROOT, 'tools/bridge/providers'));
  for (const name of ['review-budget.cjs', 'review-runtime.cjs', 'review-context.cjs', 'build-pilots.cjs']) { hash.update(name); hash.update(content(path.join(ROOT, 'tools/bridge', name))); }
  hash.update(content(path.join(ROOT, 'packages/vscode-extension/API.md')));
  for (const name of ['package.json', 'README.md', 'LICENSE']) hash.update(content(path.join(ROOT, 'packages/dsh-bridge-sdk', name)));
  for (const name of ['packages/dsh-door/package.json', 'packages/vscode-extension/package.json']) hash.update(content(path.join(ROOT, name)));
  for (const pkg of ['dsh-door', 'vscode-extension']) for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE']) hash.update(content(path.join(ROOT, 'packages', pkg, name)));
  hash.update(content(path.join(ROOT, 'packages/dsh-door/cordis.patch.yml')));
  const fingerprintFiles = files => {
    const digest = crypto.createHash('sha256');
    const add = file => {
      if (!fs.existsSync(file)) return;
      if (fs.statSync(file).isDirectory()) { for (const name of fs.readdirSync(file).sort()) add(path.join(file, name)); return; }
      digest.update(path.relative(ROOT, file).replace(/\\/g, '/')); digest.update('\0'); digest.update(content(file)); digest.update('\0');
    };
    for (const file of files) add(path.join(ROOT, file));
    return digest.digest('hex');
  };
  const matrix = json(path.join(ROOT, 'compat/versions.json')), editors = json(path.join(ROOT, 'compat/editors.json'));
  // 验收要求纳入工具指纹；登记结果的时间、路径和状态不参与，避免证据自引用。
  const requirements = { kernels: [...new Set(matrix.versions.map(entry => JSON.stringify([entry.dsh, entry.distribution, entry.platform || matrix.platform])))].sort(),
    editors: [...new Set([editors.minimum, editors.chatBaseline, ...(editors.supported || []).map(entry => entry.editor)])].filter(Boolean).sort(), platform: editors.platform };
  const typeConfigs = fs.readdirSync(ROOT).filter(name => /^tsconfig(?:\.[^.]+)*\.json$/.test(name)).sort();
  const toolFingerprint = crypto.createHash('sha256').update(fingerprintFiles(['tools', '.github/workflows', ...typeConfigs, 'packages/vscode-extension/tools', 'packages/vscode-extension/test', 'packages/dsh-door/tools', 'packages/dsh-door/test', 'packages/dsh-bridge-sdk/test'])).update(JSON.stringify(requirements)).digest('hex');
  return { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])), fingerprint: hash.digest('hex'),
    toolFingerprint,
    lockFingerprint: fingerprintFiles(['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) };
}
function versions() {
  return {
    panel: json(path.join(ROOT, 'packages/vscode-extension/package.json')).version,
    door: json(path.join(ROOT, 'packages/dsh-door/package.json')).version,
    peer: json(path.join(ROOT, 'packages/dsh-door/package.json')).peerDependencies['@deepseek-ai/dsh-acp'],
    sdk: json(path.join(ROOT, 'packages/dsh-bridge-sdk/package.json')).version,
    vscode: json(path.join(ROOT, 'packages/vscode-extension/package.json')).engines.vscode,
  };
}
function readAsar(archive, relative) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, prefix.length, 0);
    const size = prefix.readUInt32LE(12);
    if (size > 64 * 1024 * 1024) throw new Error('ASAR header 超出读取上限');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 16);
    let entry = JSON.parse(buffer.toString());
    for (const part of relative.split('/')) entry = entry?.files?.[part];
    if (!entry) throw new Error(`ASAR 缺少 ${relative}`);
    if (entry.files) return Object.keys(entry.files);
    if (entry.unpacked) return fs.readFileSync(path.join(`${archive}.unpacked`, relative), 'utf8');
    const content = Buffer.alloc(Number(entry.size));
    fs.readSync(fd, content, 0, content.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    return content.toString();
  } finally { fs.closeSync(fd); }
}
function desktopInfo(executable) {
  const archive = path.join(path.dirname(executable), 'resources/app.asar');
  try {
    const pkg = JSON.parse(readAsar(archive, 'dsh/node_modules/@deepseek-ai/dsh/package.json'));
    const acp = JSON.parse(readAsar(archive, 'dsh/node_modules/@deepseek-ai/dsh-acp/package.json'));
    return { executable, version: pkg.version, acp: acp.version, distribution: 'desktop' };
  } catch (error) { return { executable, error: redact(error.message) }; }
}
function desktopGuiProcessIds() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name = 'DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=|--expose-internals|[\\/]lib[\\/](host|cli)\\.js' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error('无法核对 Desktop GUI 进程');
  const ids = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(ids) ? ids : [ids];
}
function candidates() {
  const desktops = locate.runningDesktopExecutables();
  return { desktops: desktops.map(desktopInfo), commands: locate.dshCommandCandidates({
    dshCommand: process.env.DSH_PANEL_DSH || 'dsh', homedir: os.homedir(), desktopExecutables: desktops,
    extensionDir: path.join(ROOT, 'packages/vscode-extension'),
  }) };
}
function resolveRuntime(options = {}) {
  const inventory = candidates();
  const commands = options.command ? [options.command] : inventory.commands;
  const errors = [];
  for (const command of commands) {
    try {
      const output = locate.runDshSync({ command, args: ['--version'], timeoutMs: 10000 });
      const found = output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/g)?.pop();
      if (!found || (options.dsh && found !== options.dsh)) throw new Error(`目标 ${options.dsh || 'DSH'}，实际 ${found || output.trim()}`);
      const desktop = inventory.desktops.find((item) => command.toLowerCase().includes(path.dirname(item.executable).toLowerCase()));
      return { command, version: found, distribution: desktop ? 'desktop' : 'npm', acp: desktop?.acp };
    } catch (error) { errors.push(redact(error.message)); }
  }
  const error = new Error(`没有匹配的 DSH 运行时：${errors.join('；')}`);
  error.kind = 'unavailable';
  throw error;
}
function runDir(label = 'run') {
  const base = path.join(ROOT, 'build/compat');
  require('../run-resources.cjs').plainParents(base);
  fs.mkdirSync(base, { recursive: true });
  const name = String(label).replace(/[^A-Za-z0-9._-]/g, '-');
  return fs.mkdtempSync(path.join(base, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}-`));
}
function writeReport(folder, report) {
  const file = path.join(folder, 'report.json');
  fs.writeFileSync(file, `${JSON.stringify(safeObject(report), null, 2)}\n`);
  return file;
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-vscode-compat', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}
function supportedMatrix(matrix = json(path.join(ROOT, 'compat/versions.json')), operatingSystems = ['windows-latest', 'ubuntu-latest']) {
  const declared = [...new Map(matrix.versions.map(item => [item.distribution + ':' + item.dsh, { dsh: item.dsh, distribution: item.distribution }])).values()];
  return { matrix: { include: declared.filter(item => item.distribution === 'npm').flatMap(item => operatingSystems.map(os => ({ ...item, os }))) },
    desktop: declared.filter(item => item.distribution === 'desktop') };
}
function discoveryResult(matrix, npm, releases, issues = []) {
  const supported = supportedMatrix(matrix), declared = new Set(matrix.versions.map(item => item.distribution + ':' + item.dsh));
  const available = Object.keys(npm?.versions || {}).filter(version => semver.valid(version)).sort(semver.rcompare);
  const stable = available.find(version => !semver.prerelease(version)), prerelease = available.find(version => semver.prerelease(version));
  const upstream = (Array.isArray(releases) ? releases : []).filter(release => !release.draft).map(release => release.tag_name?.replace(/^dsh-v/, '')).filter(version => semver.valid(version)).sort(semver.rcompare)[0];
  const npmVersions = [...new Set([stable, prerelease, available.includes(upstream) && upstream].filter(Boolean))].filter(version => !declared.has('npm:' + version));
  return { ...supported, stable, prerelease, upstream, acquisitionIssues: issues,
    probes: { include: npmVersions.flatMap(dsh => ['windows-latest', 'ubuntu-latest'].map(os => ({ dsh, os, distribution: 'npm' }))) },
    desktopProbes: upstream && !available.includes(upstream) && !declared.has('desktop:' + upstream) ? [{ dsh: upstream, distribution: 'desktop', status: 'manual-environment-required' }] : [] };
}
async function discover() {
  const matrix = json(path.join(ROOT, 'compat/versions.json'));
  const results = await Promise.allSettled([fetchJson(matrix.sources.registry + '/@deepseek-ai%2Fdsh'), fetchJson(matrix.sources.releases + '?per_page=30')]);
  return discoveryResult(matrix, results[0].status === 'fulfilled' ? results[0].value : undefined,
    results[1].status === 'fulfilled' ? results[1].value : undefined,
    results.flatMap((result, index) => result.status === 'rejected' ? [{ source: index ? 'upstream' : 'registry', status: 'acquisition-failed', error: redact(result.reason.message) }] : []));
}

module.exports = { ROOT, locate, json, sha256, contentSha256, argsOf, redact, safeObject, sourceState, versions, readAsar, desktopInfo, desktopGuiProcessIds, candidates, resolveRuntime, runDir, writeReport, fetchJson, supportedMatrix, discoveryResult, discover, semver };
