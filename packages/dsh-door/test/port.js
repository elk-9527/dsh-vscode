/*
 * ACP 接入点插件（`dsh-acp-door`）的端口判定（纯函数）。
 *
 * 单独测试的原因：端口此前只写在档的配置里，于是"面板设置里是 A、档里是 B"
 * 这类不一致只能人工核对，遗漏核对的表现是内核已启动、该插件未监听在预期端口，
 * 界面停留在「正在启动…」，用户需等待约两分钟。目前面板可用 DSH_ACP_DOOR_PORT 固定
 * 该端口，这一层的优先级必须有测试覆盖，否则调整判定顺序会造成静默回退。
 */
import { DEFAULT_PORT, LOOPBACK_HOST, resolveDoorHost, resolveDoorPort } from '../lib/port.js';

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

console.log('\n── 该插件的端口判定 ───────────────────────────────────');

check('监听地址固定为 127.0.0.1（没有鉴权，不允许暴露到其它地址）', LOOPBACK_HOST === '127.0.0.1');
check(
  '未配置地址或明确回环地址 → 监听 127.0.0.1，且不产生拒绝标记',
  resolveDoorHost({}).host === LOOPBACK_HOST && !resolveDoorHost({ host: '127.0.0.1' }).rejected,
);
check(
  '0.0.0.0、localhost、局域网地址均被拒绝并固定回环',
  ['0.0.0.0', 'localhost', '192.168.1.8'].every((host) => {
    const result = resolveDoorHost({ host });
    return result.host === LOOPBACK_HOST && result.rejected;
  }),
);
check('默认是 47821（与桌面端一致，便于"有该插件即连接"）', DEFAULT_PORT === 47821, String(DEFAULT_PORT));
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
