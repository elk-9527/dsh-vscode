/**
 * ACP 接入点插件（dsh-acp-door）—— 在**正在运行的** DSH 内核上额外提供一个 ACP 接入点。
 *
 * 需要该接入点的原因：ACP 默认使用「标准输入输出」，而该通道只能在进程启动的那一刻
 * 建立。桌面端已在运行，外部程序无法接入该通道。DSH 自带的 ACP 插件支持注入传输层
 * （源码为 `const stream = config.stream ?? ndJsonStream(stdout, stdin)`），
 * 因此本插件在每个 TCP 连接上**再挂载一份 ACP**，并复用同一个内核。
 *
 * 效果：经该接入点创建的会话与桌面端属于**同一个内核、同一套工具、同一份会话记录**，
 * 仅客户端替换为外部程序。内核内部的内容均未改变。
 *
 * 仅监听回环地址（127.0.0.1），不向局域网暴露。
 *
 * 在传输层上，该插件还完成两件 ACP 本身不提供的工作（均使用 ACP 官方的 `_meta` 扩展点，
 * 不另行定义协议 —— 判断逻辑位于 ./frames.js，可脱离内核单独测试）：
 *
 *   - **补充预设**：桌面端把工具改为「按会话挂载 preset」，而 ACP 创建 agent 时
 *     从不指定 preset，不补充则会得到一个没有可用工具的 agent。见
 *     {@link mountPresetOnNewSessions}。
 *   - **使客户端能够选择预设**：内核不允许会话开始后更换预设（agent-preset/locked），
 *     因此「更换预设」只能通过**下一条 session/new** 完成 —— 客户端在
 *     `_meta['dsh-door'].preset` 中指定，该插件把可用清单放在回复的 `_meta` 中。
 *
 * @module dsh-acp-door
 */
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import * as acp from '@deepseek-ai/dsh-acp';
import {
  FALLBACK_PRESETS,
  MOUNT_WAIT_MS,
  createOutboundRelay,
  doorSessionsError,
  doorSessionsMethod,
  doorSessionsResult,
  DOOR_SESSIONS_PREFIX,
  isDoorSessionsRequest,
  isNewSessionRequest,
  isResponseTo,
  normalizePresets,
  parseLine,
  requestedPreset,
  waitForMount,
} from './frames.js';
import { DEFAULT_LIST_LIMIT, getSession, listSessions, resolveSessionsRoot } from './sessions.js';
// 端口判定单独构成一个纯模块：否则必须载入整个插件（需 import 内核）才能测试该判定。
import { LOOPBACK_HOST, resolveDoorHost, resolveDoorPort } from './port.js';
import { resolveInitialModel } from './model.js';
import { disposeLiveConnections } from './lifecycle.js';
import {
  DOOR_STATUS_METHOD,
  doorStatusPayload,
  doorStatusResult,
  isDoorStatusRequest,
} from './status.js';
// 权限预设的旁路方法（纯帧工具与载荷规整），理由见该文件开头。
import {
  DOOR_ERR_NO_SESSION,
  DOOR_ERR_UNKNOWN_PRESET,
  DOOR_PERMISSION_PREFIX,
  doorErrorCode,
  doorPermissionError,
  doorPermissionMethod,
  doorPermissionResult,
  isDoorPermissionRequest,
  permissionError,
  permissionPayload,
  permissionTarget,
  settledPermission,
} from './permission.js';

export const name = 'acp-door';

/**
 * 依赖的内核服务：前四项为 ACP 桥本身所需（与 @deepseek-ai/dsh-acp 一致），
 * `agentPresets` 为补充挂载预设所需 —— 见 {@link mountPresetOnNewSessions}。
 *
 * 将 `agentPresets` 声明为**硬依赖**而不采用「运行时检测，缺失则跳过」的原因：
 * cordis 的服务代理对未声明的属性会**直接抛出异常**（`cannot get property "…" without inject`），
 * 而该异常发生在内核创建 agent 的同步流程中 —— 或者中断 `session/new`，
 * 或者被 async 捕获后不再传播、使该插件**表现为正在工作**（实测两种情况均遇到过）。声明为硬依赖后，
 * 缺少该服务的 profile 将直接不启动该接入点，可直接观察，优于静默产生一个没有可用工具的 agent。
 */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions', 'agentPresets'];

/** 新会话默认挂载的 agent preset（客户端未指定时使用）。 */
const DEFAULT_PRESET = 'standard';

/**
 * 可选的诊断日志。
 *
 * 需要该功能的原因：无界面运行时**无法查看内核日志**，而此处需要排查的
 * 正是「内核内部时序」问题（事件不等待监听器、组装耗时数十毫秒）。缺少记录时只能依靠推测。
 *
 * 启用方式：配置 `diagLog: <文件路径>`，或设置环境变量 `DSH_ACP_DOOR_DIAG`。
 * 两者均未提供时不写入任何文件。写入失败亦不影响该插件本身。
 *
 * @param file - 文件路径；空值表示关闭。
 * @returns 记录一行的函数。
 */
function makeDiag(file) {
  if (typeof file !== 'string' || !file) return () => {};
  return (message) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // 诊断日志写入失败不应当影响该插件。
    }
  };
}

