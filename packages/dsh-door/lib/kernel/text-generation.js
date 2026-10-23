import { randomUUID } from 'node:crypto';

export const TEXT_GENERATE = 'dsh-door/text/generate';
const fail = (message, code = -32042) => { throw Object.assign(new Error(message), { code }); };
/** The direct LLM service has no agent loop or tool dispatcher. Verified for this runtime generation. */
export function textGenerationSupported(llm, version) {
  return version === '0.2.1-rc.2' && typeof llm?.stream === 'function';
}
export async function generateTextOnly(llm, { prompt, provider, model, signal }) {
  if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > 256 * 1024) fail('修复请求为空或超过大小限制。', -32602);
  if (!provider || !model) fail('当前模型不可用，请先选择模型后重试。');
  signal.throwIfAborted();
  let text = '', finish;
  const blocks = new Map();
  const stream = await llm.stream({ provider, model, tools: [], messages: [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }], signal });
  signal.throwIfAborted();
  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType === 'tool-call' || chunk.type === 'block-end' && chunk.block?.type === 'tool-call') fail('模型返回了工具请求，已拒绝此响应。工具未执行，请重新生成。', -32046);
    if (chunk.type === 'text-delta') { blocks.set(chunk.index, (blocks.get(chunk.index) || '') + chunk.text); }
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.set(chunk.index, chunk.block.text);
    text = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('');
    if (Buffer.byteLength(text) > 256 * 1024) fail('修复建议过大，请缩小范围。', -32045);
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  signal.throwIfAborted();
  if (finish?.kind !== 'stop') fail(finish?.kind === 'aborted' ? '修复生成已取消。' : '模型未完整返回修复建议，请重试。', finish?.kind === 'aborted' ? -32800 : -32046);
  return { text, path: 'llm-direct-v1', tools: false };
}
/** Reserve before starting I/O; only a session owned by this connection may select the model route. */
export function handleTextGeneration(frame, state) {
  if (frame?.method === '$/cancel_request') {
    const run = state.textRuns?.get(frame.params?.requestId);
    if (!run) return false;
    run.abort(new Error('修复生成已取消。')); return true;
  }
  if (frame?.method !== TEXT_GENERATE || frame.id === undefined) return false;
  const replyError = error => state.respond({ jsonrpc: '2.0', id: frame.id, error: { code: error.code || -32046, message: error.message || '修复生成失败，请重试。' } });
  try {
    if (!state.textGeneration) fail('当前内核不支持禁用工具的修复生成，请更新兼容的接入点或使用手动修复。');
    const id = frame.params?.sessionId, agent = state.agentsBySession?.get(id);
    if (!state.sessions?.has(id) || !agent) fail('会话不属于当前连接。', -32003);
    if (state.textRuns.size >= 2 || state.textRuns.has(frame.id)) fail('修复生成请求已达到并发上限。', -32045);
    const controller = new AbortController(); state.textRuns.set(frame.id, controller);
    const timer = setTimeout(() => controller.abort(new Error('修复生成超时，请重试。')), 90000);
    const route = { provider: agent.options?.provider || state.modelRoute?.selection?.provider, model: agent.options?.model || state.modelRoute?.selection?.model };
    state.textPending ||= new Set();
    const pending = generateTextOnly(state.textLlm, { prompt: frame.params?.prompt, provider: route.provider, model: route.model, signal: controller.signal })
      .then(result => state.respond({ jsonrpc: '2.0', id: frame.id, result }), error => replyError(controller.signal.aborted ? Object.assign(new Error(controller.signal.reason?.message || '修复生成已取消。'), { code: -32800 }) : error))
      .finally(() => { clearTimeout(timer); state.textRuns.delete(frame.id); state.textPending.delete(pending); }).catch(() => {});
    state.textPending.add(pending);
  } catch (error) { replyError(error); }
  return true;
}
