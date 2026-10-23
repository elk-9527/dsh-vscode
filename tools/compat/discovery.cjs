'use strict';
const fs = require('node:fs'), path = require('node:path');
const { ROOT, discover, supportedMatrix } = require('./lib.cjs');
async function main() {
  const result = process.argv.includes('--offline') ? { ...supportedMatrix(), probes: { include: [] }, acquisitionIssues: [], desktopProbes: [] } : await discover();
  const summary = { ...result, acquisitionIssues: result.acquisitionIssues.map(({ source, status }) => ({ source, status })) };
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build/discovery.json'), JSON.stringify(summary, null, 2) + '\n');
  const outputs = { matrix: JSON.stringify(result.matrix), probes: JSON.stringify(result.probes), probe_count: result.probes.include.length, acquisition_failed: result.acquisitionIssues.length > 0 };
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Supported regression: ${result.matrix.include.length} npm combinations. Candidate probes: ${result.probes.include.length}. Acquisition failures: ${result.acquisitionIssues.length}. Desktop discoveries require a dedicated environment: ${result.desktopProbes.map(item => item.dsh).join(', ') || 'none'}.\n`);
  console.log(JSON.stringify(summary));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
