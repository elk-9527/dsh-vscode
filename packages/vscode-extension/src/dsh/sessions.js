'use strict';

/**
 * 历史会话的本地读取：列 `$DSH_HOME/sessions` 下的会话、重建一段会话的回放。
 *
 * ── 为什么面板自己要有一份 ────────────────────────────────────────
 * 门（`dsh-acp-door`）从 0.0.8 起用 `dsh-door/sessions/list|get` 两个旁路方法
 * 对外提供这份数据，面板优先走它。但那是有版本的：**门是装在用户档里的插件，
 * 而 user 的档由 DSH 桌面端自己管理** —— 实测（2026-09-19 00:05）桌面端重启时
 * 把档里的依赖重写回了旧版 tgz，于是「门太旧、没有旁路方法」，历史会话在
 * **最常用的那种模式（接着桌面端那一个内核）下直接不可用**。要求用户为了看
 * 历史去改自己的生产档、再重启一次，是把扩展自己的依赖问题转嫁给用户。
 *
 * 面板本来就和内核跑在**同一台机器**上（默认连回环地址），会话文件就在本地
 * 磁盘上，所以它完全可以自己读 —— 不依赖门的版本、不碰用户的档、不用重启。
 * 只有在连**别的机器上的门**（`dshPanel.host` 改成非回环）时，本地读才是错的，
 * 那种情况必须走门的旁路方法（见 `src/panel/view.js` 里的选择逻辑）。
 *
 * ── 与门那份的关系 ──────────────────────────────────────────────
 * 逻辑与 `packages/dsh-door/lib/sessions.js` **逐字对应**（门那份是 ESM，
 * 扩展零依赖、只能是 CommonJS，所以不能直接 require）。两份不许各改各的：
 * `test/sessions-parity.js` 会把两份实现喂同一批会话文件、比对输出必须一致，
 * 改了一边忘了另一边，那条测试会先炸。
 *
 * ── 文件格式（v3，实测逆向，非官方文档）─────────────────────────
 * `session.v3.jsonl.zstd` 是**多帧 zstd 拼接**：每帧一批 JSONL 事件，
 * 帧以魔数 `28 B5 2F FD` 开头。Node 的一次性 `zstdDecompressSync` 只解第一帧，
 * 必须按魔数切帧逐帧解压（实测 3944 帧零失败）。关键事件：
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
 * 所有函数都是**只读**的（readdir/stat/readFile），绝不写、绝不删 ——
 * 会话记录是用户的资产。
 *
 * @module dsh-panel/sessions
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

/** 会话主文件的固定名字。 */
const SESSION_FILE = 'session.v3.jsonl.zstd';

/** zstd 帧魔数（little-endian 的 0xFD2FB528）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 列表默认最多回多少条（按修改时间从新到旧截断）。 */
const DEFAULT_LIST_LIMIT = 100;

/** 单个会话文件超过这么大（字节）就跳过内容解读，只报名片（防呆，实测最大 ~7MB）。 */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/**
 * `$DSH_HOME` 的会话目录。
 *
 * 与内核同一套判定：环境变量 `DSH_HOME` 优先，否则 `~/.dsh`。
 * @param {object} [options]
 * @param {object} [options.env] 默认 process.env（测试可注入）。
 * @param {string} [options.homedir] 默认 os.homedir()（测试可注入）。
 */
function resolveSessionsRoot({ env = process.env, homedir = os.homedir() } = {}) {
  const configured = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return path.join(configured || path.join(homedir, '.dsh'), 'sessions');
}

/** 当前 Node 有没有 zstd 解压（没有就报人话，绝不因此崩掉）。 */
function hasZstdSupport() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * 解一个会话文件：按魔数切帧、逐帧解压、逐行解析。
 *
 * 坏帧跳过不致命（尾部半截帧是内核写一半被杀的样子，前面的内容照样有效）。
 *
 * @param {string} file 会话文件路径。
 * @returns {{events: object[], frames: number, error?: string}}
 */
function decodeSessionFile(file) {
  if (!hasZstdSupport()) {
    return { events: [], frames: 0, error: '本机 Node 不支持 zstd，解不了会话文件' };
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
      // 半行坏 JSON 跳过 —— 逐帧边界上可能有一行被截断。
    }
  }
  return {
    events,
    frames: starts.length,
    error: bad > 0 ? `${bad} 个坏帧被跳过` : undefined,
  };
}

/** 把消息 content 数组里的 text 块拼成一段文本。 */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** 拼 reasoning 块（思考过程）。 */
function reasoningOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 一份会话的「名片」：标题、目录、回合数等列表要用的信息。
 *
 * @param {object[]} events 解出的事件流。
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
        if (kind !== 'user') break; // 插件塞进来的系统噪音不算用户说的话
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
    /** 标题缺失时的兜底：用户的第一句话。 */
    fallbackTitle: firstUserText,
    cwd,
    preset,
    createdAt,
    /** 会话里最后一个事件的时间（比目录 mtime 更贴近「最后说话时刻」）。 */
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
 * 先按目录修改时间从新到旧排，**只解码截断后的前 limit 个** ——
 * 解 zstd 是这套里最贵的一步，老会话排在后面就不值得为它花时间。
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
        continue; // 没有 session.v3.jsonl.zstd 的目录不是会话
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
    // 给列表的字段收干净：file 是绝对路径，客户端不需要（也知道），
    // 留着只是多余信息面。这里去掉，只留 id 等名片字段。
    delete card.file;
    sessions.push(card);
  }
  void groups;
  return { sessions, skipped: Math.max(0, found.length - taken.length) };
}

/**
 * 按 id 取一段会话：名片 + 回放。
 *
 * 安全：id 只允许字母、数字、点、下划线、连字符 —— 它要拼进文件路径，
 * 这一条把路径穿越（`..`、分隔符）整个堵死。
 *
 * 先按目录名找（最常见：目录名就是会话 id 或带 `session-` 前缀），
 * 找不到再按文件头里的 id 扫一遍兜底。
 *
 * @param {string} root `$DSH_HOME/sessions`。
 * @param {string} id 会话 id。
 * @param {object} [options] 透传给 {@link sessionTranscript}。
 * @returns {{card: object, entries: object[], truncated: boolean}}
 * @throws {Error} 找不到或 id 不合法。
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
  // 兜底：目录名对不上，就按头部 id 找。
  for (const file of candidates) {
    const { events } = decodeSessionFile(file);
    const head = events.find((event) => event.type === 'session');
    if (head && head.id === wanted) return pick(file);
  }
  throw new Error(`找不到会话 ${wanted}`);
}

/**
 * 重建一段会话的回放：用户说了什么、它答了什么、动过哪些工具。
 *
 * 顺序按事件 seq 走。工具卡在**收到结果**时落位（call 与 result 天然成对，
 * 只收到 call 没收到 result 的（中断）不渲染 —— 回放里一张没有结果的卡
 * 只会让用户困惑）。
 *
 * @param {object[]} events
 * @param {object} [options]
 * @param {number} [options.maxEntries] 最多回放多少条（防止把几 MB 的转写塞给界面）。
 * @param {number} [options.maxChars] 单条文本最大长度，超了截断并注明。
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
              // arguments 不是合法 JSON 就原样给字符串，界面能显示就行
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
        if (!call) break; // 没有对应 call 的结果不渲染
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
