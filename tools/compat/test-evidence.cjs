'use strict';
const assert = require('node:assert/strict');
const { validateIdentity, validateReport, validateHistoricalReport, validateReleaseApproval, readReleaseApproval, evaluateRelease, releaseCheck, releaseRequirements,
  PREFLIGHT_COMMANDS, preflightSummary, strictSummary, REQUIRED, LOCAL, FINGERPRINTS, REAL_WORKFLOW, REAL_LOGS, STRICT_COMMAND } = require('./release-check.cjs');
const { requiredChecks, editorEvidence } = require('./editor-evidence.cjs');
const fs = require('node:fs'), path = require('node:path');
const { ROOT, sha256 } = require('./lib.cjs');
const current = { panel: '1.0.0', door: '1.0.0', sdk: '1.0.0', peer: '1.0.0', vscode: '^1.90.2' };
const state = { fingerprint: 'a'.repeat(64), toolFingerprint: 'b'.repeat(64), lockFingerprint: 'c'.repeat(64) };
const base = { schemaVersion: 2, platform: 'win32', status: 'passed', packages: current, source: state, sourceStart: state, sourceEnd: state };
const artifacts = [{ kind: 'tgz', sha256: 'd'.repeat(64) }, { kind: 'vsix', sha256: 'e'.repeat(64) }, { kind: 'sdk', sha256: 'f'.repeat(64) }];
const report = { ...base, runtime: { version: '1.0.0', acpVersion: '1.0.0', distribution: 'npm' }, artifacts: [artifacts[0]], stages: REQUIRED.map(name => ({ name, status: 'passed' })) };
const expected = { platform: 'win32', dsh: '1.0.0', distribution: 'npm', tgzSha256: artifacts[0].sha256 };
assert.deepEqual(validateReport(report, current, state, expected), []);
for (const key of FINGERPRINTS) {
  assert(validateIdentity({ ...base, sourceStart: { ...state, [key]: '0'.repeat(64) } }, current, state, 'win32').length);
  assert(validateIdentity({ ...base, sourceEnd: { ...state, [key]: '0'.repeat(64) } }, current, state, 'win32').length);
  assert(validateIdentity(base, current, { ...state, [key]: '0'.repeat(64) }, 'win32').length);
  const missing = { ...state }; delete missing[key];
  assert(validateIdentity({ ...base, sourceStart: missing }, current, state, 'win32').length);
}
assert(validateReport({ ...report, platform: 'linux' }, current, state, expected).length);
assert(validateReport(report, current, state, { ...expected, distribution: 'desktop' }).length);
assert(validateReport(report, current, state, { ...expected, tgzSha256: '0'.repeat(64) }).length);
assert(validateReport({ ...report, stages: [...report.stages, report.stages[0]] }, current, state, expected).length);
assert.deepEqual(validateReport({ ...report, stages: [...report.stages, { name: 'optional-platform', status: 'not-applicable', required: false }] }, current, state, expected), []);
for (const status of ['failed', 'skipped', 'not-applicable', 'environment-blocked']) assert(validateReport({ ...report, stages: report.stages.map((stage, index) => index ? stage : { ...stage, status }) }, current, state, expected).length);
const legacy = { ...report, schemaVersion: 1 }; delete legacy.sourceStart; delete legacy.sourceEnd;
assert.deepEqual(validateHistoricalReport(legacy), []);
assert(validateReport(legacy, current, state, expected).length);
const strictLog = '\n汇总：\n  ✅ first suite  (0.1s)\n  ✅ second suite  (0.2s)\n\n✅ 全部套件通过（共 2 个）\n';
const summary = strictSummary(strictLog);
assert.deepEqual(summary, { suites: 2, passed: 2, complete: true });
for (const output of ['', strictLog.replace('共 2 个', '共 3 个'), strictLog.replace('second suite', 'first suite'), strictLog.replace('✅ second', '⏭ second'), strictLog.replace('✅ second', '❌ second'), strictLog + '\n❌ 1 个套件失败\n']) assert.equal(strictSummary(output).complete, false);
assert.equal(strictSummary(strictLog + '\n汇总：\n  ❌ later suite  (0.1s)\n\n❌ 1 个套件失败\n').complete, false, '不能误用较早的成功汇总');
const workflowEvidence = Object.fromEntries(['strictRegression', 'realWorkflow'].map(key => {
  const directory = `build/evidence-fixture/${key}`;
  return [key, { file: `${directory}/${key === 'strictRegression' ? 'regression' : 'real'}-report.json`, sha256: '1'.repeat(64),
    logs: (key === 'strictRegression' ? ['full-suite.log'] : REAL_LOGS).map(name => ({ name, file: `${directory}/${name}`, sha256: '1'.repeat(64) })) }];
}));
const workflowDigests = Object.fromEntries(Object.values(workflowEvidence).flatMap(item => [item, ...item.logs]).map(item => [item.file, item.sha256]));
const realEvidence = {
  'real-runtime-catalog': { runtime: '1.0.0', provider: 'fixture-provider', model: 'fixture-model', capabilities: 7 },
  'real-session-start': { created: true }, 'real-permission-catalog': { read: true }, 'real-permission-selection': { value: 'workspace-write', confirmed: true },
  'real-model-native-review': { findings: 1, structuredResult: true }, 'review-keeps-workspace': { unchanged: true },
  'real-independent-regression-before-fix': { executionId: 'before', exitCode: 1, cwd: 'generated-fixture', interface: 'mock-vscode-task-adapter' },
  'real-model-read-only-repair-suggestion': { permission: 'read-only', generationPath: 'llm-direct-v1', toolsEnabled: false, edits: 1, toolEvents: 0, workspaceUnchanged: true },
  'real-repair-editor-application': { interface: 'mock-vscode-editor-adapter', previewed: true, saved: false, diskUnchanged: true },
  'real-independent-regression-after-fix': { executionId: 'after', exitCode: 0, separateFromChat: true, distinctExecution: true },
  'real-model-re-review': { findings: 0, sameCase: true, distinctOperation: true, workspaceUnchanged: true },
  'real-workflow-durable-offline-read': { reviews: 2, testExecutions: 2, exactRawText: true, source: 'local-report-store' },
  'real-profile-skills-health': { ok: true }, 'test-kernel-cleanup': { portClosed: true },
};
const input = { current, state, platform: 'win32', kernelReports: [report], combinations: [{ dsh: '1.0.0', distribution: 'npm', platform: 'win32' }], minimum: '1.90.2', artifacts, candidateManifest: { ...base, artifacts },
  editorReports: ['1.90.2', '1.91.1', '1.142.0'].map(editor => ({ ...base, editor, defaultLaunch: true, vsixSha256: artifacts[1].sha256, checks: requiredChecks(editor).map(name => ({ name, status: 'passed' })) })),
  localReport: { ...base, artifacts, checks: LOCAL.map(name => ({ name, status: 'passed', evidence: name === 'vsix-editor' ? { paths: ['attach', 'self'].map(mode => ({ mode, exitCode: 0, vsixSha256: artifacts[1].sha256, log: mode + '.log', logSha256: '1'.repeat(64) })) } : { observed: true } })) },
  localLogDigests: { 'attach.log': '1'.repeat(64), 'self.log': '1'.repeat(64) },
  preflight: Object.fromEntries(['quick-ui', 'contracts'].map(name => [name, { ...base, evidenceVersion: 1, checks: [{ name, status: 'passed', command: PREFLIGHT_COMMANDS[name], exitCode: 0, stable: true,
    summary: name === 'quick-ui' ? summary : { complete: true }, logs: ['stdout', 'stderr'].map(stream => ({ stream, file: name + '.' + stream, sha256: '1'.repeat(64) })) }] }])),
  preflightEvidence: { file: 'preflight.json', sha256: '1'.repeat(64) }, preflightDigests: Object.fromEntries(['preflight.json', ...['quick-ui', 'contracts'].flatMap(name => ['stdout', 'stderr'].map(stream => name + '.' + stream))].map(file => [file, '1'.repeat(64)])),
  preflightSummaries: { 'quick-ui': summary, contracts: { complete: true } },
  strictRegression: { ...base, scope: 'candidate-door-regression', command: STRICT_COMMAND, exitCode: 0, suites: 2, summary, log: { file: workflowEvidence.strictRegression.logs[0].file, sha256: '1'.repeat(64) }, artifacts: [artifacts[0]] },
  realWorkflow: { ...base, artifacts: [artifacts[0], artifacts[2]], checks: REAL_WORKFLOW.map(name => ({ name, status: 'passed', evidence: realEvidence[name] })) },
  workflowEvidence, workflowDigests, strictLogSummary: summary };
