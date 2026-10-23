'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shipFiles } = require('../tools/ship-list');
const { contentTypesXml, createArchive, archiveEntries } = require('../tools/build-vsix');
const { CONTENT, invalidSourceLinks, renderedReadme, verifyPackageFiles } = require('../tools/package-links.cjs');
const root = path.resolve(__dirname, '..');
const { publishPanel } = require('../tools/publish');
const { publishDoor } = require('../../dsh-door/tools/publish.cjs');

function publication(publish, { candidate = 'candidate with spaces.vsix', report = 'release.json', invalidPackage = false, invalidReport = false, drift = false, privateContent = false, extra = [] } = {}) {
  const calls = []; let inspections = 0, error;
  try {
    publish(['--yes', ...(candidate ? ['--candidate', candidate] : []), ...(report ? ['--report', report] : []), ...extra], {
      env: { VSCE_PAT: 'fixture' },
      spawn(command, args) {
        calls.push({ command, args });
        return { status: privateContent && args.some(arg => String(arg).includes('check-public-paths.cjs')) ? 1 : 0, stdout: '' };
      },
      verify(file, kind) { inspections++; if (invalidPackage) throw new Error('Invalid package inventory'); return { file, kind, sha256: drift && inspections > 1 ? 'changed' : 'accepted' }; },
      approve() { if (invalidReport) throw new Error('Report is pending or belongs to another candidate'); },
    });
  } catch (caught) { error = caught; }
  return { error, published: calls.some(call => call.args.some(arg => arg.replace(/^"|"$/g, '') === 'publish')), calls };
}
for (const publish of [publishPanel, publishDoor]) {
  for (const options of [{ candidate: '' }, { report: '' }, { invalidPackage: true }, { invalidReport: true }, { drift: true }, { privateContent: true }, { extra: ['--patch'] }, { extra: ['--force'] }]) {
    const failed = publication(publish, options); assert.equal(failed.published, false); assert(failed.error, 'Invalid submission must fail closed');
  }
  const valid = publication(publish); assert.equal(valid.published, true); assert.equal(valid.error, undefined);
  const command = valid.calls.find(call => call.args.some(arg => arg.replace(/^"|"$/g, '') === 'publish'));
  const argv = command.args.map(arg => arg.replace(/^"|"$/g, ''));
  if (publish === publishPanel) assert(argv.includes('--packagePath') && argv.includes(path.resolve('candidate with spaces.vsix')));
  else assert(argv.includes(path.resolve('candidate with spaces.vsix')) && argv.includes('https://registry.npmjs.org') && argv.includes('--ignore-scripts'));
  assert(!valid.calls.some(call => call.args.includes('pack') || call.args.includes('package') || call.args.includes('version')), 'Publication never builds or increments a version');
}
assert.deepEqual(invalidSourceLinks(`[API](${CONTENT}API.md)`), []);
for (const link of [
  'https://github.com/elk-9527/dsh-vscode/blob/HEAD/API.md',
  'https://github.com/elk-9527/dsh-vscode/blob/main/API.md',
  'https://github.com/elk-9527/dsh-vscode/tree/f67309db5e0c791b0a99a836915d13367889cf45/packages/dsh-door',
]) assert.equal(invalidSourceLinks(`[source](${link})`).length, 1);
const fixtureParent = path.resolve(root, '../../build/packaging-tests'); fs.mkdirSync(fixtureParent, { recursive: true });
const temporary = fs.mkdtempSync(path.join(fixtureParent, 'dsh-package-format-'));
try {
  const source = path.join(temporary, 'source'), packed = path.join(temporary, 'packed');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true }); fs.mkdirSync(path.join(packed, 'src'), { recursive: true });
  const readme = '[API](API.md)\n[external](https://example.invalid/page)\n';
  for (const [name, text] of [['README.md', readme], ['LICENSE', 'Fixture license\n'], ['API.md', 'Fixture API\n'], ['src/index.js', 'exports.value = 1;\n']]) fs.writeFileSync(path.join(source, name), text);
  fs.writeFileSync(path.join(packed, 'readme.md'), renderedReadme(readme));
  fs.writeFileSync(path.join(packed, 'LICENSE.txt'), 'Fixture license\r\n');
  fs.writeFileSync(path.join(packed, 'API.md'), 'Fixture API\n');
  fs.writeFileSync(path.join(packed, 'src/index.js'), 'exports.value = 1;\r\n');
  assert.equal(verifyPackageFiles(source, packed).files, 4);
  fs.writeFileSync(path.join(packed, 'src/index.js'), 'exports.value = 2;\n');
  assert.throws(() => verifyPackageFiles(source, packed), /Stale package: src\/index.js/);
  fs.writeFileSync(path.join(packed, 'src/index.js'), 'exports.value = 1;\n');
  fs.writeFileSync(path.join(packed, 'readme.md'), 'Wrong README\n');
  assert.throws(() => verifyPackageFiles(source, packed), /Stale package: README.md/);
  fs.writeFileSync(path.join(packed, 'readme.md'), renderedReadme(readme));
  fs.writeFileSync(path.join(packed, 'extra.js'), 'not shipped');
  assert.throws(() => verifyPackageFiles(source, packed), /Unexpected package file/);
  const portable = path.join(temporary, 'candidate with spaces.vsix');
  const python = { platform: 'linux', run(command, args, options) {
    return require('node:child_process').execFileSync(process.platform === 'win32' && command === 'python3' ? 'python' : command, args, options);
  } };
  createArchive(source, portable, python);
  assert.deepEqual(archiveEntries(portable, python).sort(), ['API.md', 'LICENSE', 'README.md', 'src/index.js'].sort(), 'The Linux/macOS ZIP path creates readable forward-slash entries and supports spaces');
  const invalid = path.join(temporary, 'invalid.tgz'); fs.writeFileSync(invalid, 'not a tarball');
  assert.throws(() => require('../../../tools/bridge/packages.cjs').verifyCandidate(invalid, 'tgz'), 'A malformed candidate cannot pass archive inspection');
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), fixtureParent);
  assert(path.basename(temporary).startsWith('dsh-package-format-') && !fs.lstatSync(temporary).isSymbolicLink());
  fs.rmSync(temporary, { recursive: true, force: true });
}
assert(!/Extension="\./.test(contentTypesXml()), 'Content type extensions must omit the leading dot');
const packedWithoutEditor = require('node:child_process').spawnSync(process.execPath,
  [path.resolve(root, '../../tools/bridge/test-live.cjs'), '--packed-vsix'],
  { cwd: path.resolve(root, '../..'), encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert.equal(packedWithoutEditor.status, 1, 'Reusing a native archive requires editor validation');
assert(packedWithoutEditor.stderr.includes('--packed-vsix requires --editor'));
console.log('Publication content gates, inventory failures and package content types passed');