/**
 * 为本连接新建的会话补充挂载 agent preset。
 *
 * ── 需要该步骤的原因 ──────────────────────────────────────────────
 * 桌面端 / 网页端架构将**宿主层**的工具全部停用（`dsh-web-app` 的补丁中
 * `tool-bash` / `tool-pwsh` / `tool-jobs` / `tool-fs` / `tool-fs-search`
 * 均为 `disabled: true`），改为「每个会话按 agent preset 挂载一套工具」。
 * 而 `@deepseek-ai/dsh-acp` 创建 agent 时只传入 `meta.cwd`、**从不指定 preset**
 * （见 `dsh-acp/lib/index.js` 的 `AcpSession.create`）。两者叠加后，经该接入点建立的会话
 * 在宿主层没有工具、在预设层也未挂载 —— 即一个没有可用工具的 agent。
 *
 * 内核自身的报错信息指明了正确做法：
 *   `(join through AgentPresets.mount() or composeFrom() in the agent factory setup)`
 * 此处使用公开的 `agentPresets.select(agent, id)` 完成该步骤：它会重新组装该 agent
 * 的作用域，并把本次选择记入会话记录 —— 因此之后在桌面端打开该会话时，
 * 显示的预设同样正确。切换仅允许发生在「尚未产出任何内容」的会话上，
 * 而 agent/created 这一时刻正符合该条件。
 *
 * ── 不影响桌面端自身创建的会话的原因 ────────────────────────────
 * `agent/created` 的载体是 **agent 自身的作用域**（`scopeTarget(agent, agent)`），
 * 事件按作用域过滤，因此注册在本连接上下文上的监听只接收本连接创建的 agent。
 *
 * ⚠️ 此处存在一个**经实测确认的竞态**：内核派发该事件时**不等待**监听器返回的
 * promise（`Promise.resolve(returned).catch(...)`），因此「补充挂载预设」与
 * 「客户端发出第一个 prompt」是并行的两件事。本地回环往返仅需约 1ms，
 * 而组装一份 preset 需要数十毫秒 —— 往返必然先完成，结果是模型收到
 * **0 个工具 schema**（会话记录中 `toolsTokens: 0`），因而只能把工具调用
 * 以文本形式写出。因此本函数把挂载 promise 记入 `pending`，由
 * {@link gatePrompts} 在传输层阻塞该会话的 `session/prompt`。
 *
 * @param child - 本连接的内核上下文（已声明 agentPresets 依赖）。
 * @param preset - preset id。
 * @param pending - sessionId → 挂载 promise；供入站闸查询。
 * @param diag - 诊断日志函数。
 */
function mountPresetOnNewSessions(child, { defaultPreset, state, diag }) {
  child.on('agent/created', ({ agent } = {}) => {
    // 整段捕获异常：内核将该监听器**同步**执行于创建 agent 的流程内，
    // 任何同步异常都会直接中断 session/new（实测遇到：
    // `cannot get property "agentPresets" without inject`）。
    try {
      const sessionId = agent?.id;
      // 本次应当挂载的预设共有三种来源，优先级由高到低：
      //   1. 客户端在 session/new 或 session/resume 中指定的（_meta）；
      //   2. 本内核进程内记录的（该会话此前挂载过的预设）—— 断线重连时适用；
      //   3. 该插件配置中的默认值。
      // 第 2 项重要的原因：内核仅在**桌面端那种建会话方式**下才把预设写入
      // 会话记录，经该接入点建立的会话记录中没有 agentPreset（实测），因此恢复时
      // 仅依据记录无法得知原先使用的预设。
      const asked = state.queue.shift() ?? state.resumes.get(sessionId);
      const remembered = state.sessionPresets.get(sessionId);
      diag(
        `agent/created 会话=${sessionId}（指定=${asked?.preset ?? '(未指定)'}` +
          `，记录=${remembered ?? '-'}）`,
      );

      const mount = (async () => {
        let chosen = defaultPreset;
        try {
          chosen = await choosePreset(asked, remembered, defaultPreset, state, diag);
        } catch (error) {
          diag(`选择预设时发生错误，改用 "${defaultPreset}"：${String(error)}`);
        }
        await applyPreset(child, agent, chosen, state, diag);
      })();

      // 记入 pending：在其落定之前，本会话的 session/prompt 会被入站闸阻塞，
      // session/new（以及 session/resume）的回复也会等待它。
      state.pending.set(sessionId, mount);
      mount.finally(() => {
        if (state.pending.get(sessionId) === mount) state.pending.delete(sessionId);
      });
    } catch (error) {
      diag(`处理 agent/created 时抛出异常：${String(error)}`);
      child.logger?.warn?.(`acp-door: 处理 agent/created 失败：${String(error)}`);
    }
  });
}

/**
 * 把该预设实际挂载到该 agent 上。
 *
 * 两条路径，对应两种会话：
 *
 * - **新建的会话**使用 `select(agent, id)`：它会重新组装 agent 的作用域，并把本次
 *   选择**记入会话记录**（`agent-preset/selected`），之后在桌面端打开这段会话时，
 *   显示的预设同样正确。
 * - **恢复的会话**（断线重连，或从历史中打开）不能使用 `select` —— 内核按
 *   「是否执行过回合」上锁（`agent-preset/locked`，属于设计，不是故障）。
 *   但恢复时 agent 的作用域是**重新组装**的，缺少此次补充则两者皆无：
 *   没有工具、没有提示词段落。实测症状较为典型 —— 模型把工具调用以文本形式写出
 *   （`<｜｜DSML｜｜invoke …>`），因为其没有任何工具 schema。
 *   此时使用 `mount(agent.ctx, id)`：该入口供**工厂期**使用，只负责组装，
 *   不受「已执行过回合」这一锁的限制。
 */
