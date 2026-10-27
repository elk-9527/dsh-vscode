'use strict';
/** 历史查询独立于 ACP 回合；取消只影响本连接对应的请求。 */
function cancelHistoryRequest(frame, state) {
  const id = frame?.method === '$/cancelRequest' ? frame.params?.id : frame?.method === '$/cancel_request' ? frame.params?.requestId : undefined;
  const controller = id !== undefined && state.historyReads?.get(id);
  if (!controller) return false;
  controller.abort(); return true;
}
async function runHistoryRequest(frame, method, state, diag = () => {}) {
  const reads = state.historyReads ||= new Map();
  const reply = value => { if (!state.historyClosed) state.respond({ jsonrpc: '2.0', id: frame.id, ...value }); };
  const error = (code, message) => reply({ error: { code, message } });
  if (reads.has(frame.id)) { error(-32600, '历史请求 id 已在使用'); return; }
  const handler = state.sessionsHandler;
  if (!['list', 'get', 'state', 'archive'].includes(method) || !handler || typeof handler[method] !== 'function') { error(-32601, `该插件不支持 ${frame.method}`); return; }
  if (reads.size >= 8) { error(-32000, '历史查询较多，请稍后重试'); return; }
  const controller = new AbortController(); reads.set(frame.id, controller);
  let onAbort;
  const cancelled = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true }); });
  if (method === 'archive') void cancelled.catch(() => {});
  try {
    const operation = Promise.resolve().then(() => method === 'get' ? handler.get(frame.params?.id, { signal: controller.signal })
      : method === 'archive' ? handler.archive(frame.params?.id, frame.params?.archived, { signal: controller.signal })
      : method === 'state' ? handler.state() : handler.list({ ...(frame.params || {}), signal: controller.signal }));
    let result = await (method === 'archive' ? operation : Promise.race([cancelled, operation]));
    if (method !== 'archive') controller.signal.throwIfAborted();
    if (method === 'get' && typeof state.projectHistoryImages === 'function') result = state.projectHistoryImages(result);
    if (method !== 'archive') controller.signal.throwIfAborted(); reply({ result }); diag(`旁路应答 ${frame.method}（请求 ${frame.id}）成功`);
  } catch (cause) {
    const message = controller.signal.aborted ? '历史查询已取消' : cause?.message || String(cause);
    error(controller.signal.aborted ? -32800 : -32000, message); diag(`旁路应答 ${frame.method}（请求 ${frame.id}）失败：${message}`);
  } finally { controller.signal.removeEventListener('abort', onAbort); if (reads.get(frame.id) === controller) reads.delete(frame.id); }
}
module.exports = { cancelHistoryRequest, runHistoryRequest };
