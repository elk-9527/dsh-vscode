import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

/** A revision describes a set without exposing session identities. */
export function archiveRevision(ids) {
  return createHash('sha256').update(JSON.stringify([...new Set(ids)].sort())).digest('hex');
}

export function archiveSnapshot(registry) {
  if (!registry) return { ids: new Set(), visibleIds: undefined, archiveStateKnown: false, workspaceStateKnown: false, archiveSupported: false };
  const ids = registry.archivedSessionIds;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('DSH 归档状态暂时无法读取，请稍后同步。');
  let visibleIds;
  if (typeof registry.list === 'function') {
    const workspaces = registry.list();
    if (!Array.isArray(workspaces)) throw new Error('DSH 工作区成员暂时无法读取，请稍后同步。');
    visibleIds = new Set(workspaces.flatMap(workspace => workspace.sessionIds || []));
    for (const id of registry.pinnedSessionIds || []) visibleIds.add(id);
  }
  return { ids: new Set(ids), visibleIds, archiveStateKnown: true, workspaceStateKnown: Boolean(visibleIds),
    archiveSupported: typeof registry.archiveSession === 'function' && typeof registry.unarchiveSession === 'function',
    archiveRevision: archiveRevision([...ids.map(id => 'archive:' + id), ...(visibleIds ? [...visibleIds].map(id => 'visible:' + id) : [])]) };
}

export function archiveMetadata(snapshot) {
  const { ids, visibleIds, ...metadata } = snapshot;
  return metadata;
}

/** Register only a conversation explicitly opened by this ACP connection. */
export async function registerHistorySession(registry, header) {
  if (!registry || !header?.id || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || typeof registry.resolveByPath !== 'function' || typeof registry.create !== 'function') return false;
  const workspace = await registry.resolveByPath(header.cwd) || await registry.create(header.cwd);
  await workspace.attachSession(header.id);
  return true;
}

export async function setHistoryArchived(registry, id, archived, { signal } = {}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || typeof archived !== 'boolean') {
    throw Object.assign(new Error('归档操作需要有效的会话 id 和布尔状态。'), { code: -32602 });
  }
  if (!archiveSnapshot(registry).archiveSupported) throw Object.assign(new Error('当前内核不支持归档同步，请更新接入点并连接 DSH。'), { code: -32601 });
  signal?.throwIfAborted();
  try {
    // Let DSH refuse active sessions; never request stopActivity implicitly.
    if (archived) await registry.archiveSession(id);
    else await registry.unarchiveSession(id);
  } catch (error) {
    if (error?.name === 'WorkspaceActiveSessionError') throw new Error('该会话仍有运行中的任务，请结束后再归档。');
    throw error;
  }
  // Once the write starts, report its committed outcome even if cancelled.
  const committed = archiveSnapshot(registry);
  return { id, archived: committed.ids.has(id), ...archiveMetadata(committed) };
}
