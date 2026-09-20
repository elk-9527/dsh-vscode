/**
 * ACP 接入点插件（dsh-acp-door）在传输层需要执行的若干「检查帧 / 修改帧」判断。
 *
 * 单独成为一个文件的原因：这些函数为纯函数，不需要内核、不需要 TCP 即可测试
 * （见 test/frames.js）。该插件本身只能在真实内核中测试，代价显著更高 ——
 * 因此可以移出的逻辑均移出。
 *
 * 背景：ACP 在**等待回复的过程中**无法被打断，但其协议提供一个官方
 * 扩展点 `_meta`（schema 中即 `z.record(z.string(), z.unknown())`，
 * 文档原话是 "reserved by ACP to allow clients and agents to attach
 * additional metadata"）。因此预设相关的实现不另行定义协议：
 *
 *   客户端 → session/new 的 params._meta['dsh-door'] = { preset: 'ptc' }
 *   该插件 → session/new 的 result._meta['dsh-door'] = { presets: [...], current: ... }
 *
 * @module dsh-acp-door/frames
 */

/** `_meta` 中属于该插件的键。 */
export const DOOR_META_KEY = 'dsh-door';

/**
 * 该插件自定义方法的前缀：`dsh-door/sessions/list`、`dsh-door/sessions/get`。
 *
 * 不采用 `session/list` 的原因：该名称可能由内核自身新增，一旦重名则无法确定
 * 应答方。前缀带 `dsh-door` 后，命名空间属于该插件，内核不会产生该方法。
 */
export const DOOR_SESSIONS_PREFIX = 'dsh-door/sessions/';

/**
 * 判断是否为该插件应当处理的「历史会话」请求（带 id 的 JSON-RPC 请求）。
 * @param {object} frame
 */
export function isDoorSessionsRequest(frame) {
  return Boolean(frame) && frame.id !== undefined && typeof frame.method === 'string'
    && frame.method.startsWith(DOOR_SESSIONS_PREFIX);
}

/** 取方法名中前缀之后的部分：'list' 或 'get'。 */
export function doorSessionsMethod(frame) {
  return isDoorSessionsRequest(frame) ? frame.method.slice(DOOR_SESSIONS_PREFIX.length) : undefined;
}

/** 该插件对历史会话请求的成功应答帧（一行 JSON，不含尾随换行 —— 由调用方拼接）。 */
export function doorSessionsResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** 该插件对历史会话请求的错误应答帧。 */
export function doorSessionsError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 内核自带预设的后备清单。
 *
 * 正常情况下使用 `agentPresets.list()` 的真实结果（带中文名与说明）；
 * 仅在无法取得时退回此处。这四个 id 来自内核的 `presets/` 目录，
 * 系依据实际内容抄录，并非推测所得。
 */
export const FALLBACK_PRESETS = [
  { id: 'standard', name: '标准模式' },
  { id: 'ptc', name: 'PTC 模式' },
  { id: 'minimal', name: '极简模式' },
  { id: 'cordis', name: '创造模式' },
];

/**
 * 解析一行 NDJSON。无法解析时返回 undefined（交由上层原样放行）。
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

/** 判断是否为「客户端要新建会话」的请求。 */
export function isNewSessionRequest(frame) {
  return Boolean(frame) && frame.method === 'session/new' && frame.id !== undefined;
}

/** 判断是否为针对某个已跟踪请求 id 的回复。 */
export function isResponseTo(frame, ids) {
  return Boolean(frame) && frame.id !== undefined && frame.method === undefined && ids.has(frame.id);
}

/**
 * 客户端在该条 session/new 中指定的 preset。
 *
 * @returns {string|undefined} 未指定，或指定的值不是字符串时，均返回 undefined。
 */
export function requestedPreset(frame) {
  const meta = frame?.params?._meta?.[DOOR_META_KEY];
  const preset = meta?.preset;
  return typeof preset === 'string' && preset.trim() ? preset.trim() : undefined;
}

/**
 * 把内核返回的 preset 清单整理为统一形状。
 *
 * 需要过滤的原因：`agentPresets.list()` 的返回值属于内核的内部结构，
 * 直接传给客户端等于把内核的内部形状当作对外协议。此处仅保留四个字段，
 * 内核升级后改动其他字段亦不会外泄。
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
 * 向 `session/new` 的回复中补充一份预设清单。
 *
 * 仅新增 `_meta`，原有字段均不变动 —— 客户端无法识别 `_meta` 时仍可正常使用。
 * 出错的回复（仅有 error、没有 result）原样返回。
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
 * 从回复中读出该插件补充的信息（客户端侧使用，测试中亦以其作为断言依据）。
 *
 * @param {object} frame
 * @returns {object|undefined}
 */
export function readPresetMeta(frame) {
  return frame?.result?._meta?.[DOOR_META_KEY] ?? frame?._meta?.[DOOR_META_KEY];
}

/**
 * 等待会话的预设挂载完成，最长等待该时长（出站方向上阻塞即意味着客户端无法取得
 * session/new 的回复，因此必须设置上限）。
 */
export const MOUNT_WAIT_MS = 15000;

