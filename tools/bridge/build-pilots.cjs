'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runDshSync } = require('../../packages/vscode-extension/src/door/locate');
const { extractPackageArchive } = require('./package-archive.cjs');
const ROOT = path.resolve(__dirname, '../..');
const PILOTS = [
  { name: '@michengai/dsh-code-review', version: '0.1.9', candidate: '0.1.9-ide.7',
    sha256: 'd77a24a0f54c69728112fbd6817c643c1489f006045cefb6d328bab1d9bdc606',
    runtimeSha256: '7df2296398e2508af6dd87525bf0c3af2ae56c9f7ed182334228532a1326b54d', key: 'review' },
  { name: '@linxin666/dsh-client-ui-skill-explorer', version: '0.4.4', candidate: '0.4.4-ide.6',
    sha256: 'd09440cf5557d3e3bf09a35fbea05f3fbfae073e25b3658344bd63d95a666862', key: 'skills' },
];
/** 从已校验的上游发行包生成候选包，不改动已安装插件目录。 */
function build({ home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  output = path.join(ROOT, 'build/ide-bridge/pilots'), fresh = false } = {}) {
  output = path.resolve(output); fs.mkdirSync(output, { recursive: true });
  const records = [];
  for (const pilot of PILOTS) {
    let extracted;
    try {
    let source = path.join(home, 'profiles/desktop/node_modules', pilot.name);
    const archived = path.join(output,'upstream',pilot.key);
    if (fresh || !fs.existsSync(path.join(source,'package.json')) || JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version !== pilot.version) {
      if (!fresh && fs.existsSync(archived)) source = archived;
      else {
        const packed = JSON.parse(runDshSync({ command: 'npm', args: ['pack', `${pilot.name}@${pilot.version}`, '--ignore-scripts', '--registry=https://registry.npmjs.org', '--pack-destination', output, '--json'], timeoutMs: 60000 }));
        extracted = fs.mkdtempSync(path.join(output, `${pilot.key}-upstream-`));
        extractPackageArchive(path.join(output, packed[0].filename), extracted);
        source = path.join(extracted, 'package');
      }
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    const original = fs.readFileSync(path.join(source, 'lib/index.js'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');
    if (manifest.version !== pilot.version || hash !== pilot.sha256) throw new Error(`上游源码不匹配：${pilot.name}`);
    if (pilot.runtimeSha256 && createHash('sha256').update(fs.readFileSync(path.join(source,'lib/runtime.js'))).digest('hex') !== pilot.runtimeSha256) throw new Error('上游审查执行源码不匹配');
    const target = path.join(output, `${pilot.key}-${pilot.candidate}`);
    fs.cpSync(source, target, { recursive: true, dereference: true, filter: file => !file.split(path.sep).includes('node_modules') || file === source || file.startsWith(`${source}${path.sep}`) && !file.slice(source.length + 1).split(path.sep).includes('node_modules') });
    if (!fs.existsSync(archived)) fs.cpSync(target,archived,{recursive:true});
    const registration = fs.readFileSync(path.join(__dirname, `providers/${pilot.key}.txt`), 'utf8');
    const anchor = pilot.key === 'review' ? '    const operations = new Set();' : '\tconst routes = makeRoutes(ctx, {';
    if (original.split(anchor).length !== 2) throw new Error('源码补丁定位失败');
    const modifiedNotice = `// Modified by DSH in VS Code: IDE Bridge adaptation of ${pilot.name}@${pilot.version}.\n`;
    const imports = modifiedNotice + "import { registerProvider } from 'dsh-ide-bridge-sdk';\n" + (pilot.key === 'skills' ? "import { SkillFileStore } from 'dsh-ide-bridge-sdk/skill-files';\n" : "import budgetRuntime from './review-budget.cjs';\nconst { createReviewBudget } = budgetRuntime;\n");
    fs.writeFileSync(path.join(target, 'lib/index.js'), imports + original.replace(anchor, `${registration}\n${anchor}`));
    if (pilot.key === 'review') fs.writeFileSync(path.join(target,'lib/runtime.js'), modifiedNotice + require('./review-runtime.cjs').patchReviewRuntime(fs.readFileSync(path.join(source,'lib/runtime.js'),'utf8')));
    if (pilot.key === 'review') fs.copyFileSync(path.join(__dirname, 'review-budget.cjs'), path.join(target, 'lib/review-budget.cjs'));
    if (pilot.key === 'review') fs.copyFileSync(path.join(__dirname, 'review-context.cjs'), path.join(target, 'lib/review-context.cjs'));
    for (const name of pilot.key === 'review' ? ['index.js', 'runtime.js', 'review-context.cjs', 'review-budget.cjs'] : ['index.js']) {
      execFileSync(process.execPath, ['--check', path.join(target, 'lib', name)], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
    }
    manifest.version = pilot.candidate;
    for (const version of ['0.2.1-alpha.1', '0.2.1-rc.2']) {
      for (const [name, range] of Object.entries(manifest.peerDependencies || {})) if (name.startsWith('@deepseek-ai/dsh') && !range.includes(version)) manifest.peerDependencies[name] = range + ' || ' + version;
      if (manifest.dsh?.engines?.dsh && !manifest.dsh.engines.dsh.includes(version)) manifest.dsh.engines.dsh += ' || ' + version;
    }
    manifest.dependencies = { ...manifest.dependencies, 'dsh-ide-bridge-sdk': JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/dsh-bridge-sdk/package.json'))).version };
    manifest.dshIdeBridge = { upstreamVersion: pilot.version, upstreamEntrySha256: hash, protocolVersion: 1,
      modificationNotice: 'Modified by DSH in VS Code to register IDE Bridge capabilities and declare the SDK dependency.' };
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (pilot.key === 'review') fs.appendFileSync(path.join(target, 'NOTICE'), '\nDSH in VS Code adaptation: lib/index.js registers IDE Bridge capabilities; lib/runtime.js adds structured reports, bounded Git context and review budgets; lib/review-context.cjs prepares read-only working-tree material; package.json declares the adapter version and SDK dependency. Original license and attribution notices are retained.\n');
    const packed = JSON.parse(runDshSync({ command: 'npm', args: ['pack', target, '--ignore-scripts', '--pack-destination', output, '--json'], timeoutMs: 30000 }));
    const file = path.join(output, packed[0].filename);
    records.push({ ...pilot, file: path.relative(ROOT, file).replace(/\\/g, '/'), packageSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    } finally {
      if (extracted) fs.rmSync(extracted, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(records, null, 2) + '\n');
  console.log(JSON.stringify(records.map(r => ({ name: r.name, version: r.candidate, file: r.file })), null, 2));
  return records;
}
if (require.main === module) {
  const options = require('../compat/lib.cjs').argsOf();
  if (Object.keys(options).some(key => !['fresh', 'out'].includes(key)) ||
    options.fresh !== undefined && options.fresh !== true || options.out !== undefined && typeof options.out !== 'string') {
    throw new Error('Usage: build-pilots.cjs [--fresh] [--out <directory>]');
  }
  build({ fresh: options.fresh === true, output: options.out });
}
module.exports = { PILOTS, build };
