/**
 * dsh-acp-door —— 在**正在运行的** DSH 内核上额外开一扇 ACP 门。
 *
 * 为什么需要它：ACP 默认走「标准输入输出」，而那根线只能接在进程启动的那一刻。
 * 桌面端已经在跑了，外部程序没法把线插进去。但 DSH 自带的 ACP 插件支持注入传输层
 * （源码里写着 `const stream = config.stream ?? ndJsonStream(stdout, stdin)`），
 * 所以本插件在每个 TCP 连接上**再挂一份 ACP**，复用同一个内核。
 *
 * 效果：走这扇门创建的会话和桌面端是**同一个内核、同一套工具、同一份会话记录**，
 * 只是客户端换成了外部程序。内核里的东西一个没变。
 *
 * 只监听回环地址（127.0.0.1），不对局域网暴露。
 *
 * 传输层上它还做两件 ACP 本身没有的事（都用 ACP 官方的 `_meta` 扩展点，
 * 不另造协议 —— 判断逻辑在 ./frames.js 里，可以脱离内核单独测）：
 *
 *   - **补预设**：桌面端把工具改成「按会话挂 preset」，而 ACP 建 agent 时
 *     从不点名 preset，不补就是一个「有嘴没手」的 agent。见
 *     {@link mountPresetOnNewSessions}。
 *   - **让客户端能选预设**：内核不允许会话开始后换预设（agent-preset/locked），
 *     所以「换预设」只能是**下一条 session/new** 的事 —— 客户端在
 *     `_meta['dsh-door'].preset` 里点名，门把可用清单放在回复的 `_meta` 里。
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

export const name = 'acp-door';

/**
 * 依赖的内核服务：前面四项是 ACP 桥本身需要的（与 @deepseek-ai/dsh-acp 一致），
 * `agentPresets` 是补挂预设需要的 —— 见 {@link mountPresetOnNewSessions}。
 *
 * 为什么把 `agentPresets` 写成**硬依赖**而不是「运行时偷看一眼，没有就算了」：
 * cordis 的服务代理对未声明的属性会**直接抛**（`cannot get property "…" without inject`），
 * 而那个异常发生在内核创建 agent 的同步流程里 —— 要么打断 `session/new`，
 * 要么被 async 吞掉、让门**假装在工作**（实测两种都踩过）。声明成硬依赖后，
 * 缺服务的 profile 会直接不启动这扇门，一眼就能看出来，好过静默地给出一个没手的 agent。
 */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions', 'agentPresets'];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 47821;

/** 新会话默认挂载的 agent preset（客户端没点名时用它）。 */
const DEFAULT_PRESET = 'standard';

