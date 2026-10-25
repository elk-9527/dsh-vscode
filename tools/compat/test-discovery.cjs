'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { supportedMatrix, discoveryResult, ROOT, versions, sha256 } = require('./lib.cjs');
const { classifyProbe } = require('./probe.cjs');
const { REQUIRED, FINGERPRINTS } = require('./release-check.cjs');
const matrix = { versions: [{ dsh: '1.0.0', distribution: 'npm' }, { dsh: '1.0.0', distribution: 'npm' }, { dsh: '1.1.0', distribution: 'desktop' }] };
assert.equal(supportedMatrix(matrix).matrix.include.length, 2);
assert.equal(supportedMatrix(matrix).desktop.length, 1);
const discovered = discoveryResult(matrix, { versions: { '1.0.0': {}, '1.2.0-rc.1': {} } }, [{ tag_name: 'dsh-v1.2.0-rc.1' }]);
assert.equal(discovered.probes.include.length, 2); assert.equal(discovered.probes.include[0].dsh, '1.2.0-rc.1');
assert.deepEqual(discovered.matrix, supportedMatrix(matrix).matrix);
const desktop = discoveryResult(matrix, { versions: { '1.0.0': {} } }, [{ tag_name: 'dsh-v1.3.0' }]);
assert.equal(desktop.desktopProbes[0].distribution, 'desktop'); assert.equal(desktop.probes.include.length, 0);
const unavailable = discoveryResult(matrix, undefined, undefined, [{ source: 'registry', status: 'acquisition-failed' }]);
assert.deepEqual(unavailable.matrix, discovered.matrix); assert.equal(unavailable.acquisitionIssues.length, 1);
assert.throws(() => classifyProbe({ status: 'failed' }, true), /required/);

