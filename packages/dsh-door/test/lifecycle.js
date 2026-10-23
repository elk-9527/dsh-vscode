import { disposeLiveConnections } from '../lib/lifecycle.js';

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? `（${detail}）` : ''}`);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

console.log('dsh-acp-door · 连接生命周期');

const calls = [];
const errors = [];
const live = new Set([
  {
    teardown: () => calls.push('a-teardown'),
    socket: { destroyed: false, destroy: () => calls.push('a-destroy') },
  },
  {
    teardown: () => { calls.push('b-teardown'); throw new Error('b teardown'); },
    socket: { destroyed: false, destroy: () => calls.push('b-destroy') },
  },
  {
    teardown: () => calls.push('c-teardown'),
    socket: { destroyed: false, destroy: () => { calls.push('c-destroy'); throw new Error('c socket'); } },
  },
  {
    teardown: () => calls.push('d-teardown'),
    socket: { destroyed: true, destroy: () => calls.push('d-destroy') },
  },
]);

const count = disposeLiveConnections(live, (phase, error) => {
  errors.push(`${phase}:${error.message}`);
});

check('返回实际清理的连接数', count === 4, String(count));
check('清理后集合为空', live.size === 0, String(live.size));
check('每条连接都尝试拆除 ACP 桥', ['a', 'b', 'c', 'd'].every((id) => calls.includes(`${id}-teardown`)), calls.join(','));
check('某条 teardown 抛错也继续销毁它的 socket', calls.includes('b-destroy'), calls.join(','));
check('某条 socket 抛错也不影响后一条连接', calls.includes('d-teardown'), calls.join(','));
check('已经关闭的 socket 不会重复 destroy', !calls.includes('d-destroy'), calls.join(','));
check('两类清理错误均被报告', errors.includes('teardown:b teardown') && errors.includes('socket:c socket'), errors.join(','));
check('重复清理是幂等的', disposeLiveConnections(live) === 0);

// The bridge may retain its Agent scope until actual provider settlement, so
// teardown can now finish asynchronously and reject after sockets are closed.
let completeTeardown;
const settling = new Promise(resolve => { completeTeardown = resolve; });
const asyncErrors = [], rejected = [], asyncCalls = [];
const observeRejection = error => rejected.push(error);
process.on('unhandledRejection', observeRejection);
try {
  const asyncLive = new Set([
    { teardown: async () => { await settling; throw new Error('delayed teardown'); }, socket: { destroy() { asyncCalls.push('first-socket'); } } },
    { teardown: () => Promise.reject(new Error('rejected teardown')), socket: { destroy() { asyncCalls.push('second-socket'); } } },
  ]);
  check('异步拆除不延迟关闭连接和清理登记', disposeLiveConnections(asyncLive, (phase, error) => asyncErrors.push(`${phase}:${error.message}`)) === 2 && asyncLive.size === 0 && asyncCalls.length === 2);
  check('异步拆除未落定前不伪造完成结果', !asyncErrors.includes('teardown:delayed teardown'));
  completeTeardown();
  await new Promise(resolve => setImmediate(resolve));
  check('立即和延迟的异步拆除拒绝均被报告', asyncErrors.includes('teardown:rejected teardown') && asyncErrors.includes('teardown:delayed teardown'), asyncErrors.join(','));
  check('异步拆除不会留下未处理的 Promise 拒绝', rejected.length === 0, rejected.map(error => error.message).join(','));
  check('异步清理后重复调用仍为幂等', disposeLiveConnections(asyncLive) === 0);
} finally { process.off('unhandledRejection', observeRejection); }

console.log(`\n${'═'.repeat(56)}`);
if (failures.length === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`   - ${failure}`);
  process.exitCode = 1;
}
