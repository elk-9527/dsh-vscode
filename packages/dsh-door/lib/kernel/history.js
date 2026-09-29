/**
 * History compatibility adapter.
 *
 * DSH 0.2 publishes ctx.sessionQuery, which owns format migration and exact
 * live/persisted reads.  Older kernels are served by the existing read-only v3
 * disk reader.  Do not add a private v4 decoder here: sessionQuery is the
 * supported boundary and remains valid if the persistence backend changes.
 */

import {
  DEFAULT_LIST_LIMIT,
  getSession,
  listSessions,
  sessionTranscript,
  summarizeSession,
} from '../sessions.js';

const MAX_LIST_LIMIT = 500;
const MAX_CONCURRENCY = 4;

function requestedLimit(params = {}) {
  return typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
    ? Math.min(Math.floor(params.limit), MAX_LIST_LIMIT)
    : DEFAULT_LIST_LIMIT;
}

function assertSessionId(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('会话 id 不合法');
  return value;
}

/** Add the separately stored v4 header to the old event-folding functions. */
export function eventsWithSessionHeader(header, events) {
  const session = header && typeof header === 'object' ? header : {};
  return [{ type: 'session', ...session }, ...(Array.isArray(events) ? events : [])];
}

/** Convert one sessionQuery read into the stable door history payload. */
export function historyFromQueryRead(read) {
  const header = read?.session ?? read?.header ?? {};
  const events = eventsWithSessionHeader(header, read?.events);
  const card = summarizeSession(events);
  const transcript = sessionTranscript(events);
  return { card, ...transcript };
}

async function mapLimited(items, mapper, concurrency = MAX_CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Create a history handler backed by the public DSH 0.2 sessionQuery service. */
export function createSessionQueryHistory(service, diag = () => {}) {
  if (
    !service ||
    typeof service.listSessions !== 'function' ||
    typeof service.readSession !== 'function'
  ) {
    return undefined;
  }
  return {
    kind: 'session-query',
    async list(params = {}) {
      const limit = requestedLimit(params);
      const records = await service.listSessions();
      const selected = records.slice(0, limit);
      const sessions = await mapLimited(selected, async (record) => {
        const header = record?.header ?? record?.session ?? record ?? {};
        const id = typeof header.id === 'string' ? header.id : '';
        if (!id) return { id: '', title: '', fallbackTitle: '', cwd: '', preset: '', createdAt: 0, lastTime: 0, turns: 0, userMessages: 0, decodeError: '会话记录缺少 id' };
        try {
          return historyFromQueryRead(await service.readSession(id)).card;
        } catch (error) {
          const card = summarizeSession(eventsWithSessionHeader(header, []));
          card.decodeError = error && error.message ? error.message : String(error);
          diag(`读取会话 ${id} 失败，列表中保留名片：${card.decodeError}`);
          return card;
        }
      });
      return {
        sessions: sessions.filter((card) => card.id),
        skipped: Math.max(0, records.length - selected.length),
      };
    },
    async get(id) {
      const wanted = assertSessionId(id);
      try {
        return historyFromQueryRead(await service.readSession(wanted));
      } catch (error) {
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || /not found|no session/i.test(error?.message || '')) {
          throw new Error(`找不到会话 ${wanted}`);
        }
        throw error;
      }
    },
  };
}

/** Create the legacy read-only v3 history handler. */
export function createLegacyHistory(root) {
  return {
    kind: 'legacy-v3-disk',
    async list(params = {}) {
      const { sessions, skipped, error } = listSessions(root, { limit: requestedLimit(params) });
      if (error) throw new Error(error);
      return { sessions, skipped };
    },
    async get(id) {
      return getSession(root, id, {});
    },
  };
}
