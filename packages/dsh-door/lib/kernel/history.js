/**
 * History compatibility adapter.
 *
 * DSH 0.2 publishes ctx.sessionQuery, which owns format migration and exact
 * live/persisted reads.  Older kernels are served by the existing read-only v3
 * disk reader.  Do not add a private v4 decoder here: sessionQuery is the
 * supported boundary and remains valid if the persistence backend changes.
 */

import {
  getSessionAsync,
  listSessionsAsync,
  sessionTranscript,
  summarizeSession,
} from '../sessions.js';
import historyQuery from '../history-query.cjs';
import { archiveSnapshot, archiveMetadata, setHistoryArchived } from './history-archive.js';
const { historyOptions, matchesHistory, historyPage, pageMetadata } = historyQuery;

const MAX_CONCURRENCY = 4;

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
export function createSessionQueryHistory(service, diag = () => {}, { getWorkspaceRegistry = () => undefined } = {}) {
  if (
    !service ||
    typeof service.listSessions !== 'function' ||
    typeof service.readSession !== 'function'
  ) {
    return undefined;
  }
  return {
    kind: 'session-query',
    get archiveSupported() { return archiveSnapshot(getWorkspaceRegistry()).archiveSupported; },
    async state() { return archiveMetadata(archiveSnapshot(getWorkspaceRegistry())); },
    async archive(id, archived, options) { return setHistoryArchived(getWorkspaceRegistry(), id, archived, options); },
    async list(params = {}) {
      params.signal?.throwIfAborted();
      const options = historyOptions(params);
      const listed = await service.listSessions(); params.signal?.throwIfAborted();
      const archive = archiveSnapshot(getWorkspaceRegistry());
      if (options.archived && !archive.archiveStateKnown) throw new Error('当前内核不支持读取已归档会话，请更新接入点并连接 DSH。');
      if (options.unlisted && !archive.workspaceStateKnown) throw new Error('当前内核不支持区分未登记的历史，请更新接入点并连接 DSH。');
      const page = result => ({ ...result, ...archiveMetadata(archive), sessions: result.sessions.map(card => ({ ...card, ...(archive.archiveStateKnown ? { archived: archive.ids.has(card.id) } : {}) })),
        ...(!archive.archiveStateKnown ? { limitation: '当前接入点无法同步归档状态，列表可能包含已归档会话。' } : {}) });
      const records = listed.filter(record => {
        const header = record?.header ?? record?.session ?? record;
        return typeof header?.id === 'string' && header.id && (!archive.archiveStateKnown || archive.ids.has(header.id) === options.archived)
          && (options.archived || !archive.visibleIds || archive.visibleIds.has(header.id) !== options.unlisted) && matchesHistory(header, { ...options, query: '' });
      });
      const selected = options.query ? records : records.slice(options.offset, options.offset + options.limit);
      // The batch API resolves persistence once and folds titles without replaying
      // every complete log. Full counts and fallback text remain in get(id).
      if (typeof service.readTitleSnapshots === 'function') {
        const ids = selected.map(record => record?.header?.id ?? record?.session?.id ?? record?.id).filter(id => typeof id === 'string' && id);
        const observations = new Map((await service.readTitleSnapshots(ids)).map(item => [item.sessionId, item]));
        params.signal?.throwIfAborted();
        const cards = selected.map(record => {
          const header = record?.header ?? record?.session ?? record ?? {};
          const observation = observations.get(header.id);
          const card = summarizeSession(eventsWithSessionHeader(observation?.status === 'fulfilled' ? observation.value.session : header, []));
          card.summaryPartial = true;
          if (observation?.status === 'fulfilled') card.title = observation.value.title?.title || '';
          else if (observation?.status === 'rejected') card.decodeError = '会话标题暂时无法读取';
          return card;
        }).filter(card => card.id);
        return page(options.query ? historyPage(cards, options) : pageMetadata(cards, records.length, options));
      }
      const sessions = await mapLimited(selected, async (record) => {
        params.signal?.throwIfAborted();
        const header = record?.header ?? record?.session ?? record ?? {};
        const id = typeof header.id === 'string' ? header.id : '';
        if (!id) return { id: '', title: '', fallbackTitle: '', cwd: '', preset: '', createdAt: 0, lastTime: 0, turns: 0, userMessages: 0, decodeError: '会话记录缺少 id' };
        try {
          const read = await service.readSession(id); params.signal?.throwIfAborted();
          return historyFromQueryRead(read).card;
        } catch (error) {
          params.signal?.throwIfAborted();
          const card = summarizeSession(eventsWithSessionHeader(header, []));
          card.decodeError = error && error.message ? error.message : String(error);
          diag(`读取会话 ${id} 失败，列表中保留名片：${card.decodeError}`);
          return card;
        }
      });
      const cards = sessions.filter(card => card.id);
      return page(options.query ? historyPage(cards, options) : pageMetadata(cards, records.length, options));
    },
    async get(id, options = {}) {
      options.signal?.throwIfAborted();
      const wanted = assertSessionId(id);
      try {
        const result = historyFromQueryRead(await service.readSession(wanted)); options.signal?.throwIfAborted();
        const archive = archiveSnapshot(getWorkspaceRegistry());
        if (archive.archiveStateKnown) result.card.archived = archive.ids.has(wanted);
        return result;
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
      const { error, ...result } = await listSessionsAsync(root, params);
      if (error) throw new Error(error);
      return result;
    },
    async get(id, options = {}) {
      return getSessionAsync(root, id, options);
    },
  };
}
