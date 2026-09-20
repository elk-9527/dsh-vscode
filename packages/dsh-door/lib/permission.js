/**
 * ACP 接入点插件（dsh-acp-door）的旁路方法：**权限预设**（`dsh-door/permission/get|set`）。
 *
 * 需要该功能的原因：桌面端的「权限」选择器（仅可查看 / 工作区内修改 /
 * Auto Approval / 完全权限）在内核中对应 `@deepseek-ai/dsh-permission-presets`
 * 服务，客户端读取的是会话的 `permissions` 投影。ACP 只暴露
 * 「模型」「推理强度」两个 config option（`session/set_config_option`），
 * 官方 README 亦明确说明其「刻意不提供 DSH 专用呈现数据与交互式 UI 功能」，
 * 权限预设属于该类数据。因此该插件自行增加两个方法，把内核的清单与切换原样传给客户端，
 * **不另行定义权限语义**（清单从内核读取，切换亦调用内核的 set()）。
 *
 * 该文件为纯模块：不 import 内核、不操作 socket，可脱离内核单独测试。
 * 内核侧的接线位于 ./index.js 的 {@link handleDoorPermission}。
 *
 * @module dsh-acp-door/permission
 */

/**
 * 该插件自定义方法的前缀。与历史会话方法相同，带 `dsh-door` 命名空间：
 * `dsh-door/permission/get`、`dsh-door/permission/set`。
 */
export const DOOR_PERMISSION_PREFIX = 'dsh-door/permission/';

/** 读取当前权限与可选清单。 */
export const PERMISSION_GET_METHOD = 'dsh-door/permission/get';

/** 切换到指定权限预设。 */
export const PERMISSION_SET_METHOD = 'dsh-door/permission/set';

/** 清单中最多接受的项数（防御措施：内核配置了异常长度的表时，客户端负载不会超出上限）。 */
export const MAX_PERMISSION_OPTIONS = 50;

/**
 * 该插件为权限方法定义的错误码。
 *
 * 需要占用三个错误码的原因：这几种失败对用户而言是**三件不同的事**（更换一个仍然存在的选项 /
 * 重新打开该会话 / 无法归类），而它们原先全部归入 -32000。归入同一码时，
 * 客户端只能以该插件的中文原话进行正则匹配 —— 该插件修改一个词，客户端即刻分错档，
 * 表现为「这个名字已经不在了」被表述为「读不到当前权限，点重新连接再试一次」，
 * 而重新连接无法修复该情形（用户已于 2026-09-19 就「文案里出现内部词」提出过一次意见，
 * 依据原话分档属于同一类问题：把供程序判定的信息写成了叙述性文字）。
 *
 * -32601（方法不存在）与 -32602（参数不对）为 JSON-RPC 自身的约定，沿用。
 */
export const DOOR_ERR_OTHER = -32000;

/** 要切换的选项名不在内核表中（内核 `resolve()` 的原话照常携带，日志需要该内容）。 */
export const DOOR_ERR_UNKNOWN_PRESET = -32002;

/** 会话 id 在该内核中不存在（非该内核创建，或已经关闭）。 */
export const DOOR_ERR_NO_SESSION = -32003;

/**
 * 把「哪个选项不存在 / 哪段会话不存在」标记在异常上，使应答层能够取得错误码。
 *
 * 内核原话一字不改地放入 `message` —— 该内容通常包含可用清单，供人员与日志查阅。
 */
export function permissionError(code, message) {
  const error = new Error(message);
  error.doorCode = code;
  return error;
}

/** 从异常中读取该插件的错误码；未标记的按 {@link DOOR_ERR_OTHER} 处理（不推测为其他档）。 */
export function doorErrorCode(error) {
  return error && typeof error.doorCode === 'number' ? error.doorCode : DOOR_ERR_OTHER;
}

