'use strict';

/*
 * 权限预设的「界面翻译」层（纯函数，见 src/dsh/permission.js）。
 *
 * 本层用于固定**与桌面端一致**这一约束：
 *   - 清单不写死：内核返回什么就显示什么（用户安装 Auto Approval 等插件，
 *     或在 cordis.patch.yml 中添加预设时，面板必须一并出现）；
 *   - 内置三项的**中文标签与桌面端逐字一致**（仅可查看/工作区内修改/完全权限），
 *     自定义项一律使用内核提供的 name（由他人命名的内容不作改动）；
 *   - 「完全权限」必须附带确认文案，且文案只有一份（扩展中的那一份）。
 */

const {
  BUILTIN,
  CONFIRM,
  DISPLAY_ONLY,
  DOOR_CODES,
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

/** 本机上那份真实的清单（dsh-base 三项 + auto-approval 插件添加的一项）。 */
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
  check('三项都带中文说明（内核给出的是英文，此处翻译为中文）',
    Boolean(byValue['read-only'].description && byValue['workspace-write'].description &&
      byValue['danger-full-access'].description));
  check('说明里没有残留的英文原句',
    !Object.values(byValue).some((item) => /anywhere|permitted|prompts/.test(item.description || '')));
}

section('2. 自定义项（含插件添加的项）原样使用内核提供的名称');
{
  const decorated = decorateOptions(REAL, 'read-only');
  const auto = decorated.find((item) => item.value === 'auto-approval');
  check('auto-approval 的标签就是内核给的 Auto Approval（不替他改名）',
    auto.label === 'Auto Approval', auto.label);
  check('插件添加的项不带中文说明（插件未提供时留空）', auto.description === undefined);
  const custom = decorateOptions(
    [{ value: 'my-tier', name: '我的档', description: '自己配的' }],
    'my-tier',
  )[0];
  check('用户自行添加的预设：名称与说明均原样保留', custom.label === '我的档' &&
    custom.description === '自己配的');
  const nameless = decorateOptions([{ value: 'no-name' }], 'no-name')[0];
  check('内核未提供名称 → 使用 id 顶替（内核自身也如此回退）', nameless.label === 'no-name');
}

section('3. 当前项与确认步骤');
{
  const decorated = decorateOptions(REAL, 'auto-approval');
  check('只有一个 active', decorated.filter((item) => item.active).length === 1);
  check('active 落在当前值上', decorated.find((item) => item.active).value === 'auto-approval');
  const danger = decorated.find((item) => item.value === 'danger-full-access');
  check('完全权限要确认', danger.needsConfirm === true);
  check('确认文案随选项一并发送（webview 中不另存一份）',
    danger.confirm && danger.confirm.title === CONFIRM.title && danger.confirm.accept === CONFIRM.accept);
  check('确认文案为中文表述（不是「Are you sure?」）',
    /完全权限/.test(CONFIRM.title) && /不再逐条询问/.test(CONFIRM.body));
  check('另外三档不需要确认',
    decorateOptions(REAL, 'read-only').filter((item) => item.needsConfirm).length === 1);
  check('NEEDS_CONFIRM 只包含 danger-full-access 这一个 id', NEEDS_CONFIRM.size === 1 &&
    NEEDS_CONFIRM.has('danger-full-access'));
}

section('4. 当前值不在清单里（内核的 custom 状态）');
{
  const decorated = decorateOptions(REAL, 'custom');
  check('custom 也是中文标签（自定义）', currentLabel('custom', REAL) === '自定义');
  check('custom 不是任何选项的 active（清单中没有它）',
    decorated.filter((item) => item.active).length === 0);
  check('完全陌生的值也不报错，原样显示', currentLabel('weird-tier', REAL) === 'weird-tier');
  check('空值返回「未知」，而非 undefined', currentLabel('', []) === '（未知）');
  check('清单为空时 currentLabel 仍然给出标签',
    currentLabel('read-only', []) === '仅可查看');
}

