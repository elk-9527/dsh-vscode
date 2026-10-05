'use strict';
const fs = require('node:fs'), path = require('node:path');
const { ROOT, locate } = require('../compat/lib.cjs');
function packSdk(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const packed = JSON.parse(locate.runDshSync({ command: 'npm', args: ['pack', path.join(ROOT, 'packages/dsh-bridge-sdk'), '--ignore-scripts', '--pack-destination', destination, '--json'] }));
  return path.join(destination, packed[0].filename);
}
/** 未发布 SDK 的本地候选使用精确 file: 覆盖；不改变版本等待或脚本审批策略。 */
function pinSdk(profile, archive) {
  const file = path.join(profile, 'pnpm-workspace.yaml');
  const original = fs.readFileSync(file, 'utf8');
  const spec = JSON.stringify('file:' + path.resolve(archive).split(path.sep).join('/'));
  let updated;
  if (/^overrides:\s*$/m.test(original)) {
    if (/^  ['"]?dsh-ide-bridge-sdk['"]?:/m.test(original)) updated = original.replace(/^  ['"]?dsh-ide-bridge-sdk['"]?:[^\r\n]*/m, '  dsh-ide-bridge-sdk: ' + spec);
    else updated = original.replace(/^overrides:\s*$/m, 'overrides:\n  dsh-ide-bridge-sdk: ' + spec);
  } else updated = original.trimEnd() + '\n\noverrides:\n  dsh-ide-bridge-sdk: ' + spec + '\n';
  fs.writeFileSync(file, updated); return { original, updated };
}
module.exports = { packSdk, pinSdk };
