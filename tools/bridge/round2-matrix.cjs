'use strict';
/** 复用已获取的精确运行时，重新验收候选；保留首版证据，不把旧报告视为本轮通过。 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ROOT, json, locate, redact, sourceState, versions } = require('../compat/lib.cjs');
const rows = [['0.1.5-rc.2', 'npm'], ['0.2.0-rc.1', 'npm'], ['0.2.0-rc.2', 'npm'], ['0.2.0-rc.2', 'desktop']];
const report = { source: sourceState(), packages: versions(), time: new Date().toISOString(), status: 'passed', rows: [] };
for (const [version, distribution] of rows) {
  const previous = json(path.join(ROOT, `compat/evidence/dsh-${version}-${distribution}-door-0.2.0-panel-0.3.0.json`));
  const command = previous.runtime.command.replaceAll('<USER>', os.homedir().replace(/\\/g, '/'));
  const parts = locate.resolveCommand(command);
  if (parts.length > 1 && !fs.existsSync(parts[1])) throw new Error('原运行时来源不可用，需重新获取精确版本');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/compat/test.cjs'), `--dsh=${version}`, `--command=${command}`], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 240000 });
  const log = path.join(ROOT, `build/round2-matrix-${version}-${distribution}.log`);
  fs.writeFileSync(log, redact((result.stdout || '') + (result.stderr || '')));
  const status = result.status === 0 ? 'passed' : 'failed';
  report.rows.push({ version, distribution, status, log: path.relative(ROOT, log).replace(/\\/g, '/') });
  if (status !== 'passed') report.status = 'failed';
  console.log(`${status} ${version}/${distribution}`);
}
fs.writeFileSync(path.join(ROOT, 'build/round2-matrix.json'), JSON.stringify(report, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