section('4.5 custom 是展示项，不是可切换的目标');
{
  /*
   * 内核的 `selectFor` 在「当前设置不匹配任何预设」时会把 custom 作为一项
   * **附在清单末尾**（permission-presets/index.js:233），而 `resolve('custom')`
   * 直接抛出异常（:245）。因此它必须保留在清单中（当前状态需要显示），
   * 但**不能成为可点击的一行**；桌面端同样如此处理（optionsOf 中滤除 custom）。
   * 点击它原先表现为「无法读取当前权限」，容易让人误认为无法连接内核。
   */
  const withCustom = decorateOptions(
    [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'custom', name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' },
    ],
    'custom',
  );
  const custom = withCustom.find((item) => item.value === 'custom');
  check('custom 保留在清单中（否则弹卡没有任何勾选项）', Boolean(custom));
  check('custom 标了 selectable: false', custom.selectable === false);
  check('custom 用的是中文标签「自定义」，不是内核给的 Custom', custom.label === '自定义', custom.label);
  check('custom 是 active（当前确实不在任何预设上）', custom.active === true);
  check('custom 不需要确认（它无法切换）', custom.needsConfirm === false);
  check('其余档一律可选', withCustom.filter((item) => item.value !== 'custom')
    .every((item) => item.selectable === true));
  check('真实四档中没有不可选项（不得将可切换项标灰）',
    decorateOptions(REAL, 'workspace-write').every((item) => item.selectable === true));
  check('DISPLAY_ONLY 只包含 custom 一项（不得将其他项一并标灰）',
    DISPLAY_ONLY.size === 1 && DISPLAY_ONLY.has('custom'));
}

section('5. 异常输入不报错（webview 与内核之间可能传入任意数据）');
{
  check('options 不是数组 → 空清单', decorateOptions(undefined, 'x').length === 0 &&
    decorateOptions({ a: 1 }, 'x').length === 0);
  check('选项中含有异常项 → 跳过，不抛出',
    decorateOptions([null, 'x', { value: 'ok' }, { name: '没有 value' }], 'ok').length === 1);
  check('BUILTIN 覆盖 custom（内核会把它作为展示项附加在末尾）', Boolean(BUILTIN.custom));
}

section('6. 「无法切换」的各种说法互不相同，且**均不得出现内部词**');
{
  const oldDoor = explainPermissionFailure({ code: -32601, message: '门不支持 dsh-door/permission/get（门版本太旧或方法名不对）' });
  const noService = explainPermissionFailure({ code: -32601, message: '这个内核里没有权限预设服务（@deepseek-ai/dsh-permission-presets 没挂），所以这里切不了权限' });
  const other = explainPermissionFailure({ code: -32000, message: '这个内核里没有会话 abc' });
  check('该插件的旧版 → 状态是 old-door', oldDoor.state === 'old-door');
  check('未安装权限服务 → 状态是 no-service', noService.state === 'no-service');
  check('其他错误 → 状态是 error', other.state === 'error');
  check('三种说法的正文互不相同（不得合并为一句）',
    new Set([oldDoor.text, noService.text, other.text]).size === 3);
  /*
   * 本条依据用户 2026-09-19 的反馈：旧版插件那句原先为
   * 「切不了权限（内核里的门太旧）」+「要门 dsh-acp-door 0.0.12+」，
   * 用户原话为「『门』都出来了，别人能知道是什么意思？」。
   * 因此现在**所有对外文案**均需通过黑名单检查：内部组件名、包名、版本号、
   * 「档」、设置项全名，一个都不允许出现。
   */
  const JARGON = /门|dsh-acp-door|dsh-base|dsh-door|@deepseek-ai|0\.0\.\d+|档|profile|settings\.yaml|dshPanel\.|host:|:\d{4,5}|zstd|Node /;
  for (const [name, shaped] of [['old-door', oldDoor], ['no-service', noService], ['error', other]]) {
    const all = `${shaped.text} ${shaped.detail || ''}`;
    check(`${name} 的文案中没有内部词（门/包名/版本号/档/设置项）`, !JARGON.test(all), all);
  }
  check('该插件的旧版说明给出的处理途径是「升级或换一台」',
    /升级|最新版|桌面端/.test(oldDoor.detail || ''), oldDoor.detail);
  check('未提供权限设置的说法指向桌面端（更换内核无效）',
    /桌面端/.test(noService.detail || ''), noService.detail);
  check('无任何信息时也不报错', explainPermissionFailure().state === 'error' &&
    explainPermissionFailure(undefined).text.length > 0);
}

