'use strict';
const fs = require('node:fs'), path = require('node:path');
const { ROOT, argsOf, json } = require('./lib.cjs');
function classifyProbe(report, declared = false) {
  if (declared) throw new Error('Declared combinations belong to the required regression matrix');
  if (report.status === 'passed') return 'candidate-passed';
  if (report.status === 'acquisition-failed' || report.stages?.some(stage => stage.status === 'acquisition-failed')) return 'acquisition-failed';
  const install = report.stages?.find(stage => stage.name === 'installation');
  if (install?.status === 'failed' && /Plugin dsh-acp-door@[^\s]+ is incompatible with dsh[^\n]*peerDependencies/i.test(install.error || '')) return 'not-declared';
  return 'incompatible';
}
async function run(options) {
  const matrix = json(path.join(ROOT, 'compat/versions.json'));
  if (matrix.versions.some(item => item.dsh === options.dsh && item.distribution === 'npm')) throw new Error('Use the supported regression job for this version');
  const report = await require('./test.cjs').run({ ...options, install: true });
  const result = { ...require('./public-evidence.cjs').publicEvidence(report), dsh: options.dsh, distribution: 'npm', status: classifyProbe(report), declaredSupported: false };
  const folder = path.join(ROOT, 'build/probes'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'probe-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Candidate probe ${options.dsh}: ${result.status}; supported regression requirements are unchanged.`);
  return result;
}
if (require.main === module) run(argsOf()).then(result => { process.exitCode = ['candidate-passed', 'not-declared'].includes(result.status) ? 0 : 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { classifyProbe };
