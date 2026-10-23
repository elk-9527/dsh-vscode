'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT } = require('../compat/lib.cjs');
const { extractVsix } = require('./packages.cjs');
const { checkArchiveReadme } = require('../../packages/vscode-extension/tools/package-links.cjs');
const python = process.platform === 'win32' ? 'python' : 'python3';
const parent = path.join(ROOT, 'build/archive-tests'); fs.mkdirSync(parent, { recursive: true });
const fixture = fs.mkdtempSync(path.join(parent, 'zip-'));
execFileSync(python, ['-c', String.raw`import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
readme = '# Package 中文\n[readme](https://github.com/elk-9527/dsh-vscode/blob/main/README.md)'
for name, entries in [
    ('normal', [('extension/README.md', readme), ('extension/data.txt', 'preserved content')]),
    ('unsafe', [('../outside.txt', 'must not escape')]),
    ('duplicate', [('extension/data.txt', 'one'), ('extension/data.txt', 'two')]),
    ('bad-link', [('extension/README.md', '[bad](https://github.com/elk-9527/dsh-vscode/blob/dev/README.md)')]),
    ('large-readme', [('extension/README.md', 'x' * 1048577)])]:
    with zipfile.ZipFile(root / (name + '.vsix'), 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file, content in entries:
            archive.writestr(file, content)
with zipfile.ZipFile(root / 'link.vsix', 'w') as archive:
    entry = zipfile.ZipInfo('extension/link'); entry.create_system = 3; entry.external_attr = 0o120777 << 16
    archive.writestr(entry, 'outside')`, fixture], { windowsHide: true, stdio: 'pipe' });
const routes = process.platform === 'win32' ? ['win32', 'linux'] : [process.platform];
for (const platform of routes) {
  const destination = path.join(fixture, platform); fs.mkdirSync(destination);
  extractVsix(path.join(fixture, 'normal.vsix'), destination, { platform, python });
  assert.equal(fs.readFileSync(path.join(destination, 'extension/data.txt'), 'utf8'), 'preserved content');
  assert.equal(checkArchiveReadme(path.join(fixture, 'normal.vsix'), { platform, python }), true);
  for (const name of ['unsafe', 'duplicate']) {
    const rejected = path.join(fixture, platform + '-' + name); fs.mkdirSync(rejected);
    assert.throws(() => extractVsix(path.join(fixture, name + '.vsix'), rejected, { platform, python }));
  }
  for (const name of ['bad-link', 'large-readme']) assert.throws(() => checkArchiveReadme(path.join(fixture, name + '.vsix'), { platform, python }));
}
const rejectedLink = path.join(fixture, 'linux-link'); fs.mkdirSync(rejectedLink);
assert.throws(() => extractVsix(path.join(fixture, 'link.vsix'), rejectedLink, { platform: 'linux', python }));
assert(!fs.existsSync(path.join(fixture, 'outside.txt')));
console.log('PASS portable VSIX extraction and README validation reject traversal, duplicates, links, stale branches and oversized README');
