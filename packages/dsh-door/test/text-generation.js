import assert from 'node:assert/strict';
import { generateTextOnly, handleTextGeneration, textGenerationSupported } from '../lib/kernel/text-generation.js';

const signal = new AbortController().signal;
let requests = 0, toolExecutions = 0;
const llm = { async *stream(options) {
  requests++; assert.deepEqual(options.tools, []); assert.equal(options.messages.length, 1);
  yield { type: 'text-delta', index: 0, text: '{"edits":[]}' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"edits":[]}' } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}, execute() { toolExecutions++; } };
assert(textGenerationSupported(llm, '0.2.1-rc.2'));
assert(!textGenerationSupported(llm, '0.2.0-rc.2'));
assert(!textGenerationSupported({}, '0.2.1-rc.2'));
const options = { prompt: 'suggest a repair', provider: 'fixture', model: 'fixture', signal };
assert.deepEqual(await generateTextOnly(llm, options), { text: '{"edits":[]}', path: 'llm-direct-v1', tools: false });
for (const chunk of [{ type: 'tool-call-delta' }, { type: 'block-start', blockType: 'tool-call' }, { type: 'block-end', block: { type: 'tool-call' } }]) {
  await assert.rejects(generateTextOnly({ async *stream() { yield chunk; } }, options), /工具请求/);
}
for (const reason of [{ kind: 'error' }, { kind: 'aborted' }, { kind: 'length' }]) await assert.rejects(generateTextOnly({ async *stream() { yield { type: 'finish', reason }; } }, options));
await assert.rejects(generateTextOnly({ async *stream() { yield { type: 'text-delta', index: 0, text: 'x'.repeat(262145) }; } }, options), /过大/);
const abort = new AbortController(); abort.abort(); await assert.rejects(generateTextOnly(llm, { ...options, signal: abort.signal }));
const responses = [], state = { textLlm: llm, textGeneration: true, textRuns: new Map(), sessions: new Set(['owned']), agentsBySession: new Map([['owned', { options: { provider: 'fixture', model: 'fixture' } }]]), respond: response => responses.push(response) };
assert(handleTextGeneration({ id: 1, method: 'dsh-door/text/generate', params: { sessionId: 'foreign', prompt: 'x' } }, state));
assert.equal(responses[0].error.code, -32003); assert.equal(requests, 1);
assert(handleTextGeneration({ id: 2, method: 'dsh-door/text/generate', params: { sessionId: 'owned', prompt: 'x' } }, state));
for (let i = 0; !responses.find(item => item.id === 2) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(responses.find(item => item.id === 2).result.tools, false);
await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(state.textRuns.size, 0);
state.textGeneration = false; handleTextGeneration({ id: 3, method: 'dsh-door/text/generate' }, state); assert.equal(responses.at(-1).error.code, -32042);
state.textGeneration = true;
state.textLlm = { async *stream(options) { await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); } };
for (const id of [4, 5]) handleTextGeneration({ id, method: 'dsh-door/text/generate', params: { sessionId: 'owned', prompt: 'wait' } }, state);
handleTextGeneration({ id: 6, method: 'dsh-door/text/generate', params: { sessionId: 'owned', prompt: 'excess' } }, state);
assert.equal(responses.at(-1).error.code, -32045);
for (const id of [4, 5]) assert(handleTextGeneration({ method: '$/cancel_request', params: { requestId: id } }, state));
let cancellationTimer;
try { await Promise.race([Promise.allSettled([...state.textPending]), new Promise((_, reject) => { cancellationTimer = setTimeout(() => reject(new Error('Cancellation did not settle')), 1000); })]); } finally { clearTimeout(cancellationTimer); }
assert.equal(state.textRuns.size, 0); assert.equal(state.textPending.size, 0);
assert.equal(responses.find(item => item.id === 4).error.code, -32800);
assert.equal(toolExecutions, 0);
console.log('PASS direct text generation: empty tools, attempted calls rejected without dispatch, ownership, cancellation, size and completion');
