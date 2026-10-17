'use strict';
/** 版本声明、诊断脱敏及严格发布门槛的跨包契约。 */
const assert = require('node:assert/strict');
const os = require('node:os');
const { argsOf, safeObject, versions, semver, json, ROOT, contentSha256 } = require('./lib.cjs');
const { validateReport, REQUIRED } = require('./release-check.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { dshCommandCandidates, explainKernelFailure } = require('../../packages/vscode-extension/src/door/locate');
const { mergeExclusions } = require('./install-local.cjs');
const { publicEvidence } = require('./public-evidence.cjs');

assert.deepEqual(mergeExclusions(['@scope/plugin@1.0.7', '@scope/plugin@1.0.10', 'billion-context@0.1.174', 'billion-context@0.1.175']), ['@scope/plugin@1.0.7 || 1.0.10', 'billion-context@0.1.174 || 0.1.175']);
assert.throws(() => mergeExclusions(['billion-context@*']));
const attemptReport = { checks: [{ name: 'editor-failure', status: 'failed', evidence: 'first attempt' }, { name: 'self-failure', status: 'failed', evidence: 'unresolved' }] };
require('./local.cjs').completeAttempt(attemptReport, 'editor');
assert.deepEqual(attemptReport.previousFailures, [{ name: 'editor-failure', status: 'failed', evidence: 'first attempt' }]);
assert.deepEqual(attemptReport.checks, [{ name: 'self-failure', status: 'failed', evidence: 'unresolved' }]);
const contentFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-content-'));
try {
  const first = path.join(contentFixture, 'first'), second = path.join(contentFixture, 'second');
  const compare = (a, b) => { fs.writeFileSync(first, a); fs.writeFileSync(second, b); return contentSha256(first) === contentSha256(second); };
  assert(compare('first\r\nsecond\r\n', 'first\nsecond\n'));
  assert(!compare('first\nsecond\n', 'first\nchanged\n'));
  assert(!compare('first\n', 'first'));
  assert(!compare('\uFEFFfirst\n', 'first\n'));
  assert(!compare(Buffer.from([0, 13, 10]), Buffer.from([0, 10])));
  assert(!compare(Buffer.from([255, 13, 10]), Buffer.from([255, 10])));
} finally { fs.rmSync(contentFixture, { recursive: true, force: true }); }

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
const editorMatrix = json(path.join(ROOT, 'compat/editors.json'));
if (editorMatrix.supported?.length) {
  const { validateEditorEvidence } = require('./release-check.cjs');
  const evidence = json(path.join(ROOT, editorMatrix.supported[0].evidence));
  const state = { fingerprint: evidence.source.fingerprint };
  assert.deepEqual(validateEditorEvidence(evidence, evidence.vsixSha256, current, state), []);
  assert(validateEditorEvidence(evidence, '0'.repeat(64), current, state).length);
  assert(validateEditorEvidence({ ...evidence, defaultLaunch: false }, evidence.vsixSha256, current, state).length);
  assert(validateEditorEvidence({ ...evidence, checks: evidence.checks.slice(1) }, evidence.vsixSha256, current, state).length);
  assert(validateEditorEvidence(evidence, evidence.vsixSha256, current, { fingerprint: 'changed' }).length);
}
assert.equal(editorMatrix.minimum, json(path.join(ROOT, 'packages/vscode-extension/package.json')).engines.vscode.replace(/^\^/, ''));
assert.equal(json(path.join(ROOT, editorMatrix.evidence)).editor, editorMatrix.minimum);
for (const entry of matrix.versions) {
  assert(semver.valid(entry.dsh));
  assert(['pending', 'passed', 'failed'].includes(entry.status));
  if (entry.status === 'passed') assert(entry.evidence.length);
}
console.log('PASS 兼容声明、预发布范围、脱敏、报告漂移、必测跳过与矩阵契约');