async function applyPreset(child, agent, chosen, state, diag) {
  try {
    await child.agentPresets.select(agent, chosen);
    state.applied.set(agent.id, chosen);
    state.sessionPresets.set(agent.id, chosen);
    diag(`挂预设成功（select）会话=${agent.id} preset=${chosen}`);
    return;
  } catch (error) {
    if (!isPresetLocked(error)) {
      diag(`挂预设失败 会话=${agent.id}：${String(error)}`);
      child.logger?.warn?.(`acp-door: 会话 ${agent.id} 挂预设 "${chosen}" 失败：${String(error)}`);
      return;
    }
    // 会话已经开始过 —— 走恢复路径。
    diag(`会话已开始，改用 mount 补挂（会话=${agent.id} preset=${chosen}）`);
  }

  try {
    const mounted = await child.agentPresets.mount(agent.ctx, chosen);
    const actual = mounted?.id ?? chosen;
    state.applied.set(agent.id, actual);
    state.sessionPresets.set(agent.id, actual);
    diag(`恢复会话补挂预设成功（mount）会话=${agent.id} preset=${actual}`);
  } catch (error) {
    // 恢复的会话本身已经组装完成，补充挂载失败最多导致「没有可用工具」，
    // 不应当因此使重连会话这一操作整体失败 —— 但需要在日志中明确记录。
    diag(`恢复会话补挂预设失败 会话=${agent.id}：${String(error)}`);
    child.logger?.warn?.(
      `acp-door: 恢复会话 ${agent.id} 补挂预设 "${chosen}" 失败：${String(error)}`,
    );
  }
}

/**
 * 确定该新会话挂载哪个预设。
 *
 * @param {object|undefined} asked 客户端本次请求中的指定（可能不存在）。
 * @param {string|undefined} remembered 本进程内记录的该会话原先使用的预设。
 * @param {string} defaultPreset 该插件配置中的默认值。
 * @returns {Promise<string>} 实际要挂载的 preset id。
 */
async function choosePreset(asked, remembered, defaultPreset, state, diag) {
  const wanted = asked?.preset ?? remembered;
  if (!wanted || wanted === defaultPreset) return wanted || defaultPreset;
  const known = await state.listPromise;
  if (known.some((item) => item.id === wanted)) return wanted;
  if (asked) asked.fallback = true;
  diag(`预设 "${wanted}" 不在清单里（点名=${asked?.preset ?? '-'}），改用 "${defaultPreset}"`);
  return defaultPreset;
}

/**
 * 获取本连接可用的预设清单。
 *
 * 采用真实清单而非固定清单的原因：`$DSH_HOME/.agent-presets/` 中用户可以自行放置
 * 预设，内核的 `agentPresets.list()` 每次调用都会重新扫描磁盘，能够发现用户自行写入的预设。
 * 无法取得时（服务形状变化、扫描磁盘出错）退回内核自带的四个 —— 不因其导致该接入点无法启动，
 * 因此该函数**不会 reject**。
 *
 * @returns {Promise<{id: string, name?: string, description?: string}[]>}
 */
function loadPresets(child, diag) {
  return (async () => {
    try {
      if (typeof child.agentPresets?.list !== 'function') {
        diag('agentPresets 上没有 list()，改用后备清单');
        return FALLBACK_PRESETS;
      }
      const list = normalizePresets(await child.agentPresets.list());
      if (!list.length) {
        diag('agentPresets.list() 返回空清单，改用后备清单');
        return FALLBACK_PRESETS;
      }
      diag(`可用预设 ${list.length} 个：${list.map((item) => item.id).join(', ')}`);
      return list;
    } catch (error) {
      diag(`获取预设清单失败，改用后备清单：${String(error)}`);
      return FALLBACK_PRESETS;
    }
  })();
}

/**
 * 入站闸：一方面记录客户端指定的预设，一方面把 `session/prompt` 阻塞至预设挂载完成。
 *
 * 见 {@link mountPresetOnNewSessions} 中说明的竞态。此处完成两项工作：
 *   1. 遇到 `session/new` 时将其记入 `state`（客户端在哪条请求上指定了预设、
 *      使用的哪个 id），供 agent/created 与出站方向查询；
 *   2. 若某行属于「预设尚未挂载完成」的会话的 `session/prompt`，则先等待其完成。
 * 除这两项工作外逐字节透传，不修改任何内容。
 *
 * @param source - socket 的入站可读流。
 * @param state - 本连接的共享状态（见 apply 里的说明）。
 * @param diag - 诊断日志函数。
 * @returns 加了闸的可读流，交给 ndJsonStream。
 */
