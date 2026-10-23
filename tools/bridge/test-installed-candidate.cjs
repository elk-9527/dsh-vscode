'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, locate } = require('../compat/lib.cjs');
const { createFixture } = require('../test-workspace.cjs');
const { packDoor, packPackage, verifyCandidate, verifyInstalledCandidate } = require('./packages.cjs');
const { extractPackageArchive } = require('./package-archive.cjs');
const folder = createFixture('installed-candidate');
try {
  const lf = packDoor(folder), artifact = verifyCandidate(lf, 'tgz');
  const extraction = path.join(folder, 'lf'); fs.mkdirSync(extraction); extractPackageArchive(lf, extraction);
  const installed = path.join(extraction, 'package');
  assert.equal(verifyInstalledCandidate(artifact, installed).files, Object.keys(artifact.files).length);
  const file = path.join(installed, 'lib/status.js'), original = fs.readFileSync(file);
  fs.writeFileSync(file, original.toString().replace(/\r?\n/g, '\r\n'));
  assert.throws(() => verifyInstalledCandidate(artifact, installed), /content differs/);
  fs.writeFileSync(file, original); const modified = Buffer.from(original); modified[0] ^= 1; fs.writeFileSync(file, modified);
  assert.throws(() => verifyInstalledCandidate(artifact, installed), /content differs/); fs.writeFileSync(file, original);
  fs.renameSync(file, file + '.missing'); assert.throws(() => verifyInstalledCandidate(artifact, installed), /Unexpected|Missing/); fs.renameSync(file + '.missing', file);
  fs.writeFileSync(path.join(installed, 'extra'), 'extra'); assert.throws(() => verifyInstalledCandidate(artifact, installed), /Unexpected/); fs.unlinkSync(path.join(installed, 'extra'));
  fs.mkdirSync(path.join(installed, 'extra-directory')); assert.throws(() => verifyInstalledCandidate(artifact, installed), /Unexpected/); fs.rmdirSync(path.join(installed, 'extra-directory'));
  const outside = path.join(folder, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  fs.symlinkSync(outside, path.join(installed, 'external'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => verifyInstalledCandidate(artifact, installed), /link/); fs.unlinkSync(path.join(installed, 'external'));
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  // Reverse combination: source-equivalent CRLF archive, compared using its own byte manifest.
  const crlfSource = path.join(folder, 'source'); fs.cpSync(installed, crlfSource, { recursive: true });
  const convert = directory => { for (const name of fs.readdirSync(directory)) { const target = path.join(directory, name); if (fs.statSync(target).isDirectory()) convert(target); else fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\r?\n/g, '\r\n')); } }; convert(crlfSource);
  const reverse = path.join(folder, 'reverse'); fs.mkdirSync(reverse);
  const info = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', crlfSource, '--ignore-scripts', '--pack-destination', reverse, '--json'] }));
  const crlf = verifyCandidate(path.join(reverse, info[0].filename), 'tgz'), target = path.join(folder, 'crlf'); fs.mkdirSync(target); extractPackageArchive(crlf.file, target);
  assert(verifyInstalledCandidate(crlf, path.join(target, 'package')).files > 10);
  const archiveBytes = fs.readFileSync(lf); fs.appendFileSync(lf, 'changed'); assert.throws(() => verifyInstalledCandidate(artifact, installed)); fs.writeFileSync(lf, archiveBytes);
  const binarySource = path.join(folder, 'binary'); fs.mkdirSync(binarySource); fs.writeFileSync(path.join(binarySource, 'package.json'), JSON.stringify({ name: 'binary-fixture', version: '1.0.0', files: ['payload.bin'] }));
  const binary = Buffer.from([255, 13, 10, 0, 13, 10, 128]); fs.writeFileSync(path.join(binarySource, 'payload.bin'), binary);
  const binaryArchive = packPackage(binarySource, folder), binaryTarget = path.join(folder, 'binary-unpack'); fs.mkdirSync(binaryTarget); extractPackageArchive(binaryArchive, binaryTarget);
  assert(fs.readFileSync(path.join(binaryTarget, 'package/payload.bin')).equals(binary));
  console.log('PASS exact archive installation: LF/CRLF, binary bytes, mutation, missing/extra paths, links and changed archive');
} finally { require('../run-resources.cjs').plainParents(folder); fs.rmSync(folder, { recursive: true, force: true }); }
