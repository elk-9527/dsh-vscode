'use strict';

/*
 * 权限预设的「界面翻译」层（纯函数，见 src/dsh/permission.js）。
 *
 * 这一层要焊住的是**跟桌面端一致**：
 *   - 清单不写死 —— 内核给什么就显示什么（用户装了 Auto Approval 那种插件、
 *     或者自己在 cordis.patch.yml 里加了预设，面板必须跟着多出来）；
 *   - 内置那三项的**中文标签跟桌面端逐字一致**（仅可查看/工作区内修改/完全权限），
 *     自定义项一律用内核给的 name（别人起的名不替他改）；
 *   - 「完全权限」必须带确认文案，而且文案只有一份（扩展里那份）。
 */

const {
  BUILTIN,
  CONFIRM,
  NEEDS_CONFIRM,
  decorateOptions,
  currentLabel,
  explainPermissionFailure,
} = require('../src/dsh/permission.js');

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

/** 这台机器上那份真实的清单（dsh-base 三项 + auto-approval 插件加的一项）。 */
const REAL = [
  { value: 'read-only', name: 'read-only' },
  { value: 'workspace-write', name: 'workspace-write' },
  { value: 'auto-approval', name: 'Auto Approval' },
  { value: 'danger-full-access', name: 'danger-full-access' },
];

section('1. 内置那三项的中文标签（跟桌面端逐字一致）');
{
  const decorated = decorateOptions(REAL, 'workspace-write');
  const byValue = Object.fromEntries(decorated.map((item) => [item.value, item]));
  check('read-only → 仅可查看', byValue['read-only'].label === '仅可查看', byValue['read-only'].label);
  check('workspace-write → 工作区内修改', byValue['workspace-write'].label === '工作区内修改');
  check('danger-full-access → 完全权限', byValue['danger-full-access'].label === '完全权限');
  check('三项都带中文说明（内核给的是英文，这里翻成人话）',
    Boolean(byValue['read-only'].description && byValue['workspace-write'].description &&
      byValue['danger-full-access'].description));
  check('说明里没有残留的英文原句',
    !Object.values(byValue).some((item) => /anywhere|permitted|prompts/.test(item.description || '')));
}

section('2. 自定义项（含插件加的）原样用内核给的名字');
{
  const decorated = decorateOptions(REAL, 'read-only');
  const auto = decorated.find((item) => item.value === 'auto-approval');
  check('auto-approval 的标签就是内核给的 Auto Approval（不替他改名）',
    auto.label === 'Auto Approval', auto.label);
  check('插件加的项不带中文说明（它自己没给就留空）', auto.description === undefined);
  const custom = decorateOptions(
    [{ value: 'my-tier', name: '我的档', description: '自己配的' }],
    'my-tier',
  )[0];
  check('用户自己加的预设：名字与说明都照搬', custom.label === '我的档' &&
    custom.description === '自己配的');
  const nameless = decorateOptions([{ value: 'no-name' }], 'no-name')[0];
  check('内核连名字都没给 → 用 id 顶上（内核自己也这么兜底）', nameless.label === 'no-name');
}

section('3. 当前项与确认门');
{
  const decorated = decorateOptions(REAL, 'auto-approval');
  check('只有一个 active', decorated.filter((item) => item.active).length === 1);
  check('active 落在当前值上', decorated.find((item) => item.active).value === 'auto-approval');
  const danger = decorated.find((item) => item.value === 'danger-full-access');
  check('完全权限要确认', danger.needsConfirm === true);
  check('确认文案跟着选项一起发过去（webview 里不另存一份）',
    danger.confirm && danger.confirm.title === CONFIRM.title && danger.confirm.accept === CONFIRM.accept);
  check('确认文案说的是人话（不是「Are you sure?」）',
    /完全权限/.test(CONFIRM.title) && /不再逐条问你/.test(CONFIRM.body));
  check('另外三档不需要确认',
    decorateOptions(REAL, 'read-only').filter((item) => item.needsConfirm).length === 1);
  check('NEEDS_CONFIRM 只认 danger-full-access 这一个 id', NEEDS_CONFIRM.size === 1 &&
    NEEDS_CONFIRM.has('danger-full-access'));
}

section('4. 当前值不在清单里（内核的 custom 状态）');
{
  const decorated = decorateOptions(REAL, 'custom');
  check('custom 也是中文标签（自定义）', currentLabel('custom', REAL) === '自定义');
  check('custom 不是任何选项的 active（清单里没有它）',
    decorated.filter((item) => item.active).length === 0);
  check('完全陌生的值也不炸，原样显示', currentLabel('weird-tier', REAL) === 'weird-tier');
  check('空值给「未知」而不是 undefined', currentLabel('', []) === '（未知）');
  check('清单为空时 currentLabel 仍然给得出标签',
    currentLabel('read-only', []) === '仅可查看');
}

section('5. 垃圾输入不炸（webview 与内核之间什么都可能来）');
{
  check('options 不是数组 → 空清单', decorateOptions(undefined, 'x').length === 0 &&
    decorateOptions({ a: 1 }, 'x').length === 0);
  check('选项里混垃圾 → 跳过，不抛',
    decorateOptions([null, 'x', { value: 'ok' }, { name: '没有 value' }], 'ok').length === 1);
  check('BUILTIN 覆盖 custom（内核会把它作为展示项附加在末尾）', Boolean(BUILTIN.custom));
}

section('6. 「切不了」的三种说法各不一样');
{
  const oldDoor = explainPermissionFailure({ code: -32601, message: '门不支持 dsh-door/permission/get（门版本太旧或方法名不对）' });
  const noService = explainPermissionFailure({ code: -32601, message: '这个内核里没有权限预设服务（@deepseek-ai/dsh-permission-presets 没挂），所以这里切不了权限' });
  const other = explainPermissionFailure({ code: -32000, message: '这个内核里没有会话 abc' });
  check('旧门 → 劝升级门（状态是 old-door）', oldDoor.state === 'old-door');
  check('旧门的话里点名了版本要求（0.0.12）', /0\.0\.12/.test(oldDoor.detail));
  check('没装权限服务 → 明说这个内核没有（状态 no-service）', noService.state === 'no-service');
  check('没装服务时不说「升级门」（那是另一回事）', !/0\.0\.12/.test(noService.detail));
  check('其它错误照实转述原文', other.state === 'error' && other.detail === '这个内核里没有会话 abc');
  check('什么信息都没有也不炸', explainPermissionFailure().state === 'error' &&
    explainPermissionFailure(undefined).text.length > 0);
}

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
