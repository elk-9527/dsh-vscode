'use strict';
/** 纯验证函数不运行测试、不写报告；CLI 仅装载已完成证据并打印结论。 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, argsOf, json, versions, sha256, sourceState, semver } = require('./lib.cjs');
const REQUIRED = ['runtime', 'package', 'installation', 'startup', 'handshake', 'status', 'session', 'model-switch', 'preset-switch', 'stream', 'permissions', 'permission-request', 'permission-cancel', 'tools', 'history', 'editor-context-snapshot', 'resume', 'cancel', 'cleanup'];
const LOCAL = ['desktop-attach', 'desktop-closed-self-start', 'configuration-inheritance', 'real-model-tool', 'local-kernel-cleanup', 'vsix-editor', 'installed-files'];
const FINGERPRINTS = ['fingerprint', 'toolFingerprint', 'lockFingerprint'];
const RELEASE_CHECKS = ['candidates', 'kernel-matrix', 'editors', 'local', 'quick-ui', 'contracts', 'strict-regression', 'real-workflow'];
const STRICT_COMMAND = 'node test/run-all.js --all --strict';
const PREFLIGHT_COMMANDS = { 'quick-ui': ['packages/vscode-extension/test/run-all.js', '--ui', '--strict'], contracts: ['tools/compat/contracts.cjs'] };
function preflightSummary(name, stdout) {
  return name === 'quick-ui' ? strictSummary(stdout) : { complete: String(stdout).trimEnd().split(/\r?\n/).at(-1) === 'PASS 兼容声明、预发布范围、脱敏、报告漂移、必测跳过与矩阵契约' };
}
function validatePreflight(name, report, reference, digests, summary, current, state, platform) {
  const issues = [...validateIdentity(report, current, state, platform), ...required(report?.checks, [name], '预检')];
  if (!reference?.file || !digest(reference.sha256) || digests?.[reference.file] !== reference.sha256) issues.push('预检原始报告缺失或摘要不同');
  if (report?.status !== 'passed' || report?.evidenceVersion !== 1) issues.push('预检报告未通过或缺少当前原始证据格式');
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  if (checks.length !== 1) issues.push('预检存在额外、重复或跳过检查');
  const check = checks[0];
  if (JSON.stringify(check?.command) !== JSON.stringify(PREFLIGHT_COMMANDS[name]) || check?.exitCode !== 0 || check?.stable !== true || check?.error) issues.push('预检命令、退出码或输入稳定性无效');
  const logs = Array.isArray(check?.logs) ? check.logs : [];
  if (logs.length !== 2) issues.push('预检必须保留 stdout 与 stderr');
  for (const stream of ['stdout', 'stderr']) {
    const matches = logs.filter(item => item?.stream === stream);
    if (matches.length !== 1 || !matches[0].file || !digest(matches[0].sha256) || digests?.[matches[0].file] !== matches[0].sha256) issues.push(`预检 ${stream} 日志缺失、重复或摘要不同`);
  }
  if (!summary?.complete || JSON.stringify(check?.summary) !== JSON.stringify(summary)) issues.push('预检总运行器实际汇总无效');
  return issues;
}
const REAL_WORKFLOW = ['real-runtime-catalog', 'real-session-start', 'real-permission-catalog', 'real-permission-selection',
  'real-model-native-review', 'review-keeps-workspace', 'real-independent-regression-before-fix', 'real-model-read-only-repair-suggestion',
  'real-repair-editor-application', 'real-independent-regression-after-fix', 'real-model-re-review', 'real-workflow-durable-offline-read',
  'real-profile-skills-health', 'test-kernel-cleanup'];
const REAL_LOGS = ['kernel.log', 'review-report.json', 'repair-suggestion.json', 'regression-1.log', 'regression-2.log', 're-review-report.json'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fileName = file => typeof file === 'string' ? path.relative(ROOT, path.resolve(ROOT, file)).replace(/\\/g, '/') : undefined;
/** Parse only the runner's final complete summary, never a child suite's success text. */
function strictSummary(output) {
  const text = String(output || '').replace(/\r\n/g, '\n');
  const index = text.lastIndexOf('\n汇总：\n');
  const lines = index < 0 ? [] : text.slice(index + '\n汇总：\n'.length).trimEnd().split('\n');
  const footer = /^✅ 全部套件通过（共 ([1-9]\d*) 个）$/.exec(lines.at(-1) || '');
  const rows = lines.slice(0, -1).filter(line => line.trim()).map(line => /^\s+(✅|⏭\s*|❌)\s+(.+?)\s+\([\d.]+s\)(.*)$/.exec(line));
  const names = rows.filter(Boolean).map(row => row[2]);
  return { suites: Number(footer?.[1]) || 0, passed: rows.filter(row => row?.[1] === '✅' && !row[3]).length,
    complete: Boolean(footer && rows.length && rows.every(row => row?.[1] === '✅' && !row[3]) && rows.length === Number(footer[1]) && new Set(names).size === names.length) };
}
function required(items, names, label) {
  const list = Array.isArray(items) ? items : [];
  return names.flatMap(name => {
    const matches = list.filter(item => item?.name === name);
    return matches.length !== 1 ? [`${label} ${name} ${matches.length ? '重复' : '缺失'}`] : matches[0].status === 'passed' ? [] : [`${label} ${name} 未通过（${matches[0].status || '无状态'}）`];
  });
}
function validateIdentity(report, current, state, platform) {
  if (!report || typeof report !== 'object') return ['验收报告缺失'];
  const issues = [];
  if (report?.schemaVersion !== 2) issues.push('当前验收需要 schemaVersion 2；历史报告不能升级为当前通过');
  if (!report.platform) issues.push('证据平台缺失');
  else if (report.platform !== platform || !['win32', 'linux', 'darwin'].includes(platform)) issues.push('证据平台不匹配');
  for (const name of ['panel', 'door', 'sdk']) {
    if (!report.packages?.[name]) issues.push(`报告缺少 ${name} 版本`);
    else if (report.packages[name] !== current?.[name]) issues.push(`报告对应的 ${name} 版本已变化`);
  }
  for (const key of FINGERPRINTS) {
    if (!digest(state?.[key]) || !digest(report?.sourceStart?.[key]) || !digest(report?.sourceEnd?.[key])) issues.push(`缺少起止 ${key}`);
    else if (report.sourceStart[key] !== report.sourceEnd[key] || report.sourceEnd[key] !== state[key]) issues.push(`验收期间或之后 ${key} 已变化`);
    if (report?.source?.[key] !== report?.sourceEnd?.[key]) issues.push(`报告 source 与结束 ${key} 不一致`);
  }
  return issues;
}
function validateWorkflowFiles(key, reference, digests) {
  const issues = [], reportName = key === 'strictRegression' ? 'regression-report.json' : 'real-report.json';
  if (!reference || typeof reference.file !== 'string' || path.basename(reference.file) !== reportName || !digest(reference.sha256) || digests?.[reference.file] !== reference.sha256) issues.push(`${key} 原始报告缺失或摘要不同`);
  const logs = Array.isArray(reference?.logs) ? reference.logs : [];
  const names = key === 'strictRegression' ? ['full-suite.log'] : REAL_LOGS;
  if (logs.length !== names.length) issues.push(`${key} 实际日志清单缺失或重复`);
  for (const name of names) {
    const matches = logs.filter(item => item?.name === name);
    const expected = typeof reference?.file === 'string' && fileName(path.join(path.dirname(path.resolve(ROOT, reference.file)), name));
    if (matches.length !== 1 || matches[0].file !== expected || !digest(matches[0].sha256) || digests?.[matches[0].file] !== matches[0].sha256) issues.push(`${key} ${name} 日志或产物缺失、重复或摘要不同`);
  }
  return issues;
}
function validateWorkflowReport(report, kinds, current, state, platform, artifacts) {
  const issues = validateIdentity(report, current, state, platform);
  if (report?.status !== 'passed' || report?.error || report?.cleanupError || report?.sourceChanged) issues.push('工作流报告未完整通过');
  for (const kind of kinds) {
    const matches = (Array.isArray(report?.artifacts) ? report.artifacts : []).filter(item => item?.kind === kind);
    if (matches.length !== 1 || !digest(matches[0].sha256) || matches[0].sha256 !== artifacts.find(item => item.kind === kind)?.sha256) issues.push(`工作流未验收同一份最终 ${kind}`);
  }
  return issues;
}
function validateStrictRegression(report, reference, digests, summary, current, state, platform, artifacts) {
  const issues = [...validateWorkflowReport(report, ['tgz'], current, state, platform, artifacts), ...validateWorkflowFiles('strictRegression', reference, digests)];
  if (report?.scope !== 'candidate-door-regression' || report?.command !== STRICT_COMMAND || report?.exitCode !== 0 || !Number.isSafeInteger(report?.suites) || report.suites < 1) issues.push('严格回归需要候选包、完整 --all --strict 命令、退出码 0 与正数套件数');
  if (!summary?.complete || summary.suites !== report?.suites || summary.passed !== report?.suites || JSON.stringify(report?.summary) !== JSON.stringify(summary)) issues.push('严格回归实际日志缺少完整全通过汇总或套件数不同');
  const log = (Array.isArray(reference?.logs) ? reference.logs : []).find(item => item?.name === 'full-suite.log');
  if (!log || report?.log?.file !== log.file || report?.log?.sha256 !== log.sha256) issues.push('严格回归报告与实际 full-suite.log 不一致');
  return issues;
}
function validateRealWorkflow(report, reference, digests, current, state, platform, artifacts) {
  const issues = [...validateWorkflowReport(report, ['tgz', 'sdk'], current, state, platform, artifacts), ...validateWorkflowFiles('realWorkflow', reference, digests), ...required(report?.checks, REAL_WORKFLOW, '真实工作流必测')];
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  if (checks.some(item => item?.status !== 'passed') || new Set(checks.map(item => item?.name)).size !== checks.length) issues.push('真实工作流存在失败、跳过或重复检查');
  const evidence = name => checks.find(item => item?.name === name)?.evidence || {};
  const expect = (name, valid) => { if (!valid) issues.push(`真实工作流 ${name} 实际证据不完整`); };
  const catalog = evidence('real-runtime-catalog');
  expect('real-runtime-catalog', semver.valid(catalog.runtime) && semver.satisfies(catalog.runtime, current?.peer || '') && typeof catalog.provider === 'string' && catalog.provider.length && typeof catalog.model === 'string' && catalog.model.length && Number.isSafeInteger(catalog.capabilities) && catalog.capabilities > 0);
  expect('real-session-start', evidence('real-session-start').created === true);
  expect('real-permission-catalog', evidence('real-permission-catalog').read === true);
  const selection = evidence('real-permission-selection'); expect('real-permission-selection', selection.confirmed === true && typeof selection.value === 'string' && selection.value.length);
  const review = evidence('real-model-native-review'); expect('real-model-native-review', Number.isSafeInteger(review.findings) && review.findings > 0 && review.structuredResult === true);
  expect('review-keeps-workspace', evidence('review-keeps-workspace').unchanged === true);
  const before = evidence('real-independent-regression-before-fix'), after = evidence('real-independent-regression-after-fix');
  expect('real-independent-regression-before-fix', before.exitCode === 1 && typeof before.executionId === 'string' && before.executionId.length && before.cwd === 'generated-fixture' && before.interface === 'mock-vscode-task-adapter');
  const repair = evidence('real-model-read-only-repair-suggestion');
  expect('real-model-read-only-repair-suggestion', repair.permission === 'read-only' && repair.generationPath === 'llm-direct-v1' && repair.toolsEnabled === false && Number.isSafeInteger(repair.edits) && repair.edits > 0 && repair.toolEvents === 0 && repair.workspaceUnchanged === true);
  const applied = evidence('real-repair-editor-application'); expect('real-repair-editor-application', applied.interface === 'mock-vscode-editor-adapter' && applied.previewed === true && applied.saved === false && applied.diskUnchanged === true);
  expect('real-independent-regression-after-fix', after.exitCode === 0 && typeof after.executionId === 'string' && after.executionId.length && after.executionId !== before.executionId && after.separateFromChat === true && after.distinctExecution === true);
  const again = evidence('real-model-re-review'); expect('real-model-re-review', again.findings === 0 && again.sameCase === true && again.distinctOperation === true && again.workspaceUnchanged === true);
  const offline = evidence('real-workflow-durable-offline-read'); expect('real-workflow-durable-offline-read', offline.reviews === 2 && offline.testExecutions === 2 && offline.exactRawText === true && offline.source === 'local-report-store');
  expect('real-profile-skills-health', evidence('real-profile-skills-health').ok === true);
  expect('test-kernel-cleanup', evidence('test-kernel-cleanup').portClosed === true);
  return issues;
}
function validateHistoricalReport(report) {
  const issues = [];
  if (![1, 2].includes(report?.schemaVersion)) issues.push('未知历史证据格式');
  if (report?.status !== 'passed') issues.push(`内核报告状态 ${report?.status}`);
  if (!digest(report?.source?.fingerprint)) issues.push('历史产品指纹缺失');
  for (const name of ['panel', 'door']) if (!semver.valid(report?.packages?.[name])) issues.push(`历史 ${name} 版本无效`);
  if (!semver.valid(report?.runtime?.version) || !semver.valid(report?.runtime?.acpVersion) || !['desktop', 'npm'].includes(report?.runtime?.distribution)) issues.push('历史运行时身份无效');
  if (!['win32', 'linux', 'darwin'].includes(report?.platform)) issues.push('历史平台缺失');
  if (report?.schemaVersion === 2) issues.push(...validateIdentity(report, report.packages, report.sourceEnd, report.platform));
  return [...issues, ...required(report?.stages, REQUIRED, '必测')];
}
function validateReport(report, current, state, expected = {}) {
  const issues = [...validateHistoricalReport(report), ...validateIdentity(report, current, state, expected.platform)];
  if (Array.isArray(report?.stages) && report.stages.some(stage => stage?.status !== 'passed' && !(stage?.required === false && stage.status === 'not-applicable'))) issues.push('内核报告仍有失败、跳过或必测环境缺失');
  if (!semver.satisfies(report?.runtime?.version || '', current?.peer || '')) issues.push('运行时不在当前兼容声明中');
  if (!semver.satisfies(report?.runtime?.acpVersion || '', current?.peer || '')) issues.push('实际 ACP 缺失或不在依赖声明中');
  if (['0.2.1-rc.2', '0.2.1-rc.3'].includes(report?.runtime?.acpVersion)) issues.push(...required(report?.stages, ['text-generation'], '直接无工具生成必测'));
  for (const key of ['dsh', 'distribution']) if (expected[key] && report?.runtime?.[key === 'dsh' ? 'version' : key] !== expected[key]) issues.push(`运行时 ${key} 与矩阵不匹配`);
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts.filter(item => item.kind === 'tgz') : [];
  if (artifacts.length !== 1 || !digest(artifacts[0].sha256) || expected.tgzSha256 && artifacts[0].sha256 !== expected.tgzSha256) issues.push('内核未验收同一份最终 tgz');
  return issues;
}
function validateHistoricalEditor(evidence, archive, current, state) {
  const issues = [];
  if (evidence?.status !== 'passed' || evidence?.defaultLaunch !== true || !semver.satisfies(evidence?.editor || '', current?.vscode || '^1.90.2')) issues.push('编辑器版本、状态或默认启动证据无效');
  if (evidence?.source?.fingerprint !== state?.fingerprint || evidence?.packages?.panel !== current?.panel || evidence?.packages?.door !== current?.door) issues.push('编辑器证据对应的产品已变化');
  if (!digest(evidence?.vsixSha256) || evidence.vsixSha256 !== archive) issues.push('编辑器未验收同一份最终 VSIX');
  if (!digest(evidence?.source?.fingerprint)) issues.push('历史编辑器产品指纹无效');
  const nativeChat = evidence?.capabilities?.nativeChat ?? (Array.isArray(evidence?.checks) && evidence.checks.some(check => check?.name === 'native participant registered' && check.status === 'passed'));
  return [...issues, ...required(evidence?.checks, require('./editor-evidence.cjs').requiredChecks(evidence?.editor, nativeChat, { historical: evidence?.schemaVersion === 1 }), '编辑器检查')];
}
function validateEditorEvidence(evidence, archive, current, state, platform) {
  return [...validateHistoricalEditor(evidence, archive, current, state), ...validateIdentity(evidence, current, state, platform),
    ...(Array.isArray(evidence?.checks) && evidence.checks.some(check => check?.status !== 'passed') ? ['编辑器验收仍有失败或跳过'] : [])];
}
function releaseRequirements(matrix, editors) {
  const combinations = [...new Map(matrix.versions.map(entry => {
    const value = { dsh: entry.dsh, distribution: entry.distribution, platform: entry.platform || matrix.platform };
    return [JSON.stringify(value), value];
  })).values()];
  return { combinations, minimum: editors.minimum, chatBaseline: editors.chatBaseline,
    editorVersions: [...new Set([editors.minimum, editors.chatBaseline, ...(editors.supported || []).map(entry => entry.editor)].filter(Boolean))] };
}
function validateReleaseApproval(report, { kind, sha256: archive, current, state, platform, requirements }) {
  const issues = validateIdentity(report, current, state, platform);
  if (report?.scope !== 'release' || report?.status !== 'passed' || report?.releaseReady !== true) issues.push('发布报告未确认当前完整发布要求');
  issues.push(...required(report?.checks, RELEASE_CHECKS, '发布检查'));
  if (report?.issues?.length || !Array.isArray(report?.issues)) issues.push('发布报告仍含未解决事项');
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts.filter(item => item.kind === kind) : [];
  if (artifacts.length !== 1 || !digest(archive) || artifacts[0]?.sha256 !== archive) issues.push(`待发布 ${kind} 与已验收文件摘要不一致`);
  if (!report?.validation) issues.push('缺少可重新验证的原始验收输入');
  else {
    const fresh = evaluateRelease({ ...report.validation, ...requirements, current, state, platform, inputIssues: [...(report.validation.inputIssues || []), ...(requirements?.inputIssues || []), ...(requirements?.preflightInputIssues || []), ...(requirements?.reportInputIssues || [])] });
    if (!fresh.releaseReady) issues.push(...fresh.issues.map(issue => `重新验证：${issue}`));
    if (JSON.stringify(report.artifacts) !== JSON.stringify(fresh.artifacts)) issues.push('发布摘要与重新验证的候选清单不同');
  }
  return issues;
}
function readReleaseApproval(candidateFile, reportFile, kind) {
  if (typeof candidateFile !== 'string' || typeof reportFile !== 'string') throw new Error('正式发布需要明确的候选包与发布报告');
  const report = json(path.resolve(reportFile));
  const matrix = json(path.join(ROOT, 'compat/versions.json')), editors = json(path.join(ROOT, 'compat/editors.json'));
  const requirements = releaseRequirements(matrix, editors);
  requirements.artifacts = (report.validation?.artifacts || []).map(item => ({ ...item, sha256: typeof item.file === 'string' && fs.existsSync(path.resolve(ROOT, item.file)) ? sha256(path.resolve(ROOT, item.file)) : undefined }));
  requirements.localLogDigests = localLogs(report.validation?.localReport);
  Object.assign(requirements, readWorkflowInputs(report.validation || {}), readPreflightInputs(report.validation || {}), readReportInputs(report.validation || {}, { current: versions(), state: sourceState(), platform: process.platform }));
  const issues = validateReleaseApproval(report, { kind, sha256: sha256(path.resolve(candidateFile)), current: versions(), state: sourceState(), platform: process.platform, requirements });
  if (issues.length) throw new Error(`发布被阻止：${issues.join('；')}`);
  return report;
}
function validateReportReferences(references, count, digests, label) {
  const list = Array.isArray(references) ? references : references ? [references] : [];
  return list.length !== count || new Set(list.map(item => item?.file)).size !== list.length || list.some(item => !item?.file || !digest(item.sha256) || digests?.[item.file] !== item.sha256) ? [`${label}原始报告引用缺失、重复或摘要不同`] : [];
}
function evaluateRelease({ current, state, platform, kernelReports, combinations, editorReports, minimum, chatBaseline = '1.91.1', editorVersions = [], localReport, localLogDigests = {}, artifacts = [], candidateManifest, preflight, preflightEvidence, preflightDigests = {}, preflightSummaries = {}, reportEvidence = {}, reportDigests = {},
  strictRegression, realWorkflow, workflowEvidence = {}, workflowDigests = {}, strictLogSummary, inputIssues = [] }) {
  const issues = [], checks = [];
  const reasons = report => !report ? ['missing'] : [
    ...(['panel', 'door', 'sdk'].some(name => report.packages?.[name] && report.packages[name] !== current?.[name]) || report.platform && report.platform !== platform || FINGERPRINTS.some(key => digest(report.sourceEnd?.[key]) && (report.sourceEnd[key] !== state?.[key] || digest(report.sourceStart?.[key]) && report.sourceStart[key] !== report.sourceEnd[key])) ? ['stale'] : []),
    ...(report.status && report.status !== 'passed' || ['checks', 'stages'].some(key => Array.isArray(report[key]) && report[key].some(item => item?.status && item.status !== 'passed' && !(item.required === false && item.status === 'not-applicable'))) ? ['failed'] : [])];
  const stage = (name, errors, causes = []) => { checks.push({ name, status: errors.length ? 'failed' : 'passed', ...(errors.length ? { reasons: [...new Set(causes.length ? causes : ['invalid'])] } : {}) }); issues.push(...errors); };
  const artifact = kind => artifacts.find(item => item.kind === kind)?.sha256;
  const candidateIssues = candidateManifest ? validateIdentity({ ...candidateManifest, source: candidateManifest.sourceEnd }, current, state, platform) : ['候选清单缺失'];
  candidateIssues.push(...inputIssues, ...validateReportReferences(reportEvidence.candidateManifest, 1, reportDigests, '候选清单'));
  for (const kind of ['tgz', 'vsix', 'sdk']) {
    if (artifacts.filter(item => item.kind === kind).length !== 1 || !digest(artifact(kind))) candidateIssues.push(`候选 ${kind} 缺失、重复或摘要无效`);
    const matches = (Array.isArray(candidateManifest?.artifacts) ? candidateManifest.artifacts : []).filter(item => item?.kind === kind);
    if (candidateManifest && (matches.length !== 1 || matches[0].sha256 !== artifact(kind))) candidateIssues.push(`候选清单 ${kind} 与实际文件不同`);
    const actual = artifacts.find(item => item.kind === kind);
    if (matches.length === 1 && actual?.file !== matches[0].file && actual?.producerFile !== matches[0].file) candidateIssues.push(`候选 ${kind} 本机路径缺少原始生产者绑定`);
  }
  stage('candidates', candidateIssues, reasons(candidateManifest));
  const kernelIssues = [], kernelReasons = [];
  if (!combinations?.length) kernelIssues.push('没有声明的内核验收组合');
  for (const entry of combinations || []) {
    const targetPlatform = entry.platform || platform;
    const matches = (kernelReports || []).filter(report => report.platform === targetPlatform && report.runtime?.version === entry.dsh && report.runtime?.distribution === entry.distribution);
    if (matches.length !== 1) { kernelIssues.push(`${entry.dsh}/${entry.distribution}/${targetPlatform} 当前证据${matches.length ? '重复' : '缺失'}`); kernelReasons.push(matches.length ? 'invalid' : 'missing'); }
    else { kernelIssues.push(...validateReport(matches[0], current, state, { platform: targetPlatform, dsh: entry.dsh, distribution: entry.distribution, tgzSha256: artifact('tgz') })); kernelReasons.push(...reasons(matches[0])); }
  }
  kernelIssues.push(...validateReportReferences(reportEvidence.kernelReports, (kernelReports || []).length, reportDigests, '内核'));
  stage('kernel-matrix', kernelIssues, kernelReasons);
  const editorIssues = [];
  if (!(editorReports || []).some(report => report.editor === minimum)) editorIssues.push('最低编辑器缺少当前证据');
  if (!(editorReports || []).some(report => report.editor === chatBaseline)) editorIssues.push('Chat 基线编辑器缺少当前证据');
  if ((editorReports || []).length < 3 || new Set((editorReports || []).map(report => report.editor)).size < 3) editorIssues.push('最低、Chat 基线、稳定版三个编辑器证据不齐');
  for (const editor of editorVersions) if ((editorReports || []).filter(report => report.editor === editor).length !== 1) editorIssues.push(`${editor} 编辑器证据缺失或重复`);
  if (new Set((editorReports || []).map(report => report.editor)).size !== (editorReports || []).length) editorIssues.push('编辑器版本证据重复');
  for (const report of editorReports || []) editorIssues.push(...validateEditorEvidence(report, artifact('vsix'), current, state, platform));
  editorIssues.push(...validateReportReferences(reportEvidence.editorReports, (editorReports || []).length, reportDigests, '编辑器'));
  const editorMissing = new Set((editorReports || []).map(report => report.editor)).size < 3 || [minimum, chatBaseline, ...editorVersions].some(editor => !(editorReports || []).some(report => report.editor === editor));
  stage('editors', editorIssues, [...(editorMissing ? ['missing'] : []), ...(editorReports || []).flatMap(reasons)]);
  const localIssues = localReport ? validateIdentity(localReport, current, state, platform) : ['本机报告缺失'];
  if (localReport) {
    const localChecks = Array.isArray(localReport.checks) ? localReport.checks : [];
    if (localReport.status !== 'passed') localIssues.push('本机报告未通过');
    for (const kind of ['tgz', 'vsix']) if (artifacts.filter(item => item.kind === kind && digest(item.sha256)).length !== 1) localIssues.push(`最终 ${kind} 安装包缺失、重复或摘要无效`);
    localIssues.push(...required(localChecks, LOCAL, '本机必测'));
    for (const name of LOCAL) if (!localChecks.find(check => check?.name === name)?.evidence) localIssues.push(`本机必测 ${name} 缺少实际证据`);
    if (localChecks.some(check => check?.status !== 'passed')) localIssues.push('本机验收仍有失败或跳过');
    for (const kind of ['tgz', 'vsix']) { const matches = (Array.isArray(localReport.artifacts) ? localReport.artifacts : []).filter(item => item?.kind === kind); if (matches.length !== 1 || matches[0].sha256 !== artifact(kind)) localIssues.push(`本机验收 ${kind} 与候选不一致或重复`); }
    const editorPaths = localChecks.find(check => check?.name === 'vsix-editor')?.evidence?.paths;
    if (!Array.isArray(editorPaths) || editorPaths.length !== 2 || !['attach', 'self'].every(mode => editorPaths.filter(item => item?.mode === mode && item.exitCode === 0 && item.vsixSha256 === artifact('vsix')).length === 1)) localIssues.push('本机 VSIX 缺少同一候选的双路径编辑器验收');
    for (const item of Array.isArray(editorPaths) ? editorPaths : []) if (!item?.log || !digest(item.logSha256) || localLogDigests[item.log] !== item.logSha256) localIssues.push('本机编辑器验收日志缺失或摘要不同');
  }
  localIssues.push(...validateReportReferences(reportEvidence.localReport, 1, reportDigests, '本机'));
  stage('local', localIssues, reasons(localReport));
  for (const name of ['quick-ui', 'contracts']) {
    const report = preflight?.[name];
    stage(name, report ? validatePreflight(name, report, preflightEvidence, preflightDigests, preflightSummaries[name], current, state, platform) : [`${name} 预检报告缺失`], reasons(report));
  }
  stage('strict-regression', validateStrictRegression(strictRegression, workflowEvidence.strictRegression, workflowDigests, strictLogSummary, current, state, platform, artifacts), reasons(strictRegression));
  stage('real-workflow', validateRealWorkflow(realWorkflow, workflowEvidence.realWorkflow, workflowDigests, current, state, platform, artifacts), reasons(realWorkflow));
  const validation = { kernelReports, combinations, editorReports, minimum, chatBaseline, editorVersions, localReport, localLogDigests, artifacts, candidateManifest, preflight, preflightEvidence, preflightDigests, preflightSummaries, reportEvidence, reportDigests,
    strictRegression, realWorkflow, workflowEvidence, workflowDigests, strictLogSummary, inputIssues };
  return { schemaVersion: 2, scope: 'release', status: issues.length ? 'pending' : 'passed', releaseReady: !issues.length, platform, packages: current, source: state, sourceStart: state, sourceEnd: state, artifacts, issues, checks, validation };
}
function localLogs(report) {
  const paths = (Array.isArray(report?.checks) ? report.checks : []).find(check => check?.name === 'vsix-editor')?.evidence?.paths;
  return Object.fromEntries((Array.isArray(paths) ? paths : []).map(item => [item.log, typeof item.log === 'string' && fs.existsSync(path.resolve(ROOT, item.log)) ? sha256(path.resolve(ROOT, item.log)) : undefined]));
}
function fileDigest(file) {
  try { return typeof file === 'string' && fs.statSync(path.resolve(ROOT, file)).isFile() ? sha256(path.resolve(ROOT, file)) : undefined; }
  catch { return undefined; }
}
/** References stay in the local release report; raw logs and model output are never public evidence. */
function workflowReference(file, key) {
  if (typeof file !== 'string') return undefined;
  const report = fileName(file), names = key === 'strictRegression' ? ['full-suite.log'] : REAL_LOGS;
  return { file: report, sha256: fileDigest(report), logs: names.map(name => {
    const log = fileName(path.join(path.dirname(path.resolve(ROOT, file)), name));
    return { name, file: log, sha256: fileDigest(log) };
  }) };
}
/** I/O boundary: always reopen original reports and log bytes before granting publication. */
function readWorkflowInputs(validation) {
  const workflowDigests = {}, inputIssues = [...(validation.inputIssues || [])], reports = {};
  const workflowEvidence = validation.workflowEvidence || {};
  for (const key of ['strictRegression', 'realWorkflow']) {
    const reference = workflowEvidence[key];
    if (!reference) continue;
    for (const item of [reference, ...(Array.isArray(reference.logs) ? reference.logs : [])]) {
      if (typeof item?.file === 'string') workflowDigests[item.file] = fileDigest(item.file);
    }
    try {
      const value = json(path.resolve(ROOT, reference.file));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('必须是 JSON 对象');
      if (JSON.stringify(value) !== JSON.stringify(validation[key])) inputIssues.push(`${key} 原始报告与汇总中的内容不同`);
      reports[key] = value;
    } catch { inputIssues.push(`${key} 原始报告缺失或不是有效 JSON 对象`); }
  }
  let summary;
  const log = (Array.isArray(workflowEvidence.strictRegression?.logs) ? workflowEvidence.strictRegression.logs : []).find(item => item?.name === 'full-suite.log');
  try { if (typeof log?.file === 'string') summary = strictSummary(fs.readFileSync(path.resolve(ROOT, log.file), 'utf8')); } catch { /* Missing log remains an explicit failed gate. */ }
  return { strictRegression: reports.strictRegression, realWorkflow: reports.realWorkflow, workflowDigests, strictLogSummary: summary, inputIssues };
}
/** Reopen the original preflight container and both output streams at the I/O boundary. */
function readPreflightInputs(validation) {
  const preflightDigests = {}, preflightSummaries = {}, inputIssues = [];
  const preflightEvidence = validation.preflightEvidence;
  let preflight;
  if (preflightEvidence?.file) {
    preflightDigests[preflightEvidence.file] = fileDigest(preflightEvidence.file);
    try {
      preflight = json(path.resolve(ROOT, preflightEvidence.file));
      if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) throw new Error('invalid preflight');
      if (JSON.stringify(preflight) !== JSON.stringify(validation.preflight)) inputIssues.push('预检原始报告与汇总中的内容不同');
      for (const name of Object.keys(PREFLIGHT_COMMANDS)) {
        const logs = preflight[name]?.checks?.[0]?.logs;
        for (const item of Array.isArray(logs) ? logs : []) if (typeof item?.file === 'string') preflightDigests[item.file] = fileDigest(item.file);
        const stdout = Array.isArray(logs) && logs.find(item => item?.stream === 'stdout');
        if (stdout?.file && preflightDigests[stdout.file]) preflightSummaries[name] = preflightSummary(name, fs.readFileSync(path.resolve(ROOT, stdout.file), 'utf8'));
      }
    } catch { inputIssues.push('预检原始报告或日志缺失或无效'); }
  }
  return { preflight, preflightEvidence, preflightDigests, preflightSummaries, preflightInputIssues: inputIssues };
}
function reportReference(file) { return typeof file === 'string' ? { file: fileName(file), sha256: fileDigest(file) } : undefined; }
/** Candidates, kernel/editor observations and local installation reports retain their original identities too. */
function readReportInputs(validation, { current, state, platform }) {
  const reportEvidence = validation.reportEvidence || {}, reportDigests = {}, reportInputIssues = [], values = {};
  for (const key of ['candidateManifest', 'localReport', 'kernelReports', 'editorReports']) {
    const multiple = key.endsWith('Reports'), refs = multiple ? reportEvidence[key] || [] : [reportEvidence[key]].filter(Boolean);
    const loaded = [];
    for (const reference of Array.isArray(refs) ? refs : []) {
      try {
        reportDigests[reference.file] = fileDigest(reference.file);
        let value = json(path.resolve(ROOT, reference.file));
        if (key === 'editorReports' && !value.editor) value = require('./editor-evidence.cjs').editorEvidence(value, state, current, { supported: true, vsix: validation.artifacts?.find(item => item.kind === 'vsix')?.file, platform });
        loaded.push(value);
      } catch { reportInputIssues.push(key + ' 原始报告缺失或无效'); }
    }
    values[key] = multiple ? loaded : loaded[0];
    if (JSON.stringify(values[key]) !== JSON.stringify(validation[key])) reportInputIssues.push(key + ' 原始报告与汇总中的内容不同');
  }
  return { ...values, reportEvidence, reportDigests, reportInputIssues };
}
function releaseCheck(options, context = {}) {
  const matrix = context.matrix || json(path.join(ROOT, 'compat/versions.json'));
  const editors = context.editors || json(path.join(ROOT, 'compat/editors.json'));
  const load = file => typeof file === 'string' && fs.existsSync(path.resolve(ROOT, file)) ? json(path.resolve(ROOT, file)) : undefined;
  if (options.historical) {
    const issues = matrix.versions.flatMap(entry => (entry.evidence || []).flatMap(file => validateHistoricalReport(load(file)).map(issue => `${file}: ${issue}`)));
    for (const file of [editors.evidence, ...(editors.supported || []).map(entry => entry.evidence)].filter(Boolean)) {
      const evidence = load(file);
      issues.push(...validateHistoricalEditor(evidence, evidence?.vsixSha256, { ...evidence?.packages, vscode: '>=0.0.0' }, evidence?.source).map(issue => `${file}: ${issue}`));
    }
    return { scope: 'historical', status: issues.length ? 'failed' : 'passed', releaseReady: false, issues };
  }
  const current = context.current || versions(), state = context.state || sourceState(), platform = context.platform || process.platform;
  const inputIssues = [];
  const read = (file, label) => {
    if (typeof file !== 'string') { inputIssues.push(`${label}路径无效`); return undefined; }
    try {
      const report = load(file);
      if (!report) inputIssues.push(`${label}文件缺失：${file}`);
      else if (typeof report !== 'object' || Array.isArray(report)) { inputIssues.push(`${label}必须是 JSON 对象：${file}`); return undefined; }
      return report;
    }
    catch { inputIssues.push(`${label}文件不是有效 JSON：${file}`); return undefined; }
  };
  const bundle = options.evidence ? read(options.evidence, '证据清单') : undefined;
  if (bundle && bundle.schemaVersion !== 1) inputIssues.push('证据清单需要 schemaVersion 1');
  const bundlePath = file => typeof file === 'string' ? path.resolve(path.dirname(path.resolve(ROOT, options.evidence)), file) : file;
  const bundled = (key) => {
    if (!bundle || bundle[key] === undefined) return [];
    if (!Array.isArray(bundle[key])) { inputIssues.push(`证据清单 ${key} 必须是路径数组`); return []; }
    return bundle[key].map(bundlePath);
  };
  const selected = (option, key) => options[option] || (bundle?.[key] ? bundlePath(bundle[key]) : undefined);
  const localFile = selected('local-report', 'localReport'), candidateFile = selected('candidates', 'candidateManifest'), preflightFile = selected('preflight', 'preflight');
  const strictFile = selected('strict-regression', 'strictRegression'), realFile = selected('real-workflow', 'realWorkflow');
  const localReport = localFile ? read(localFile, '本机报告') : undefined;
  const candidateManifest = candidateFile ? read(candidateFile, '候选清单') : undefined;
  const artifactList = candidateManifest?.artifacts || localReport?.artifacts || [];
  if (!Array.isArray(artifactList)) inputIssues.push('候选 artifacts 必须是数组');
  const mapping = bundle?.candidateFiles, mapped = mapping !== undefined;
  const kinds = ['tgz', 'vsix', 'sdk'];
  const validMapping = mapped && mapping && typeof mapping === 'object' && !Array.isArray(mapping)
    && Object.keys(mapping).length === kinds.length && kinds.every(kind => typeof mapping[kind] === 'string' && mapping[kind].length > 0);
  if (mapped && (!validMapping || !candidateManifest || artifactList.length !== kinds.length)) inputIssues.push('candidateFiles 必须完整映射原始清单的 tgz/vsix/sdk 三个文件');
  const artifacts = (Array.isArray(artifactList) ? artifactList : []).map(item => {
    let file = mapped ? validMapping ? bundlePath(mapping[item?.kind]) : undefined : item?.file;
    if (mapped && typeof file === 'string') {
      try {
        const absolute = path.resolve(ROOT, file), relative = path.relative(path.join(ROOT, 'build'), absolute);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('outside build');
        require('../run-resources.cjs').plainParents(absolute);
        if (!fs.lstatSync(absolute).isFile()) throw new Error('not a file');
        file = fileName(absolute);
      } catch { inputIssues.push(`候选 ${item?.kind} 显式路径必须是 build 内无链接的文件`); file = undefined; }
    }
    return { ...item, ...(mapped ? { file, producerFile: item?.file } : {}), sha256: fileDigest(file) };
  });
  const identity = report => ['panel', 'door', 'sdk'].every(name => report?.packages?.[name] === current[name]);
  const kernelFiles = [...(options.report ? [options.report] : []), ...bundled('kernelReports')];
  const explicitKernels = Boolean(options.report) || Boolean(bundle && Object.hasOwn(bundle, 'kernelReports'));
  const registeredKernels = (matrix.currentRelease?.evidence || []).length ? matrix.currentRelease.evidence
    : matrix.versions.filter(entry => ['panel', 'door', 'sdk'].every(name => entry[name] === current[name])).flatMap(entry => entry.evidence || []);
  // 显式清单完整指定当前证据，避免同一次验收同时消费登记副本或旧重跑结果。
  const kernelReports = (explicitKernels ? kernelFiles : registeredKernels).map(file => read(file, '内核证据')).filter(Boolean);
  const editorFiles = bundled('editorReports');
  const explicitEditors = Boolean(bundle && Object.hasOwn(bundle, 'editorReports'));
  const registeredEditors = explicitEditors ? [] : (editors.currentRelease?.evidence || []).length ? editors.currentRelease.evidence
    : [editors.evidence, ...(editors.supported || []).map(entry => entry.evidence)].filter(Boolean).filter(file => identity(load(file)));
  const editorReports = (explicitEditors ? editorFiles : registeredEditors).map(file => {
    const report = read(file, '编辑器证据');
    if (!report || report.editor) return report;
    try { return require('./editor-evidence.cjs').editorEvidence(report, state, current, { supported: true, vsix: artifacts.find(item => item.kind === 'vsix')?.file, platform }); }
    catch (error) { inputIssues.push(`编辑器原始报告未通过：${error.message}`); return report; }
  }).filter(Boolean);
  const unique = reports => [...new Map(reports.map(report => [JSON.stringify(report), report])).values()];
  const strictRegression = strictFile ? read(strictFile, '严格回归报告') : undefined;
  const realWorkflow = realFile ? read(realFile, '真实工作流报告') : undefined;
  const workflowEvidence = { strictRegression: workflowReference(strictFile, 'strictRegression'), realWorkflow: workflowReference(realFile, 'realWorkflow') };
  const workflowInputs = readWorkflowInputs({ strictRegression, realWorkflow, workflowEvidence, inputIssues });
  const preflight = preflightFile ? read(preflightFile, '预检报告') : undefined;
  const preflightInputs = readPreflightInputs({ preflight, preflightEvidence: preflightFile ? { file: fileName(preflightFile), sha256: fileDigest(preflightFile) } : undefined });
  const reportEvidence = { candidateManifest: reportReference(candidateFile), localReport: reportReference(localFile),
    kernelReports: (explicitKernels ? kernelFiles : registeredKernels).map(reportReference), editorReports: (explicitEditors ? editorFiles : registeredEditors).map(reportReference) };
  const reportInputs = readReportInputs({ candidateManifest, localReport, kernelReports: unique(kernelReports), editorReports: unique(editorReports), artifacts, reportEvidence }, { current, state, platform });
  const result = evaluateRelease({ current, state, platform, kernelReports: unique(kernelReports), ...releaseRequirements(matrix, editors), editorReports: unique(editorReports),
    localReport, localLogDigests: localLogs(localReport), artifacts, candidateManifest, ...preflightInputs,
    workflowEvidence, ...workflowInputs, ...reportInputs, inputIssues: [...workflowInputs.inputIssues, ...preflightInputs.preflightInputIssues, ...reportInputs.reportInputIssues, ...inputIssues.filter(issue => !workflowInputs.inputIssues.includes(issue))] });
  return result;
}
if (require.main === module) {
  try { const result = releaseCheck(argsOf()); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.scope === 'historical' ? result.status === 'passed' ? 0 : 1 : result.releaseReady ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateReport, validateHistoricalReport, validateHistoricalEditor, validateEditorEvidence, validateIdentity, validateReleaseApproval, readReleaseApproval, evaluateRelease, releaseCheck, releaseRequirements,
  PREFLIGHT_COMMANDS, preflightSummary, validatePreflight, readPreflightInputs, strictSummary, validateStrictRegression, validateRealWorkflow, REQUIRED, LOCAL, FINGERPRINTS, REAL_WORKFLOW, REAL_LOGS, STRICT_COMMAND };
