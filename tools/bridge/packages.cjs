'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { ROOT, locate, argsOf, sha256, sourceState, versions } = require('../compat/lib.cjs');
function normalize(bytes) {
  if (bytes.includes(0)) return bytes;
  try { return Buffer.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n')); }
  catch { return bytes; }
}
function packPackage(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const stage = require('../test-workspace.cjs').createFixture('package-stage');
  try {
    for (const name of packageFiles(source)) {
      const target = path.join(stage, name), bytes = fs.readFileSync(path.join(source, name));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const text = /\.(?:[cm]?js|json|md|txt|ya?ml|ts|html|css|svg)$/.test(name) || /(?:^|\/)(?:LICENSE|NOTICE)$/.test(name);
      fs.writeFileSync(target, text ? normalize(bytes) : bytes);
      fs.chmodSync(target, fs.statSync(path.join(source, name)).mode & 0o111 ? 0o755 : 0o644);
      fs.utimesSync(target, 0, 0);
    }
    const packed = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', stage, '--ignore-scripts', '--pack-destination', path.resolve(destination), '--json'] }));
    return path.join(destination, packed[0].filename);
  } finally { require('../run-resources.cjs').plainParents(stage); fs.rmSync(stage, { recursive: true, force: true }); }
}
function packSdk(destination) { return packPackage(path.join(ROOT, 'packages/dsh-bridge-sdk'), destination); }
function packDoor(destination) { return packPackage(path.join(ROOT, 'packages/dsh-door'), destination); }
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
      require('./package-archive.cjs').extractPackageArchive(file, temporary);
      extracted = path.join(temporary, 'package'); verifyTarFiles(source, extracted);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json')));
    const expected = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    assert.equal(manifest.name, expected.name); assert.equal(manifest.version, expected.version);
    const markdown = fs.readFileSync(path.join(extracted, 'README.md'), 'utf8');
    assert.equal(require('../../packages/vscode-extension/tools/package-links.cjs').invalidSourceLinks(markdown).length, 0, 'Candidate README has invalid public source links');
    assert.equal(sha256(file), before, 'Candidate changed during verification');
    const files = {};
    const collect = relative => {
      const target = path.join(extracted, relative), stat = fs.lstatSync(target);
      assert(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'Candidate contains a link or special file');
      if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) collect(path.join(relative, name));
      else files[relative.replace(/\\/g, '/')] = sha256(target);
    };
    for (const name of fs.readdirSync(extracted).sort()) collect(name);
    return { kind, file, sha256: before, name: manifest.name, version: manifest.version, files,
      ...(kind === 'vsix' ? { installedManifestSha256: sha256(path.join(temporary, 'extension.vsixmanifest')), manifest } : {}) };
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(parent)); assert(!fs.lstatSync(temporary).isSymbolicLink());
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
/** Compare installed bytes to the exact validated producer archive, independently of checkout newlines. */
function verifyInstalledCandidate(candidate, installed, { root = installed } = {}) {
  const fresh = verifyCandidate(candidate.file, candidate.kind);
  assert.equal(fresh.sha256, candidate.sha256, 'Candidate changed before installation verification');
  const boundary = fs.realpathSync(root), target = fs.realpathSync(installed), relative = path.relative(boundary, target);
  assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Installed package link escapes installation root');
  const found = new Set();
  const walk = relative => {
    const file = path.join(target, relative), stat = fs.lstatSync(file), name = relative.replace(/\\/g, '/');
    assert(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'Installed package contains a link or special file');
    if (stat.isDirectory()) { assert(Object.keys(fresh.files).some(item => item.startsWith(name + '/')), 'Unexpected installed package directory: ' + name); for (const child of fs.readdirSync(file)) walk(path.join(relative, child)); return; }
    if (fresh.kind === 'vsix' && name === '.vsixmanifest') { assert.equal(sha256(file), fresh.installedManifestSha256, 'Installer manifest differs from candidate'); return; }
    assert(Object.hasOwn(fresh.files, name) && !found.has(name), 'Unexpected installed package file: ' + name); found.add(name);
    if (sha256(file) === fresh.files[name]) return;
    // VS Code adds this documented installer field while serializing package.json.
    if (fresh.kind === 'vsix' && name === 'package.json') {
      const value = JSON.parse(fs.readFileSync(file)); assert(Object.hasOwn(value, '__metadata'), 'Installed package manifest bytes differ');
      delete value.__metadata; assert.deepEqual(value, fresh.manifest, 'Installed package manifest differs from candidate'); return;
    }
    assert.fail('Installed package content differs / 内容不一致: ' + name);
  };
  for (const name of fs.readdirSync(target)) walk(name);
  for (const name of Object.keys(fresh.files)) assert(found.has(name), 'Missing installed package file: ' + name);
  assert.equal(sha256(candidate.file), candidate.sha256, 'Candidate changed during installation verification');
  return { files: found.size, sha256: fresh.sha256 };
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
function artifactRecord({ files, installedManifestSha256, manifest, ...artifact }) { return { ...artifact, file: path.relative(ROOT, artifact.file).replace(/\\/g, '/') }; }
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
module.exports = { verifyInstalledCandidate, packPackage, packSdk, packDoor, pinSdk, verifyCandidate, candidates, artifactRecord, finishEvidence, buildCandidates, extractVsix };
