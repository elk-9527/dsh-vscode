'use strict';

/**
 * 历史会话的本地读取：列出 `$DSH_HOME/sessions` 下的会话、重建一段会话的回放。
 *
 * ── 面板侧需要独立实现的原因 ──────────────────────────────────────
 * ACP 接入点插件（`dsh-acp-door`）自 0.0.8 起通过 `dsh-door/sessions/list|get` 两个旁路方法
 * 对外提供该数据，面板优先使用这两个方法。但该能力有版本要求：**该插件安装在用户档中，
 * 而用户的档由 DSH 桌面端自身管理** —— 实测（2026-09-19 00:05）桌面端重启时
 * 会将档中的依赖重写回旧版 tgz，于是出现「插件版本过低、不提供旁路方法」的情形，
 * 历史会话在**最常用的模式（连接桌面端那一个内核）下直接不可用**。要求用户为查看
 * 历史而修改自己的生产档并再次重启，属于将扩展自身的依赖问题转由用户承担。
 *
 * 面板与内核运行在**同一台机器**上（默认连接回环地址），会话文件位于本地
 * 磁盘，因此面板可以自行读取 —— 不依赖该插件版本、不修改用户的档、不需要重启。
 * 接入点和面板固定在同一台机器上，因此本地读取始终对应当前使用的 DSH 数据目录。
 *
 * ── 与该插件实现的对应关系 ──────────────────────────────────────
 * 逻辑与 `packages/dsh-door/lib/sessions.js` **逐字对应**（该实现为 ESM，
 * 而扩展保持零依赖、只能使用 CommonJS，因此无法直接 require）。两份实现不得各自修改：
 * `test/sessions-parity.js` 会将两份实现传入同一批会话文件并比对输出，要求完全一致，
 * 修改其中一份而遗漏另一份时该测试会先失败。
 *
 * ── 文件格式（v3，实测逆向，非官方文档）─────────────────────────
 * `session.v3.jsonl.zstd` 为**多帧 zstd 拼接**：每帧包含一批 JSONL 事件，
 * 帧以魔数 `28 B5 2F FD` 开头。Node 的一次性 `zstdDecompressSync` 仅解压第一帧，
 * 需要按魔数切帧并逐帧解压（实测 3944 帧零失败）。关键事件：
 *
 *   {type:'session', id, createdAt, cwd, agentPreset}          首帧首行（会话头）
 *   {type:'session/title', data:{title, source:{kind}}}        内核生成的标题
 *   {type:'user/message', data:{content:[{type:'text',text}], source:{kind:'user'|'plugin', ...}}}
 *   {type:'assistant/message', data:{turn, step, message:{content:[{type:'reasoning'|'text'|'tool-call',...}]}}}
 *       —— 每 step 恰好一条，content 是该步的**完整**内容（实测确认，不是增量）
 *   {type:'tool/call', data:{callId, name, arguments:"<JSON 字符串>"}}
 *   {type:'tool/result', data:{message:{source:{callId}, content:[{type:'tool-result', content:[...]}]}}}
 *   {type:'turn/start', data:{turn}} / {type:'turn/end', ...}
 *
 * 所有函数均为**只读**（readdir/stat/readFile），不执行写入与删除操作 ——
 * 会话记录属于用户的资产。
 *
 * @module dsh-panel/sessions
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

/** 会话主文件的固定文件名。 */
const SESSION_FILE = 'session.v3.jsonl.zstd';

/** zstd 帧魔数（little-endian 的 0xFD2FB528）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 列表默认返回的最大条数（按修改时间由新到旧截断）。 */
const DEFAULT_LIST_LIMIT = 100;

/** 单个会话文件超过该大小（字节）时跳过内容解读，仅返回名片（保护性限制，实测最大约 7MB）。 */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/**
 * `$DSH_HOME` 的会话目录。
 *
 * 与内核采用同一套判定：环境变量 `DSH_HOME` 优先，否则为 `~/.dsh`。
 * @param {object} [options]
 * @param {object} [options.env] 默认 process.env（测试可注入）。
 * @param {string} [options.homedir] 默认 os.homedir()（测试可注入）。
 */
function resolveSessionsRoot({ env = process.env, homedir = os.homedir() } = {}) {
  const configured = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return path.join(configured || path.join(homedir, '.dsh'), 'sessions');
}

/** 判断当前 Node 是否提供 zstd 解压（不提供时给出通用提示，不因此崩溃）。 */
function hasZstdSupport() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * 解析一个会话文件：按魔数切帧、逐帧解压、逐行解析。
 *
 * 跳过坏帧不会导致失败（尾部的不完整帧是内核写入过程中被终止的结果，其之前的内容仍然有效）。
 *
 * @param {string} file 会话文件路径。
 * @returns {{events: object[], frames: number, error?: string}}
 */
