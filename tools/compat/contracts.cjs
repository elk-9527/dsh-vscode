'use strict';
/** 版本声明、诊断脱敏及严格发布门槛的跨包契约。 */
const assert = require('node:assert/strict');
const os = require('node:os');
const { argsOf, safeObject, versions, semver, json, ROOT } = require('./lib.cjs');
const { validateReport, REQUIRED } = require('./release-check.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { dshCommandCandidates, explainKernelFailure } = require('../../packages/vscode-extension/src/door/locate');
const { mergeExclusions } = require('./install-local.cjs');
const { publicEvidence } = require('./public-evidence.cjs');

assert.deepEqual(mergeExclusions(['@scope/plugin@1.0.7', '@scope/plugin@1.0.10', 'billion-context@0.1.174', 'billion-context@0.1.175']), ['@scope/plugin@1.0.7 || 1.0.10', 'billion-context@0.1.174 || 0.1.175']);
assert.throws(() => mergeExclusions(['billion-context@*']));

assert.equal(explainKernelFailure({ stderr: 'Plugin dsh-acp-door@0.1.1 is incompatible with dsh 0.2.0-rc.2: peerDependencies' }).kind, 'plugin-incompatible');
if (process.platform === 'win32') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-command-'));
  try {
    const executable = path.join(temporary, 'DeepSeek Harness.exe');
    const cli = path.join(temporary, 'resources/runtime/cli/bin/dsh.cmd');
    fs.writeFileSync(executable, 'fixture'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '@echo off');
    const commands = dshCommandCandidates({ dshCommand: 'explicit-choice', homedir: temporary, desktopExecutables: [executable] });
    assert.equal(commands[0], 'explicit-choice');
    assert(commands.some((command) => command.includes(cli)));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

assert.deepEqual(argsOf(['--', '--dsh', '0.2.0-rc.2', '--json']), { dsh: '0.2.0-rc.2', json: true });
assert.equal(semver.satisfies('0.2.0-rc.2', '0.2.0-rc.1'), false);
assert.equal(semver.satisfies('0.2.0-rc.2', '^0.2.0'), false);
const redacted = safeObject({ apiKey: 'must-hide', nested: { path: path.join(os.homedir(), 'workspace'), text: 'Authorization: Bearer must-hide' } });
assert(!JSON.stringify(redacted).includes('must-hide'));
assert(!JSON.stringify(redacted).includes(os.homedir()));
const current = versions();
const publicResult = publicEvidence({ status: 'passed', source: { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64), path: 'PRIVATE_PATH' },
  packages: current, runtime: { version: '0.2.0-rc.2', acpVersion: '0.2.0-rc.2', distribution: 'desktop', command: 'PRIVATE_COMMAND' },
  accountsBefore: [{ ciphertextDigest: 'PRIVATE_DIGEST' }], backup: 'PRIVATE_BACKUP', error: 'PRIVATE_ERROR',
  stages: [{ name: 'tools', status: 'passed', evidence: { text: 'PRIVATE_PROMPT', cwd: 'PRIVATE_CWD' } }],
  artifacts: [{ kind: 'vsix', sha256: 'c'.repeat(64), file: 'PRIVATE_FILE' }] });
assert(!JSON.stringify(publicResult).includes('PRIVATE_'));
assert.equal(publicResult.stages[0].status, 'passed'); assert.equal(publicResult.runtime.version, '0.2.0-rc.2');
const state = { fingerprint: 'current-code' };
const report = { status: 'passed', packages: current, source: state, runtime: { version: '0.2.0-rc.1', acpVersion: '0.2.0-rc.1' }, stages: REQUIRED.map((name) => ({ name, status: 'passed' })) };
assert.deepEqual(validateReport(report, current, state), []);
assert(validateReport({ ...report, stages: report.stages.filter((item) => item.name !== 'tools') }, current, state).some((issue) => issue.includes('tools')));
assert(validateReport({ ...report, stages: report.stages.map((item) => item.name === 'tools' ? { ...item, status: 'skipped' } : item) }, current, state).some((issue) => issue.includes('tools')));
assert(validateReport(report, current, { fingerprint: 'changed-code' }).length);
assert(validateReport({ ...report, status: 'acquisition-failed' }, current, state).length);
assert(validateReport({ ...report, stages: [...report.stages, { name: 'tools', status: 'failed' }] }, current, state).length);
assert(validateReport({ ...report, runtime: { version: '0.2.0-rc.1' } }, current, state).length);
const matrix = json(path.join(ROOT, 'compat/versions.json'));
for (const entry of matrix.versions) {
  assert(semver.valid(entry.dsh));
  assert(['pending', 'passed', 'failed'].includes(entry.status));
  if (entry.status === 'passed') assert(entry.evidence.length);
}
console.log('PASS 兼容声明、预发布范围、脱敏、报告漂移、必测跳过与矩阵契约');
