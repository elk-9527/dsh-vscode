'use strict';
/** 版本声明、诊断脱敏及严格发布门槛的跨包契约。 */
const assert = require('node:assert/strict');
const os = require('node:os');
const { argsOf, safeObject, versions, semver, json, ROOT, contentSha256 } = require('./lib.cjs');
const { validateReport: validateCurrentReport, validateHistoricalReport, REQUIRED } = require('./release-check.cjs');
const validateReport = (report, current, state) => validateCurrentReport(report, current, state, { platform: 'win32' });
const path = require('node:path');
const fs = require('node:fs');
const { createFixture } = require('../test-workspace.cjs');
const { dshCommandCandidates, explainKernelFailure } = require('../../packages/vscode-extension/src/door/locate');
const { mergeExclusions } = require('./install-local.cjs');
const { publicEvidence } = require('./public-evidence.cjs');

assert.deepEqual(mergeExclusions(['@scope/plugin@1.0.7', '@scope/plugin@1.0.10', 'billion-context@0.1.174', 'billion-context@0.1.175']), ['@scope/plugin@1.0.7 || 1.0.10', 'billion-context@0.1.174 || 0.1.175']);
assert.throws(() => mergeExclusions(['billion-context@*']));
const attemptReport = { checks: [{ name: 'editor-failure', status: 'failed', evidence: 'first attempt' }, { name: 'self-failure', status: 'failed', evidence: 'unresolved' }] };
require('./local.cjs').completeAttempt(attemptReport, 'editor');
assert.deepEqual(attemptReport.previousFailures, [{ name: 'editor-failure', status: 'failed', evidence: 'first attempt' }]);
assert.deepEqual(attemptReport.checks, [{ name: 'self-failure', status: 'failed', evidence: 'unresolved' }]);
const contentFixture = createFixture('compat-content');
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
  const temporary = createFixture('compat-command');
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
assert(semver.satisfies('0.2.1-rc.2', current.peer), 'DSH 0.2.1-rc.2 必须能够通过接入点依赖检查');
assert(semver.satisfies('0.2.1-rc.3', current.peer), 'rc.3 适配候选必须能够通过精确依赖检查');
assert(!semver.satisfies('0.2.1-rc.4', current.peer), '未知预发布版不应自动进入支持范围');
const publicResult = publicEvidence({ status: 'passed', source: { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64), path: 'PRIVATE_PATH' },
  packages: current, runtime: { version: '0.2.0-rc.2', acpVersion: '0.2.0-rc.2', distribution: 'desktop', command: 'PRIVATE_COMMAND' },
  accountsBefore: [{ ciphertextDigest: 'PRIVATE_DIGEST' }], backup: 'PRIVATE_BACKUP', error: 'PRIVATE_ERROR',
  stages: [{ name: 'tools', status: 'passed', evidence: { text: 'PRIVATE_PROMPT', cwd: 'PRIVATE_CWD' } }],
  artifacts: [{ kind: 'vsix', sha256: 'c'.repeat(64), file: 'PRIVATE_FILE' }] });
