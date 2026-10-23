'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { ROOT, locate, argsOf, sha256, sourceState, versions } = require('../compat/lib.cjs');
function packSdk(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const packed = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', path.join(ROOT, 'packages/dsh-bridge-sdk'), '--ignore-scripts', '--pack-destination', destination, '--json'] }));
  return path.join(destination, packed[0].filename);
}
function packDoor(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const packed = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', path.join(ROOT, 'packages/dsh-door'), '--ignore-scripts', '--pack-destination', destination, '--json'] }));
  return path.join(destination, packed[0].filename);
}
const normalize = bytes => bytes.includes(0) ? bytes : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
function packageFiles(source) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  const files = [];
  const walk = relative => {
    const file = path.join(source, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file); assert(!stat.isSymbolicLink(), 'Package source contains a link');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(relative, name));
    else files.push(relative.replace(/\\/g, '/'));
  };
  for (const item of [...new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', ...manifest.files])]) walk(item);
  return [...new Set(files)].sort();
}
function verifyTarFiles(source, extracted) {
  const expected = new Set(packageFiles(source)), found = new Set();
  const walk = relative => {
    const file = path.join(extracted, relative), stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), 'Package contains a link');
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file)) walk(path.join(relative, name)); return; }
    const name = relative.replace(/\\/g, '/');
    assert(expected.has(name) && !found.has(name), `Unexpected package file: ${name}`); found.add(name);
    assert(normalize(fs.readFileSync(path.join(source, name))).equals(normalize(fs.readFileSync(file))), `Stale package: ${name}`);
  };
  for (const name of fs.readdirSync(extracted)) walk(name);
  for (const name of expected) assert(found.has(name), `Missing package file: ${name}`);
}
function extractVsix(file, destination, { platform = process.platform, run = execFileSync, python = 'python3' } = {}) {
  if (platform === 'win32') {
    const literal = value => "'" + value.replace(/'/g, "''") + "'";
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      `$z=[IO.Compression.ZipFile]::OpenRead(${literal(file)}); try { ` +
      "if($z.Entries.Count -gt 10000){throw 'Too many package entries'}; $total=0L; foreach($e in $z.Entries){ " +
      "if($e.FullName -match '(^/|\\\\|(^|/)\\.\\.(/|$))'){throw 'Unsafe package path'}; $total += $e.Length }; if($total -gt 268435456){throw 'Package too large'} " +
      `} finally {$z.Dispose()}; [IO.Compression.ZipFile]::ExtractToDirectory(${literal(file)},${literal(destination)})`],
    { windowsHide: true, timeout: 30000, stdio: 'pipe' });
    return;
  }
  run(python, ['-c', String.raw`import pathlib, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 10000 or sum(item.file_size for item in entries) > 268435456:
        raise ValueError('Package exceeds extraction budget')
    names = set()
    for item in entries:
        name = item.filename
        parts = pathlib.PurePosixPath(name).parts
        mode = stat.S_IFMT(item.external_attr >> 16)
        if name in names or not name or name.startswith('/') or '\\' in name or ':' in name or '..' in parts or any(ord(char) < 32 for char in name):
            raise ValueError('Unsafe or duplicate package path')
        if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or item.flag_bits & 1:
            raise ValueError('Unsupported package entry type')
        names.add(name)
    archive.extractall(sys.argv[2])`, file, destination], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
}
/** Read-only candidate inspection; only temporary extraction lives under build. */
function verifyCandidate(input, kind) {
  assert(['vsix', 'tgz', 'sdk'].includes(kind), 'Unknown candidate kind');
  assert.equal(typeof input, 'string', `Need explicit ${kind} candidate`);
  const file = fs.realpathSync(path.resolve(input));
  assert(fs.statSync(file).isFile() && file.endsWith(kind === 'vsix' ? '.vsix' : '.tgz'), 'Invalid candidate file');
  const before = sha256(file);
  const parent = path.join(ROOT, 'build/candidate-validation'); fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, `${kind}-`));
  try {
    let source, extracted;
    if (kind === 'vsix') {
      source = path.join(ROOT, 'packages/vscode-extension');
      extractVsix(file, temporary);
      const top = fs.readdirSync(temporary).sort();
      assert.deepEqual(top, ['[Content_Types].xml', 'extension', 'extension.vsixmanifest'].sort(), 'Unexpected VSIX root files');
      extracted = path.join(temporary, 'extension');
      require('../../packages/vscode-extension/tools/package-links.cjs').verifyPackageFiles(source, extracted);
    } else {
      source = path.join(ROOT, kind === 'tgz' ? 'packages/dsh-door' : 'packages/dsh-bridge-sdk');
      const list = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/);
      assert(list.length <= 10000 && list.every(name => /^package\//.test(name) && !/[\u0000-\u001f\\]/.test(name) && !name.split('/').includes('..')), 'Unsafe tar package paths');
      assert.equal(new Set(list).size, list.length, 'Duplicate tar package entries');
      const expectedFiles = new Set(packageFiles(source).map(name => `package/${name}`));
      assert(list.filter(name => !name.endsWith('/')).every(name => expectedFiles.has(name)), 'Unexpected tar package entries');
      const details = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      assert(details.trim().split(/\r?\n/).every(line => /^[-d]/.test(line)), 'Package contains a link or special entry');
      execFileSync('tar', ['-xzf', file, '-C', temporary], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
      extracted = path.join(temporary, 'package'); verifyTarFiles(source, extracted);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json')));
    const expected = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    assert.equal(manifest.name, expected.name); assert.equal(manifest.version, expected.version);
    const markdown = fs.readFileSync(path.join(extracted, 'README.md'), 'utf8');
    assert.equal(require('../../packages/vscode-extension/tools/package-links.cjs').invalidSourceLinks(markdown).length, 0, 'Candidate README has invalid public source links');
    assert.equal(sha256(file), before, 'Candidate changed during verification');
    return { kind, file, sha256: before, name: manifest.name, version: manifest.version };
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(parent)); assert(!fs.lstatSync(temporary).isSymbolicLink());
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
function candidates(options, { editor = false } = {}) {
  const required = editor ? ['tgz', 'sdk', 'vsix'] : ['tgz', 'sdk'];
  const found = {};
  for (const kind of required) {
    assert.equal(typeof options[kind], 'string', `需要 --${kind} 指定本轮唯一候选文件`);
    found[kind] = verifyCandidate(options[kind], kind);
  }
  return found;
}
function artifactRecord(artifact) { return { ...artifact, file: path.relative(ROOT, artifact.file).replace(/\\/g, '/') }; }
function finishEvidence(report) {
  report.sourceEnd = sourceState();
  const changed = ['fingerprint', 'toolFingerprint', 'lockFingerprint'].filter(key => !report.sourceStart?.[key] || report.sourceStart[key] !== report.sourceEnd[key]);
  for (const artifact of report.artifacts || []) {
    const file = path.resolve(ROOT, artifact.file);
    if (!fs.existsSync(file) || sha256(file) !== artifact.sha256) changed.push(`artifact:${artifact.kind || path.basename(file)}`);
  }
  if (changed.length) { report.status = 'failed'; report.sourceChanged = changed; report.error = '验收输入或候选文件在执行期间发生变化，请使用固定候选重新验收'; }
  return report;
}
function buildCandidates(destination) {
  const folder = path.resolve(destination), current = versions();
  const expected = [`dsh-acp-panel-${current.panel}.vsix`, `dsh-acp-door-${current.door}.tgz`, `dsh-ide-bridge-sdk-${current.sdk}.tgz`, 'manifest.json'];
  assert(expected.every(name => !fs.existsSync(path.join(folder, name))), '候选文件已存在；请复用并验收这些文件，或选择新的目录');
  const start = sourceState();
  fs.mkdirSync(folder, { recursive: true });
  const files = [
    ['vsix', require('../../packages/vscode-extension/tools/build-vsix.js').buildVsix(['--out', path.join(folder, expected[0])])],
    ['tgz', packDoor(folder)], ['sdk', packSdk(folder)],
  ];
  const artifacts = files.map(([kind, file]) => artifactRecord(verifyCandidate(file, kind)));
  const end = sourceState();
  for (const name of ['fingerprint', 'toolFingerprint', 'lockFingerprint']) assert.equal(start[name], end[name], `Candidate inputs changed: ${name}`);
  const record = { schemaVersion: 2, packages: current, platform: process.platform, sourceStart: start, sourceEnd: end, artifacts };
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
/** 未发布 SDK 的本地候选使用精确 file: 覆盖；不改变版本等待或脚本审批策略。 */
function pinSdk(profile, archive) {
  const file = path.join(profile, 'pnpm-workspace.yaml');
  const original = fs.readFileSync(file, 'utf8');
  const spec = JSON.stringify('file:' + path.resolve(archive).split(path.sep).join('/'));
  let updated;
  if (/^overrides:\s*$/m.test(original)) {
    if (/^  ['"]?dsh-ide-bridge-sdk['"]?:/m.test(original)) updated = original.replace(/^  ['"]?dsh-ide-bridge-sdk['"]?:[^\r\n]*/m, '  dsh-ide-bridge-sdk: ' + spec);
    else updated = original.replace(/^overrides:\s*$/m, 'overrides:\n  dsh-ide-bridge-sdk: ' + spec);
  } else updated = original.trimEnd() + '\n\noverrides:\n  dsh-ide-bridge-sdk: ' + spec + '\n';
  fs.writeFileSync(file, updated); return { original, updated };
}
if (require.main === module) {
  try { const options = argsOf(); assert(typeof options.out === 'string' && Object.keys(options).every(key => key === 'out'), '需要 --out 指定新的候选输出目录'); console.log(JSON.stringify(buildCandidates(options.out), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packSdk, packDoor, pinSdk, verifyCandidate, candidates, artifactRecord, finishEvidence, buildCandidates, extractVsix };
