/*
 * ACP 接入点插件（`dsh-acp-door`）的权限预设旁路方法（纯函数）。
 *
 * 单独设置一个套件的原因：这一层是「内核 ↔ 面板」之间唯一的新协议面，
 * 且其输入有一半来自**用户可配**的内容（`read-only` 那几个是内置的，
 * `auto-approval` 是插件加的，用户还能自行添加预设）。因此这里固定的是
 * 「无论内核给出的形状如何，返回给客户端的形状都是确定的」，以及
 * 「各类失败各有各的码、各有各的说明（该插件不支持的方法 / 没有权限服务 / 参数不对 /
 * 选项名不存在 / 会话不存在）—— 客户端依照码处理，不依赖原始文本推测」。
 */
import {
  DOOR_ERR_NO_SESSION,
  DOOR_ERR_OTHER,
  DOOR_ERR_UNKNOWN_PRESET,
  DOOR_PERMISSION_PREFIX,
  MAX_PERMISSION_OPTIONS,
  PERMISSION_GET_METHOD,
  PERMISSION_SET_METHOD,
  doorErrorCode,
  doorPermissionError,
  doorPermissionMethod,
  doorPermissionResult,
  isDoorPermissionRequest,
  normalizePermissionOptions,
  permissionError,
  permissionPayload,
  permissionTarget,
  settledPermission,
} from '../lib/permission.js';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ───────────────────────────────────────`);
}

section('1. 认出「这是该插件的权限方法」');
{
  const get = { jsonrpc: '2.0', id: 1, method: PERMISSION_GET_METHOD, params: { id: 's1' } };
  const set = { jsonrpc: '2.0', id: 2, method: PERMISSION_SET_METHOD, params: { id: 's1', value: 'read-only' } };
  check('get 认出来了', isDoorPermissionRequest(get) && doorPermissionMethod(get) === 'get');
  check('set 认出来了', isDoorPermissionRequest(set) && doorPermissionMethod(set) === 'set');
  check('通知（没有 id）不算请求 —— 该插件只应答请求',
    !isDoorPermissionRequest({ method: PERMISSION_GET_METHOD }));
  check('内核自己的方法不算（别抢人家的）',
    !isDoorPermissionRequest({ id: 3, method: 'session/set_config_option' }) &&
      !isDoorPermissionRequest({ id: 4, method: 'session/permission' }));
  check('前缀是 dsh-door 命名空间', DOOR_PERMISSION_PREFIX === 'dsh-door/permission/');
  check('空值/垃圾不炸', !isDoorPermissionRequest(undefined) && !isDoorPermissionRequest(null) &&
    !isDoorPermissionRequest({ id: 5, method: 42 }));
}

section('2. 参数：谁、切成什么');
{
  check('get：只要会话 id', JSON.stringify(permissionTarget('get', { id: 'abc' })) === '{"sessionId":"abc"}');
  check('get 忽略 value（读不该有副作用）',
    JSON.stringify(permissionTarget('get', { id: 'abc', value: 'x' })) === '{"sessionId":"abc"}');
  check('set：要 id + value',
    JSON.stringify(permissionTarget('set', { id: 'abc', value: 'danger-full-access' })) ===
      '{"sessionId":"abc","value":"danger-full-access"}');
  check('set 少一个就说少一个', permissionTarget('set', { id: 'abc' }).value === undefined);
  check('空字符串不算（不得用 "" 去切）',
    permissionTarget('set', { id: 'abc', value: '' }).value === undefined &&
      permissionTarget('get', { id: '' }).sessionId === undefined);
  check('params 整个缺失也不炸', JSON.stringify(permissionTarget('get', undefined)) === '{}');
  check('params 是数组/数字也不炸', permissionTarget('get', []).sessionId === undefined &&
    permissionTarget('get', 7).sessionId === undefined);
}

section('3. 洗内核给的选项');
{
  const cleaned = normalizePermissionOptions([
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: '工作区内修改', description: '在工作区里写' },
    { value: 'auto-approval', name: 'Auto Approval', description: '' },
    { value: 'x' },
    { name: '只有名字' },
    null,
    '字符串',
    { value: 42, name: 'value 不是字符串' },
  ]);
  check('只留能用的（有 value 的）', cleaned.length === 4, JSON.stringify(cleaned));
  check('缺 name 用 value 顶上（与内核相同的后备行为）',
    cleaned[0].name === 'read-only' && cleaned[3].name === 'x',
    JSON.stringify(cleaned.map((item) => item.name)));
  check('description 空串不带上（空的不算说明）', !('description' in cleaned[2]));
  check('description 原样带上', cleaned[1].description === '在工作区里写');
  check('不是数组 → 空清单（不抛）',
    normalizePermissionOptions(undefined).length === 0 &&
      normalizePermissionOptions({ value: 'x' }).length === 0);
  check('超长的表会被截断（有上限，避免 webview 负载过大）',
    normalizePermissionOptions(Array.from({ length: 200 }, (_, i) => ({ value: `p${i}` }))).length ===
      MAX_PERMISSION_OPTIONS);
}

section('4. 回给客户端的载荷');
{
  const payload = permissionPayload({
    currentValue: 'workspace-write',
    options: [{ value: 'read-only', name: 'read-only' }],
    defaultPreset: 'workspace-write',
  });
  check('currentValue / options / defaultPreset 都在',
    payload.currentValue === 'workspace-write' && payload.options.length === 1 &&
      payload.defaultPreset === 'workspace-write');
  check('没有默认值时就不带这个字段（少一个空字段）',
    !('defaultPreset' in permissionPayload({ currentValue: 'x', options: [] })));
  check('读不到当前值 → custom（内核的「不在任何预设上」就是这个意思）',
    permissionPayload({ currentValue: undefined, options: [] }).currentValue === 'custom');
  check('custom 本身原样留着（不要把它当成没读到）',
    permissionPayload({ currentValue: 'custom', options: [] }).currentValue === 'custom');
}

section('5. 切换之后以「刚切的那个」为准');
{
  check('内核回读还是旧值 → 用刚切的', settledPermission('workspace-write', 'read-only') === 'workspace-write');
  check('内核回读是空的 → 用刚切的', settledPermission('', 'read-only') === 'read-only');
  check('内核回读是 undefined → 用刚切的', settledPermission(undefined, 'read-only') === 'read-only');
}

section('6. 应答帧的形状');
{
  check('成功帧是 {jsonrpc, id, result}',
    JSON.stringify(doorPermissionResult(9, { currentValue: 'x' })) ===
      '{"jsonrpc":"2.0","id":9,"result":{"currentValue":"x"}}');
  check('错误帧是 {jsonrpc, id, error:{code,message}}',
    JSON.stringify(doorPermissionError(9, -32601, '没有')) ===
      '{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"没有"}}');
  check('错误码用 JSON-RPC 的约定（方法不存在 -32601 / 参数不对 -32602 / 其它 -32000）',
    doorPermissionError(1, -32602, '').error.code === -32602);
}

section('7. 失败要分档：客户端照着码说话，不去猜中文原话');
{
  /*
   * 本节的由来：此前「选项名不存在」与「会话找不到」都返回 -32000，客户端只能对该插件的
   * 中文原始文本做正则匹配来决定应答内容 —— 该插件改动措辞后，客户端即分档错误，用户
   * 得到的原因说明也随之错误（表现见 2026-09-21 的 bug 清单：点 custom 报「读不到当前权限」）。
   */
  check('三个码齐了，而且是三个不同的数',
    DOOR_ERR_OTHER === -32000 && DOOR_ERR_UNKNOWN_PRESET === -32002 && DOOR_ERR_NO_SESSION === -32003 &&
      new Set([DOOR_ERR_OTHER, DOOR_ERR_UNKNOWN_PRESET, DOOR_ERR_NO_SESSION]).size === 3,
    [DOOR_ERR_OTHER, DOOR_ERR_UNKNOWN_PRESET, DOOR_ERR_NO_SESSION].join(','));
  check('不与 JSON-RPC 自身的约定冲突（-32601 / -32602 / -32700 那几个）',
    ![DOOR_ERR_OTHER, DOOR_ERR_UNKNOWN_PRESET, DOOR_ERR_NO_SESSION].some((code) =>
      [-32600, -32601, -32602, -32700, -32701].includes(code)));
  const unknown = permissionError(DOOR_ERR_UNKNOWN_PRESET, 'permission: unknown preset "gone" (known: read-only)');
  check('打标的异常带得走码', doorErrorCode(unknown) === DOOR_ERR_UNKNOWN_PRESET);
  check('内核原话一个字不改地留着（可用清单就在里面，日志与排障要靠它）',
    /unknown preset "gone"/.test(unknown.message) && /known: read-only/.test(unknown.message),
    unknown.message);
  check('未标记的异常落到 -32000（不猜测为别的档）',
    doorErrorCode(new Error('别的问题')) === DOOR_ERR_OTHER);
  check('垃圾输入不炸', doorErrorCode(undefined) === DOOR_ERR_OTHER &&
    doorErrorCode(null) === DOOR_ERR_OTHER && doorErrorCode({}) === DOOR_ERR_OTHER);
  check('错误帧带着这个码发出去',
    doorPermissionError(1, DOOR_ERR_NO_SESSION, '').error.code === DOOR_ERR_NO_SESSION);
}

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