section('7. 失败分档：优先依据错误码，中文原文仅用于该插件的旧版');
{
  /*
   * 本节固定 2026-09-21 那份问题清单中的第 5 条：切换时名称已失效（面板开着期间
   * 另一端卸载了插件或修改了表），该插件返回 -32000，因此此处全部归入 'error' ——
   * 用户看到「无法读取当前权限 / 请点击『重新连接』后重试」，而重连永远无法修复，
   * 真实原因（名称已不存在）仅留在日志中。现在该插件会分别报告这两种失败的码，
   * 此处按码给出说明。
   */
  check('扩展识别的码与该插件发送的码一致（差值一位即会分错类别）',
    DOOR_CODES.UNKNOWN_PRESET === -32002 && DOOR_CODES.NO_SESSION === -32003,
    `${DOOR_CODES.UNKNOWN_PRESET} / ${DOOR_CODES.NO_SESSION}`);
  const gone = explainPermissionFailure({
    code: DOOR_CODES.UNKNOWN_PRESET,
    message: 'permission: unknown preset "gone" (known: read-only, workspace-write)',
  });
  const noSession = explainPermissionFailure({
    code: DOOR_CODES.NO_SESSION,
    message: '这个内核里没有会话 abc（可能它是别的内核建的，或已被关闭）',
  });
  check('选项名不在了 → no-such-preset', gone.state === 'no-such-preset', gone.state);
  check('会话不在了 → no-session', noSession.state === 'no-session', noSession.state);
  check('这两种都不得说成「无法读取当前权限」（与事实不符）',
    !/无法读取/.test(gone.text + (gone.detail || '')) && !/无法读取/.test(noSession.text + (noSession.detail || '')),
    `${gone.text} / ${noSession.text}`);
  check('也不得建议「请点击『重新连接』后重试」（无法修复，只会让用户做无效尝试）',
    !/重新连接/.test(gone.text + (gone.detail || '')),
    gone.text + ' ' + (gone.detail || ''));
  check('选项不存在时指向「重新读取清单、选择仍可用的项」',
    /重新读/.test(gone.detail || '') && /仍可用/.test(gone.detail || ''), gone.detail);
  check('会话不存在时指向「重新打开一段」这条途径',
    /历史|重新打开|重开/.test(noSession.detail || ''), noSession.detail);
  check('**码优先于原话**：原话形如「方法不存在」时仍按码处理',
    explainPermissionFailure({ code: DOOR_CODES.UNKNOWN_PRESET, message: 'Method not found' })
      .state === 'no-such-preset');
  check('五种情形的正文互不相同（不得合并为一句）',
    new Set([gone.text, noSession.text, explainPermissionFailure({ code: -32601, message: 'Method not found' }).text,
      explainPermissionFailure({ code: -32601, message: '没有权限预设服务' }).text,
      explainPermissionFailure({ code: -32000, message: '别的问题' }).text]).size === 5);
  const JARGON = /门|dsh-acp-door|dsh-base|dsh-door|@deepseek-ai|0\.0\.\d+|档|profile|settings\.yaml|dshPanel\.|host:|:\d{4,5}|zstd|Node /;
  for (const [name, shaped] of [['no-such-preset', gone], ['no-session', noSession]]) {
    const all = `${shaped.text} ${shaped.detail || ''}`;
    check(`${name} 的文案中也没有内部词`, !JARGON.test(all), all);
  }
}

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
