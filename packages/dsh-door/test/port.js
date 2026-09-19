/*
 * 门的端口判定（纯函数）。
 *
 * 为什么要单独测：端口以前只写在档的配置里，于是"面板设置里是 A、档里是 B"
 * 这种情况只能靠人去对，对不上就是"内核起来了但门没开在我等的地方"——
 * 用户对着「正在启动…」干等两分钟。现在面板可以用 DSH_ACP_DOOR_PORT
 * 把它钉死，这一层优先级必须有测试焊着，不然哪天有人调个顺序就悄悄回退了。
 */
import { DEFAULT_PORT, resolveDoorPort } from '../lib/port.js';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `（${detail}）` : ''}`);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

console.log('\n── 门的端口判定 ───────────────────────────────────────');

check('默认是 47821（和桌面端一致，方便"有门就接"）', DEFAULT_PORT === 47821, String(DEFAULT_PORT));
check('什么都没配 → 默认端口', resolveDoorPort({}, {}) === 47821);
check('档里配了 → 用档里的', resolveDoorPort({ port: 1234 }, {}) === 1234);
check(
  '环境变量优先于档里的（面板说了算）',
  resolveDoorPort({ port: 1234 }, { DSH_ACP_DOOR_PORT: '47831' }) === 47831,
);
check(
  '环境变量是空串/垃圾 → 退回档里的',
  resolveDoorPort({ port: 1234 }, { DSH_ACP_DOOR_PORT: 'abc' }) === 1234 &&
    resolveDoorPort({ port: 1234 }, { DSH_ACP_DOOR_PORT: '' }) === 1234,
);
check(
  '0 是合法值（让系统挑空闲端口）',
  resolveDoorPort({ port: 1234 }, { DSH_ACP_DOOR_PORT: '0' }) === 0 &&
    resolveDoorPort({ port: 0 }, {}) === 0,
);
check(
  '越界/负数/小数一律不算数，退回默认',
  resolveDoorPort({}, { DSH_ACP_DOOR_PORT: '65536' }) === 47821 &&
    resolveDoorPort({}, { DSH_ACP_DOOR_PORT: '-1' }) === 47821 &&
    resolveDoorPort({}, { DSH_ACP_DOOR_PORT: '12.5' }) === 47821,
);
check(
  '档里配了垃圾 → 默认端口（不崩）',
  resolveDoorPort({ port: 'x' }, {}) === 47821 && resolveDoorPort(undefined, {}) === 47821,
);

console.log(`\n  ${failed === 0 ? '✅' : '❌'} 端口判定：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`);
for (const item of failures) console.log(`     - ${item}`);
process.exit(failed === 0 ? 0 : 1);
