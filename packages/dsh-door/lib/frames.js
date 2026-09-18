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

/**
 * 等会话的预设挂完，最多等这么久（出站方向上卡住就等于客户端拿不到
 * session/new 的回复，必须有上限）。
 */
export const MOUNT_WAIT_MS = 15000;

/** 等一个 promise 落定，但最多等 ms 毫秒（到点就放行，不报错）。 */
export async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 等一个会话的预设挂完；**到点就放行**。
 *
 * 入站方向（`session/prompt`）和出站方向（`session/new` 的回复）都要用它，
 * 两边用的是同一个上限 —— 它们等的是同一件事，没道理一个等 15 秒、另一个
 * 无限等。挂载内部全都 catch 过了，所以「等不到」只可能是内核某个服务
 * 返回了一个**永不落定**的 promise；那时候无限等下去的后果不是报错，
 * 而是**消息静默消失**（入站被永久按住，界面上什么都看不出来），
 * 属于最难查的一类故障。宁可退化成「这个会话手里没工具」这种看得见的后果。
 *
 * @param {Promise<unknown>|undefined} pending 挂载 promise。
 * @param {number} [ms] 最多等多久。
 * @returns {Promise<boolean>} true = 它落定了（成功或失败都算）；false = 等超时了。
 */
export async function waitForMount(pending, ms = MOUNT_WAIT_MS) {
  if (!pending || typeof pending.then !== 'function') return true;
  const settled = await withTimeout(
    pending.then(() => true, () => true),
    ms,
  );
  return settled === true;
}

/**
 * 若这一行是某个建会话/恢复会话请求的回复，就补上预设清单后返回；否则原样返回。
 *
 * 两种回复都要处理，**出错的回复也要**：
 *   - 成功：补 `_meta` 清单，让客户端知道有哪些预设、当前是哪个；
 *   - 失败：把这次的点名从 `state.queue` / `state.resumes` 里**摘掉**。
 *
 * 为什么失败那条非有不可（实测踩过的坑）：`agent/created` 只在会话真的建出来时
 * 才触发，而它在队列里是按「发出顺序」领点名的（session/new 时 sessionId 还
 * 不知道，只能排队）。请求失败时不会有 `agent/created` 来领走这一条 ——
 * 如果不摘掉，它会**一直留在队首**，等下一次 session/new 建会话时被领走：
 * 用户明明没点名（或点了另一个），却莫名其妙挂上了上一次那个预设。
 * 而且这个错误只在「一次失败的建会话」之后才出现，最难查的那种。
 *
 * @param {string} line 原始 NDJSON 行（带尾随换行）。
 * @param {object} state 本连接共享状态。
 * @param {(message: string) => void} diag
 * @returns {Promise<string>} 要写进 socket 的行。
 */
export async function decorateLine(line, state, diag) {
  // 便宜的预筛：没有跟踪中的请求就完全不用看这行。
  if (state.replies.size === 0) return line;
  const frame = parseLine(line);
  // 这里把 state.replies（Map）当 id 集合用：Map 也有 has()。
  if (!isResponseTo(frame, state.replies)) return line;
  const asked = state.replies.get(frame.id);
  state.replies.delete(frame.id);

  // 出错的回复：没有 result 可补，但要把这次的点名摘干净（见上面的说明）。
  if (!frame.result || typeof frame.result !== 'object') {
    if (asked) {
      const at = state.queue.indexOf(asked);
      if (at >= 0) state.queue.splice(at, 1);
      if (typeof asked.sessionId === 'string' && asked.sessionId) state.resumes.delete(asked.sessionId);
      diag(
        `请求 ${frame.id} 失败了：把它的点名从队列里摘掉` +
          `（${asked.preset ?? '(没点名)'}），免得下一次建会话领到它`,
      );
    }
    return line;
  }

  const sessionId = frame.result?.sessionId ?? asked?.sessionId;
  const mounting = typeof sessionId === 'string' ? state.pending.get(sessionId) : undefined;
  if (mounting) await withTimeout(mounting, MOUNT_WAIT_MS);

  try {
    const presets = await (state.listPromise ?? Promise.resolve(FALLBACK_PRESETS));
    const current =
      (typeof sessionId === 'string' &&
        (state.applied.get(sessionId) ?? state.sessionPresets.get(sessionId))) ||
      state.defaultPreset;
    const decorated = withPresetMeta(frame, {
      presets,
      current,
      requested: asked?.preset,
      fallback: asked?.fallback === true ? true : undefined,
    });
    diag(
      `回复 ${asked?.sessionId ? 'session/resume' : 'session/new'}（请求 ${frame.id} 会话 ${sessionId}）：` +
        `requested=${asked?.preset ?? '-'} current=${current}` +
        `${asked?.fallback ? '（点名的不存在，已退回默认）' : ''}`,
    );
    return `${JSON.stringify(decorated)}\n`;
  } catch (error) {
    // 补清单失败不该影响这个会话本身 —— 回复原样放行。
    diag(`补预设清单失败（不影响会话）：${String(error)}`);
    return line;
  }
}

/**
 * 出站方向的中继：内核回复补预设清单，门自己的旁路应答走同一个写出口。
 *
 * 这一层掌管**唯一的 socket 写出口**：内核的回复和门自己的旁路应答
 * （`dsh-door/sessions/*`）都进同一个队列、由一个泵顺序写。为什么不能
 * 各写各的：WritableStream 同时只允许一个 writer，两个来源交错写会把
 * 一整行 JSON 劈成两半。
 *
 * ⚠️ 实测踩过的坑（正是这个函数写错过一次的教训）：返回值必须是
 * **WritableStream**（ndJsonStream 会自己 getWriter 往里写）。最初写成
 * TransformStream 却没人消费 readable —— transform 永远不执行，内核的
 * 回复永远出不去，客户端看起来就是「门接了线但死不吭声」。所以这里
 * 必须有一条测试断言「写进来的行一定会从 sink 出来」。
 *
 * @param sink - socket 的出站可写流（web 流）。
 * @param state - 本连接的共享状态；这里会把 `state.respond(frame)` 装好。
 * @param diag - 诊断日志函数。
 * @returns {WritableStream} 交给 ndJsonStream 当输出端。
 */
export function createOutboundRelay(sink, state, diag) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  /** 待写进 socket 的字节行。 */
  const queue = [];
  let writer = null;
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      if (!writer) writer = sink.getWriter();
      while (queue.length > 0) {
        await writer.write(queue.shift());
      }
    } catch (error) {
      diag(`出站管道断开：${String(error)}`);
    } finally {
      draining = false;
    }
  }
  state.respond = (frame) => {
    queue.push(encoder.encode(`${JSON.stringify(frame)}\n`));
    drain();
  };

  return new WritableStream({
    async write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index + 1);
        buffer = buffer.slice(index + 1);
        let out;
        try {
          out = await decorateLine(line, state, diag);
        } catch (error) {
          // 装饰失败不该吞掉内核的回复 —— 原样放行。
          diag(`装饰出站帧失败（原样放行）：${String(error)}`);
          out = line;
        }
        queue.push(encoder.encode(out));
      }
      drain();
    },
    close() {
      if (buffer) queue.push(encoder.encode(buffer));
      drain();
    },
  });
}
