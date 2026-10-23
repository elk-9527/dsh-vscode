'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PILOTS } = require('./build-pilots.cjs');
const { extractPackageArchive } = require('./package-archive.cjs');
const ROOT = path.resolve(__dirname, '../..');
const parent = path.join(ROOT, 'build'); fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'pilot-build-test-'));
try {
  const output = path.join(folder, '候选 packages'), home = path.join(folder, 'empty-home');
  fs.mkdirSync(home);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-pilots.cjs'), '--fresh', '--out', output], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, npm_config_cache: path.join(folder, 'empty-npm-cache') },
  });
  assert.equal(result.status, 0, `Cold pilot build failed: ${result.error?.message || ''}\n${result.stdout || ''}\n${result.stderr || ''}`);
  assert.deepEqual(fs.readdirSync(home), [], 'Cold build must not read or populate an installed DSH profile');
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')));
  assert.equal(manifest.length, PILOTS.length);
  let unicodeFiles = 0;
  for (const pilot of PILOTS) {
    const record = manifest.find(item => item.name === pilot.name);
    const candidate = path.resolve(ROOT, record.file);
    assert.equal(record.candidate, pilot.candidate);
    assert.equal(createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'), record.packageSha256);
    const upstream = path.join(output, 'upstream', pilot.key);
    assert.equal(JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'))).version, pilot.version);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(upstream, 'lib/index.js'))).digest('hex'), pilot.sha256);
    const extracted = path.join(folder, pilot.key); fs.mkdirSync(extracted);
    const entries = extractPackageArchive(candidate, extracted);
    const packaged = path.join(extracted, 'package');
    const modified = new Set(['package.json', 'lib/index.js', ...(pilot.key === 'review' ? ['lib/runtime.js', 'NOTICE'] : [])]);
    function compare(directory, relative = '') {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name), next = path.join(relative, name);
        if (fs.statSync(file).isDirectory()) compare(file, next);
        else if (!modified.has(next.replace(/\\/g, '/'))) {
          assert.deepEqual(fs.readFileSync(path.join(packaged, next)), fs.readFileSync(file), `Upstream file differs: ${next}`);
          if (/[^\x00-\x7f]/.test(next)) unicodeFiles += 1;
        }
      }
    }
    compare(upstream);
    assert(entries.some(entry => entry.path === 'package/lib/index.js'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(packaged, 'package.json'))).version, pilot.candidate);
  }
  assert(unicodeFiles >= 11, 'Regression must include the upstream Chinese documentation paths');
  console.log(`PASS cold registry build of ${manifest.length} pilot packages with an empty profile/cache; ${unicodeFiles} Unicode files preserved`);
} finally {
  assert.equal(path.dirname(path.resolve(folder)), parent);
  assert(!fs.lstatSync(folder).isSymbolicLink());
  fs.rmSync(folder, { recursive: true, force: true });
}