assert(!JSON.stringify(publicResult).includes('PRIVATE_'));
assert.equal(publicResult.stages[0].status, 'passed'); assert.equal(publicResult.runtime.version, '0.2.0-rc.2');
const state = { fingerprint: 'a'.repeat(64), toolFingerprint: 'b'.repeat(64), lockFingerprint: 'c'.repeat(64) };
const report = { schemaVersion: 2, platform: 'win32', status: 'passed', packages: current, source: state, sourceStart: state, sourceEnd: state, runtime: { version: '0.2.0-rc.1', acpVersion: '0.2.0-rc.1', distribution: 'npm' }, artifacts: [{kind: 'tgz', sha256: 'd'.repeat(64)}], stages: REQUIRED.map((name) => ({ name, status: 'passed' })) };
assert.deepEqual(validateReport(report, current, state), []);
assert(validateReport({ ...report, stages: report.stages.filter((item) => item.name !== 'tools') }, current, state).some((issue) => issue.includes('tools')));
assert(validateReport({ ...report, stages: report.stages.map((item) => item.name === 'tools' ? { ...item, status: 'skipped' } : item) }, current, state).some((issue) => issue.includes('tools')));
assert(validateReport(report, current, { fingerprint: 'changed-code' }).length);
assert(validateReport({ ...report, status: 'acquisition-failed' }, current, state).length);
assert(validateReport({ ...report, stages: [...report.stages, { name: 'tools', status: 'failed' }] }, current, state).length);
assert(validateReport({ ...report, runtime: { version: '0.2.0-rc.1' } }, current, state).length);
const matrix = json(path.join(ROOT, 'compat/versions.json'));
const editorMatrix = json(path.join(ROOT, 'compat/editors.json'));
{
  const { CHECKS, requiredChecks } = require('./editor-evidence.cjs');
  const legacy = requiredChecks('1.85.0');
  assert.equal(legacy.length, CHECKS.length);
  assert(legacy.includes('native Chat unavailable keeps sidebar'));
  assert(legacy.includes('sidebar receives unsaved file reference'));
  assert(!legacy.includes('native participant registered'));
  assert.deepEqual(requiredChecks('1.91.0'), CHECKS);
  assert.deepEqual(requiredChecks('1.142.0'), CHECKS);
  assert.deepEqual(requiredChecks('1.90.2', true), CHECKS);
  assert.deepEqual(requiredChecks('1.90.2', false), legacy);
  assert(semver.satisfies('1.90.2', json(path.join(ROOT, 'packages/vscode-extension/package.json')).engines.vscode), 'VS Code 1.90.2 必须能够安装当前面板');
  const evidence = { status: 'passed', editor: '1.90.2', defaultLaunch: true, source: state, packages: current, vsixSha256: 'a'.repeat(64), checks: legacy.map(name => ({ name, status: 'passed' })) };
  const { validateHistoricalEditor: validateEditorEvidence } = require('./release-check.cjs');
  assert.deepEqual(validateEditorEvidence(evidence, evidence.vsixSha256, current, state), []);
  const nativeEvidence = { ...evidence, capabilities: { nativeChat: true }, checks: CHECKS.map(name => ({ name, status: 'passed' })) };
  assert.deepEqual(validateEditorEvidence(nativeEvidence, evidence.vsixSha256, current, state), []);
  assert(validateEditorEvidence({ ...evidence, capabilities: { nativeChat: true } }, evidence.vsixSha256, current, state).length);
  assert(validateEditorEvidence({ ...evidence, editor: '1.91.0' }, evidence.vsixSha256, current, state).length);
  assert(validateEditorEvidence({ ...evidence, checks: evidence.checks.filter(check => check.name !== 'native composer Git diff snapshot') }, evidence.vsixSha256, current, state).length);
  assert(validateEditorEvidence({ ...evidence, checks: evidence.checks.filter(check => check.name !== 'sidebar receives unsaved file reference') }, evidence.vsixSha256, current, state).length);
}
if (editorMatrix.supported?.length) {
  const { validateHistoricalEditor: validateEditorEvidence } = require('./release-check.cjs');
  const evidence = json(path.join(ROOT, editorMatrix.supported[0].evidence));
  const state = { fingerprint: evidence.source.fingerprint };
  const testedPackages = { ...current, ...evidence.packages };
  assert.deepEqual(validateEditorEvidence(evidence, evidence.vsixSha256, testedPackages, state), []);
  assert(validateEditorEvidence(evidence, evidence.vsixSha256, { ...testedPackages, door: 'changed' }, state).length);
  assert(validateEditorEvidence(evidence, '0'.repeat(64), testedPackages, state).length);
  assert(validateEditorEvidence({ ...evidence, defaultLaunch: false }, evidence.vsixSha256, testedPackages, state).length);
  assert(validateEditorEvidence({ ...evidence, checks: evidence.checks.slice(1) }, evidence.vsixSha256, testedPackages, state).length);
  assert(validateEditorEvidence(evidence, evidence.vsixSha256, testedPackages, { fingerprint: 'changed' }).length);
}
assert.equal(editorMatrix.minimum, json(path.join(ROOT, 'packages/vscode-extension/package.json')).engines.vscode.replace(/^\^/, ''));
assert.equal(json(path.join(ROOT, editorMatrix.evidence)).editor, editorMatrix.minimum);
for (const entry of matrix.versions) {
  assert(semver.valid(entry.dsh));
  assert(['pending', 'passed', 'failed'].includes(entry.status));
  if (entry.status === 'passed') assert(entry.evidence.length);
  if (entry.status === 'passed') for (const file of entry.evidence) assert.deepEqual(validateHistoricalReport(json(path.join(ROOT, file))), [], file);
}
require('./test-evidence.cjs');
console.log('PASS 兼容声明、预发布范围、脱敏、报告漂移、必测跳过与矩阵契约');
