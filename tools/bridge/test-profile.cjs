'use strict';

/** Install a selected Desktop model bundle only into dedicated test profiles. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, locate, sha256 } = require('../compat/lib.cjs');

function packageDigest(directory) {
  const hash = crypto.createHash('sha256');
  const walk = relative => {
    const file = path.join(directory, relative);
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    } else { hash.update(relative.replace(/\\/g, '/')); hash.update(fs.readFileSync(file)); }
  };
  walk('package.json'); walk('lib'); walk('cordis.patch.yml');
  return hash.digest('hex');
}

function prepareTestProvider({ profile, packageName, command, folder, log = () => {} }) {
  if (!['dshdoor', 'bridge-real'].includes(profile)) throw new Error('Model bundle preparation is restricted to dedicated test profiles.');
  if (!packageName) return { synced: false };
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) throw new Error('Invalid test model package name.');
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const source = path.join(home, 'profiles', 'desktop');
  const sourceManifest = path.join(source, 'package.json');
  if (!fs.existsSync(sourceManifest)) return { synced: false };
  const sourcePkg = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));
  // Built-in adapters need no profile dependency. External providers whose ids
  // differ from their bundle names can be selected explicitly with the test env.
  if (!sourcePkg.dsh?.profile?.bundles?.includes(packageName)) return { synced: false };
  const sourceDirectory = path.join(source, 'node_modules', packageName);
  if (!fs.existsSync(path.join(sourceDirectory, 'package.json'))) throw new Error(`Selected model bundle is not installed: ${packageName}`);
  const directory = path.join(home, 'profiles', profile);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const installed = path.join(directory, 'node_modules', packageName);
  const digest = packageDigest(sourceDirectory);
  const version = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'package.json'), 'utf8')).version;
  if (manifest.dsh?.profile?.bundles?.includes(packageName) && fs.existsSync(path.join(installed, 'package.json')) && packageDigest(installed) === digest) {
    return { synced: false, packageName, version, digest };
  }
  if (!folder) {
    const base = path.join(ROOT, 'build/test-model-profiles');
    fs.mkdirSync(base, { recursive: true });
    folder = fs.mkdtempSync(path.join(base, `${profile}-`));
  }
  const backup = path.join(folder, `${profile}-model-before`);
  fs.mkdirSync(backup, { recursive: true });
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, name));
  }
  const packed = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', sourceDirectory, '--ignore-scripts', '--pack-destination', folder, '--json'], timeoutMs: 120000 }));
  const file = path.join(folder, path.basename(packed[0].filename));
  const persistent = path.join(ROOT, 'build/install', `${path.basename(file, '.tgz')}-${sha256(file).slice(0, 16)}.tgz`);
  fs.mkdirSync(path.dirname(persistent), { recursive: true });
  if (!fs.existsSync(persistent)) fs.copyFileSync(file, persistent);
  locate.runDshSync({ command, args: ['plugin', '--profile', profile, 'add', `file:${persistent.replace(/\\/g, '/')}`], timeoutMs: 180000 });
  const after = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (!after.dsh?.profile?.bundles?.includes(packageName) || packageDigest(installed) !== digest) throw new Error(`Model bundle installation did not match the source: ${packageName}`);
  log('info', `Dedicated test model bundle installed: ${packageName}@${version}`);
  return { synced: true, packageName, version, digest };
}

module.exports = { prepareTestProvider };
