/** 一次运行 dsh-acp-door 的全部纯函数测试。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  ['帧解析与中继', 'frames.js'],
  ['历史会话读取', 'sessions.js'],
  ['端口与监听边界', 'port.js'],
  ['模型选择与状态', 'model-status.js'],
  ['权限预设旁路', 'permission.js'],
];

const results = [];
for (const [name, file] of suites) {
  console.log(`\n${'█'.repeat(3)} ${name} ${'█'.repeat(3)}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, file)], {
    cwd: path.resolve(root, '..'),
    stdio: 'inherit',
  });
  results.push({ name, code: result.status, ms: Date.now() - started });
}

console.log(`\n${'═'.repeat(56)}`);
for (const result of results) {
  console.log(
    `  ${result.code === 0 ? '✅' : '❌'} ${result.name}  (${(result.ms / 1000).toFixed(1)}s)`,
  );
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length) {
  console.log(`\n❌ ${failed.length} 个套件失败`);
  process.exit(1);
}
console.log(`\n✅ dsh-acp-door 全部通过（共 ${results.length} 个套件）`);