const current = versions(), requested = '0.2.1-rc.3';
const state = { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64), toolFingerprint: 'c'.repeat(64), lockFingerprint: 'd'.repeat(64) };
const clone = value => structuredClone(value);
function gateMessage(label = 'requirements') {
  return `Plugin dsh-acp-door@${current.door} is incompatible with dsh ${requested}: ${label} ${JSON.stringify({ '@deepseek-ai/dsh-acp': current.peer })}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for dsh-acp-door@${current.door} on dsh ${requested} with \`dsh plugin allow-version\` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active.`;
}
// Minimal installer output preserves the gate, repeated diagnostic and pnpm warning, without runner paths.
function installerOutput(eol = '\n') {
  return ['Progress: resolved 0, reused 1, downloaded 0, added 0',
    '[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.', 'Packages: +3', '+++',
    'Packages are hard linked from the content-addressable store to the virtual store.',
    '  Content-addressable store is at: <CACHE>', '  Virtual store is at: node_modules/.pnpm',
    'Progress: resolved 3, reused 1, downloaded 2, added 3, done', '', 'dependencies:', `+ dsh-acp-door ${current.door}`, '',
    'Done in 1.4s using pnpm v11.28.6', '', '! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.28.6.tgz', '',
    'dsh: installation rejected: ' + gateMessage(), gateMessage(),
    'dsh: restored package.json, pnpm-lock.yaml, and node_modules.',
    `dsh: to accept the risk, run: dsh plugin --profile compat allow-version dsh-acp-door@${current.door} --dsh-version ${requested} --accept-risk`,
    'dsh: plugin command failed; diagnostics: <WORK>/pnpm.log'].join(eol);
}
function rejected(error = gateMessage()) {
  return { schemaVersion: 2, time: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', platform: 'linux',
    source: clone(state), sourceStart: clone(state), sourceEnd: clone(state), packages: clone(current), requested, status: 'failed', error,
    runtime: { version: requested, acpVersion: requested, distribution: 'npm', command: 'PRIVATE_COMMAND' },
    artifacts: [{ kind: 'tgz', name: 'dsh-acp-door', version: current.door, file: 'candidate.tgz', sha256: 'e'.repeat(64) }],
    resources: { status: 'passed', errors: [], reason: 'rebuildable-work-removed' },
    stages: [{ name: 'package', status: 'passed', evidence: { sha256: 'e'.repeat(64) } },
      { name: 'loopback-environment', status: 'passed' },
      { name: 'runtime', status: 'passed', evidence: { version: requested, acpVersion: requested, distribution: 'npm' } },
      { name: 'installation', status: 'failed', error }] };
}
function completed() {
  const report = rejected(); delete report.error; report.status = 'passed';
  // The runtime version and resolved ACP version are deliberately different.
  report.runtime.acpVersion = '0.2.1-rc.2';
  report.stages = [...new Set([...REQUIRED, 'loopback-environment', 'text-generation'])].map(name => ({ name, status: 'passed' }));
  report.stages.find(item => item.name === 'package').evidence = { sha256: report.artifacts[0].sha256 };
  report.stages.find(item => item.name === 'runtime').evidence = { version: requested, distribution: 'npm', acpVersion: report.runtime.acpVersion };
  report.stages.find(item => item.name === 'installation').evidence = { installedVersion: current.door };
  report.stages.find(item => item.name === 'status').evidence = { version: current.door, runtime: { acpVersion: report.runtime.acpVersion } };
  return report;
}
const cases = [];
const add = (name, report, status = 'incompatible') => cases.push({ name, report, status });
const mutate = (name, edit, base = rejected()) => { const report = clone(base); edit(report); add(name, report); };
add('Linux requirements and pnpm warning', rejected(installerOutput()), 'not-declared');
const windows = rejected(installerOutput('\r\n')); windows.platform = 'win32'; add('Windows CRLF requirements', windows, 'not-declared');
add('old complete peerDependencies gate', rejected(gateMessage('peerDependencies')), 'not-declared');
add('warning prefix and multiline requirements', rejected('[WARN] dsh: installation rejected: ' + gateMessage().replace(': requirements {', ': requirements\n{').replace('}. Running', '}.\nRunning')), 'not-declared');
add('multiline requirements JSON', rejected(gateMessage().replace(JSON.stringify({ '@deepseek-ai/dsh-acp': current.peer }), JSON.stringify({ '@deepseek-ai/dsh-acp': current.peer }, null, 2))), 'not-declared');
add('complete behavior with distinct DSH and ACP versions', completed(), 'candidate-passed');
const optional = completed(); optional.stages.find(item => item.name === 'text-generation').status = 'not-applicable'; optional.stages.find(item => item.name === 'text-generation').required = false;
add('optional direct text generation unavailable', optional, 'candidate-passed');
add('acquisition failure', { status: 'acquisition-failed' }, 'acquisition-failed');
const acquisition = rejected(); acquisition.stages.push({ name: 'download', status: 'acquisition-failed' }); add('gate plus acquisition failure', acquisition, 'acquisition-failed');
add('missing report', undefined); add('bare passed status', { status: 'passed' });
add('unstructured failure', { status: 'failed', stages: [{ name: 'stream', status: 'failed' }] });
mutate('missing stages', report => { delete report.stages; });
mutate('malformed stages', report => { report.stages = {}; });
mutate('missing package verification', report => { report.stages.shift(); });
mutate('duplicate stage', report => { report.stages.push(clone(report.stages[0])); });
mutate('null stage', report => { report.stages.push(null); });
mutate('later behavior failure', report => { report.stages.push({ name: 'stream', status: 'failed' }); });
mutate('later cleanup failure', report => { report.stages.push({ name: 'cleanup', status: 'failed' }); });
mutate('cleanup resource failure', report => { report.resources.status = 'failed'; });
mutate('resource error despite passed label', report => { report.resources.errors.push('PRIVATE_ERROR'); });
mutate('missing resources', report => { delete report.resources; });
mutate('budget abort', report => { report.resources.abort = 'Validation time limit exceeded'; });
mutate('source drift marker', report => { report.sourceChanged = ['toolFingerprint']; });
mutate('cleanup error marker', report => { report.cleanupError = 'PRIVATE_ERROR'; });
for (const key of FINGERPRINTS) {
  mutate('changed ' + key, report => { report.sourceEnd[key] = 'f'.repeat(64); });
  mutate('missing ' + key, report => { delete report.sourceStart[key]; });
}
mutate('missing end snapshot', report => { delete report.sourceEnd; });
mutate('mismatched source snapshot', report => { report.source.toolFingerprint = 'f'.repeat(64); });
mutate('missing completion time', report => { delete report.finishedAt; });
mutate('missing candidate digest', report => { delete report.artifacts[0].sha256; });
mutate('null candidate', report => { report.artifacts = [null]; });
mutate('package digest mismatch', report => { report.stages[0].evidence.sha256 = 'f'.repeat(64); });
mutate('candidate package mismatch', report => { report.artifacts[0].name = 'other-plugin'; });
mutate('candidate version mismatch', report => { report.artifacts[0].version = '9.9.9'; });
mutate('report package mismatch', report => { report.packages.door = '9.9.9'; });
mutate('runtime version mismatch', report => { report.runtime.version = '9.9.9'; });
mutate('runtime stage mismatch', report => { report.stages[2].evidence.version = '9.9.9'; });
mutate('missing actual ACP', report => { delete report.runtime.acpVersion; });
mutate('ACP stage mismatch', report => { report.stages[2].evidence.acpVersion = '9.9.9'; });
mutate('ACP already inside the gate range', report => { report.runtime.acpVersion = report.stages[2].evidence.acpVersion = '0.2.1-rc.2'; });
mutate('another top-level failure', report => { report.error = 'PRIVATE_ERROR'; });
mutate('passed label contradicts installation failure', report => { report.status = 'passed'; });
for (const [name, error] of [
  ['other plugin', gateMessage().replaceAll('dsh-acp-door@', 'other-plugin@')],
  ['other door version', gateMessage().replaceAll(`dsh-acp-door@${current.door}`, 'dsh-acp-door@9.9.9')],
  ['other DSH version', gateMessage().replaceAll(`dsh ${requested}`, 'dsh 9.9.9')],
  ['other ACP requirement', gateMessage().replace('@deepseek-ai/dsh-acp', '@deepseek-ai/other')],
  ['other peer range', gateMessage().replace(current.peer, '*')],
  ['truncated gate', gateMessage().slice(0, -12)],
  ['incomplete legacy phrase', `Plugin dsh-acp-door@${current.door} is incompatible with dsh ${requested}: peerDependencies`],
  ['unknown policy phrase', gateMessage().replace('requirements', 'policy')],
  ['additional install error', gateMessage() + '\nERR_PNPM_FETCH_500 download failed'],
  ['timeout after gate', gateMessage() + '\nError: ETIMEDOUT'],
  ['active exemption', gateMessage().replace('not active.', 'active.')],
]) add(name, rejected(error));
mutate('passed missing required behavior', report => { report.stages = report.stages.filter(item => item.name !== 'stream'); }, completed());
mutate('passed unknown stage', report => { report.stages.push({ name: 'unknown', status: 'passed' }); }, completed());
mutate('passed with behavior failure', report => { report.stages.find(item => item.name === 'stream').status = 'failed'; }, completed());
mutate('passed with skipped behavior', report => { report.stages.find(item => item.name === 'stream').status = 'skipped'; }, completed());
mutate('passed with status ACP mismatch', report => { report.stages.find(item => item.name === 'status').evidence.runtime.acpVersion = requested; }, completed());
mutate('passed with resource abort', report => { report.resources.abort = 'Validation cancelled'; }, completed());
for (const item of cases) assert.equal(classifyProbe(item.report), item.status, item.name);
const supported = JSON.parse(fs.readFileSync(path.join(ROOT, 'compat/versions.json'))).versions.find(item => item.distribution === 'npm').dsh;
assert.throws(() => classifyProbe({ ...rejected(), requested: supported }), /required regression/);