function decodeSessionFile(file) {
  if (!hasZstdSupport()) {
    // 面向用户的文案（会话卡片上那一行）：说明当前机器无法读取该文件，不出现 Node/zstd 等术语。
    // 「本机 Node 没有 zstd」这一事实写入日志（由调用方经 log 记录）。
    return { events: [], frames: 0, error: '读不了这个会话文件（这台机器的运行环境不支持这种压缩）' };
  }
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (error) {
    return { events: [], frames: 0, error: `读不了会话文件：${error && error.message ? error.message : error}` };
  }
  if (buf.length > MAX_DECODE_BYTES) {
    return { events: [], frames: 0, error: `会话文件太大（${(buf.length / 1048576).toFixed(1)}MB），跳过解读` };
  }
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i);
    }
  }
  let text = '';
  let bad = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8');
    } catch {
      bad += 1;
    }
  }
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') events.push(value);
    } catch {
      // 跳过不完整的 JSON 行 —— 帧边界处可能存在被截断的一行。
    }
  }
  return {
    events,
    frames: starts.length,
    error: bad > 0 ? `${bad} 个坏帧被跳过` : undefined,
  };
}

/** 将消息 content 数组中的 text 块拼接为一段文本。 */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** 拼接 reasoning 块（思考过程）。 */
function reasoningOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 会话的「名片」：标题、目录、回合数等列表所需的信息。
 *
 * @param {object[]} events 解析出的事件流。
 * @param {object} meta {file, mtime, size}
 */
function summarizeSession(events, meta = {}) {
  let id = '';
  let title = '';
  let cwd = '';
  let preset = '';
  let createdAt = 0;
  let turns = 0;
  let userMessages = 0;
  let firstUserText = '';
  let lastTime = 0;
  for (const event of events) {
    if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time;
    switch (event.type) {
      case 'session':
        id = typeof event.id === 'string' ? event.id : '';
        cwd = typeof event.cwd === 'string' ? event.cwd : '';
        createdAt = typeof event.createdAt === 'number' ? event.createdAt : 0;
        preset = typeof event.agentPreset === 'string' ? event.agentPreset : '';
        break;
      case 'session/title':
        if (!title && event.data && typeof event.data.title === 'string') title = event.data.title;
        break;
      case 'user/message': {
        const kind = event.data && event.data.source ? event.data.source.kind : undefined;
        if (kind !== 'user') break; // 由插件写入的系统信息不计入用户输入
        userMessages += 1;
        if (!firstUserText) {
          firstUserText = textOf(event.data && event.data.content).replace(/\s+/g, ' ').slice(0, 80);
        }
        break;
      }
      case 'turn/start':
        turns += 1;
        break;
      default:
        break;
    }
  }
  const card = {
    id,
    title,
    /** 标题缺失时的后备值：用户的第一句话。 */
    fallbackTitle: firstUserText,
    cwd,
    preset,
    createdAt,
    /** 会话中最后一个事件的时间（比目录 mtime 更接近「最后一次交互时刻」）。 */
    lastTime: lastTime || createdAt,
    turns,
    userMessages,
  };
  if (meta.file !== undefined) card.file = meta.file;
  if (meta.mtime !== undefined) card.mtime = meta.mtime;
  if (meta.size !== undefined) card.size = meta.size;
  return card;
}

/**
 * 列出历史会话（只读）。
 *
 * 先按目录修改时间由新到旧排序，**仅解码截断后的前 limit 个** ——
 * zstd 解压是本流程中开销最大的一步，排序靠后的旧会话不值得为其消耗时间。
 *
 * @param {string} root `$DSH_HOME/sessions`。
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {{sessions: object[], skipped: number, error?: string}}
 */
function listSessions(root, { limit = DEFAULT_LIST_LIMIT } = {}) {
  const found = [];
  let groups = 0;
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return { sessions: [], skipped: 0, error: `读不了会话目录：${error && error.message ? error.message : error}` };
  }
  for (const group of dirs) {
    const groupDir = path.join(root, group.name);
    let entries;
    try {
      if (!group.isDirectory()) continue;
      entries = fs.readdirSync(groupDir, { withFileTypes: true });
      groups += 1;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(groupDir, entry.name, SESSION_FILE);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue; // 不含 session.v3.jsonl.zstd 的目录不是会话
      }
      found.push({ file, mtime: st.mtimeMs, size: st.size, dirName: entry.name });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const taken = found.slice(0, Math.max(1, limit));
  const sessions = [];
  for (const item of taken) {
    const { events, error } = decodeSessionFile(item.file);
    const card = summarizeSession(events, { file: item.file, mtime: item.mtime, size: item.size });
    if (!card.id) card.id = item.dirName;
    if (error) card.decodeError = error;
    // 精简返回给列表的字段：file 为绝对路径，客户端不需要该字段（客户端已掌握该路径），
    // 保留只会扩大信息面。此处将其删除，仅保留 id 等名片字段。
    delete card.file;
    sessions.push(card);
  }
  void groups;
  return { sessions, skipped: Math.max(0, found.length - taken.length) };
}

