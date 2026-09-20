/**
 * ACP 接入点插件（dsh-acp-door）的「历史会话」读取：列出 `$DSH_HOME/sessions` 下的会话并重建回放。
 *
 * ── 由该插件实现的原因 ────────────────────────────────────────────
 * 会话文件在磁盘上（`$DSH_HOME/sessions/<工作目录>/<会话id>/session.v3.jsonl.zstd`），
 * 内核服务没有「列出历史会话」的公开接口。该插件运行于内核进程内，与内核共用
 * `$DSH_HOME`，读取磁盘可直接进行；且此处所有函数均为**只读**（readdir/stat/readFile），
 * 不写入、不删除 —— 会话记录属于用户的资产。
 *
 * ── 文件格式（v3，实测逆向所得，非官方文档）─────────────────────
 * `session.v3.jsonl.zstd` 为**多帧 zstd 拼接**：每帧包含一批 JSONL 事件，
 * 帧以魔数 `28 B5 2F FD` 开头。Node 的一次性 `zstdDecompressSync` 只解压第一帧，
 * 必须按魔数切帧后逐帧解压（实测 3944 帧无失败）。关键事件：
 *
 *   {type:'session', id, createdAt, cwd, agentPreset}          首帧首行（会话头）
 *   {type:'session/title', data:{title, source:{kind}}}        内核生成的标题
 *   {type:'user/message', data:{content:[{type:'text',text}], source:{kind:'user'|'plugin', ...}}}
 *   {type:'assistant/message', data:{turn, step, message:{content:[{type:'reasoning'|'text'|'tool-call',...}]}}}
 *       —— 每 step 恰好一条，content 是该步的**完整**内容（实测确认，非增量）
 *   {type:'tool/call', data:{callId, name, arguments:"<JSON 字符串>"}}
 *   {type:'tool/result', data:{message:{source:{callId}, content:[{type:'tool-result', content:[...]}]}}}
 *   {type:'turn/start', data:{turn}} / {type:'turn/end', ...}
 *
 * @module dsh-acp-door/sessions
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

/** 会话主文件的固定名称。 */
export const SESSION_FILE = 'session.v3.jsonl.zstd';

/** zstd 帧魔数（0xFD2FB528 的 little-endian 表示）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 列表默认返回的最大条数（按修改时间从新到旧截断）。 */
export const DEFAULT_LIST_LIMIT = 100;

/** 单个会话文件超过该字节数时跳过内容解读，仅返回名片信息（防御措施，实测最大约 7MB）。 */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/**
 * `$DSH_HOME` 对应的会话目录。
 *
 * 与内核采用同一套判定：环境变量 `DSH_HOME` 优先，否则为 `~/.dsh`。
 * @param {object} [options]
 * @param {object} [options.env] 默认 process.env（测试可注入）。
 * @param {string} [options.homedir] 默认 os.homedir()（测试可注入）。
 */
export function resolveSessionsRoot({ env = process.env, homedir = os.homedir() } = {}) {
  const configured = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return path.join(configured || path.join(homedir, '.dsh'), 'sessions');
}

/** 当前 Node 是否支持 zstd 解压（不支持时返回可读的说明，且不因此导致该插件崩溃）。 */
export function hasZstdSupport() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * 解码一个会话文件：按魔数切帧、逐帧解压、逐行解析。
 *
 * 跳过坏帧不构成致命错误（尾部的不完整帧是内核写入中途被终止的结果，其前面的内容仍然有效）。
 *
 * @param {string} file 会话文件路径。
 * @returns {{events: object[], frames: number, error?: string}}
 */
export function decodeSessionFile(file) {
  if (!hasZstdSupport()) {
    return { events: [], frames: 0, error: '当前 Node 没有 zlib.zstdDecompressSync，解不了会话文件' };
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
      // 跳过不完整的坏 JSON 行 —— 逐帧边界上可能有一行被截断。
    }
  }
  return {
    events,
    frames: starts.length,
    error: bad > 0 ? `${bad} 个坏帧被跳过` : undefined,
  };
}

/** 把消息 content 数组中的 text 块拼接为一段文本。 */
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
 * 一份会话的「名片」：标题、目录、回合数等列表所需的信息。
 *
 * @param {object[]} events 解出的事件流。
 * @param {object} meta {file, mtime, size}
 */
export function summarizeSession(events, meta = {}) {
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
        if (kind !== 'user') break; // 插件写入的系统消息不计入用户发言
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
    /** 会话中最后一个事件的时间（比目录 mtime 更接近「最后一次发言时刻」）。 */
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
 * 先按目录修改时间从新到旧排序，**仅解码截断后的前 limit 个** ——
 * 解压 zstd 是此流程中开销最大的一步，靠后的旧会话不值得为其消耗时间。
 *
 * @param {string} root `$DSH_HOME/sessions`。
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {{sessions: object[], skipped: number, error?: string}}
 */
export function listSessions(root, { limit = DEFAULT_LIST_LIMIT } = {}) {
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
    // 收敛列表字段：file 为绝对路径，客户端既不需要也已知晓，
    // 保留它只会增加多余的信息面。此处将其移除，仅保留 id 等名片字段。
    delete card.file;
    sessions.push(card);
  }
  void groups;
  return { sessions, skipped: Math.max(0, found.length - taken.length) };
}

/**
 * 按 id 取一段会话：名片与回放。
 *
 * 安全约束：id 仅允许字母、数字、点、下划线、连字符 —— 该 id 会被拼入文件路径，
 * 此项校验可完全阻断路径穿越（`..`、路径分隔符）。
 *
 * 先按目录名查找（最常见的情形：目录名即会话 id，或带 `session-` 前缀），
 * 未找到时再按文件头中的 id 全量扫描作为后备。
 *
 * @param {string} root `$DSH_HOME/sessions`。
 * @param {string} id 会话 id。
 * @param {object} [options] 透传给 {@link sessionTranscript}。
 * @returns {{card: object, entries: object[], truncated: boolean}}
 * @throws {Error} 找不到或 id 不合法。
 */
export function getSession(root, id, options = {}) {
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
  // 后备：目录名不匹配时，按头部 id 查找。
  for (const file of candidates) {
    const { events } = decodeSessionFile(file);
    const head = events.find((event) => event.type === 'session');
    if (head && head.id === wanted) return pick(file);
  }
  throw new Error(`找不到会话 ${wanted}`);
}

/**
 * 重建一段会话的回放：用户发送的内容、模型的应答、调用过的工具。
 *
 * 顺序按事件的 seq 排列。工具卡片在**收到结果**时生成（call 与 result 天然成对，
 * 仅收到 call 而未收到 result 的情形（中断）不渲染 —— 回放中出现一张没有结果的
 * 卡片只会造成用户困惑）。
 *
 * @param {object[]} events
 * @param {object} [options]
 * @param {number} [options.maxEntries] 最多回放的条数（防止把数 MB 的转写内容传给界面）。
 * @param {number} [options.maxChars] 单条文本的最大长度，超出时截断并注明。
 * @returns {{entries: object[], truncated: boolean}}
 */
export function sessionTranscript(events, { maxEntries = 2000, maxChars = 50000 } = {}) {
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
              // arguments 不是合法 JSON 时原样保留为字符串，界面能够显示即可
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