input.reportEvidence = Object.fromEntries(['candidateManifest', 'localReport', 'kernelReports', 'editorReports'].map(key => [key, key.endsWith('Reports') ? input[key].map((_, index) => ({ file: key + index, sha256: '1'.repeat(64) })) : { file: key, sha256: '1'.repeat(64) }]));
input.reportDigests = Object.fromEntries(Object.values(input.reportEvidence).flat().map(item => [item.file, item.sha256]));
const approval = evaluateRelease(input);
assert.equal(approval.releaseReady, true, approval.issues.join('; '));
assert.deepEqual(validateReleaseApproval(approval, { kind: 'vsix', sha256: artifacts[1].sha256, current, state, platform: 'win32' }), []);
assert(validateReleaseApproval(approval, { kind: 'vsix', sha256: artifacts[0].sha256, current, state, platform: 'win32' }).length);
assert(validateReleaseApproval({ ...approval, checks: [...approval.checks, approval.checks[0]] }, { kind: 'vsix', sha256: artifacts[1].sha256, current, state, platform: 'win32' }).length);
for (const name of Object.keys(PREFLIGHT_COMMANDS)) {
  for (const change of [{ exitCode: 17 }, { stable: false }, { command: ['child-success.js'] }, { logs: [] }, { status: 'skipped' }, { summary: { complete: false } }]) {
    const value = structuredClone(input); Object.assign(value.preflight[name].checks[0], change);
    assert.equal(evaluateRelease(value).checks.find(item => item.name === name).status, 'failed');
  }
  const duplicate = structuredClone(input); duplicate.preflight[name].checks.push(duplicate.preflight[name].checks[0]); assert(!evaluateRelease(duplicate).releaseReady);
}
assert(!evaluateRelease({ ...input, preflightDigests: {} }).releaseReady);
const pending = evaluateRelease({ ...input, kernelReports: [] });
const tampered = { ...pending, status: 'passed', releaseReady: true, issues: [], checks: approval.checks };
assert(validateReleaseApproval(tampered, { kind: 'vsix', sha256: artifacts[1].sha256, current, state, platform: 'win32' }).length, '顶层改成 passed 不得掩盖缺失内核证据');
assert(validateReleaseApproval(approval, { kind: 'vsix', sha256: artifacts[1].sha256, current, state, platform: 'win32', requirements: { combinations: [{ dsh: '2.0.0', distribution: 'npm' }] } }).length, '当前声明覆盖报告里的旧要求');
assert(validateReleaseApproval(approval, { kind: 'vsix', sha256: artifacts[1].sha256, current, state, platform: 'win32', requirements: { artifacts: artifacts.map(item => item.kind === 'tgz' ? { ...item, sha256: '0'.repeat(64) } : item) } }).length, '其他候选文件摘要漂移也应阻止当前上传');
for (const key of ['strictRegression', 'realWorkflow']) {
  for (const changed of [undefined, { ...input[key], schemaVersion: 1 }, { ...input[key], status: 'failed' }, { ...input[key], sourceEnd: { ...state, toolFingerprint: '0'.repeat(64) } }, { ...input[key], platform: 'linux' }, { ...input[key], artifacts: [] }]) {
    assert.equal(evaluateRelease({ ...input, [key]: changed }).releaseReady, false, `${key} 不能接受缺失、历史、失败、过期、错误平台或候选`);
  }
  const absent = evaluateRelease({ ...input, [key]: undefined });
  assert(validateReleaseApproval({ ...absent, status: 'passed', releaseReady: true, issues: [], checks: approval.checks }, { kind: 'vsix', sha256: artifacts[1].sha256, current, state, platform: 'win32' }).length, `${key} 缺失不能由汇总 passed 掩盖`);
  assert.equal(evaluateRelease({ ...input, workflowEvidence: { ...workflowEvidence, [key]: undefined } }).releaseReady, false);
  assert.equal(evaluateRelease({ ...input, workflowEvidence: { ...workflowEvidence, [key]: { ...workflowEvidence[key], logs: [...workflowEvidence[key].logs, workflowEvidence[key].logs[0]] } } }).releaseReady, false);
}
for (const change of [{ command: 'node test/run-all.js --all' }, { scope: 'source-regression' }, { exitCode: 1 }, { suites: 0 }, { suites: 3 }, { summary: { ...summary, complete: false } }, { log: { ...input.strictRegression.log, sha256: '0'.repeat(64) } }]) assert.equal(evaluateRelease({ ...input, strictRegression: { ...input.strictRegression, ...change } }).releaseReady, false);
assert.equal(evaluateRelease({ ...input, strictLogSummary: { ...summary, complete: false } }).releaseReady, false);
assert.equal(evaluateRelease({ ...input, workflowDigests: {} }).releaseReady, false);
for (const name of REAL_WORKFLOW) {
  for (const status of ['failed', 'skipped', 'not-applicable', 'environment-blocked']) assert.equal(evaluateRelease({ ...input, realWorkflow: { ...input.realWorkflow, checks: input.realWorkflow.checks.map(item => item.name === name ? { ...item, status } : item) } }).releaseReady, false);
  assert.equal(evaluateRelease({ ...input, realWorkflow: { ...input.realWorkflow, checks: input.realWorkflow.checks.filter(item => item.name !== name) } }).releaseReady, false);
  assert.equal(evaluateRelease({ ...input, realWorkflow: { ...input.realWorkflow, checks: [...input.realWorkflow.checks, input.realWorkflow.checks.find(item => item.name === name)] } }).releaseReady, false);
  assert.equal(evaluateRelease({ ...input, realWorkflow: { ...input.realWorkflow, checks: input.realWorkflow.checks.map(item => item.name === name ? { ...item, evidence: {} } : item) } }).releaseReady, false);
}
for (const [name, change] of [
  ['real-independent-regression-before-fix', { exitCode: 0 }], ['real-independent-regression-after-fix', { executionId: 'before' }],
  ['real-model-read-only-repair-suggestion', { permission: 'workspace-write' }], ['real-model-read-only-repair-suggestion', { toolEvents: 1 }],
  ['real-model-re-review', { findings: 1 }], ['real-workflow-durable-offline-read', { exactRawText: false }],
]) assert.equal(evaluateRelease({ ...input, realWorkflow: { ...input.realWorkflow, checks: input.realWorkflow.checks.map(item => item.name === name ? { ...item, evidence: { ...item.evidence, ...change } } : item) } }).releaseReady, false);
for (const changed of [{ ...input, kernelReports: [legacy] }, { ...input, kernelReports: [{ ...report, platform: 'linux' }] }, { ...input, editorReports: input.editorReports.slice(1) }, { ...input, artifacts: [] }, { ...input, preflight: undefined }]) {
  const result = evaluateRelease(changed); assert.equal(result.status, 'pending'); assert.equal(result.releaseReady, false);
}
assert.equal(evaluateRelease({ ...input, localLogDigests: {} }).releaseReady, false);
assert.equal(evaluateRelease({ ...input, localReport: { ...input.localReport, checks: input.localReport.checks.map(check => ({ ...check, evidence: undefined })) } }).releaseReady, false);
assert.equal(JSON.stringify(input).includes('releaseReady'), false, '纯验证不应改写输入报告');
const missingLocal = evaluateRelease({ ...input, localReport: undefined });
assert(missingLocal.issues.some(issue => issue.includes('本机报告缺失')));
assert(!missingLocal.issues.some(issue => /版本已变化|本机验收.*与候选不一致|证据平台不匹配/.test(issue)), '没有报告不能声称其版本、平台或摘要已变化');
assert.deepEqual(missingLocal.checks.find(check => check.name === 'local').reasons, ['missing']);
assert(evaluateRelease({ ...input, localReport: { ...input.localReport, status: 'failed' } }).checks.find(check => check.name === 'local').reasons.includes('failed'));
assert(evaluateRelease({ ...input, localReport: { ...input.localReport, sourceEnd: { ...state, toolFingerprint: '0'.repeat(64) } } }).checks.find(check => check.name === 'local').reasons.includes('stale'));
assert.equal(evaluateRelease({ ...input, artifacts: [...artifacts, { kind: 'tgz', sha256: undefined }] }).releaseReady, false, '无效重复候选也不能被忽略');
assert.equal(evaluateRelease({ ...input, editorReports: input.editorReports.map((item, index) => index ? item : { ...item, checks: [...item.checks, { name: 'unresolved-extra', status: 'failed' }] }) }).releaseReady, false);
const folder = fs.mkdtempSync(path.join(ROOT, 'build/compat-evidence-contract-'));
try {
  const write = (name, data) => { const file = path.join(folder, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); return file; };
  const materializeWorkflows = (value, prefix) => {
    for (const [name, report] of Object.entries(value.preflight)) {
      const stdout = name === 'quick-ui' ? strictLog : 'PASS 兼容声明、预发布范围、脱敏、报告漂移、必测跳过与矩阵契约\n';
      report.checks[0].logs = ['stdout', 'stderr'].map(stream => { const file = write(prefix + '/preflight/' + name + '.' + stream + '.log', stream === 'stdout' ? stdout : 'browser diagnostic after summary\n'); return { stream, file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file) }; });
      report.checks[0].summary = preflightSummary(name, stdout);
    }
    const rawPreflight = write(prefix + '/preflight.json', value.preflight);
    value.preflightEvidence = { file: path.relative(ROOT, rawPreflight).replace(/\\/g, '/'), sha256: sha256(rawPreflight) };
    value.preflightDigests = Object.fromEntries([value.preflightEvidence, ...Object.values(value.preflight).flatMap(report => report.checks[0].logs)].map(item => [item.file, item.sha256]));
    value.reportEvidence = Object.fromEntries(['candidateManifest', 'localReport', 'kernelReports', 'editorReports'].map(key => {
      const reference = (data, index) => { const file = write(prefix + '/inputs/' + key + index + '.json', data); return { file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file) }; };
      return [key, key.endsWith('Reports') ? value[key].map(reference) : reference(value[key], 0)];
    }));
    value.reportDigests = Object.fromEntries(Object.values(value.reportEvidence).flat().map(item => [item.file, item.sha256]));
    value.workflowEvidence = {};
    for (const key of ['strictRegression', 'realWorkflow']) {
      const logs = (key === 'strictRegression' ? ['full-suite.log'] : REAL_LOGS).map(name => {
        const file = write(`${prefix}/${key}/${name}`, name === 'full-suite.log' ? strictLog : `fixture ${name}\n`);
        return { name, file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file) };
      });
      if (key === 'strictRegression') value[key].log = { file: logs[0].file, sha256: logs[0].sha256 };
      const file = write(`${prefix}/${key}/${key === 'strictRegression' ? 'regression' : 'real'}-report.json`, value[key]);
      value.workflowEvidence[key] = { file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file), logs };
    }
    value.workflowDigests = Object.fromEntries(Object.values(value.workflowEvidence).flatMap(item => [item, ...item.logs]).map(item => [item.file, item.sha256]));
  };
  const replacements = artifacts.map(item => { const file = write(`candidate.${item.kind}`, item.kind); return [item.sha256, sha256(file), file]; });
  let text = JSON.stringify(input); for (const [before, after] of replacements) text = text.split(before).join(after);
  const fixture = JSON.parse(text);
  for (const item of fixture.artifacts) item.file = replacements.find(([, hash]) => hash === item.sha256)[2];
  fixture.candidateManifest.artifacts = fixture.artifacts;
  for (const item of fixture.localReport.checks.find(check => check.name === 'vsix-editor').evidence.paths) { item.log = write(`${item.mode}.log`, item.mode); item.logSha256 = sha256(item.log); }
  materializeWorkflows(fixture, 'workflow');
  const kernels = [fixture.kernelReports[0], { ...fixture.kernelReports[0], runtime: { ...fixture.kernelReports[0].runtime, distribution: 'desktop' } }];
  const matrix = { platform: 'win32', versions: [...kernels.map(item => ({ dsh: item.runtime.version, distribution: item.runtime.distribution, panel: '0.9.0', door: '0.9.0', evidence: ['absent-historical.json'] })), { dsh: '1.0.0', distribution: 'npm', panel: current.panel, door: current.door, sdk: current.sdk }], currentRelease: { status: 'pending', evidence: [] } };
  const editors = { minimum: '1.90.2', chatBaseline: '1.91.1', evidence: 'absent-historical-editor.json', supported: [{ editor: '1.91.1' }, { editor: '1.142.0' }], currentRelease: { status: 'pending', evidence: [] } };
  const context = { matrix, editors, current, state, platform: 'win32' };
  assert.equal(releaseRequirements(matrix, editors).combinations.length, 2, '产品版本历史不能重复增加必测组合');
  const rawEditor = { ...base, artifacts: [fixture.artifacts[1]], stages: [{ name: 'packed-vsix-native-editor', status: 'passed', result: { vscode: '1.90.2', diagnosticLaunchFlags: [], checks: requiredChecks('1.90.2'), vsixSha256: fixture.artifacts[1].sha256 } }] };
  assert.equal(editorEvidence(rawEditor, state, current, { vsix: fixture.artifacts[1].file, platform: 'win32' }).editor, '1.90.2');
  assert.throws(() => editorEvidence({ ...rawEditor, stages: [...rawEditor.stages, rawEditor.stages[0]] }, state, current, { vsix: fixture.artifacts[1].file, platform: 'win32' }), /唯一/);
  assert.throws(() => editorEvidence({ ...rawEditor, stages: [...rawEditor.stages, { name: 'unresolved', status: 'failed' }] }, state, current, { vsix: fixture.artifacts[1].file, platform: 'win32' }), /失败或跳过/);
  const repeatedObservations = { ...rawEditor, stages: [{ ...rawEditor.stages[0], result: { ...rawEditor.stages[0].result, checks: [...rawEditor.stages[0].result.checks, rawEditor.stages[0].result.checks[0]] } }] };
  assert.equal(editorEvidence(repeatedObservations, state, current, { vsix: fixture.artifacts[1].file, platform: 'win32' }).checks.length, requiredChecks('1.90.2').length, '重复观察同一能力可以归一化，不能误拒真实编辑器报告');
  const kernelFiles = kernels.map((item, index) => write(`kernel-${index}.json`, item));
  const editorFiles = [rawEditor, ...fixture.editorReports.slice(1)].map((item, index) => write(`editor-${index}.json`, item));
  const { writeEditorEvidence } = require('./editor-evidence.cjs');
  const editorOutput = path.join(folder, 'public-editor.json');
  assert.equal(writeEditorEvidence(editorFiles[0], editorOutput, { vsix: fixture.artifacts[1].file, platform: 'win32' }, { state, current }).editor, '1.90.2');
  assert.throws(() => writeEditorEvidence(editorFiles[0], editorOutput), /已存在/);
  const evidence = { schemaVersion: 1, kernelReports: kernelFiles.map(file => path.basename(file)), editorReports: editorFiles.map(file => path.basename(file)),
    candidateManifest: path.basename(write('candidate-manifest.json', fixture.candidateManifest)), localReport: path.basename(write('local-report.json', fixture.localReport)), preflight: path.basename(write('preflight.json', fixture.preflight)),
    strictRegression: path.relative(folder, path.resolve(ROOT, fixture.workflowEvidence.strictRegression.file)), realWorkflow: path.relative(folder, path.resolve(ROOT, fixture.workflowEvidence.realWorkflow.file)) };
  const evidenceFile = write('evidence.json', evidence);
  const result = releaseCheck({ evidence: evidenceFile }, context);
  assert.equal(result.releaseReady, true, result.issues.join('; '));
  assert.equal(result.validation.kernelReports.length, 2);
  assert.equal(result.validation.editorReports.length, 3);
  const registered = releaseCheck({ candidates: path.join(folder, evidence.candidateManifest), 'local-report': path.join(folder, evidence.localReport), preflight: path.join(folder, evidence.preflight),
    'strict-regression': path.join(folder, evidence.strictRegression), 'real-workflow': path.join(folder, evidence.realWorkflow) }, {
    ...context, matrix: { ...matrix, currentRelease: { evidence: kernelFiles } }, editors: { ...editors, currentRelease: { evidence: editorFiles } }
  });
  assert.equal(registered.releaseReady, true, registered.issues.join('; '));
  const emptyExplicit = releaseCheck({ evidence: write('empty-evidence.json', { ...evidence, kernelReports: [], editorReports: [] }) }, {
    ...context, matrix: { ...matrix, currentRelease: { evidence: kernelFiles } }, editors: { ...editors, currentRelease: { evidence: editorFiles } }
  });
  assert.equal(emptyExplicit.releaseReady, false, '显式空清单不能悄悄回退为已登记证据');
  assert.equal(emptyExplicit.validation.kernelReports.length, 0);
  assert.equal(emptyExplicit.validation.editorReports.length, 0);
  const missingFile = releaseCheck({ evidence: write('missing-evidence.json', { ...evidence, kernelReports: ['missing-kernel.json'] }) }, context);
  assert.equal(missingFile.releaseReady, false);
  assert(missingFile.issues.some(issue => issue.includes('内核证据文件缺失')));
  assert.equal(releaseCheck({ evidence: write('malformed-evidence.json', { ...evidence, editorReports: 'editor-0.json' }) }, context).releaseReady, false);
  for (const key of ['strictRegression', 'realWorkflow']) {
    const absent = { ...evidence }; delete absent[key];
    assert.equal(releaseCheck({ evidence: write(`missing-${key}.json`, absent) }, context).releaseReady, false);
    assert.equal(releaseCheck({ evidence: write(`array-${key}.json`, { ...evidence, [key]: [evidence[key], evidence[key]] }) }, context).releaseReady, false);
  }
  const { updateMatrix } = require('./matrix.cjs');
  const originalMatrix = JSON.stringify(matrix);
  const first = updateMatrix(matrix, kernels[0], current, state, kernelFiles[0], () => undefined);
  assert.equal(first.currentRelease.status, 'pending');
  assert.deepEqual(first.currentRelease.evidence, [kernelFiles[0]]);
  const second = updateMatrix(first, kernels[1], current, state, kernelFiles[1], file => file === kernelFiles[0] ? kernels[0] : undefined);
  assert.equal(second.currentRelease.status, 'passed');
  assert.deepEqual(second.versions.slice(0, matrix.versions.length), matrix.versions, '历史记录原样保留');
  assert.equal(JSON.stringify(matrix), originalMatrix, '登记规划不得改写调用者的矩阵');
  const changedState = { ...state, toolFingerprint: '0'.repeat(64) };
  const changed = { ...kernels[0], source: changedState, sourceStart: changedState, sourceEnd: changedState };
  const retried = updateMatrix(second, changed, current, changedState, 'new-current.json', file => file === kernelFiles[0] ? kernels[0] : kernels[1]);
  assert.equal(retried.currentRelease.status, 'pending', '工具变化后旧验收不得计入当前完整通过');
  assert.deepEqual(retried.currentRelease.evidence, ['new-current.json']);
  assert.equal(retried.versions.length, second.versions.length + 1, '同产品重新验收追加记录，保留旧身份');
  const { recordEvidence } = require('./matrix.cjs');
  fs.mkdirSync(path.join(folder, 'compat'), { recursive: true });
  write('compat/versions.json', matrix);
  const recordContext = { root: folder, current, state, platform: 'win32' };
  const registeredFile = recordEvidence(kernelFiles[0], recordContext);
  const registeredBytes = fs.readFileSync(path.join(folder, registeredFile));
  assert.equal(recordEvidence(kernelFiles[0], recordContext), registeredFile, '同一身份可幂等登记并修复未完成的矩阵写入');
  assert.deepEqual(fs.readFileSync(path.join(folder, registeredFile)), registeredBytes, '重跑不改原证据文件');
  recordEvidence(kernelFiles[1], recordContext);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'compat/versions.json'))).currentRelease.status, 'passed');
  const newRegisteredFile = recordEvidence(write('changed-kernel.json', changed), { ...recordContext, state: changedState });
  assert.notEqual(newRegisteredFile, registeredFile, '同产品不同工具输入得到新的不可覆盖身份');
  assert.deepEqual(fs.readFileSync(path.join(folder, registeredFile)), registeredBytes);
  const { writeReleaseReport } = require('./release-report.cjs');
  const output = path.join(folder, 'release.json');
  assert.equal(writeReleaseReport({ evidence: evidenceFile, out: output }, context).releaseReady, true);
  const saved = fs.readFileSync(output, 'utf8');
  assert.throws(() => writeReleaseReport({ out: output }, context), /已存在/);
  assert.equal(fs.readFileSync(output, 'utf8'), saved, '旧汇总报告不能被失败重跑覆盖');
  // Exercise the same disk reread used by real publication, with current local
  // identity and generated evidence only; no test, kernel or uploader is run.
  const { versions, sourceState, json } = require('./lib.cjs');
  const live = JSON.parse(JSON.stringify(fixture));
  const liveCurrent = versions(), liveState = sourceState();
  const liveRequirements = releaseRequirements(json(path.join(ROOT, 'compat/versions.json')), json(path.join(ROOT, 'compat/editors.json')));
  const identify = value => {
    if (!value || typeof value !== 'object') return;
    if (value.schemaVersion === 2 && value.packages) Object.assign(value, { packages: liveCurrent, source: liveState, sourceStart: liveState, sourceEnd: liveState, platform: process.platform });
    for (const child of Object.values(value)) identify(child);
  };
  identify(live);
  Object.assign(live, { current: liveCurrent, state: liveState, platform: process.platform, ...liveRequirements });
  live.kernelReports = liveRequirements.combinations.map(entry => ({ ...live.kernelReports[0], platform: entry.platform || process.platform,
    runtime: { version: entry.dsh, acpVersion: entry.dsh, distribution: entry.distribution } }));
  live.editorReports = liveRequirements.editorVersions.map(editor => ({ ...live.editorReports[0], editor, checks: requiredChecks(editor).map(name => ({ name, status: 'passed' })) }));
  live.realWorkflow.checks.find(item => item.name === 'real-runtime-catalog').evidence.runtime = liveRequirements.combinations[0].dsh;
  live.localLogDigests = Object.fromEntries(live.localReport.checks.find(item => item.name === 'vsix-editor').evidence.paths.map(item => [item.log, sha256(item.log)]));
  materializeWorkflows(live, 'publication');
  const publication = evaluateRelease(live);
  assert.equal(publication.releaseReady, true, publication.issues.join('; '));
  const publicationFile = write('publication-release.json', publication), candidateFile = live.artifacts.find(item => item.kind === 'vsix').file;
  assert.equal(readReleaseApproval(candidateFile, publicationFile, 'vsix').releaseReady, true);
  for (const key of ['strictRegression', 'realWorkflow']) {
    const originalFile = path.resolve(ROOT, live.workflowEvidence[key].file), originalBytes = fs.readFileSync(originalFile);
    fs.writeFileSync(originalFile, JSON.stringify({ ...JSON.parse(originalBytes), modifiedAfterApproval: true }));
    assert.throws(() => readReleaseApproval(candidateFile, publicationFile, 'vsix'), /原始报告/, '即使改后的原始 JSON 仍声称通过，也必须重新核验其固定摘要');
    fs.writeFileSync(originalFile, originalBytes);
    for (const item of [live.workflowEvidence[key], ...live.workflowEvidence[key].logs]) {
      const file = path.resolve(ROOT, item.file), bytes = fs.readFileSync(file);
      fs.appendFileSync(file, '\nchanged after approval\n');
      assert.throws(() => readReleaseApproval(candidateFile, publicationFile, 'vsix'), /发布被阻止/, `${key} 原始报告或任一实际日志被改写后必须拒绝`);
      fs.writeFileSync(file, bytes);
    }
    const forged = JSON.parse(JSON.stringify(publication)); forged.validation[key].status = 'failed';
    assert.throws(() => readReleaseApproval(candidateFile, write(`forged-${key}-release.json`, forged), 'vsix'), /原始报告与汇总中的内容不同/);
  }
  for (const item of [...Object.values(live.reportEvidence).flat(), live.preflightEvidence, ...Object.values(live.preflight).flatMap(report => report.checks[0].logs)]) {
    const file = path.resolve(ROOT, item.file), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, 'changed');
    for (const kind of ['vsix', 'tgz', 'sdk']) assert.throws(() => readReleaseApproval(live.artifacts.find(item => item.kind === kind).file, publicationFile, kind), /发布被阻止/);
    fs.writeFileSync(file, bytes); fs.renameSync(file, file + '.missing');
    assert.throws(() => readReleaseApproval(candidateFile, publicationFile, 'vsix'), /发布被阻止/); fs.renameSync(file + '.missing', file);
  }
  const forgedPreflight = structuredClone(publication); forgedPreflight.validation.preflight['quick-ui'].checks[0].exitCode = 17;
  assert.throws(() => readReleaseApproval(candidateFile, write('forged-preflight.json', forgedPreflight), 'vsix'), /原始报告与汇总中的内容不同/);
  assert.equal(readReleaseApproval(candidateFile, publicationFile, 'vsix').releaseReady, true, '原始字节恢复后重新核验通过');
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
console.log('PASS schema2 指纹起止、完整严格回归、真实工作流、日志摘要重验、候选身份与历史隔离');