/**
 * 按 id 读取一段会话：名片 + 回放。
 *
 * 安全性：id 仅允许字母、数字、点、下划线、连字符 —— 该值会拼入文件路径，
 * 该限制可完全阻断路径穿越（`..`、路径分隔符）。
 *
 * 先按目录名查找（最常见的情形：目录名即会话 id 或带有 `session-` 前缀），
 * 未找到时再按文件头中的 id 扫描一遍作为后备。
 *
 * @param {string} root `$DSH_HOME/sessions`。
 * @param {string} id 会话 id。
 * @param {object} [options] 透传给 {@link sessionTranscript}。
 * @returns {{card: object, entries: object[], truncated: boolean}}
 * @throws {Error} 未找到或 id 不合法。
 */
function getSession(root, id, options = {}) {
  const wanted = String(id || '');
  if (!/^[A-Za-z0-9._-]+$/.test(wanted)) throw new Error('会话 id 不合法');
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读不了会话目录：${error && error.message ? error.message : error}`);
  }
  const candidates = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, group.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(root, group.name, entry.name, SESSION_FILE));
    }
  }
  const byDir = candidates.find((file) => {
    const base = path.basename(path.dirname(file));
    return base === wanted || base === `session-${wanted}` || `session-${base}` === wanted;
  });
  const pick = (file) => {
    const { events, error } = decodeSessionFile(file);
    const card = summarizeSession(events, { mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size });
    if (error) card.decodeError = error;
    const { entries, truncated } = sessionTranscript(events, options);
    return { card, entries, truncated };
  };
  if (byDir) return pick(byDir);
  // 后备：目录名不匹配时，按文件头中的 id 查找。
  for (const file of candidates) {
    const { events } = decodeSessionFile(file);
    const head = events.find((event) => event.type === 'session');
    if (head && head.id === wanted) return pick(file);
  }
  throw new Error(`找不到会话 ${wanted}`);
}

/**
 * 重建一段会话的回放：用户输入、模型回复、涉及的工具调用。
 *
 * 顺序按事件 seq 执行。工具卡片在**收到结果**时生成（call 与 result 成对出现，
 * 仅收到 call 而未收到 result 的情形（中断）不参与渲染 —— 回放中一张没有结果的
 * 卡片会使用户无法判断该调用的结果）。
 *
 * @param {object[]} events
 * @param {object} [options]
 * @param {number} [options.maxEntries] 最多回放多少条（避免将数 MB 的转写内容传给界面）。
 * @param {number} [options.maxChars] 单条文本的最大长度，超出时截断并注明。
 * @returns {{entries: object[], truncated: boolean}}
 */
function sessionTranscript(events, { maxEntries = 2000, maxChars = 50000 } = {}) {
  const clip = (text, hardLimit = maxChars) => {
    if (typeof text !== 'string' || text.length <= hardLimit) return text || '';
    return `${text.slice(0, hardLimit)}\n…（回放截断，原文更长）`;
  };
  const entries = [];
  const calls = new Map(); // callId → {name, args}
  let truncated = false;

  const push = (entry) => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    return true;
  };

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const kind = event.data && event.data.source ? event.data.source.kind : undefined;
        if (kind !== 'user') break;
        const text = clip(textOf(event.data && event.data.content));
        if (!text.trim()) break;
        if (!push({ kind: 'user', text })) return { entries, truncated };
        break;
      }
      case 'assistant/message': {
        const content = (event.data && event.data.message && event.data.message.content) || [];
        const text = clip(textOf(content));
        const thinking = reasoningOf(content);
        if (!text.trim() && !thinking.trim()) break;
        if (!push(thinking.trim() ? { kind: 'assistant', text, thinking } : { kind: 'assistant', text })) {
          return { entries, truncated };
        }
        break;
      }
      case 'tool/call': {
        const data = event.data || {};
        if (typeof data.callId === 'string' && data.callId) {
          let args = data.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              // arguments 不是合法 JSON 时原样保留字符串，界面可直接显示
            }
          }
          calls.set(data.callId, { name: data.name || 'tool', args });
        }
        break;
      }
      case 'tool/result': {
        const callId = event.data && event.data.message && event.data.message.source
          ? event.data.message.source.callId
          : undefined;
        const call = typeof callId === 'string' ? calls.get(callId) : undefined;
        if (!call) break; // 没有对应 call 的结果不参与渲染
        const blocks = (event.data.message && event.data.message.content) || [];
        const output = clip(
          blocks
            .map((block) => {
              if (!block) return '';
              if (typeof block.text === 'string') return block.text;
              if (block.type === 'tool-result' && Array.isArray(block.content)) {
                return block.content
                  .filter((part) => part && typeof part.text === 'string')
                  .map((part) => part.text)
                  .join('');
              }
              return '';
            })
            .filter(Boolean)
            .join('\n'),
          20000,
        );
        calls.delete(callId);
        if (!push({ kind: 'tool', name: call.name, args: call.args, output })) {
          return { entries, truncated };
        }
        break;
      }
      default:
        break;
    }
  }
  return { entries, truncated };
}

module.exports = {
  SESSION_FILE,
  DEFAULT_LIST_LIMIT,
  resolveSessionsRoot,
  hasZstdSupport,
  decodeSessionFile,
  summarizeSession,
  listSessions,
  getSession,
  sessionTranscript,
};
