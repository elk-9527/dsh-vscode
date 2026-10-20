'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { shipFiles } = require('../tools/ship-list');
const { contentTypesXml } = require('../tools/build-vsix');
const { CONTENT, invalidSourceLinks, renderedReadme, verifyPackageFiles } = require('../tools/package-links.cjs');
const root = path.resolve(__dirname, '..');

function publication({ mismatch = false, failedList = false, privateContent = false } = {}) {
  const calls = [];
  let exitCode;
  const stop = {};
  try {
    vm.runInNewContext(fs.readFileSync(path.join(root, 'tools/publish.js'), 'utf8'), {
      __dirname: path.join(root, 'tools'), console: { log() {}, error() {} },
      process: { execPath: process.execPath, platform: process.platform, argv: ['node', 'publish.js', '--yes'], env: { VSCE_PAT: 'fixture' }, exit(code) { exitCode = code; throw stop; } },
      require(name) {
        if (name === 'node:child_process') return { spawnSync(command, args) {
          calls.push(args);
          if (args.some(arg => String(arg).includes('check-public-paths.cjs'))) return { status: privateContent ? 1 : 0, stdout: '' };
          if (args.includes('ls')) return { status: failedList ? 1 : 0, stdout: shipFiles(root).slice(mismatch ? 1 : 0).join('\n') };
          return { status: 0, stdout: '' };
        } };
        if (name === './ship-list') return require('../tools/ship-list');
        if (name === './package-links.cjs') return require('../tools/package-links.cjs');
        return require(name);
      },
    });
    exitCode = 0;
  } catch (error) { if (error !== stop) throw error; }
  return { exitCode, published: calls.some(args => args.includes('publish')), calls };
}
assert.equal(publication({ mismatch: true }).published, false, 'Real publication must reject package content drift');
assert.equal(publication({ failedList: true }).published, false, 'A failed file inventory must block publication');
assert.equal(publication({ privateContent: true }).published, false, 'Public content check must run before publication');
const valid = publication(); assert.equal(valid.published, true); assert.equal(valid.exitCode, 0);
const publish = valid.calls.find(args => args.includes('publish'));
assert(publish.includes('--githubBranch') && publish.includes('main') && publish.includes(CONTENT));
assert.deepEqual(invalidSourceLinks(`[API](${CONTENT}API.md)`), []);
for (const link of [
  'https://github.com/elk-9527/dsh-vscode/blob/HEAD/API.md',
  'https://github.com/elk-9527/dsh-vscode/blob/main/API.md',
  'https://github.com/elk-9527/dsh-vscode/tree/f67309db5e0c791b0a99a836915d13367889cf45/packages/dsh-door',
]) assert.equal(invalidSourceLinks(`[source](${link})`).length, 1);
const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-package-format-'));
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
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(require('node:os').tmpdir()));
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
