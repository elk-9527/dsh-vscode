'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { ROOT, json, sourceState, versions, sha256 } = require('./lib.cjs');
const CHECKS = ['extension activation', 'isolated observation loaded', 'native commands', 'runtime providers', 'one shared connection', 'isolated endpoint home', 'native configuration diagnosis', 'diagnosis clipboard', 'native theme 1', 'native theme 2', 'native theme 3', 'native keyboard navigation commands', 'reduced motion setting', 'Problems finding', 'native full report', 'run view', 'reference document is unsaved', 'native participant registered', 'native Chat receives unsaved file reference', 'native history pagination', 'native history search', 'native Markdown export', 'finding quick fix action', 'fix preview without source mutation', 'native diff preview', 'approved single fix stays unsaved', 'save and review uses new snapshot', 'stale diagnostics removed', 'explicit retry new identity', 'cleanup preserves newer findings', 'finished cleanup', 'window reopen restores review'];
CHECKS.push('native model configuration diagnosis', 'native draft persistence', 'window reopen restores draft');
CHECKS.push('native composer workspace file search', 'native composer unsaved file snapshot', 'native composer selection snapshot', 'native composer manual skill attachment');
CHECKS.push('native composer offline project skill search', 'native composer offline project skill body');
CHECKS.push('native composer Git diff snapshot', 'native composer Problems snapshot', 'native composer immutable context', 'native composer context queue', 'native composer context transmission');
CHECKS.push('native slash commands', 'native workflow baseline', 'native workflow diff', 'native workflow undo', 'native workflow undo conflict', 'native test task pass', 'native test task fail', 'native test result attachment', 'native test task cancellation');
CHECKS.push('native session switch blocks undo', 'native test blocks history switch', 'native test blocks session adoption', 'native model picker rechecks running task', 'native history clears workflow records');
CHECKS.splice(CHECKS.indexOf('cleanup preserves newer findings'), 2, 'cleanup preserves referenced case and newer findings', 'finished cleanup protects open evidence');
CHECKS.push('no editor completion commands', 'no editor completion payload', 'no code completion capability');
CHECKS.push('review baseline has no chat turn', 'real repair baseline test fails', 'independent repair test passes', 'repair and re-review share saved case', 'native durable case report', 'window reopen keeps complete saved report', 'offline saved repair and test history');
CHECKS.push('native file editor opens', 'composer captures opened editor');
function requiredChecks(editor, nativeChat) {
  return nativeChat !== true && require('semver').valid(editor) && require('semver').lt(editor, '1.91.0')
    ? [...CHECKS.filter(name => !['native participant registered', 'native Chat receives unsaved file reference'].includes(name)), 'native Chat unavailable keeps sidebar', 'sidebar receives unsaved file reference']
    : [...CHECKS];
}
function editorEvidence(report, state = sourceState(), current = versions(), { supported = false } = {}) {
  assert.equal(report.status, 'passed', '编辑器报告未通过');
  assert.equal(report.source?.fingerprint, state.fingerprint, '编辑器报告对应的源码已变化');
  const editor = report.stages?.find(stage => stage.name === 'packed-vsix-native-editor' && stage.status === 'passed')?.result;
  const minimum = json(path.join(ROOT, 'packages/vscode-extension/package.json')).engines.vscode.replace(/^\^/, '');
  if (supported) assert(require('semver').satisfies(editor?.vscode || '', `^${minimum}`), '编辑器版本不在声明支持范围');
  else assert.equal(editor?.vscode, minimum, '未使用声明的最低编辑器');
  assert.equal(editor.diagnosticLaunchFlags?.length, 0, '默认启动未通过');
  assert.notEqual(editor.nativeMode, 'restricted', '原生能力受到限制');
  const nativeChat = editor.checks.includes('native participant registered');
  const checks = requiredChecks(editor.vscode, nativeChat);
  for (const check of checks) assert(editor.checks.includes(check), `缺少编辑器检查：${check}`);
  assert.equal(editor.vsixSha256, sha256(path.join(ROOT, `packages/vscode-extension/build/dsh-acp-panel-${current.panel}.vsix`)), '安装包已变化');
  return { schemaVersion: 1, status: 'passed', platform: 'win32', editor: editor.vscode, defaultLaunch: true,
    source: { commit: state.commit, fingerprint: state.fingerprint }, packages: { panel: current.panel, door: current.door },
    vsixSha256: editor.vsixSha256, capabilities: { nativeChat }, checks: checks.map(name => ({ name, status: 'passed' })) };
}
if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2); assert(input && output, '需要输入报告与公开输出文件');
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(editorEvidence(json(path.resolve(input)), undefined, undefined, { supported: process.argv.includes('--supported') }), null, 2) + '\n');
    console.log('最低编辑器公开验证结果已写入');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { editorEvidence, CHECKS, requiredChecks };
