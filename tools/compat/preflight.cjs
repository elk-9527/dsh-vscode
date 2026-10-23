'use strict';
/** 显式执行本地发布预检；release-check 只消费这里生成的结果。 */
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, argsOf, sourceState, versions, redact, runDir, sha256 } = require('./lib.cjs');
const { FINGERPRINTS } = require('./release-check.cjs');
function runPreflight(options = {}) {
  const folder = runDir('preflight'), reports = {};
  for (const [name, argv] of [['quick-ui', ['packages/vscode-extension/test/run-all.js', '--ui', '--strict']], ['contracts', ['tools/compat/contracts.cjs']]]) {
    const sourceStart = sourceState();
    const result = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 600000 });
    const sourceEnd = sourceState(), stable = FINGERPRINTS.every(key => sourceStart[key] === sourceEnd[key]);
    const log = path.join(folder, `${name}.log`); fs.writeFileSync(log, redact(`${result.stdout || ''}${result.stderr || ''}`));
    const status = result.status === 0 && stable ? 'passed' : 'failed';
    reports[name] = { schemaVersion: 2, platform: process.platform, packages: versions(), source: sourceEnd, sourceStart, sourceEnd, status,
      checks: [{ name, status, exitCode: result.status, stable, log: path.relative(ROOT, log).replace(/\\/g, '/'), logSha256: sha256(log) }] };
  }
  const file = options.out ? path.resolve(options.out) : path.join(folder, 'preflight.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(reports, null, 2) + '\n');
  console.log(file); return reports;
}
if (require.main === module) { const result = runPreflight(argsOf()); process.exitCode = Object.values(result).every(report => report.status === 'passed') ? 0 : 1; }
module.exports = { runPreflight };