/** 等待一个 promise 落定，最长等待 ms 毫秒（到期即放行，不报错）。 */
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
 * 等待一个会话的预设挂载完成；**到期即放行**。
 *
 * 入站方向（`session/prompt`）与出站方向（`session/new` 的回复）都需要使用该函数，
 * 两侧采用同一个上限 —— 二者等待的是同一件事，不存在一侧等待 15 秒、另一侧
 * 无限等待的依据。挂载内部已全部捕获异常，因此「等待不到结果」只可能源于内核某个服务
 * 返回了一个**永不落定**的 promise；此时无限等待的后果不是报错，
 * 而是**消息静默消失**（入站方向被永久阻塞，界面上没有任何提示），
 * 属于排查难度最高的一类故障。因此选择退化为「该会话没有可用工具」这一可观察的后果。
 *
 * @param {Promise<unknown>|undefined} pending 挂载 promise。
 * @param {number} [ms] 最长等待时长。
 * @returns {Promise<boolean>} true = 已落定（成功或失败均计入）；false = 等待超时。
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
 * 若该行为某个建会话 / 恢复会话请求的回复，则补充预设清单后返回；否则原样返回。
 *
 * 两种回复均需处理，**出错的回复亦需处理**：
 *   - 成功：补充 `_meta` 清单，使客户端获知有哪些预设、当前是哪一个；
 *   - 失败：把本次的点名从 `state.queue` / `state.resumes` 中**移除**。
 *
 * 失败分支必须存在的原因（实测遇到过的失败模式）：`agent/created` 仅在会话确实建立时
 * 才触发，而它在队列中按「发出顺序」取得点名（session/new 时 sessionId 尚
 * 不可知，只能排队）。请求失败时不会出现 `agent/created` 取走该条记录 ——
 * 若不移除，它会**一直停留在队首**，待下一次 session/new 建会话时被取走：
 * 用户并未指定（或指定了另一个），实际挂载的却是上一次的预设。
 * 该错误仅在「一次失败的建会话」之后才出现，属于最难排查的一类。
 *
 * @param {string} line 原始 NDJSON 行（带尾随换行）。
 * @param {object} state 本连接共享状态。
 * @param {(message: string) => void} diag
 * @returns {Promise<string>} 要写进 socket 的行。
 */
export async function decorateLine(line, state, diag) {
  // 低成本预筛：没有跟踪中的请求时，无需解析该行。
  if (state.replies.size === 0) return line;
  const frame = parseLine(line);
  // 此处把 state.replies（Map）当作 id 集合使用：Map 同样提供 has()。
  if (!isResponseTo(frame, state.replies)) return line;
  const asked = state.replies.get(frame.id);
  state.replies.delete(frame.id);

  // 出错的回复：没有 result 可补充，但需要把本次的点名移除干净（见上文说明）。
  if (!frame.result || typeof frame.result !== 'object') {
    if (asked) {
      const at = state.queue.indexOf(asked);
      if (at >= 0) state.queue.splice(at, 1);
      if (typeof asked.sessionId === 'string' && asked.sessionId) state.resumes.delete(asked.sessionId);
      diag(
        `请求 ${frame.id} 失败：将该请求的指定从队列中移除` +
          `（${asked.preset ?? '(未指定)'}），避免下一次建会话时被取用`,
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
        `${asked?.fallback ? '（指定的预设不存在，已退回默认值）' : ''}`,
    );
    return `${JSON.stringify(decorated)}\n`;
  } catch (error) {
    // 补充清单失败不应当影响该会话本身 —— 回复原样放行。
    diag(`补充预设清单失败（不影响会话）：${String(error)}`);
    return line;
  }
}

/**
 * 出站方向的中继：为内核回复补充预设清单，该插件自身的旁路应答走同一写出口。
 *
 * 该层管理**唯一的 socket 写出口**：内核的回复与该插件自身的旁路应答
 * （`dsh-door/sessions/*`）均进入同一队列，由单个泵顺序写出。不能
 * 各自写入的原因：WritableStream 同时只允许一个 writer，两个来源交错写入会把
 * 一整行 JSON 截断为两半。
 *
 * ⚠️ 实测遇到过的失败模式（该函数曾因此写错一次）：返回值必须是
 * **WritableStream**（ndJsonStream 会自行调用 getWriter 写入）。最初实现为
 * TransformStream 但无人消费 readable —— transform 永不执行，内核的
 * 回复永不发出，客户端观察到的现象是「该插件已建立连接但无任何输出」。因此此处
 * 必须有一条测试断言「写入的行一定会从 sink 输出」。
 *
 * @param sink - socket 的出站可写流（web 流）。
 * @param state - 本连接的共享状态；此处会装配 `state.respond(frame)`。
 * @param diag - 诊断日志函数。
 * @returns {WritableStream} 交给 ndJsonStream 当输出端。
 */
export function createOutboundRelay(sink, state, diag) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  /** 待写入 socket 的字节行。 */
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
      diag(`出站管道已断开：${String(error)}`);
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
          // 装饰失败不应当丢弃内核的回复 —— 原样放行。
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