/**
 * 可选的诊断日志。
 *
 * 为什么需要它：无界面运行时**看不到内核日志**，而这里要调的恰恰是
 * 「内核内部时序」的问题（事件不等待监听器、组装要几十毫秒）。没有痕迹就只能猜。
 *
 * 打开方式：配置 `diagLog: <文件路径>`，或设置环境变量 `DSH_ACP_DOOR_DIAG`。
 * 都不给就完全不写文件。写不进去也不会影响门本身。
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
      // 诊断日志写不进去不该影响门。
    }
  };
}

/**
 * 给本连接新建的会话补挂 agent preset。
 *
 * ── 为什么需要这一步 ──────────────────────────────────────────────
 * 桌面端 / 网页端架构把**宿主层**的工具全部停用（`dsh-web-app` 的补丁里
 * `tool-bash` / `tool-pwsh` / `tool-jobs` / `tool-fs` / `tool-fs-search`
 * 都是 `disabled: true`），改成「每个会话按 agent preset 挂一套工具」。
 * 而 `@deepseek-ai/dsh-acp` 建 agent 时只传 `meta.cwd`、**从不点名 preset**
 * （见 `dsh-acp/lib/index.js` 的 `AcpSession.create`）。两边一凑，走门的会话
 * 宿主层没有工具、预设层也没挂上 —— 一个「有嘴没手」的 agent。
 *
 * 内核自己的报错文案指明了正道：
 *   `(join through AgentPresets.mount() or composeFrom() in the agent factory setup)`
 * 这里用公开的 `agentPresets.select(agent, id)` 补上这一步：它会重组装该 agent
 * 的作用域，并把这次选择记进会话记录 —— 因此之后在桌面端打开这个会话，
 * 显示的预设也是对的。切换只允许发生在「还没产出任何内容」的会话上，
 * 而 agent/created 这一刻正好是。
 *
 * ── 为什么不会影响桌面端自己开的会话 ────────────────────────────
 * `agent/created` 的载体是 **agent 自己的作用域**（`scopeTarget(agent, agent)`），
 * 事件按作用域过滤，所以注册在本连接上下文上的监听只收到本连接创建的 agent。
 *
 * ⚠️ 这里有个**实测确认的竞态**：内核派发这个事件时**不等待**监听器返回的
 * promise（`Promise.resolve(returned).catch(...)`），所以「补挂预设」与
 * 「客户端发出第一个 prompt」是并行的两件事。本地回环往返只要 ~1ms，
 * 而组装一份 preset 要几十毫秒 —— 往返必然跑赢，结果是模型收到
 * **0 个工具 schema**（会话记录里 `toolsTokens: 0`），于是它只能把工具调用
 * 当文本写出来。所以本函数把挂载 promise 记进 `pending`，由
 * {@link gatePrompts} 在传输层把该会话的 `session/prompt` 按住。
 *
 * @param child - 本连接的内核上下文（已声明 agentPresets 依赖）。
 * @param preset - preset id。
 * @param pending - sessionId → 挂载 promise；供入站闸查询。
 * @param diag - 诊断日志函数。
 */
function mountPresetOnNewSessions(child, { defaultPreset, state, diag }) {
  child.on('agent/created', ({ agent } = {}) => {
    // 整段包死：内核把这个监听器**同步**跑在创建 agent 的流程里，
    // 任何同步异常都会把 session/new 直接打断（实测踩过：
    // `cannot get property "agentPresets" without inject`）。
    try {
      const sessionId = agent?.id;
      // 这次该挂哪个预设？三种来源，优先级从高到低：
      //   1. 客户端在 session/new 或 session/resume 上点名的（_meta）；
      //   2. 本内核进程里记得的（这个会话之前挂过哪个）—— 断线接回时用得上；
      //   3. 门配置里的默认值。
      // 第 2 条为什么重要：内核只在**桌面端那种建会话方式**下才把预设写进
      // 会话记录，走门的会话记录里没有 agentPreset（实测），所以恢复时
      // 光看记录是不知道自己原来用哪个预设的。
      const asked = state.queue.shift() ?? state.resumes.get(sessionId);
      const remembered = state.sessionPresets.get(sessionId);
      diag(
        `agent/created 会话=${sessionId}（点名=${asked?.preset ?? '(没点名)'}` +
          `，记得=${remembered ?? '-'}）`,
      );

      const mount = (async () => {
        let chosen = defaultPreset;
        try {
          chosen = await choosePreset(asked, remembered, defaultPreset, state, diag);
        } catch (error) {
          diag(`选预设出错，改用 "${defaultPreset}"：${String(error)}`);
        }
        await applyPreset(child, agent, chosen, state, diag);
      })();

      // 记进 pending：在它落定之前，本会话的 session/prompt 会被入站闸按住，
      // session/new（和 session/resume）的回复也会等它。
      state.pending.set(sessionId, mount);
      mount.finally(() => {
        if (state.pending.get(sessionId) === mount) state.pending.delete(sessionId);
      });
    } catch (error) {
      diag(`处理 agent/created 抛错：${String(error)}`);
      child.logger?.warn?.(`acp-door: 处理 agent/created 失败：${String(error)}`);
    }
  });
}

