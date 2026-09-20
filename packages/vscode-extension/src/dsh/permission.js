'use strict';

/**
 * 权限预设（面板侧）：将内核返回的清单转换为中文界面所需的字段。
 *
 * 本文件为纯函数模块：不访问 vscode，不访问网络，可单独测试。
 *
 * ## 与内核保持同步、而不内置固定清单的原因
 *
 * 桌面端选择器中的选项（仅可查看 / 工作区内修改 / Auto Approval /
 * 完全权限）并非固定值，而是由内核 `@deepseek-ai/dsh-permission-presets`
 * 服务读取档中配置的预设表得到的：
 *
 *   - `read-only` / `workspace-write` / `danger-full-access` 来自
 *     `@deepseek-ai/dsh-base`；
 *   - `auto-approval` 由 `dsh-auto-approval-plugin` 插件加入该表
 *     （该插件先重述整张表，再追加自身对应的一项）；
 *   - 用户也可在 `cordis.patch.yml` 中添加自定义预设。
 *
 * 因此面板不得硬编码清单：一旦硬编码，用户安装插件或添加预设后，面板中会缺少
 * 或多出选项，与桌面端不一致。清单一律从该插件（即内核）读取。
 * 此处只做两件事：为内置选项配置中文标签（桌面端同样如此：内核返回
 * `read-only`，客户端将其本地化为「仅可查看」），
 * 以及将失败原因转换为面向用户的说明。
 */

/**
 * 内置预设的中文标签与说明。
 *
 * 标签与桌面端逐字一致（对应 `access.preset.readOnly` 等三个 i18n key）。
 * 说明为本仓库撰写的中文：内核返回的说明是英文（例如 `Read files anywhere; no
 * modifications allowed.`），桌面端中文界面中也保留该英文，即桌面端未作翻译。
 * 本面板界面全部为中文，英文说明与整体语言不一致，因此在此翻译为中文。
 * 自定义预设（含 `auto-approval` 等由插件添加的预设）一律原样使用内核给出的
 * name/description：由他人命名的内容不作改动。
 */
const BUILTIN = {
  'read-only': {
    label: '仅可查看',
    description: '可读取任意位置的文件，不允许修改。',
  },
  'workspace-write': {
    label: '工作区内修改',
    description: '可在工作区与允许的临时目录内写入；越界操作会先请求确认。',
  },
  'danger-full-access': {
    label: '完全权限',
    description: '读写任意文件均不再请求确认，仅应在信任当前任务时使用。',
  },
  custom: {
    label: '自定义',
    description: '当前的沙箱与批准设置不对应任何预设。',
  },
};

/**
 * 切换到「完全权限」前需要经过一次确认（桌面端同样设有这道风险确认）。
 *
 * 在此实现而不等待内核提供的原因：内核返回的选项中没有确认载荷，桌面端的确认
 * 由客户端按预设名附加（`access.confirm.*` 这组 i18n 位于客户端包中）。
 * `danger-full-access` 在此硬编码属于有意为之：它不是展示用字符串，
 * 而是 `@deepseek-ai/dsh-base` 中「无批准的全盘访问」预设的 id；
 * 改名即改变语义，届时此处也应同步修改。
 */
const NEEDS_CONFIRM = new Set(['danger-full-access']);

/**
 * 仅用于展示、不可作为切换目标的值。
 *
 * `custom` 不属于内核预设表中的预设，而是由内核推导出的状态（当前沙箱与批准
 * 设置不匹配任何一项），并会附加在清单末尾一并发送，供客户端显示
 * 「当前不在任何预设上」。该值无法切换：内核的 `resolve()` 对它直接抛出异常
 * （`permission: unknown preset "custom"`）。桌面端同样将其滤出可选行
 * （dsh-client-ui-permission-presets 的 optionsOf：custom is display state,
 * never a target）。
 *
 * 因此在此标注，由界面将其渲染为灰色的当前项，点击不发送消息。
 * 不得改为「从清单中删除」：删除后当前值不在清单内，弹出卡片将没有任何勾选项，
 * 只能显示内核返回的英文 `Custom`（见 media/main.js 中的后备分支）。
 */
const DISPLAY_ONLY = new Set(['custom']);

/**
 * 该插件为「无法切换」划分的错误码，与 `packages/dsh-door/lib/permission.js` 中的
 * 三个常量属于同一份契约（test/static.js 逐个数值核对，任一数值不同即会分错类别）。
 *
 * 不依赖原始文本判断的原因：这几种失败对用户而言是三件不同的事（选择一个仍
 * 存在的选项 / 重新打开该段会话 / 原因不明），若全部归入 -32000，客户端只能对
 * 中文原文做正则匹配；插件侧改动一个词，此处即会分错类别，
 * 用户看到的原因与应执行的操作均为错误。
 */
const DOOR_CODES = {
  UNKNOWN_PRESET: -32002,
  NO_SESSION: -32003,
};

/** 确认对话框中的文案（与桌面端语义一致）。 */
const CONFIRM = {
  title: '启用完全权限前需确认',
  body: '启用后不再逐条询问：修改文件、执行命令、访问工作区外均直接执行。',
  accept: '启用完全权限',
  cancel: '取消',
};

