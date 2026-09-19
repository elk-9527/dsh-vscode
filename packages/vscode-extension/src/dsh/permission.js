'use strict';

/**
 * 权限预设（面板这一侧）：把内核给的清单翻译成中文界面要的东西。
 *
 * 这个文件是**纯函数**：不碰 vscode、不碰网络，能单独测。
 *
 * ## 为什么要和内核「同步」而不是自己写死一张表
 *
 * 桌面端那个选择器里的东西（仅可查看 / 工作区内修改 / Auto Approval /
 * 完全权限）不是写死的，而是内核 `@deepseek-ai/dsh-permission-presets`
 * 服务读**档里配的预设表**：
 *
 *   - `read-only` / `workspace-write` / `danger-full-access` 来自
 *     `@deepseek-ai/dsh-base`；
 *   - `auto-approval` 是 `dsh-auto-approval-plugin` 这个插件往表里加的
 *     （它把整张表重述一遍再加自己那一项）；
 *   - 用户还能在自己的 `cordis.patch.yml` 里加自定义预设。
 *
 * 所以面板**不许硬编码清单** —— 那样用户装了插件、加了预设，面板里就少一项
 * 或者多一项，跟桌面端对不上。清单一律从门（也就是内核）读。
 * 这里只做两件事：**给内置的几项配上中文标签**（桌面端也是这么做的：
 * 内核给 `read-only`，客户端本地化成「仅可查看」），以及把失败翻译成人话。
 */

/**
 * 内置预设的中文标签与说明。
 *
 * 标签跟桌面端逐字一致（`access.preset.readOnly` 那三个 i18n key）。
 * **说明是我写的中文**：内核给的那几段是英文（`Read files anywhere; no
 * modifications allowed.`），桌面端中文界面里也是英文 —— 那是它没翻。
 * 这个面板整屏都是中文，留着英文说明对用户没好处，所以这里翻成人话。
 * 自定义预设（含 `auto-approval` 这种插件加的）一律**原样用内核给的
 * name/description**：别人起的名我不替他改。
 */
const BUILTIN = {
  'read-only': {
    label: '仅可查看',
    description: '可以读任何位置的文件，不能改任何东西。',
  },
  'workspace-write': {
    label: '工作区内修改',
    description: '可以在工作区和允许的临时目录里写；越界的操作会先问你。',
  },
  'danger-full-access': {
    label: '完全权限',
    description: '读写任何文件都不再问你。只在你信任当前这件事的时候用。',
  },
  custom: {
    label: '自定义',
    description: '当前这套沙箱与批准设置不对应任何预设。',
  },
};

/**
 * 切到「完全权限」要过一道确认（桌面端也有这道风险门）。
 *
 * 为什么在这里做而不是等内核给：内核的选项里没有确认载荷，桌面端的确认是
 * **客户端**按预设名加的（`access.confirm.*` 那一组 i18n 就在客户端包里）。
 * 名字硬编码 `danger-full-access` 是刻意的：它不是一个展示用的字符串，
 * 而是 `@deepseek-ai/dsh-base` 里那个「无批准的全盘访问」预设的 id ——
 * 换名字就等于换语义，那时这里也该跟着改。
 */
const NEEDS_CONFIRM = new Set(['danger-full-access']);

/** 确认门上的文案（跟桌面端一个意思）。 */
const CONFIRM = {
  title: '确认启用完全权限？',
  body: '启用后不再逐条问你：改文件、跑命令、访问工作区外都会直接做。',
  accept: '启用完全权限',
  cancel: '算了',
};

/** 未知预设的兜底标签（内核没给 name 时用）。 */
function fallbackLabel(value) {
  return typeof value === 'string' && value ? value : '（未知）';
}

/**
 * 把内核的选项翻成界面用的选项。
 *
 * 需要确认的那一项会**带上确认文案**（`confirm`）：文案归扩展管，
 * webview 里不另存一份 —— 两处各写一遍迟早会不一致。
 *
 * @param {Array<{value: string, name?: string, description?: string}>} options 门给的清单。
 * @param {string} currentValue 当前生效的预设名。
 * @returns {Array<{value: string, label: string, description?: string, needsConfirm: boolean, confirm?: object, active: boolean}>}
 */
function decorateOptions(options, currentValue) {
  const list = Array.isArray(options) ? options : [];
  const decorated = [];
  for (const option of list) {
    const value = option && typeof option.value === 'string' ? option.value : '';
    // 没有 value 的条目直接丢掉：UI 上点它什么也切不了，留着就是一行死按钮。
    // （门那边也洗过一遍 —— 这里是第二道，因为这份数据最终要进 webview。）
    if (!value) continue;
    const builtin = BUILTIN[value];
    const item = {
      value,
      // 内置的用中文标签；别人加的（auto-approval 之类）原样用内核给的 name。
      label: builtin ? builtin.label : option.name ? option.name : fallbackLabel(value),
      needsConfirm: NEEDS_CONFIRM.has(value),
      active: value === currentValue,
    };
    if (item.needsConfirm) item.confirm = CONFIRM;
    const description = builtin
      ? builtin.description
      : typeof option.description === 'string'
        ? option.description
        : undefined;
    if (description) item.description = description;
    decorated.push(item);
  }
  return decorated;
}

/**
 * 当前权限那一行怎么显示。
 *
 * @param {string} currentValue 门的 `currentValue`。
 * @param {Array<object>} options 门给的清单（用来查中文标签）。
 * @returns {string} 比如「工作区内修改」。
 */
function currentLabel(currentValue, options) {
  const list = Array.isArray(options) ? options : [];
  const hit = list.find((option) => option && option.value === currentValue);
  if (hit) {
    const builtin = BUILTIN[currentValue];
    if (builtin) return builtin.label;
    if (typeof hit.name === 'string' && hit.name) return hit.name;
  }
  const builtin = BUILTIN[currentValue];
  if (builtin) return builtin.label;
  return fallbackLabel(currentValue);
}

/**
 * 选不了的时候（旧门 / 内核没挂权限服务 / 拿不到会话）该怎么跟用户说。
 *
 * 三种情形的话必须不一样：**门太旧**要告诉他升级门；**内核没有权限服务**
 * 是那个档的问题（桌面端在同样的内核里也不会显示这个选择器）；
 * **其它错误**照实转述（比如会话找不到），别吞。
 *
 * @param {object} input
 * @param {number} [input.code] JSON-RPC 错误码（-32601 = 方法不存在）。
 * @param {string} [input.message] 门/内核的原话。
 * @returns {{state: 'old-door'|'no-service'|'error'|'no-session', text: string, detail?: string}}
 */
function explainPermissionFailure({ code, message } = {}) {
  const raw = typeof message === 'string' ? message : '';
  if (code === -32601 || /门不支持|Method not found|不认识权限方法/i.test(raw)) {
    // 旧门和新门「服务缺席」都回 -32601，靠原话区分（新门那句里带「没有权限预设服务」）。
    if (/没有权限预设服务|permission-presets/i.test(raw)) {
      return {
        state: 'no-service',
        text: '这个内核没装权限预设，切不了',
        detail: '换一个装了 dsh-base 的档',
      };
    }
    return {
      state: 'old-door',
      text: '切不了权限（内核里的门太旧）',
      detail: '要门 dsh-acp-door 0.0.12+',
    };
  }
  return {
    state: 'error',
    text: '读不到当前权限',
    detail: raw || undefined,
  };
}

module.exports = {
  BUILTIN,
  CONFIRM,
  NEEDS_CONFIRM,
  decorateOptions,
  currentLabel,
  explainPermissionFailure,
};