/**
 * 把这个预设真正挂到这个 agent 上。
 *
 * 两条路，对应两种会话：
 *
 * - **新建的会话**用 `select(agent, id)`：它会重组装 agent 的作用域，并把这次
 *   选择**记进会话记录**（`agent-preset/selected`），之后在桌面端打开这段会话，
 *   显示的预设也是对的。
 * - **恢复的会话**（断线接回、或从历史里打开）不能用 `select` —— 内核按
 *   「有没有跑过回合」上锁（`agent-preset/locked`，这是设计，不是故障）。
 *   但恢复时 agent 的作用域是**重新组装**的，不补这一刀它就是个空壳：
 *   没有工具、没有提示词段落。实测症状很典型 —— 模型把工具调用当文本写出来
 *   （`<｜｜DSML｜｜invoke …>`），因为它手里一个工具 schema 都没有。
 *   这时用 `mount(agent.ctx, id)`：那是**工厂期**用的入口，只负责组装，
 *   不看过回合的那把锁。
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
    // 会话已经开过了 —— 走恢复路径。
    diag(`会话已开始，改用 mount 补挂（会话=${agent.id} preset=${chosen}）`);
  }

  try {
    const mounted = await child.agentPresets.mount(agent.ctx, chosen);
    const actual = mounted?.id ?? chosen;
    state.applied.set(agent.id, actual);
    state.sessionPresets.set(agent.id, actual);
    diag(`恢复会话补挂预设成功（mount）会话=${agent.id} preset=${actual}`);
  } catch (error) {
    // 恢复的会话本来就已经组装好了，补挂失败最多是「手里没工具」，
    // 不能因此把接回会话这件事整个搞崩 —— 但要在日志里说清楚。
    diag(`恢复会话补挂预设失败 会话=${agent.id}：${String(error)}`);
    child.logger?.warn?.(
      `acp-door: 恢复会话 ${agent.id} 补挂预设 "${chosen}" 失败：${String(error)}`,
    );
  }
}

/**
 * 决定这个新会话挂哪个预设。
 *
 * @param {object|undefined} asked 客户端这次请求上的点名（可能没有）。
 * @param {string|undefined} remembered 本进程里记得的、这个会话原来用的预设。
 * @param {string} defaultPreset 门配置里的默认值。
 * @returns {Promise<string>} 实际要挂的 preset id。
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
 * 取本连接可用的预设清单。
 *
 * 为什么用真实清单而不是写死：`$DSH_HOME/.agent-presets/` 里用户可以自己放
 * 预设，内核的 `agentPresets.list()` 每次调用都重新扫盘，能看见自己写的那些。
 * 取不到（服务形状变了、扫盘出错）就退回内核自带的四个 —— 绝不因为它让门起不来，
 * 所以这个函数**不会 reject**。
 *
 * @returns {Promise<{id: string, name?: string, description?: string}[]>}
 */
function loadPresets(child, diag) {
  return (async () => {
    try {
      if (typeof child.agentPresets?.list !== 'function') {
        diag('agentPresets 上没有 list()，用兜底清单');
        return FALLBACK_PRESETS;
      }
      const list = normalizePresets(await child.agentPresets.list());
      if (!list.length) {
        diag('agentPresets.list() 返回空清单，用兜底清单');
        return FALLBACK_PRESETS;
      }
      diag(`可用预设 ${list.length} 个：${list.map((item) => item.id).join(', ')}`);
      return list;
    } catch (error) {
      diag(`取预设清单失败，用兜底清单：${String(error)}`);
      return FALLBACK_PRESETS;
    }
  })();
}

