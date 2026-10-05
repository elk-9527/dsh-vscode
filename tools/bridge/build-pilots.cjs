'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { runDshSync } = require('../../packages/vscode-extension/src/door/locate');
const ROOT = path.resolve(__dirname, '../..');
const PILOTS = [
  { name: '@michengai/dsh-code-review', version: '0.1.9', candidate: '0.1.9-ide.1',
    sha256: 'd77a24a0f54c69728112fbd6817c643c1489f006045cefb6d328bab1d9bdc606',
    runtimeSha256: '7df2296398e2508af6dd87525bf0c3af2ae56c9f7ed182334228532a1326b54d', key: 'review' },
  { name: '@linxin666/dsh-client-ui-skill-explorer', version: '0.4.4', candidate: '0.4.4-ide.2',
    sha256: 'd09440cf5557d3e3bf09a35fbea05f3fbfae073e25b3658344bd63d95a666862', key: 'skills' },
];
/** 从已校验的上游发行包生成候选包，不改动已安装插件目录。 */
function build({ home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh') } = {}) {
  const output = path.join(ROOT, 'build/ide-bridge/pilots'); fs.mkdirSync(output, { recursive: true });
  const records = [];
  for (const pilot of PILOTS) {
    let source = path.join(home, 'profiles/desktop/node_modules', pilot.name);
    const archived = path.join(output,'upstream',pilot.key);
    if (JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version !== pilot.version && fs.existsSync(archived)) source = archived;
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
    fs.writeFileSync(path.join(target, 'lib/index.js'), original.replace(anchor, `${registration}\n${anchor}`));
    if (pilot.key === 'review') fs.writeFileSync(path.join(target,'lib/runtime.js'),require('./review-runtime.cjs').patchReviewRuntime(fs.readFileSync(path.join(source,'lib/runtime.js'),'utf8')));
    manifest.version = pilot.candidate;
    manifest.dshIdeBridge = { upstreamVersion: pilot.version, upstreamEntrySha256: hash, protocolVersion: 1 };
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const packed = JSON.parse(runDshSync({ command: 'npm', args: ['pack', target, '--ignore-scripts', '--pack-destination', output, '--json'], timeoutMs: 30000 }));
    const file = path.join(output, packed[0].filename);
    records.push({ ...pilot, file: path.relative(ROOT, file).replace(/\\/g, '/'), packageSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(records, null, 2) + '\n');
  console.log(JSON.stringify(records.map(r => ({ name: r.name, version: r.candidate, file: r.file })), null, 2));
  return records;
}
if (require.main === module) build();
module.exports = { PILOTS, build };