/** 未知预设的后备标签（内核未提供 name 时使用）。 */
function fallbackLabel(value) {
  return typeof value === 'string' && value ? value : '（未知）';
}

/**
 * 将内核提供的选项转换为界面使用的选项。
 *
 * 需要确认的选项会附带确认文案（`confirm`）：文案由扩展维护，
 * webview 中不另存一份，避免两处各写一份导致不一致。
 *
 * @param {Array<{value: string, name?: string, description?: string}>} options 该插件给出的清单。
 * @param {string} currentValue 当前生效的预设名。
 * @returns {Array<{value: string, label: string, description?: string, selectable: boolean, needsConfirm: boolean, confirm?: object, active: boolean}>}
 */
function decorateOptions(options, currentValue) {
  const list = Array.isArray(options) ? options : [];
  const decorated = [];
  for (const option of list) {
    const value = option && typeof option.value === 'string' ? option.value : '';
    // 缺失 value 的条目直接丢弃：界面上点击该条无法切换任何内容，保留即为死按钮。
    // （插件侧也过滤过一次；此处为第二道，因为这份数据最终会进入 webview。）
    if (!value) continue;
    const builtin = BUILTIN[value];
    const item = {
      value,
      // 内置项使用中文标签；其他来源（如 auto-approval）原样使用内核提供的 name。
      label: builtin ? builtin.label : option.name ? option.name : fallbackLabel(value),
      // 展示项（custom）保留在清单中，但界面不得为其绑定点击处理。
      selectable: !DISPLAY_ONLY.has(value),
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
 * 当前权限一行的显示文本。
 *
 * @param {string} currentValue 该插件返回的 `currentValue`。
 * @param {Array<object>} options 该插件返回的清单（用于查询中文标签）。
 * @returns {string} 例如「工作区内修改」。
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
 * 无法选择权限时的面向用户说明（所连 DSH 版本过低 /
 * 该 DSH 未提供权限服务 / 无法取得会话）。
 *
 * ⚠️ 对外文案一律使用用户可理解的表述：不出现「门」「dsh-acp-door」「0.0.12」
 * 「档」等内部词汇，也不出现设置项名。依据为用户 2026-09-19 第二次反馈的原话
 * （「『门』都出来了，别人能知道是什么意思？」）。各情形的文案仍需互不相同
 * （有测试校验），差异体现在「该 DSH 版本过低」「该选项已不存在」
 * 「该会话已不存在」等用户可理解的表述上。
 * 版本号、包名、旁路方法名只写入日志（见 panel/view.js 中相应的 log 调用）。
 *
 * 判断顺序为有意设定：先依据错误码（新版插件会区分失败类型），
 * 错误码无法识别时才回退到原文判断。相反的顺序会退回按中文原文推测的旧方式，
 * 插件侧改动一个词即会分错类别。
 *
 * @param {object} input
 * @param {number} [input.code] JSON-RPC 错误码（-32601 = 方法不存在；见 DOOR_CODES）。
 * @param {string} [input.message] 内核/连接层的原话（只用于判断，不直接给用户看）。
 * @returns {{state: 'no-such-preset'|'no-session'|'old-door'|'no-service'|'error', text: string, detail?: string}}
 */
function explainPermissionFailure({ code, message } = {}) {
  const raw = typeof message === 'string' ? message : '';
  // 1) 新版插件已区分失败类型：直接按错误码给出结论，无需推断原文。
  if (code === DOOR_CODES.UNKNOWN_PRESET) {
    return {
      state: 'no-such-preset',
      text: '该权限选项已不存在',
      detail: '列表将重新读取，可选择仍可用的选项',
    };
  }
  if (code === DOOR_CODES.NO_SESSION) {
    return {
      state: 'no-session',
      text: '该会话在目标 DSH 上已不存在',
      detail: '发送一条消息会重新连接；也可从历史会话中重新打开',
    };
  }
  // 2) 旧版插件（0.0.12 之前）只返回 -32601，两种「服务缺席」依靠原文区分 ——
  //    此分支用于兼容，新版插件不应再进入。
  if (code === -32601 || /门不支持|该插件不支持|Method not found|不认识权限方法/i.test(raw)) {
    // 两种「服务缺席」都返回 -32601，依靠原文区分（新版插件该句中含「没有权限预设服务」）。
    if (/没有权限预设服务|permission-presets/i.test(raw)) {
      return {
        state: 'no-service',
        text: '该 DSH 未提供权限设置，此处无法切换',
        detail: '可在桌面端界面中切换',
      };
    }
    return {
      state: 'old-door',
      text: '该 DSH 版本过低，此处无法切换权限',
      detail: '请在桌面端界面中切换，或将 DSH 升级到最新版',
    };
  }
  return {
    state: 'error',
    text: '无法读取当前权限',
    detail: '请点击「重新连接」后重试；详细原因见日志',
  };
}

module.exports = {
  BUILTIN,
  CONFIRM,
  DISPLAY_ONLY,
  DOOR_CODES,
  NEEDS_CONFIRM,
  decorateOptions,
  currentLabel,
  explainPermissionFailure,
};