/**
 * 入站闸：一边记下客户端点名的预设，一边把 `session/prompt` 压到预设挂完之后。
 *
 * 见 {@link mountPresetOnNewSessions} 里说明的竞态。这里做两件事：
 *   1. 看到 `session/new` 就把它记进 `state`（客户端要在哪条请求上点名了预设、
 *      用的哪个 id），供 agent/created 与出站方向查；
 *   2. 若某行是「预设还没挂完」的会话的 `session/prompt`，就先等它挂完。
 * 除这两件事外逐字节透传，不改任何内容。
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
          // 门自己的方法（历史会话）在这里就地应答、不转发内核；
          // 其余帧照旧走闸。
          if (line.includes(DOOR_SESSIONS_PREFIX)) {
            const handled = await handleDoorSessions(line, state, diag);
            if (handled) continue;
          }
          rememberSessionRequest(line, state, diag);
          await holdUntilMounted(line, state, diag);
          controller.enqueue(encoder.encode(line));
        }
      },
      flush(controller) {
        // 收尾时可能剩下没有换行的最后一行，原样放行。
        if (buffer) controller.enqueue(encoder.encode(buffer));
      },
    }),
  );
}

/** 看到 `session/new` 或 `session/resume` 就记下它（以及客户端在上面点名的预设）。 */
function rememberSessionRequest(line, state, diag) {
  // 便宜的预筛：绝大多数入站帧都不是建会话/恢复会话的请求。
  if (!line.includes('session/new') && !line.includes('session/resume')) return;
  const frame = parseLine(line);
  if (!frame || frame.id === undefined) return;
  const preset = requestedPreset(frame);

  if (isNewSessionRequest(frame)) {
    // 建会话时 sessionId 还不知道，只能按发出顺序排（同一连接上的请求
    // 是一个接一个处理的，所以 agent/created 的顺序对得上）。
    const asked = { request: frame.id, preset };
    state.queue.push(asked);
    state.replies.set(frame.id, asked);
    diag(`收到 session/new（请求 ${frame.id}）客户端点名=${preset ?? '(没点名)'}`);
    return;
  }

  if (frame.method === 'session/resume') {
    // 恢复会话时 sessionId 就在请求里，可以直接对上号。
    const sessionId = frame.params?.sessionId;
    const asked = { request: frame.id, preset, sessionId };
    if (typeof sessionId === 'string' && sessionId) state.resumes.set(sessionId, asked);
    state.replies.set(frame.id, asked);
    diag(`收到 session/resume（会话 ${sessionId}）客户端点名=${preset ?? '(没点名)'}`);
  }
}

/**
 * 就地应答门自己的历史会话请求（`dsh-door/sessions/list|get`）。
 *
 * 为什么由门答而不是转发内核：内核没有「列出历史会话」的公开方法，
 * 而会话文件就在本机磁盘上 —— 门读盘（lib/sessions.js，只读）就够了。
 * 应答帧从 `state.respond` 走唯一的写出口，请求帧本身**吞掉不转发**
 * （内核会把它当成不认识的方法而报错，白费一圈）。
 *
 * @param {string} line 原始 NDJSON 行。
 * @param {object} state 本连接共享状态（要 state.respond / state.sessionsHandler）。
 * @param {(message: string) => void} diag
 * @returns {Promise<boolean>} true = 这帧是门的方法、已应答，调用方不要再转发。
 */
