/**
 * 门在传输层要做的几个「看帧/改帧」判断。
 *
 * 为什么单独一个文件：这些是纯函数，不需要内核、不需要 TCP 就能测
 * （见 test/frames.js）。而门本身只能在真内核里测，代价高得多 ——
 * 所以能拿到外面来的逻辑都拿到外面来。
 *
 * 背景：ACP 在**等待回复的中间时刻**没法打断，但它的协议里有一个官方
 * 扩展点 `_meta`（schema 里就是 `z.record(z.string(), z.unknown())`，
 * 文档原话是 "reserved by ACP to allow clients and agents to attach
 * additional metadata"）。所以预设这件事不另造协议：
 *
 *   客户端 → session/new 的 params._meta['dsh-door'] = { preset: 'ptc' }
 *   门     → session/new 的 result._meta['dsh-door'] = { presets: [...], current: ... }
 *
 * @module dsh-acp-door/frames
 */

/** `_meta` 里属于本门的那个键。 */
export const DOOR_META_KEY = 'dsh-door';

/**
 * 门自定义方法的前缀：`dsh-door/sessions/list`、`dsh-door/sessions/get`。
 *
 * 为什么不叫 `session/list`：那是内核可能自己长出来的方法名，撞上了就说不清
 * 是谁在应答。前缀带上 `dsh-door`，命名空间是门的，内核永远不会有这个方法。
 */
export const DOOR_SESSIONS_PREFIX = 'dsh-door/sessions/';

/**
 * 是不是门自己要接的「历史会话」请求（带 id 的 JSON-RPC 请求）。
 * @param {object} frame
 */
export function isDoorSessionsRequest(frame) {
  return Boolean(frame) && frame.id !== undefined && typeof frame.method === 'string'
    && frame.method.startsWith(DOOR_SESSIONS_PREFIX);
}

/** 取方法名里前缀后面的部分：'list' 或 'get'。 */
export function doorSessionsMethod(frame) {
  return isDoorSessionsRequest(frame) ? frame.method.slice(DOOR_SESSIONS_PREFIX.length) : undefined;
}

/** 门对历史会话请求的成功应答帧（一行 JSON，不带尾随换行 —— 调用方自己拼）。 */
export function doorSessionsResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** 门对历史会话请求的错误应答帧。 */
export function doorSessionsError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 内核自带预设的兜底清单。
 *
 * 正常情况下用的是 `agentPresets.list()` 的真实结果（带中文名与说明）；
 * 只有取不到时才退回这里。这四个 id 来自内核的 `presets/` 目录，
 * 是对着实物抄的，不是猜的。
 */
export const FALLBACK_PRESETS = [
  { id: 'standard', name: '标准模式' },
  { id: 'ptc', name: 'PTC 模式' },
  { id: 'minimal', name: '极简模式' },
  { id: 'cordis', name: '创造模式' },
];

/**
 * 解析一行 NDJSON。解析不了就返回 undefined（交给上层原样放行）。
 *
 * @param {string} line
 * @returns {object|undefined}
 */
export function parseLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 是不是「客户端要新建会话」的请求。 */
export function isNewSessionRequest(frame) {
  return Boolean(frame) && frame.method === 'session/new' && frame.id !== undefined;
}

/** 是不是对某个我们关心过的请求 id 的回复。 */
export function isResponseTo(frame, ids) {
  return Boolean(frame) && frame.id !== undefined && frame.method === undefined && ids.has(frame.id);
}

/**
 * 客户端在这条 session/new 里点名的 preset。
 *
 * @returns {string|undefined} 没点名、或点了个非字符串，都返回 undefined。
 */
export function requestedPreset(frame) {
  const meta = frame?.params?._meta?.[DOOR_META_KEY];
  const preset = meta?.preset;
  return typeof preset === 'string' && preset.trim() ? preset.trim() : undefined;
}

/**
 * 把内核返回的 preset 清单整成统一形状。
 *
 * 为什么要过滤：`agentPresets.list()` 的返回值是内核的内部结构，
 * 直接塞给客户端等于把内核的内部形状当成对外协议。这里只留四个字段，
 * 内核升级改了别的字段也不会漏出去。
 *
 * @param {unknown} rows
 * @returns {{id: string, name?: string, description?: string, order?: number}[]}
 */
export function normalizePresets(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      out.push({ id: row });
      continue;
    }
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    const entry = { id: row.id };
    if (typeof row.name === 'string') entry.name = row.name;
    if (typeof row.description === 'string') entry.description = row.description;
    if (typeof row.order === 'number' && Number.isFinite(row.order)) entry.order = row.order;
    out.push(entry);
  }
  return out;
}

/**
 * 往 `session/new` 的回复里补一份预设清单。
 *
 * 只加 `_meta`，原有字段一个不动 —— 客户端不认识 `_meta` 也照样能用。
 * 出错的回复（只有 error、没有 result）原样返回。
 *
 * @param {object} frame 内核发出的回复帧
 * @param {object} info 要放进 `_meta['dsh-door']` 的内容
 * @returns {object} 新的帧对象
 */
export function withPresetMeta(frame, info) {
  const result = frame?.result;
  if (!result || typeof result !== 'object') return frame;
  const clean = {};
  for (const [key, value] of Object.entries(info)) {
    if (value !== undefined) clean[key] = value;
  }
  return { ...frame, result: { ...result, _meta: { ...(result._meta ?? {}), [DOOR_META_KEY]: clean } } };
}

/**
 * 从回复里读出门补的那份信息（客户端侧用，测试里也用它做断言）。
 *
 * @param {object} frame
 * @returns {object|undefined}
 */
export function readPresetMeta(frame) {
  return frame?.result?._meta?.[DOOR_META_KEY] ?? frame?._meta?.[DOOR_META_KEY];
}
