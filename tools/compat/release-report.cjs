'use strict';
/** 报告写入与纯验证器分离；不会启动内核、编辑器或发布子进程。 */
const fs = require('node:fs'), path = require('node:path');
const { argsOf } = require('./lib.cjs');
const { releaseCheck } = require('./release-check.cjs');
function writeReleaseReport(options, context) {
  if (typeof options.out !== 'string') throw new Error('需要 --out 指定生成的发布报告');
  const file = path.resolve(options.out);
  if (fs.existsSync(file)) throw new Error('发布报告已存在；请指定新路径，保留原验收记录');
  const report = releaseCheck(options, context);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`${report.status}: ${file}`); return report;
}
if (require.main === module) { try { process.exitCode = writeReleaseReport(argsOf()).releaseReady ? 0 : 1; } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { writeReleaseReport };