const fixture = require('../test-workspace.cjs').createFixture('probe-cli');
try {
  fs.mkdirSync(path.join(fixture, 'compat')); fs.copyFileSync(path.join(ROOT, 'compat/versions.json'), path.join(fixture, 'compat/versions.json'));
  const tgz = path.join(fixture, 'candidate.tgz'); fs.writeFileSync(tgz, 'probe candidate fixture'); const candidateDigest = sha256(tgz);
  const hook = path.join(fixture, 'preload.cjs'), input = path.join(fixture, 'input.json');
  fs.writeFileSync(hook, `'use strict';\nconst fs = require('node:fs');\nconst lib = ${JSON.stringify(require.resolve('./lib.cjs'))};\nconst original = require(lib);\nrequire.cache[lib].exports = { ...original, ROOT: process.env.PROBE_FIXTURE };\nconst target = ${JSON.stringify(require.resolve('./test.cjs'))};\nrequire.cache[target] = { id: target, filename: target, loaded: true, exports: { run: async options => {\n  if (!options.install) throw new Error('Probe must install the requested runtime');\n  if (process.env.PROBE_MODE === 'tamper') fs.appendFileSync(options.tgz, 'changed');\n  if (process.env.PROBE_MODE === 'remove') fs.unlinkSync(options.tgz);\n  return JSON.parse(fs.readFileSync(process.env.PROBE_INPUT, 'utf8'));\n} } };\nconst cp = require('node:child_process');\nfor (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[name] = () => { throw new Error('Unexpected subprocess in offline probe fixture'); };\n`);
  function cli(report, dsh = requested, mode = '') {
    fs.writeFileSync(tgz, 'probe candidate fixture');
    const inputReport = report === undefined ? null : clone(report);
    if (inputReport?.artifacts?.[0]?.sha256 === 'e'.repeat(64)) inputReport.artifacts[0].sha256 = candidateDigest;
    if (Array.isArray(inputReport?.stages)) {
      const stage = inputReport.stages.find(item => item?.name === 'package');
      if (stage?.evidence?.sha256 === 'e'.repeat(64)) stage.evidence.sha256 = candidateDigest;
    }
    fs.writeFileSync(input, JSON.stringify(inputReport));
    const child = spawnSync(process.execPath, ['--require', hook, path.join(ROOT, 'tools/compat/probe.cjs'), '--dsh', dsh, '--tgz', tgz], {
      cwd: ROOT, env: { ...process.env, PROBE_FIXTURE: fixture, PROBE_INPUT: input, PROBE_MODE: mode }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert(!child.error, child.error?.message); assert.equal(child.signal, null);
    const output = path.join(fixture, 'build/probes/probe-result.json');
    return { child, result: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output)) : undefined };
  }
  for (const item of cases) {
    const { child, result } = cli(item.report);
    assert.equal(child.status, ['candidate-passed', 'not-declared'].includes(item.status) ? 0 : 1, item.name + ': CLI exit');
    assert.equal(result?.status, item.status, item.name + ': persisted classification');
    assert.equal(result.declaredSupported, false); assert.equal(result.dsh, requested);
    assert.equal(child.stdout.trim(), result.summary, item.name + ': public summary');
    assert(!JSON.stringify(result).includes('PRIVATE_'), item.name + ': private diagnostics');
    assert(!JSON.stringify(result).includes(fixture), item.name + ': private paths');
    if (item.status === 'not-declared') { assert.equal(result.behavior, 'not-run'); assert.match(result.summary, /behavior was not run/); }
    else if (item.status === 'candidate-passed') { assert.equal(result.behavior, 'passed'); assert.match(result.summary, /behavior passed/); }
    else { assert.equal(result.behavior, 'not-validated'); assert.match(result.summary, /probe failed/); }
  }
  for (const mode of ['tamper', 'remove']) {
    const { child, result } = cli(rejected(), requested, mode); assert.equal(child.status, 1); assert.equal(result.status, 'incompatible');
  }
  const declared = cli(rejected(), supported); assert.equal(declared.child.status, 1); assert.match(declared.child.stderr, /supported regression/); assert.equal(declared.result, undefined);
  const declaredAlias = cli(rejected(), 'v' + supported); assert.equal(declaredAlias.child.status, 1); assert.match(declaredAlias.child.stderr, /supported regression/); assert.equal(declaredAlias.result, undefined);
  const mismatched = cli(rejected(), '9.9.9'); assert.equal(mismatched.child.status, 1); assert.equal(mismatched.result.status, 'incompatible');

  const runtime = path.join(fixture, 'runtime/node_modules/@deepseek-ai/dsh'), acp = path.join(fixture, 'runtime/node_modules/@deepseek-ai/dsh-acp');
  fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true }); fs.mkdirSync(acp, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: requested }));
  fs.writeFileSync(path.join(acp, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-acp', version: '0.2.1-rc.2', exports: { './package.json': './package.json' } }));
  const entry = path.join(runtime, 'lib/bin.js'); fs.writeFileSync(entry, '');
  const { npmRuntimeInfo } = require('./test.cjs');
  assert.deepEqual(npmRuntimeInfo(entry, requested), { acpVersion: '0.2.1-rc.2' });
  assert.throws(() => npmRuntimeInfo(entry, '9.9.9'));
  fs.writeFileSync(path.join(acp, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-acp', version: 'unknown' }));
  assert.throws(() => npmRuntimeInfo(entry, requested), /ACP/);
} finally {
  require('../run-resources.cjs').plainParents(fixture); fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(`PASS supported regression and candidate discovery: ${cases.length} classification/CLI/public evidence cases, candidate integrity and resolved ACP identity`);
