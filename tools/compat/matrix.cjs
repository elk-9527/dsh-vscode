'use strict';
/** 仅显式登记通过报告；CI 的新候选检查不自动扩大支持范围。 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, json } = require('./lib.cjs');
const { validateReport } = require('./release-check.cjs');
const { publicEvidence } = require('./public-evidence.cjs');

function recordEvidence(file) {
  const report = json(path.resolve(file));
  const issues = validateReport(report);
  if (issues.length) throw new Error(`不能登记通过：${issues.join('；')}`);
  const matrixFile = path.join(ROOT, 'compat/versions.json');
  const matrix = json(matrixFile);
  const entry = matrix.versions.find((item) => item.dsh === report.runtime.version && item.distribution === report.runtime.distribution);
  if (!entry) throw new Error('新候选需要先在兼容矩阵中建立待验证条目');
  const evidence = `compat/evidence/public-dsh-${entry.dsh}-${entry.distribution}-door-${report.packages.door}-panel-${report.packages.panel}.json`;
  fs.mkdirSync(path.dirname(path.join(ROOT, evidence)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, evidence), `${JSON.stringify(publicEvidence(report), null, 2)}\n`);
  Object.assign(entry, { status: 'passed', door: report.packages.door, panel: report.packages.panel,
    acp: report.runtime.acpVersion, testedAt: report.finishedAt, fingerprint: report.source.fingerprint, evidence: [evidence] });
  fs.writeFileSync(matrixFile, `${JSON.stringify(matrix, null, 2)}\n`);
  return evidence;
}
module.exports = { recordEvidence };