function gatePrompts(source, state, diag) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return source.pipeThrough(
    new TransformStream({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index + 1);
          buffer = buffer.slice(index + 1);
          // 该插件自身的方法（历史会话 / 权限预设）在此处就地应答、不转发内核；
          // 其余帧照旧走闸。
          if (line.includes(DOOR_STATUS_METHOD)) {
            const handled = handleDoorStatus(line, state, diag);
            if (handled) continue;
          }
          if (line.includes(DOOR_SESSIONS_PREFIX)) {
            const handled = await handleDoorSessions(line, state, diag);
            if (handled) continue;
          }
          if (line.includes(DOOR_PERMISSION_PREFIX)) {
            const handled = await handleDoorPermission(line, state, diag);
            if (handled) continue;
          }
          rememberSessionRequest(line, state, diag);
          await holdUntilMounted(line, state, diag);
          controller.enqueue(encoder.encode(line));
        }
      },
      flush(controller) {
        // 收尾时可能存在没有换行的最后一行，原样放行。
        if (buffer) controller.enqueue(encoder.encode(buffer));
      },
    }),
  );
}

/** 就地应答只读的接入点版本、模型来源与能力状态。 */
function handleDoorStatus(line, state, diag) {
  const frame = parseLine(line);
  if (!isDoorStatusRequest(frame)) return false;
  const result = doorStatusPayload({
    model: state.modelRoute,
    permissionAvailable: Boolean(state.permissionHandler),
  });
  state.respond(doorStatusResult(frame.id, result));
  diag(
    `旁路应答 ${DOOR_STATUS_METHOD}（请求 ${frame.id}）：` +
      `model=${result.model.ready ? `${result.model.provider}/${result.model.model}` : '(缺失)'}`,
  );
  return true;
}

/** 遇到 `session/new` 或 `session/resume` 时记录该请求（以及客户端在其上指定的预设）。 */
function rememberSessionRequest(line, state, diag) {
  // 低成本预筛：绝大多数入站帧都不是建会话 / 恢复会话的请求。
  if (!line.includes('session/new') && !line.includes('session/resume')) return;
  const frame = parseLine(line);
  if (!frame || frame.id === undefined) return;
  const preset = requestedPreset(frame);

  if (isNewSessionRequest(frame)) {
    // 建会话时 sessionId 尚不可知，只能按发出顺序排队（同一连接上的请求
    // 是逐个处理的，因此 agent/created 的顺序能够对应）。
    const asked = { request: frame.id, preset };
    state.queue.push(asked);
    state.replies.set(frame.id, asked);
    diag(`收到 session/new（请求 ${frame.id}）客户端指定=${preset ?? '(未指定)'}`);
    return;
  }

  if (frame.method === 'session/resume') {
    // 恢复会话时 sessionId 已包含在请求中，可以直接对应。
    const sessionId = frame.params?.sessionId;
    const asked = { request: frame.id, preset, sessionId };
    if (typeof sessionId === 'string' && sessionId) state.resumes.set(sessionId, asked);
    state.replies.set(frame.id, asked);
    diag(`收到 session/resume（会话 ${sessionId}）客户端指定=${preset ?? '(未指定)'}`);
  }
}

/**
 * 就地应答该插件自身的历史会话请求（`dsh-door/sessions/list|get`）。
 *
 * 由该插件应答而不转发内核的原因：内核没有「列出历史会话」的公开方法，
 * 而会话文件位于本机磁盘上 —— 由该插件读取磁盘（lib/sessions.js，只读）即可。
 * 应答帧经 `state.respond` 走唯一的写出口，请求帧本身**被丢弃且不转发**
 * （内核会将其视为无法识别的方法并报错，不产生任何效果）。
 *
 * @param {string} line 原始 NDJSON 行。
 * @param {object} state 本连接共享状态（需要 state.respond / state.sessionsHandler）。
 * @param {(message: string) => void} diag
 * @returns {Promise<boolean>} true = 该帧属于该插件的方法且已应答，调用方不应再转发。
 */