async function handleDoorSessions(line, state, diag) {
  const frame = parseLine(line);
  if (!isDoorSessionsRequest(frame)) return false;
  const method = doorSessionsMethod(frame);
  const handler = state.sessionsHandler;
  if (!handler || typeof handler[method] !== 'function') {
    state.respond(doorSessionsError(frame.id, -32601, `门不支持 ${frame.method}（门版本太旧或方法名不对）`));
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
 * 若这一行是尚未挂完预设的会话的 `session/prompt`，等它挂完再放行。
 *
 * **等，但必须有上限**（MOUNT_WAIT_MS，跟出站方向用同一个值）。为什么：
 * 挂载那条链内部全都 catch 过了，唯一漏网的情形是内核某个服务返回一个
 * **永不落定**的 promise —— 那时 `state.pending` 里那条永远不会清掉，
 * 这一句就被永久按住：用户的消息发不出去，界面上也没有任何东西可看
 * （不是报错，是静默消失，最难查）。
 * 到点就放行：最坏的结果退化成「这个会话手里没工具」（跟挂载失败同一个后果，
 * 看得见、能重试），而不是「消息根本不发出去」。
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
  diag(`入站闸：压住会话 ${sessionId} 的 session/prompt`);
  // 等它挂完，但到点就放行（见 waitForMount 的说明）—— 挂载内部全都 catch 过，
  // 这里唯一要防的是「内核某个服务永不落定」把这句话永久按住。
  const settled = await waitForMount(waiting, MOUNT_WAIT_MS);
  if (settled) {
    diag(`入站闸：放行（等了 ${Date.now() - startedAt}ms）`);
  } else {
    diag(`入站闸：等挂载超过 ${MOUNT_WAIT_MS}ms，先放行（再等下去消息就永远发不出去了）`);
  }
}
/** 判定内核「已经开过的会话不许换预设」的拒绝。 */
function isPresetLocked(error) {
  return (
    error?.code === 'agent-preset/locked' ||
    /agent-preset\/locked|has already started/.test(String(error?.message ?? error))
  );
}

/**
 * 挂载这扇门。
 *
 * @param ctx - 内核上下文（由 DSH 注入上面列出的服务）。
 * @param config - 见 cordis.patch.yml。
 * @param config.host - 监听地址，默认 127.0.0.1（不要改成 0.0.0.0）。
 * @param config.port - 监听端口，默认 47821；传 0 由系统挑一个空闲端口。
 * @param config.provider - 新会话初始模型的服务商。
 * @param config.model - 新会话初始模型名。
 * @param config.preset - 新会话挂载的 agent preset，默认 standard。见
 *   {@link mountPresetOnNewSessions}：桌面端把工具改成「按预设挂载」，
 *   而 ACP 这条路从不点名预设，所以门要替它补上。
 *   客户端可以在 `session/new` 的 `params._meta['dsh-door'].preset` 里点名
 *   要用哪个（见 {@link choosePreset}）；这个配置是**没点名时**用的默认值。
 *   可选的 id 由内核的 `agentPresets.list()` 实时给出，随回复的 `_meta` 一起
 *   告诉客户端（见 {@link createOutboundRelay}）。
 * @param config.diagLog - 可选：诊断日志文件路径（也可用环境变量
 *   `DSH_ACP_DOOR_DIAG`）。不配则完全不写。
 */
export function apply(ctx, config = {}) {
  const host = config.host ?? DEFAULT_HOST;
  const port = config.port ?? DEFAULT_PORT;
  const { provider, model } = config;
  const preset =
    typeof config.preset === 'string' && config.preset ? config.preset : DEFAULT_PRESET;
  const diag = makeDiag(config.diagLog ?? process.env.DSH_ACP_DOOR_DIAG);

  // 历史会话：目录与内核同一套判定（DSH_HOME 或 ~/.dsh）。只读，见 lib/sessions.js。
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
    /** 取一段会话的名片与回放。 */
    async get(id) {
      return getSession(sessionsRoot, id, {});
    },
  };

  // 配置里没点名模型时，内核就不知道该找谁说话：会话照样建得起来，
  // 但**第一个回合直接失败**（实测原文：`agent "…" has no provider/model`）。
  // 这个坑很隐蔽（建会话是成功的、门也开得好好的），而且很容易踩 ——
  // 任何 id 定向的 `--patch` 覆盖都是**整体替换**配置，一不小心就把这两项冲掉。
  // 所以启动时就吵一次，别等用户发了消息才发现。
  if (!provider || !model) {
    const warn =
      'acp-door: 配置里缺 provider/model —— 走这扇门建的会话将无法说话' +
      '（会话建得起来，但一发消息就报 agent has no provider/model）。' +
      '请在门配置里补上 provider 与 model，例如 provider: opencode-go、model: deepseek-v4.1-flash。';
    diag(warn);
    ctx.logger?.warn?.(warn);
  }

  /** 每个连接对应一份 ACP 桥；断开时逐个拆掉。 */
  const live = new Set();

  /**
   * sessionId → 这个会话用的预设。**内核级**，所有连接共享。
   *
   * 为什么必须是内核级、不能跟着连接走：断线接回时是**新连接**，这份记忆
   * 要是跟着旧连接一起没了，就只能退回默认值 —— 用户的会话会莫名其妙换模式。
   * （实测踩过：放在连接里，重连时日志打的是「记得=-」。）
   */
  const presetsBySession = new Map();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    diag('客户端接入');

    // 同一个 socket 的两个方向：一个喂给 ACP 读，一个给 ACP 写。
    const { readable, writable } = Duplex.toWeb(socket);

    // 本连接共享的状态。为什么放在这里而不是模块级：一个内核可能同时接
    // 好几个客户端（VS Code 面板 + 试验台 + …），谁也不能看见谁的点名。
    const state = {
      /** sessionId → 预设挂载 promise（入站闸与出站方向都要用它）。 */
      pending: new Map(),
      /** 客户端点名的预设，按 session/new 的发出顺序排队。 */
      queue: [],
      /** 建会话/恢复会话的请求 id → 那次点名；出站时按 id 对回来（Map 同时当 id 集合用）。 */
      replies: new Map(),
      /** sessionId → 那次 session/resume 的点名（恢复时 sessionId 是已知的）。 */
      resumes: new Map(),
      /** sessionId → 实际挂上的预设（本连接内用，回复里要报当前值）。 */
      applied: new Map(),
      /**
       * sessionId → 这个会话用的预设。**跨连接**共享（见 apply 里的 presetsBySession）。
       *
       * 为什么需要：内核只在桌面端那种建会话方式下才把预设写进会话记录，
       * 走门建的会话记录里没有 agentPreset（实测）。断线接回时如果连
       * 「它原来用哪个预设」都不知道，就只能退回默认值 —— 用户会莫名其妙
       * 发现自己的会话换了模式。所以门自己在本进程里记一份。
       */
      sessionPresets: presetsBySession,
      /** 客户端没点名时用的预设（来自门配置）。 */
      defaultPreset: preset,
      /** 可用预设清单；连接挂上内核服务后才有值。 */
      listPromise: undefined,
      /** 门自己的历史会话方法（见 handleDoorSessions）。 */
      sessionsHandler,
    };

    // 出站方向加一道「补预设清单」的闸，入站方向加一道「压 prompt」的闸。
    const stream = ndJsonStream(
      createOutboundRelay(writable, state, diag),
      gatePrompts(readable, state, diag),
    );

    // 每连接挂一份 ACP。直接调 apply 而不是 ctx.plugin(AcpPlugin, {...})，
    // 因为 AcpPlugin 的 Config 校验会把不认识的 stream 字段剥掉。
    const handle = ctx.plugin({
      name: 'acp-door-connection',
      inject: [...acp.inject, 'agentPresets'],
      apply: (child) => {
        diag('连接已取得内核服务，开始挂 ACP 桥');
        // 清单要在这里取：只有拿到内核服务之后才谈得上「问内核有哪些预设」。
        state.listPromise = loadPresets(child, diag);
        mountPresetOnNewSessions(child, { defaultPreset: preset, state, diag });
        return acp.apply(child, { provider, model, stream });
      },
    });

    const teardown =
      typeof handle === 'function' ? handle : () => handle?.dispose?.();

    const entry = { socket, teardown };
    live.add(entry);

    const close = () => {
      if (!live.delete(entry)) return;
      diag('客户端断开');
      try {
        teardown();
      } catch (error) {
        ctx.logger?.warn?.(`acp-door: 拆连接失败：${String(error)}`);
      }
    };

    socket.on('close', close);
    socket.on('error', close);
    ctx.logger?.info?.('acp-door: 已接上一个客户端');
  });

  server.on('error', (error) => {
    diag(`监听失败：${String(error)}`);
    ctx.logger?.warn?.(`acp-door: 监听失败：${String(error)}`);
  });

  server.listen(port, host, () => {
    const address = server.address();
    const shown = typeof address === 'object' && address ? address.port : port;
    diag(`开始监听 ${host}:${shown}，preset=${preset}，provider=${provider}，model=${model}`);
    ctx.logger?.info?.(`acp-door: 正在监听 ${host}:${shown}`);
  });

  ctx.on('dispose', () => {
    diag('门被卸载');
    for (const entry of [...live]) entry.teardown();
    live.clear();
    server.close();
  });
}
