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
 * @module dsh-acp-door
 */
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import * as acp from '@deepseek-ai/dsh-acp';

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

/** 新会话默认挂载的 agent preset。 */
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
function mountPresetOnNewSessions(child, preset, pending, diag) {
  child.on('agent/created', ({ agent } = {}) => {
    // 整段包死：内核把这个监听器**同步**跑在创建 agent 的流程里，
    // 任何同步异常都会把 session/new 直接打断（实测踩过：
    // `cannot get property "agentPresets" without inject`）。
    try {
      diag(`agent/created 会话=${agent?.id}（准备补挂预设 "${preset}"）`);

      const mount = (async () => {
        try {
          await child.agentPresets.select(agent, preset);
          diag(`挂预设成功 会话=${agent.id} preset=${preset}`);
        } catch (error) {
          // 恢复的老会话：预设已记在会话记录里、重建时会自动还原，
          // 这时再切换会被内核拒绝（agent-preset/locked），属于正常情况。
          if (isPresetLocked(error)) {
            diag(`挂预设跳过（会话已开始，属正常）会话=${agent?.id}`);
            return;
          }
          diag(`挂预设失败 会话=${agent?.id}：${String(error)}`);
          child.logger?.warn?.(
            `acp-door: 会话 ${agent?.id} 挂预设 "${preset}" 失败：${String(error)}`,
          );
        }
      })();

      // 记进 pending：在它落定之前，本会话的 session/prompt 会被入站闸按住。
      pending.set(agent.id, mount);
      mount.finally(() => {
        if (pending.get(agent.id) === mount) pending.delete(agent.id);
      });
    } catch (error) {
      diag(`处理 agent/created 抛错：${String(error)}`);
      child.logger?.warn?.(`acp-door: 处理 agent/created 失败：${String(error)}`);
    }
  });
}

/**
 * 入站闸：把 `session/prompt` 压到该会话的预设挂载完成之后。
 *
 * 见 {@link mountPresetOnNewSessions} 里说明的竞态。这里只做一件事：
 * 逐字节透传入站帧，但若某行是「预设还没挂完」的会话的 `session/prompt`，
 * 就先等它挂完。除判重外不解析任何内容，也不碰出站方向。
 *
 * @param source - socket 的入站可读流。
 * @param pending - sessionId → 挂载 promise。
 * @param diag - 诊断日志函数。
 * @returns 加了闸的可读流，交给 ndJsonStream。
 */
function gatePrompts(source, pending, diag) {
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
          await holdUntilMounted(line, pending, diag);
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

/** 若这一行是尚未挂完预设的会话的 `session/prompt`，等它挂完再放行。 */
async function holdUntilMounted(line, pending, diag) {
  if (pending.size === 0) return;
  const trimmed = line.trim();
  if (!trimmed.includes('session/prompt')) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message?.method !== 'session/prompt') return;
  const sessionId = message.params?.sessionId;
  const waiting = pending.get(sessionId);
  if (!waiting) return;
  const startedAt = Date.now();
  diag(`入站闸：压住会话 ${sessionId} 的 session/prompt`);
  await waiting;
  diag(`入站闸：放行（等了 ${Date.now() - startedAt}ms）`);
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

  /** 每个连接对应一份 ACP 桥；断开时逐个拆掉。 */
  const live = new Set();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    diag('客户端接入');

    // 同一个 socket 的两个方向：一个喂给 ACP 读，一个给 ACP 写。
    const { readable, writable } = Duplex.toWeb(socket);

    // 本连接里「预设还没挂完」的会话：sessionId → 挂载 promise。
    const pendingPresets = new Map();

    // 入站方向加一道闸：把 session/prompt 压到对应会话的预设挂完之后，
    // 否则模型会拿到空工具表 —— 详见 mountPresetOnNewSessions 的说明。
    const stream = ndJsonStream(writable, gatePrompts(readable, pendingPresets, diag));

    // 每连接挂一份 ACP。直接调 apply 而不是 ctx.plugin(AcpPlugin, {...})，
    // 因为 AcpPlugin 的 Config 校验会把不认识的 stream 字段剥掉。
    const handle = ctx.plugin({
      name: 'acp-door-connection',
      inject: [...acp.inject, 'agentPresets'],
      apply: (child) => {
        diag('连接已取得内核服务，开始挂 ACP 桥');
        mountPresetOnNewSessions(child, preset, pendingPresets, diag);
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