async function handleDoorSessions(line, state, diag) {
  const frame = parseLine(line);
  if (!isDoorSessionsRequest(frame)) return false;
  const method = doorSessionsMethod(frame);
  const handler = state.sessionsHandler;
  if (!handler || typeof handler[method] !== 'function') {
    state.respond(doorSessionsError(frame.id, -32601, `该插件不支持 ${frame.method}（插件版本过低或方法名不符）`));
    return true;
  }
  try {
    const result =
      method === 'get'
        ? await handler.get(frame.params ? frame.params.id : undefined)
        : await handler.list(frame.params || {});
    state.respond(doorSessionsResult(frame.id, result));
    diag(`旁路应答 ${frame.method}（请求 ${frame.id}）成功`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    state.respond(doorSessionsError(frame.id, -32000, message));
    diag(`旁路应答 ${frame.method}（请求 ${frame.id}）失败：${message}`);
  }
  return true;
}

/**
 * 就地应答该插件自身的权限预设请求（`dsh-door/permission/get|set`）。
 *
 * 清单与切换均来自内核的 `@deepseek-ai/dsh-permission-presets` 服务
 * （与桌面端的「权限」选择器使用同一份数据），该插件仅做转接：
 *
 *   - `get` → 读取会话的 `permissions` 投影（`selectFor(permissionState(session))`），
 *     返回 `{currentValue, options, defaultPreset}`；
 *   - `set` → 先经 `resolve()` 校验（无法识别的预设名会抛出异常，原话转给客户端），
 *     再调用 `set(session, value)`，随后**重新读取一次**返回给客户端。
 *
 * 四种失败均需**可区分**，且客户端能够依据**错误码**分档（而非以正则匹配中文）：
 *   - 该档未安装权限预设服务 → -32601「这个内核没有权限预设」；
 *   - 要切换的选项名不在内核表中 → {@link DOOR_ERR_UNKNOWN_PRESET}（-32002）；
 *   - 会话 id 不存在（例如客户端记录的是其他内核的会话）→ {@link DOOR_ERR_NO_SESSION}（-32003）；
 *   - 会话的投影尚未注册（服务存在但投影未挂载）→ 原样转达内核原话，-32000。
 *
 * 分成三个错误码的原因：客户端对这几种失败需要输出不同的提示，而它们原先全部归入
 * -32000 —— 客户端只能依据原话推测，该插件修改一个词即分错档（详见 lib/permission.js
 * 中三个常量的说明）。内核原话一律原样携带，日志与排障需要该内容。
 *
 * @param {string} line 原始 NDJSON 行。
 * @param {object} state 本连接共享状态（需要 state.respond / state.permissionHandler）。
 * @param {(message: string) => void} diag
 * @returns {Promise<boolean>} true = 该帧属于该插件的方法且已应答，调用方不应再转发。
 */
async function handleDoorPermission(line, state, diag) {
  const frame = parseLine(line);
  if (!isDoorPermissionRequest(frame)) return false;
  const method = doorPermissionMethod(frame);
  if (method !== 'get' && method !== 'set') {
    state.respond(doorPermissionError(frame.id, -32601, `该插件不认识权限方法 ${frame.method}`));
    return true;
  }
  const handler = state.permissionHandler;
  if (!handler) {
    state.respond(
      doorPermissionError(
        frame.id,
        -32601,
        '这个内核里没有权限预设服务（@deepseek-ai/dsh-permission-presets 没挂），' +
          '因此该处无法切换权限 —— 桌面端的同一选择器在相同内核中同样不会出现。',
      ),
    );
    return true;
  }
  const { sessionId, value } = permissionTarget(method, frame.params);
  if (!sessionId) {
    state.respond(doorPermissionError(frame.id, -32602, '权限方法需要携带会话 id（params.id）'));
    return true;
  }
  if (method === 'set' && !value) {
    state.respond(
      doorPermissionError(frame.id, -32602, '切换权限需要携带目标预设名（params.value）'),
    );
    return true;
  }
  try {
    const result =
      method === 'get' ? await handler.get(sessionId) : await handler.set(sessionId, value);
    state.respond(doorPermissionResult(frame.id, result));
    diag(
      method === 'get'
        ? `旁路应答权限查询（会话 ${sessionId}）：${result.currentValue}`
        : `旁路应答权限切换（会话 ${sessionId} → ${value}）：当前=${result.currentValue}`,
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    // 错误码由下游标记（名字不存在 / 会话不存在），未标记的归入 -32000。
    // 客户端依据错误码输出提示，因此此处**不应**再次推测原话。
    state.respond(doorPermissionError(frame.id, doorErrorCode(error), message));
    diag(`旁路应答权限 ${method}（会话 ${sessionId}）失败：${message}`);
  }
  return true;
}

/**
 * 把内核的权限预设服务包装成该插件需要的两个动作。
 *
 * `service` 无法取得（该档未挂载权限预设）时返回 undefined —— 该插件照常工作，
 * 客户端只会收到「这个内核没有权限预设」的明确答复，而不是整个接入点不可用。
 *
 * @param {object} ctx 内核上下文（要 `sessions` 与 `permissionPresets`）。
 * @param {(message: string) => void} diag
 * @returns {{get: (id: string) => Promise<object>, set: (id: string, value: string) => Promise<object>}|undefined}
 */
function makePermissionHandler(ctx, diag) {
  const service = ctx.permissionPresets;
  if (!service || typeof service.selectFor !== 'function' || typeof service.set !== 'function') {
    diag('该内核没有 permissionPresets 服务，权限方法将明确返回「不支持」');
    return undefined;
  }
  /** 读取一次：会话的权限投影 → 客户端需要的载荷。 */
  const read = (session) =>
    permissionPayload({
      currentValue: service.current(session),
      options: service.selectFor(service.permissionState(session)).options,
      defaultPreset: service.defaultPreset,
    });
  /** 按 id 查找存活的会话；找不到时**携带自身的错误码**明确说明情形。 */
  const sessionOf = (id) => {
    const session = ctx.sessions?.get?.(id);
    if (!session) {
      // 标记 -32003：客户端需要与「名字不存在」区分（前者应重新打开会话，后者应更换选项）。
      throw permissionError(
        DOOR_ERR_NO_SESSION,
        `这个内核里没有会话 ${id}（可能它是别的内核建的，或已被关闭）`,
      );
    }
    return session;
  };
  return {
    async get(id) {
      return read(sessionOf(id));
    },
    async set(id, value) {
      const session = sessionOf(id);
      // 先经 resolve 校验：名称不正确时内核的原话最为准确（会列出所有可用预设名）。
      // 单独包一层仅为给「名字不存在」标记 -32002 —— 不使其混入 -32000 那一类，
      // 客户端需要依据错误码决定输出哪一句提示。
      //
      // 同时说明客户端不应发送「展示项」的原因：内核的清单中 `custom` 是
      // 「当前配置组合不匹配任何预设」的展示态，`resolve('custom')` 会在该处抛出异常。
      try {
        service.resolve(value);
      } catch (error) {
        throw permissionError(
          DOOR_ERR_UNKNOWN_PRESET,
          error && error.message ? error.message : String(error),
        );
      }
      service.set(session, value);
      const payload = read(session);
      // 投影完成折算之前读取到的可能仍是旧值 —— 以刚切换的值为准（见 settledPermission）。
      payload.currentValue = settledPermission(payload.currentValue, value);
      return payload;
    },
  };
}

/**
 * 若该行属于尚未完成预设挂载的会话的 `session/prompt`，则等待其完成后再放行。
 *
 * **需要等待，但必须设置上限**（MOUNT_WAIT_MS，与出站方向使用同一数值）。原因：
 * 挂载链路内部均已捕获异常，唯一遗漏的情形是内核某个服务返回一个
 * **永不落定**的 promise —— 此时 `state.pending` 中该条记录永不删除，
 * 这一句将被永久阻塞：用户的消息无法发出，界面上也没有任何可观察的内容
 * （不是报错，而是静默消失，最难排查）。
 * 到期即放行：最坏的结果退化为「该会话没有可用工具」（与挂载失败后果相同，
 * 可观察、可重试），而不是「消息完全无法发出」。
 */
async function holdUntilMounted(line, state, diag) {
  if (state.pending.size === 0) return;
  if (!line.includes('session/prompt')) return;
  const message = parseLine(line);
  if (message?.method !== 'session/prompt') return;
  const sessionId = message.params?.sessionId;
  const waiting = state.pending.get(sessionId);
  if (!waiting) return;
  const startedAt = Date.now();
  diag(`入站闸：阻塞会话 ${sessionId} 的 session/prompt`);
  // 等待其完成，但到期即放行（见 waitForMount 的说明）—— 挂载内部均已捕获异常，
  // 此处唯一需要防御的是「内核某个服务永不落定」导致该句被永久阻塞。
  const settled = await waitForMount(waiting, MOUNT_WAIT_MS);
  if (settled) {
    diag(`入站闸：放行（已等待 ${Date.now() - startedAt}ms）`);
  } else {
    diag(`入站闸：等待挂载超过 ${MOUNT_WAIT_MS}ms，先行放行（继续等待将导致消息无法发出）`);
  }
}
/** 判定内核「已经开始过的会话不允许更换预设」的拒绝。 */
function isPresetLocked(error) {
  return (
    error?.code === 'agent-preset/locked' ||
    /agent-preset\/locked|has already started/.test(String(error?.message ?? error))
  );
}

/**
 * 挂载该接入点。
 *
 * @param ctx - 内核上下文（由 DSH 注入上面列出的服务）。
 * @param config - 见 cordis.patch.yml。
 * @param config.host - 旧版兼容字段。接入点固定监听 127.0.0.1，其它取值会被忽略。
 * @param config.port - 监听端口，默认 47821；传 0 由系统分配一个空闲端口。
 *   优先级：环境变量 `DSH_ACP_DOOR_PORT` > 此处的配置 > 默认值。
 *   设置环境变量这一层的原因（2026-09-19）：端口原先只写在档的配置中，
 *   面板只能"期望"它与设置中的数值一致 —— 不一致即"内核已启动但该接入点未监听在
 *   预期位置"，用户面对「正在启动…」持续等待两分钟。现在启动内核的一方
 *   （VS Code 面板）可以在启动时将其固定，端口由此归**使用方**决定。
 * @param config.provider - 新会话初始模型的服务商。
 * @param config.model - 新会话初始模型名。
 * @param config.preset - 新会话挂载的 agent preset，默认 standard。见
 *   {@link mountPresetOnNewSessions}：桌面端把工具改为「按预设挂载」，
 *   而 ACP 这条路径从不指定预设，因此该插件需要代为补充。
 *   客户端可以在 `session/new` 的 `params._meta['dsh-door'].preset` 中指定
 *   要使用的预设（见 {@link choosePreset}）；该配置是**未指定时**使用的默认值。
 *   可选的 id 由内核的 `agentPresets.list()` 实时给出，随回复的 `_meta` 一并
 *   告知客户端（见 {@link createOutboundRelay}）。
 * @param config.diagLog - 可选：诊断日志文件路径（也可用环境变量
 *   `DSH_ACP_DOOR_DIAG`）。不配置则完全不写入。
 */
export function apply(ctx, config = {}) {
  const { host, rejected: rejectedHost } = resolveDoorHost(config);
  const port = resolveDoorPort(config, process.env);
  const { provider, model } = config;
  const preset =
    typeof config.preset === 'string' && config.preset ? config.preset : DEFAULT_PRESET;
  const diag = makeDiag(config.diagLog ?? process.env.DSH_ACP_DOOR_DIAG);

  /*
   * DSH 的 settings 服务会先从磁盘异步读取 `$DSH_HOME/settings.yaml`，服务完成初始化后
   * 才变为可注入；agentDefaultModel 随后才会把基础默认值替换为用户保存的模型。
   *
   * 真实复现过的竞态：内核进程启动后立刻连接，0 秒时 currentSelection() 返回
   * deepseek-official/deepseek-flash，2 秒后重新连接才返回用户实际选择的
   * opencode-go/deepseek-v4.1-flash。若接入点先开放端口，客户端会把这个短暂的基础值
   * 固定为整条连接的模型，随后表现为“DSH 里明明选对了模型，VS Code 却认证失败”。
   *
   * 因此：只有未显式配置完整 provider/model 时，首次 listen 前等待 settings 服务变为
   * 可注入。5 秒是兼容上限 —— 老 DSH 可能根本没有该服务，不能因此永久不监听。
   */
  let settingsReady = false;
  let settleSettings;
  const settingsReadyPromise = new Promise((resolve) => {
    settleSettings = resolve;
  });
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], () => {
      settingsReady = true;
      // agentDefaultModel 比本插件更早注册 settings 注入回调；再让出一个微任务，确保
      // 它的 setSource() 已执行之后我们才开放端口。
      queueMicrotask(settleSettings);
      return () => {
        settingsReady = false;
      };
    });
  }

  if (rejectedHost) {
    const warning = `acp-door: 已忽略非回环监听地址；该插件固定监听 ${LOOPBACK_HOST}`;
    diag(warning);
    ctx.logger?.warn?.(warning);
  }

  // 历史会话：目录与内核采用同一套判定（DSH_HOME 或 ~/.dsh）。只读，见 lib/sessions.js。
  const sessionsRoot =
    typeof config.sessionsDir === 'string' && config.sessionsDir
      ? config.sessionsDir
      : resolveSessionsRoot();
  const sessionsHandler = {
    /** 列出历史会话（按修改时间从新到旧）。 */
    async list(params = {}) {
      const limit =
        typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
          ? Math.min(Math.floor(params.limit), 500)
          : DEFAULT_LIST_LIMIT;
      const { sessions, skipped, error } = listSessions(sessionsRoot, { limit });
      if (error) throw new Error(error);
      return { sessions, skipped };
    },
    /** 获取一段会话的名片与回放。 */
    async get(id) {
      return getSession(sessionsRoot, id, {});
    },
  };

  /**
   * 权限预设（`dsh-door/permission/get|set`）。
   *
   * **刻意声明为非硬依赖**（未写入模块顶部的 inject）：`permissionPresets` 由
   * `@deepseek-ai/dsh-base` 这一层挂载，而该插件需要能够装入任何 profile ——
   * 若声明为硬依赖，缺少该服务的档将**完全不启动该接入点**（面板连内核都无法连接，
   * 仅为少一个下拉框付出该代价）。因此采用 `ctx.inject([...], cb)` 这种可选挂载方式：
   * 服务存在则接上，不存在则明确答复「这个内核没有权限预设」。
   */
  let permissionHandler;
  ctx.inject(['permissionPresets'], (pctx) => {
    permissionHandler = makePermissionHandler(pctx, diag);
    diag('已接入内核的权限预设服务');
    return () => {
      permissionHandler = undefined;
    };
  });

  /** 每个连接对应一份 ACP 桥；断开时逐个拆除。 */
  const live = new Set();

  /**
   * sessionId → 该会话使用的预设。**内核级**，所有连接共享。
   *
   * 必须是内核级、不能随连接存续的原因：断线重连时产生的是**新连接**，该记录
   * 若随旧连接一同消失，就只能退回默认值 —— 用户的会话会在其未预期的情况下更换模式。
   * （实测遇到：将该记录放在连接内时，重连时日志输出的是「记录=-」。）
   */
  const presetsBySession = new Map();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    diag('客户端已接入');

    // 显式配置完整时使用配置；否则读取 DSH 设置中用户当前选择的默认模型。
    // `ctx.get()` 是 Cordis 对可选服务的安全读取方式：旧版 DSH 没有该服务时返回
    // undefined，不把它列为硬依赖，接入点仍可依靠显式 provider/model 运行。
    let defaultModelService;
    try {
      defaultModelService = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    } catch (error) {
      diag(`读取 DSH 默认模型服务失败：${String(error)}`);
    }
    const modelRoute = resolveInitialModel({ provider, model }, defaultModelService);
    if (modelRoute.partialConfig) {
      const warning =
        'acp-door: provider/model 只配置了一项，已忽略这组不完整配置并尝试使用 DSH 当前默认模型';
      diag(warning);
      ctx.logger?.warn?.(warning);
    }
    if (!modelRoute.selection) {
      const warning =
        'acp-door: 无法确定初始模型；请先在 DSH 中选择默认模型，' +
        '或在该插件配置中同时填写 provider 与 model';
      diag(`${warning}${modelRoute.error ? `（${modelRoute.error}）` : ''}`);
      ctx.logger?.warn?.(warning);
    } else {
      diag(
        `本连接初始模型=${modelRoute.selection.provider}/${modelRoute.selection.model}` +
          `（来源=${modelRoute.source}）`,
      );
    }

    // 同一个 socket 的两个方向：一个传给 ACP 读取，一个供 ACP 写入。
    const { readable, writable } = Duplex.toWeb(socket);

    // 本连接共享的状态。置于此处而非模块级的原因：一个内核可能同时接入
    // 多个客户端（VS Code 面板 + 试验台 + …），任一方均不可见其他方的点名。
    const state = {
      /** sessionId → 预设挂载 promise（入站闸与出站方向均需使用）。 */
      pending: new Map(),
      /** 客户端指定的预设，按 session/new 的发出顺序排队。 */
      queue: [],
      /** 建会话 / 恢复会话的请求 id → 该次点名；出站时按 id 对应回来（Map 同时作为 id 集合使用）。 */
      replies: new Map(),
      /** sessionId → 该次 session/resume 的点名（恢复时 sessionId 已知）。 */
      resumes: new Map(),
      /** sessionId → 实际挂载的预设（在本连接内使用，回复中需要报告当前值）。 */
      applied: new Map(),
      /**
       * sessionId → 该会话使用的预设。**跨连接**共享（见 apply 中的 presetsBySession）。
       *
       * 需要该记录的原因：内核仅在桌面端那种建会话方式下才把预设写入会话记录，
       * 经该接入点建立的会话记录中没有 agentPreset（实测）。断线重连时若连
       * 「原先使用哪个预设」都不掌握，就只能退回默认值 —— 用户会在未预期的
       * 情况下发现自己的会话更换了模式。因此该插件在本进程内自行记录一份。
       */
      sessionPresets: presetsBySession,
      /** 客户端未指定时使用的预设（来自该插件配置）。 */
      defaultPreset: preset,
      /** 可用预设清单；连接挂载内核服务后才有值。 */
      listPromise: undefined,
      /** 该插件自身的历史会话方法（见 handleDoorSessions）。 */
      sessionsHandler,
      /** 本连接的新会话初始模型及来源（状态方法与 ACP 桥共用同一个判定结果）。 */
      modelRoute,
      /** 该插件自身的权限预设方法（见 handleDoorPermission）；服务缺席时为 undefined。 */
      get permissionHandler() {
        return permissionHandler;
      },
    };

    // 出站方向增加一道「补充预设清单」的闸，入站方向增加一道「阻塞 prompt」的闸。
    const stream = ndJsonStream(
      createOutboundRelay(writable, state, diag),
      gatePrompts(readable, state, diag),
    );

    // 每个连接挂载一份 ACP。直接调用 apply，而不使用 ctx.plugin(AcpPlugin, {...})，
    // 因为 AcpPlugin 的 Config 校验会剔除无法识别的 stream 字段。
    const handle = ctx.plugin({
      name: 'acp-door-connection',
      inject: [...acp.inject, 'agentPresets'],
      apply: (child) => {
        diag('连接已取得内核服务，开始挂载 ACP 桥');
        // 清单需要在此处获取：只有取得内核服务之后才能「向内核查询有哪些预设」。
        state.listPromise = loadPresets(child, diag);
        mountPresetOnNewSessions(child, { defaultPreset: preset, state, diag });
        return acp.apply(child, { ...(modelRoute.selection ?? {}), stream });
      },
    });

    const teardown =
      typeof handle === 'function' ? handle : () => handle?.dispose?.();

    const entry = { socket, teardown };
    live.add(entry);

    const close = () => {
      if (!live.delete(entry)) return;
      diag('客户端已断开');
      try {
        teardown();
      } catch (error) {
        ctx.logger?.warn?.(`acp-door: 拆除连接失败：${String(error)}`);
      }
    };

    socket.on('close', close);
    socket.on('error', close);
    ctx.logger?.info?.('acp-door: 已接入一个客户端');
  });

  server.on('error', (error) => {
    diag(`监听失败：${String(error)}`);
    ctx.logger?.warn?.(`acp-door: 监听失败：${String(error)}`);
  });

  let disposed = false;
  const listen = async () => {
    if (!resolveInitialModel({ provider, model }).selection && !settingsReady) {
      diag('等待 DSH 用户设置加载完成后再开放接入点');
      let timer;
      await Promise.race([
        settingsReadyPromise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(timer);
      diag(settingsReady ? 'DSH 用户设置已加载' : '等待设置服务到期，按旧版兼容路径继续');
    }
    if (disposed) return;
    server.listen(port, host, () => {
      const address = server.address();
      const shown = typeof address === 'object' && address ? address.port : port;
      const configuredModel = provider && model ? `${provider}/${model}` : '跟随 DSH 当前默认模型';
      diag(`开始监听 ${host}:${shown}，preset=${preset}，model=${configuredModel}`);
      ctx.logger?.info?.(`acp-door: 正在监听 ${host}:${shown}`);
    });
  };
  void listen().catch((error) => {
    diag(`等待模型设置或开始监听失败：${String(error)}`);
    ctx.logger?.warn?.(`acp-door: 启动监听失败：${String(error)}`);
  });

  ctx.on('dispose', () => {
    disposed = true;
    diag('该插件已被卸载');
    const closed = disposeLiveConnections(live, (phase, error) => {
      const text = `acp-door: 卸载时清理${phase === 'socket' ? '连接' : '连接桥'}失败：${String(error)}`;
      diag(text);
      ctx.logger?.warn?.(text);
    });
    if (closed > 0) diag(`卸载时已关闭 ${closed} 个客户端连接`);
    if (server.listening) server.close();
  });
}
