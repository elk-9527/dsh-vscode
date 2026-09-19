/**
 * 门的旁路方法：**权限预设**（`dsh-door/permission/get|set`）。
 *
 * 为什么需要它：桌面端那个「权限」选择器（仅可查看 / 工作区内修改 /
 * Auto Approval / 完全权限）在内核里是 `@deepseek-ai/dsh-permission-presets`
 * 这个服务，客户端拿的是会话的 `permissions` 投影。而 ACP 只暴露
 * 「模型」「推理强度」两个 config option（`session/set_config_option`），
 * 官方 README 也明说它「刻意不提供 DSH 专用呈现数据与交互式 UI 功能」——
 * 权限预设正好是那一类。所以门自己加两个方法，把内核的清单与切换原样透给客户端，
 * **不另造一套权限语义**（清单从内核读，切也走内核的 set()）。
 *
 * 这个文件是纯的：不 import 内核、不碰 socket，能脱离内核单独测。
 * 内核侧的接线在 ./index.js 的 {@link handleDoorPermission}。
 *
 * @module dsh-acp-door/permission
 */

/**
 * 门自定义方法的前缀。跟历史会话一样带 `dsh-door` 命名空间：
 * `dsh-door/permission/get`、`dsh-door/permission/set`。
 */
export const DOOR_PERMISSION_PREFIX = 'dsh-door/permission/';

/** 读当前权限 + 可选清单。 */
export const PERMISSION_GET_METHOD = 'dsh-door/permission/get';

/** 切到某个权限预设。 */
export const PERMISSION_SET_METHOD = 'dsh-door/permission/set';

/** 列表里最多接受多少项（防御：内核配了张离谱的表也不至于把客户端撑爆）。 */
export const MAX_PERMISSION_OPTIONS = 50;

/** 是不是门自己要接的「权限预设」请求（带 id 的 JSON-RPC 请求）。 */
export function isDoorPermissionRequest(frame) {
  return (
    Boolean(frame) &&
    frame.id !== undefined &&
    typeof frame.method === 'string' &&
    frame.method.startsWith(DOOR_PERMISSION_PREFIX)
  );
}

/** 取方法名里前缀后面的部分：'get' 或 'set'。 */
export function doorPermissionMethod(frame) {
  return isDoorPermissionRequest(frame)
    ? frame.method.slice(DOOR_PERMISSION_PREFIX.length)
    : undefined;
}

/** 门对权限请求的成功应答帧。 */
export function doorPermissionResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** 门对权限请求的错误应答帧。 */
export function doorPermissionError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 从请求里取「对哪个会话、切成什么」。
 *
 * `id` 用会话 id（ACP 的 sessionId 就是内核的会话 id —— 面板读会话记录
 * 用的也是它，两处一致）。`set` 必须带 `value`；`get` 带了也忽略。
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
 * 把内核给的选项洗一遍：只留 {value, name, description?}。
 *
 * 为什么洗：这份数据会直接进 webview。内核表是用户可配的（`read-only` 那几个
 * 是内置的，`auto-approval` 是插件加的，用户还能自己加），所以不能假设形状
 * —— 缺 name 就用 value 顶上（内核自己也这么兜底：`spec.name ?? name`），
 * 没有 value 的条目直接丢掉（没有它根本没法切）。
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
 * 组装回给客户端的载荷。
 *
 * `currentValue` 可能是 `custom`（内核的推导状态：当前旋钮组合不匹配任何预设）——
 * 那不是能选的预设，但仍然要如实告诉客户端「现在不在任何预设上」。
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
 * 切换成功之后，把一个预设名规整成客户端要的 `currentValue`。
 *
 * 为什么切换后不直接信内核回读：内核的 `set()` 是「记录选择 + 写变化的旋钮」，
 * 回读要等投影折完。调用方（门）会**重新读一次**给客户端，这个函数只是
 * 把「读回来的东西」和「刚切的那个」对齐，避免版本差异导致的空值。
 *
 * @param {string|undefined} readBack 重新读到的当前值。
 * @param {string} wanted 刚切过去的预设名。
 */
export function settledPermission(readBack, wanted) {
  return typeof readBack === 'string' && readBack ? readBack : wanted;
}
