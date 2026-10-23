'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const root = path.resolve(__dirname, '../../..'), build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
const fixture = fs.mkdtempSync(path.join(build, 'candidate-regression-')), home = path.join(fixture, 'home');
const archive = path.join(fixture, 'candidate.tgz'); fs.writeFileSync(archive, 'candidate fixture');
const digest = () => crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const originalEnv = { home: process.env.DSH_HOME, candidate: process.env.DSH_PANEL_TEST_DOOR_CANDIDATE, provider: process.env.DSH_PANEL_TEST_PROVIDER_PACKAGE };
const oldLoad = Module._load, helperPath = require.resolve('./helpers/door');
const profile = path.join(home, 'profiles/dshdoor'); fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, 'package.json'), '{}');
let failure = true, installs = [], helper;
try {
  process.env.DSH_HOME = home; process.env.DSH_PANEL_TEST_DOOR_CANDIDATE = archive; delete process.env.DSH_PANEL_TEST_PROVIDER_PACKAGE;
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === helperPath && request === '../../src/door/locate') return {
      runDshSync(options) { installs.push(options.args); if (failure) throw new Error('fixture install failed');
        for (const name of helper.doorDrift()) {
          const source = path.join(root, 'packages/dsh-door', name), destination = path.join(profile, 'node_modules/dsh-acp-door', name);
          fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
        }
      }, probePort: async () => false, spawnBackgroundDsh() {}, dshCommandCandidates: () => ['fixture'], runningDesktopExecutables: () => [],
    };
    if (parent?.filename === helperPath && request === '../../../../tools/bridge/packages.cjs') return { verifyCandidate: file => ({ file, sha256: digest() }) };
    return oldLoad.call(this, request, parent, ...rest);
  };
  delete require.cache[helperPath]; helper = require('./helpers/door');
  const installed = path.join(profile, 'node_modules/dsh-acp-door/package.json'); fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.writeFileSync(installed, 'old installation');
  assert.throws(() => helper.syncDoor({ command: 'fixture' }), /fixture install failed/);
  assert.equal(fs.readFileSync(installed, 'utf8'), 'old installation', '候选安装失败不得用源码覆盖旧文件');
  assert.equal(installs.length, 1); assert.equal(installs[0].at(-1), 'file:' + archive.replace(/\\/g, '/'));
  failure = false;
  const result = helper.syncDoor({ command: 'fixture' });
  assert.equal(result.candidateSha256, digest()); assert.deepEqual(result.copied, []); assert.deepEqual(helper.doorDrift(), []);
  process.env.DSH_HOME = path.join(root, '.local');
  const before = installs.length; assert.throws(() => helper.syncDoor({ command: 'fixture' }), /专用 DSH_HOME/); assert.equal(installs.length, before);
  console.log('PASS candidate regression uses the archive, propagates installation failure, rejects daily home and never applies source fallback');
} finally {
  Module._load = oldLoad; delete require.cache[helperPath];
  for (const [key, value] of [['DSH_HOME', originalEnv.home], ['DSH_PANEL_TEST_DOOR_CANDIDATE', originalEnv.candidate], ['DSH_PANEL_TEST_PROVIDER_PACKAGE', originalEnv.provider]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(fixture, { recursive: true, force: true });
}

// Real archives and an explicit installation target must be enough to inspect
// a candidate without changing or reading the daily extension installation.
{
  const { execFileSync } = require('node:child_process');
  const packages = require('../../../tools/bridge/packages.cjs');
  const { dedicatedHome, verifyInstallation, isolatedEnvironment } = require('../../../tools/compat/local-targets.cjs');
  const directory = fs.mkdtempSync(path.join(build, 'local-targets-'));
  try {
  const targetHome = dedicatedHome(path.join(directory, 'home'));
  const originalLocalAppData = process.env.LOCALAPPDATA, isolated = isolatedEnvironment(targetHome);
  assert.equal(process.env.LOCALAPPDATA, originalLocalAppData);
  assert.equal(isolated.DSH_HOME, targetHome);
  for (const value of Object.values(isolated)) assert(value.startsWith(targetHome + path.sep) || value === targetHome);
  assert.throws(() => dedicatedHome(path.join(root, '.local', 'not-a-test-home')), /build/);
  const link = path.join(directory, 'linked'), escaped = path.basename(directory) + '-must-not-create';
  fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => dedicatedHome(path.join(link, escaped)), /链接/);
  assert(!fs.existsSync(path.join(root, escaped)));
  const dangling = path.join(directory, 'dangling'), absent = path.join(directory, 'absent');
  fs.symlinkSync(absent, dangling, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => dedicatedHome(path.join(dangling, 'must-not-create')), /失效链接/);
  assert(!fs.existsSync(absent));
  const tgz = packages.packDoor(directory);
  const vsix = require('../tools/build-vsix.js').buildVsix(['--out', path.join(directory, 'candidate.vsix')]);
  const candidates = {tgz:packages.verifyCandidate(tgz, 'tgz'), vsix:packages.verifyCandidate(vsix, 'vsix')};
  const unpack = path.join(directory, 'unpack'); fs.mkdirSync(unpack);
  execFileSync('tar', ['-xf', tgz, '-C', unpack], {windowsHide:true});
  const panel = path.join(directory, 'extension'); packages.extractVsix(vsix, panel);
  for (const name of ['desktop', 'vscode-panel']) {
    const target = path.join(targetHome, 'profiles', name); fs.mkdirSync(target, {recursive:true});
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({dsh:{profile:{bundles:['dsh-acp-door']}}}));
    fs.cpSync(path.join(unpack, 'package'), path.join(target, 'node_modules/dsh-acp-door'), {recursive:true});
  }
  const options = {home:targetHome, extension:path.join(panel, 'extension'), candidates};
  const evidence = verifyInstallation(options); assert(evidence.files.length > 10); assert(evidence.panel.verified);
  const changed = path.join(targetHome, 'profiles/vscode-panel/node_modules/dsh-acp-door/lib/status.js'), before = fs.readFileSync(changed);
  fs.appendFileSync(changed, '\n// drift\n'); assert.throws(() => verifyInstallation(options), /内容不一致/); fs.writeFileSync(changed, before);
  const message = path.join(options.extension, 'media/main.js'), original = fs.readFileSync(message);
  fs.appendFileSync(message, '\n// drift\n'); assert.throws(() => verifyInstallation(options)); fs.writeFileSync(message, original);
  assert.throws(() => verifyInstallation({...options,candidates:{...candidates,tgz:{...candidates.tgz,sha256:'0'.repeat(64)}}}), /候选 tgz/);
  console.log('PASS explicit local installation targets validate real candidate content, reject drift/digest changes and block linked home escapes');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
