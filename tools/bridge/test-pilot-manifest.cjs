'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { PILOTS, loadPilots } = require('./build-pilots.cjs');
const { ROOT, sha256 } = require('../compat/lib.cjs');
const folder = require('../test-workspace.cjs').createFixture('pilot-manifest');
const records = PILOTS.map(pilot => {
  const file = path.join(folder, pilot.key + '.tgz'); fs.writeFileSync(file, pilot.key);
  return { ...pilot, file: path.relative(ROOT, file).replace(/\\/g, '/'), packageSha256: sha256(file) };
});
const file = path.join(folder, 'manifest.json');
const write = value => fs.writeFileSync(file, JSON.stringify(value));
write(records); assert.deepEqual(loadPilots(file), records);
for (const change of [value => value.pop(), value => value[1] = value[0], value => value[0].candidate = '0.0.0-old',
  value => value[0].sha256 = '0'.repeat(64), value => value[0].packageSha256 = '0'.repeat(64),
  value => value[0].file = 'package.json']) {
  const value = structuredClone(records); change(value); write(value); assert.throws(() => loadPilots(file));
}
write(records); fs.appendFileSync(path.resolve(ROOT, records[0].file), 'changed'); assert.throws(() => loadPilots(file), /摘要/);
console.log('PASS explicit pilot manifest: current adapters, archive identity, stale/duplicate/missing/changed inputs rejected');