/** 判断是否为该插件应当处理的「权限预设」请求（带 id 的 JSON-RPC 请求）。 */
export function isDoorPermissionRequest(frame) {
  return (
    Boolean(frame) &&
    frame.id !== undefined &&
    typeof frame.method === 'string' &&
    frame.method.startsWith(DOOR_PERMISSION_PREFIX)
  );
}

/** 取方法名中前缀之后的部分：'get' 或 'set'。 */
export function doorPermissionMethod(frame) {
  return isDoorPermissionRequest(frame)
    ? frame.method.slice(DOOR_PERMISSION_PREFIX.length)
    : undefined;
}

/** 该插件对权限请求的成功应答帧。 */
export function doorPermissionResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** 该插件对权限请求的错误应答帧。 */
export function doorPermissionError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 从请求中取出「对哪个会话、切换为什么值」。
 *
 * `id` 使用会话 id（ACP 的 sessionId 即内核的会话 id —— 面板读取会话记录
 * 亦使用该 id，两处一致）。`set` 必须携带 `value`；`get` 携带时忽略。
 *
 * @param {string} method 'get' | 'set'
 * @param {object|undefined} params
 * @returns {{sessionId: string|undefined, value: string|undefined}}
 */
export function permissionTarget(method, params) {
  const raw = params && typeof params === 'object' ? params : {};
  const sessionId = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  const value =
    method === 'set' && typeof raw.value === 'string' && raw.value ? raw.value : undefined;
  return { sessionId, value };
}

/**
 * 对内核提供的选项做规范化：仅保留 {value, name, description?}。
 *
 * 需要规范化的原因：该数据会直接进入 webview。内核的表由用户配置（`read-only` 各项
 * 为内置项，`auto-approval` 由插件添加，用户亦可自行添加），因此不能假定其形状
 * —— 缺少 name 时以 value 代替（内核自身亦取同样的后备值：`spec.name ?? name`），
 * 没有 value 的条目直接丢弃（缺少该字段无法完成切换）。
 *
 * @param {unknown} raw 内核的 options 数组。
 * @returns {Array<{value: string, name: string, description?: string}>}
 */
export function normalizePermissionOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = typeof item.value === 'string' ? item.value : undefined;
    if (!value) continue;
    const name = typeof item.name === 'string' && item.name ? item.name : value;
    const option = { value, name };
    if (typeof item.description === 'string' && item.description) {
      option.description = item.description;
    }
    out.push(option);
    if (out.length >= MAX_PERMISSION_OPTIONS) break;
  }
  return out;
}

/**
 * 组装返回给客户端的载荷。
 *
 * `currentValue` 可能为 `custom`（内核的推导状态：当前配置组合不匹配任何预设）——
 * 该值不是可选预设，但仍需如实告知客户端「当前不属于任何预设」。
 *
 * @param {object} input
 * @param {string} input.currentValue
 * @param {unknown} input.options
 * @param {string} [input.defaultPreset]
 * @returns {{currentValue: string, options: Array<object>, defaultPreset?: string}}
 */
export function permissionPayload({ currentValue, options, defaultPreset }) {
  const payload = {
    currentValue: typeof currentValue === 'string' && currentValue ? currentValue : 'custom',
    options: normalizePermissionOptions(options),
  };
  if (typeof defaultPreset === 'string' && defaultPreset) payload.defaultPreset = defaultPreset;
  return payload;
}

/**
 * 切换成功之后，把一个预设名规整为客户端需要的 `currentValue`。
 *
 * 切换后不直接采用内核回读值的原因：内核的 `set()` 语义为「记录选择 + 写入发生变化的配置项」，
 * 回读需要等待投影完成折算。调用方（该插件）会**重新读取一次**返回给客户端，该函数仅用于
 * 把「读取到的值」与「刚切换的值」对齐，避免版本差异导致的空值。
 *
 * @param {string|undefined} readBack 重新读取到的当前值。
 * @param {string} wanted 刚切换到的预设名。
 */
export function settledPermission(readBack, wanted) {
  return typeof readBack === 'string' && readBack ? readBack : wanted;
}
