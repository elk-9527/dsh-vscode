import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { rememberImageProtocolRequest, rememberImageProtocolResponse, resolveImageCapabilities, handleImageCapabilities, closeImageCapabilityRequests, projectHistoryImages, handleHistoryImageRead } from '../lib/kernel/images.js';
import { decorateLine } from '../lib/frames.js';
import { gatePrompts } from '../lib/index.js';
import { sessionTranscript as doorTranscript } from '../lib/sessions.js';
import extensionHistory from '../../vscode-extension/src/dsh/sessions.js';
import historyRequests from '../lib/history-requests.cjs';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  PASS ${name}`); }
const attachments = { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 2048, mediaTypes: ['image/png', 'image/jpeg'] }, saveImages() {}, readImage() {} };
const tools = { schemas() { return [{ name: 'send_meme' }, { name: 'image_search' }, { name: 'generate_image' }, { name: 'read_file' }]; } };
function stateOf() {
  const agent = { ctx: { get(name) { return name === 'tools' ? tools : undefined; } } };
  return { imageRuntimeVersion: '0.2.1-rc.3', imagePromptEnabled: true, imageAttachments: attachments,
    sessions: new Set(['own']), agentsBySession: new Map([['own', agent]]), textModels: new Map([['own', { provider: 'p', model: 'vision' }]]),
    textLlm: { async resolveModelInfo(provider, model) { return { provider, id: model, inputModalities: ['text', 'image'] }; } } };
}
await check('native capability comes from the exact current owned route and attachment deployment', async () => {
  const state = stateOf(), calls = [];
  state.textLlm.resolveModelInfo = async (...args) => { calls.push(args.slice(0, 2)); return { inputModalities: ['text', 'image'] }; };
  const result = await resolveImageCapabilities(state, 'own');
  assert.deepEqual(calls, [['p', 'vision']]);
  assert.deepEqual(result, { provider: 'p', model: 'vision', input: true, mode: 'native', inputModalities: ['text', 'image'],
    limits: attachments.imageLimits, tools: { meme: true, search: ['image_search'], generate: ['generate_image'], evidence: 'registered-tool-names' } });
  await assert.rejects(() => resolveImageCapabilities(state, 'other'), error => error.code === -32003);
});
await check('unknown metadata, text-only model and unverified runtime refuse images explicitly', async () => {
  const state = stateOf();
  state.textLlm.resolveModelInfo = async () => ({});
  assert.equal((await resolveImageCapabilities(state, 'own')).reason, 'model-does-not-declare-image');
  state.textLlm.resolveModelInfo = async () => ({ inputModalities: ['text'] });
  assert.equal((await resolveImageCapabilities(state, 'own')).input, false);
  state.textLlm.resolveModelInfo = async () => { throw new Error('private provider credentials'); };
  const unknown = await resolveImageCapabilities(state, 'own');
  assert.equal(unknown.reason, 'model-capability-unavailable'); assert.ok(!JSON.stringify(unknown).includes('credentials'));
  state.imageRuntimeVersion = '0.2.0-rc.2'; assert.equal((await resolveImageCapabilities(state, 'own')).reason, 'acp-image-unsupported');
});
await check('missing services or model route do not inherit stale agent options', async () => {
  const state = stateOf(); state.imageAttachments = undefined;
  assert.equal((await resolveImageCapabilities(state, 'own')).reason, 'attachment-service-unavailable');
  state.imageAttachments = attachments; state.textModels.clear();
  state.agentsBySession.get('own').options = { provider: 'old', model: 'old-image-model' };
  const result = await resolveImageCapabilities(state, 'own');
  assert.equal(result.reason, 'model-route-unresolved'); assert.equal(result.provider, undefined);
});
await check('connection initialization remains authoritative after a later model switch', async () => {
  const state = stateOf(); delete state.imagePromptEnabled;
  rememberImageProtocolRequest({ id: 1, method: 'initialize' }, state);
  rememberImageProtocolResponse({ id: 2, result: { agentCapabilities: { promptCapabilities: { image: true } } } }, state);
  assert.equal(state.imagePromptEnabled, undefined);
  rememberImageProtocolResponse({ id: 1, result: { agentCapabilities: { promptCapabilities: { image: false } } } }, state);
  assert.equal((await resolveImageCapabilities(state, 'own')).reason, 'connection-image-disabled');
  rememberImageProtocolRequest({ id: 3, method: 'initialize' }, state);
  state.replies = new Map();
  await decorateLine(JSON.stringify({ id: 3, result: { agentCapabilities: { promptCapabilities: { image: true } } } }), state, () => {});
  assert.equal((await resolveImageCapabilities(state, 'own')).input, true);
});
await check('model changes, closed sessions and caller aborts invalidate an in-flight query', async () => {
  const state = stateOf(); let release;
  state.textLlm.resolveModelInfo = () => new Promise(resolve => { release = resolve; });
  const query = resolveImageCapabilities(state, 'own');
  state.textModels.set('own', { provider: 'p', model: 'text' }); release({ inputModalities: ['image'] });
  await assert.rejects(() => query, error => error.code === -32042);
  const closed = resolveImageCapabilities(state, 'own'); state.sessions.delete('own'); release({ inputModalities: ['image'] });
  await assert.rejects(() => closed, error => error.code === -32003);
  const fresh = stateOf(), controller = new AbortController(); controller.abort();
  await assert.rejects(() => resolveImageCapabilities(fresh, 'own', { signal: controller.signal }));
});
await check('inaccessible scoped tools remain unknown instead of falsely absent', async () => {
  const state = stateOf(); state.agentsBySession.get('own').ctx.get = () => undefined;
  assert.equal((await resolveImageCapabilities(state, 'own')).tools, undefined);
});
await check('RPC cancellation settles even when a model-catalog provider ignores AbortSignal', async () => {
  const state = stateOf(), replies = []; state.respond = reply => replies.push(reply);
  state.textLlm.resolveModelInfo = () => new Promise(() => {});
  assert.equal(handleImageCapabilities({ method: 'other', id: 1 }, state), false);
  handleImageCapabilities({ method: 'dsh-door/images/capabilities', id: 1, params: { sessionId: 'own' } }, state);
  handleImageCapabilities({ method: '$/cancelRequest', params: { id: 1 } }, state);
  for (let tries = 0; state.imageQueries.size && tries < 100; tries++) await delay(2);
  assert.equal(replies[0].error.code, -32800); assert.equal(state.imageQueries.size, 0);
  handleImageCapabilities({ method: 'dsh-door/images/capabilities', id: 2, params: { sessionId: 'own' } }, state);
  closeImageCapabilityRequests(state);
  for (let tries = 0; state.imageQueries.size && tries < 100; tries++) await delay(2);
  assert.equal(replies.length, 1); assert.equal(state.imageQueries.size, 0);
});
await check('capability queries leave ACP image prompt bytes and ordering unchanged', async () => {
  const state = stateOf(), replies = []; state.respond = reply => replies.push(reply); state.pending = new Map();
  const prompt = { id: 2, method: 'session/prompt', params: { sessionId: 'own', prompt: [{ type: 'text', text: '看图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } };
  const input = [{ id: 1, method: 'dsh-door/images/capabilities', params: { sessionId: 'own' } }, prompt].map(frame => JSON.stringify(frame)).join('\n') + '\n';
  const source = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(input)); controller.close(); } });
  const forwarded = [];
  for await (const chunk of gatePrompts(source, state, () => {})) forwarded.push(new TextDecoder().decode(chunk));
  assert.equal(forwarded.join(''), JSON.stringify(prompt) + '\n');
  for (let tries = 0; state.imageQueries.size && tries < 100; tries++) await delay(2);
  assert.equal(replies[0].result.input, true);
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRfkAAAAASUVORK5CYII=', 'base64');
const ref = { attachmentId: `sha256:${createHash('sha256').update(png).digest('hex')}`, mediaType: 'image/png', width: 1, height: 1, bytes: png.length };
await check('both history projections preserve image-only user and assistant messages with bounded native refs', async () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { ...ref, name: 'private-display-name.png', extra: 'not-a-supported-field' } }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'image', attachment: ref }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '说明' }, ...Array.from({ length: 5 }, () => ({ type: 'image', attachment: ref }))] } } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { ...ref, bytes: 9 * 1024 * 1024 } }] } },
  ];
  const projected = doorTranscript(events);
  assert.deepEqual(projected, extensionHistory.sessionTranscript(events));
  assert.deepEqual(projected.entries[0], { kind: 'user', text: '', images: [{ attachment: ref }] });
  assert.deepEqual(projected.entries[1], { kind: 'assistant', text: '', images: [{ attachment: ref }] });
  assert.equal(projected.entries[2].images.length, 4); assert.match(projected.entries[2].text, /图片未载入/);
  assert.match(projected.entries[3].text, /图片未载入/); assert.equal(projected.entries[3].images, undefined);
  assert.ok(!JSON.stringify(projected).includes('private-display-name'));
});
await check('tool-result images survive native and legacy wrappers with finite traversal', async () => {
  let nested = { type: 'image', attachment: ref };
  for (let index = 0; index < 8; index++) nested = { type: 'content', content: nested };
  const events = [
    { type: 'tool/call', data: { callId: 'new', name: 'generate_image', arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'new', content: [{ type: 'tool-result', content: [{ type: 'content', content: { type: 'image', attachment: ref } }] }] } } },
    { type: 'tool/call', data: { callId: 'old', name: 'image_search', arguments: '{}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'old' }, content: [{ type: 'image', attachment: ref }] } } },
    { type: 'tool/call', data: { callId: 'deep', name: 'generate_image', arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'deep', content: [nested] } } },
    { type: 'tool/call', data: { callId: 'large', name: 'image_search', arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'large', content: [...Array.from({ length: 513 }, () => ({ type: 'text', text: '' })), { type: 'image', attachment: ref }] } } },
  ];
  const result = doorTranscript(events);
  assert.deepEqual(result, extensionHistory.sessionTranscript(events));
  assert.equal(result.entries.length, 4); assert.deepEqual(result.entries[0].images, [{ attachment: ref }]); assert.deepEqual(result.entries[1].images, [{ attachment: ref }]);
  assert.match(result.entries[2].output, /图片未载入/); assert.match(result.entries[3].output, /图片未载入/);
  const unavailable = projectHistoryImages(result, {});
  assert.match(unavailable.entries[0].output, /图片未载入/); assert.equal(unavailable.entries[0].images, undefined);
});
await check('successful explicit history/get publishes opaque connection tokens and no native refs', async () => {
  const replies = [], state = { respond: value => replies.push(value), imageAttachments: { async readImage(value) { assert.deepEqual(value, ref); return { data: png, ref }; } } };
  state.sessionsHandler = { async get() { return { card: { id: 'history' }, ...doorTranscript([{ type: 'assistant/message', data: { message: { content: [{ type: 'image', attachment: ref }] } } }]) }; } };
  state.projectHistoryImages = result => projectHistoryImages(result, state);
  await historyRequests.runHistoryRequest({ id: 1, method: 'dsh-door/sessions/get', params: { id: 'history' } }, 'get', state);
  const result = replies[0].result, image = result.entries[0].images[0];
  assert.equal(image.source, `dsh-image:${image.id}`); assert.equal(state.historyImageTokens.size, 1);
  assert.ok(!JSON.stringify(result).includes('attachmentId')); assert.ok(!JSON.stringify(result).includes('sha256:'));
  handleHistoryImageRead({ id: 2, method: 'dsh-door/images/read', params: { token: image.id } }, state);
  for (let tries = 0; state.imageReads.size && tries < 100; tries++) await delay(2);
  assert.deepEqual(replies.at(-1).result, { data: png.toString('base64'), mimeType: 'image/png' });
  const foreign = { imageAttachments: state.imageAttachments, respond: value => replies.push(value) };
  handleHistoryImageRead({ id: 3, method: 'dsh-door/images/read', params: { token: image.id } }, foreign);
  for (let tries = 0; foreign.imageReads.size && tries < 100; tries++) await delay(2);
  assert.equal(replies.at(-1).error.code, -32003);
  handleHistoryImageRead({ id: 4, method: 'dsh-door/images/read', params: { token: ref.attachmentId } }, state);
  for (let tries = 0; state.imageReads.size && tries < 100; tries++) await delay(2);
  assert.equal(replies.at(-1).error.code, -32602);
  closeImageCapabilityRequests(state); assert.equal(state.historyImageTokens.size, 0);
});
await check('history omission is explicit for unavailable services and connection token budgets', async () => {
  const result = { entries: [{ kind: 'user', text: '', images: [{ attachment: ref }] }] };
  const unavailable = projectHistoryImages(result, {});
  assert.equal(unavailable.entries[0].images, undefined); assert.match(unavailable.entries[0].text, /图片未载入/);
  const state = { imageAttachments: { readImage() {} }, historyImageTokens: new Map(Array.from({ length: 1024 }, (_, index) => [String(index), ref])) };
  const bounded = projectHistoryImages(result, state);
  assert.equal(bounded.entries[0].images, undefined); assert.match(bounded.entries[0].text, /图片未载入/); assert.equal(state.historyImageTokens.size, 1024);
  const large = { ...ref, bytes: 8 * 1024 * 1024 };
  const bytes = doorTranscript([{ type: 'assistant/message', data: { message: { content: Array.from({ length: 3 }, () => ({ type: 'image', attachment: large })) } } }]);
  assert.equal(bytes.entries[0].images.length, 2); assert.match(bytes.entries[0].text, /图片未载入/);
});
await check('cancelled or failed history reads never publish image tokens', async () => {
  const replies = [], state = { respond: value => replies.push(value), imageAttachments: { readImage() {} } };
  state.projectHistoryImages = result => projectHistoryImages(result, state);
  let release;
  state.sessionsHandler = { get() { return new Promise(resolve => { release = resolve; }); } };
  const pending = historyRequests.runHistoryRequest({ id: 1, method: 'dsh-door/sessions/get', params: { id: 'history' } }, 'get', state);
  await delay(0);
  historyRequests.cancelHistoryRequest({ method: '$/cancelRequest', params: { id: 1 } }, state);
  await pending; release({ entries: [{ kind: 'user', text: '', images: [{ attachment: ref }] }] }); await delay(0);
  assert.equal(state.historyImageTokens, undefined); assert.equal(replies[0].error.code, -32800);
  state.sessionsHandler.get = async () => { throw new Error('missing history'); };
  await historyRequests.runHistoryRequest({ id: 2, method: 'dsh-door/sessions/get', params: { id: 'history' } }, 'get', state);
  assert.equal(state.historyImageTokens, undefined); assert.equal(replies[1].error.code, -32000);
});
await check('history image bytes are integrity checked and cancelled reads do not outlive their connection', async () => {
  const replies = [], state = { respond: value => replies.push(value), imageAttachments: { async readImage() { return { data: Buffer.from('wrong'), ref }; } } };
  const image = projectHistoryImages({ entries: [{ images: [{ attachment: ref }], text: '' }] }, state).entries[0].images[0];
  handleHistoryImageRead({ id: 1, method: 'dsh-door/images/read', params: { token: image.id } }, state);
  for (let tries = 0; state.imageReads.size && tries < 100; tries++) await delay(2);
  assert.equal(replies[0].error.code, -32042);
  state.imageAttachments.readImage = () => new Promise(() => {});
  handleHistoryImageRead({ id: 2, method: 'dsh-door/images/read', params: { token: image.id } }, state);
  handleHistoryImageRead({ method: '$/cancel_request', params: { requestId: 2 } }, state);
  for (let tries = 0; state.imageReads.size && tries < 100; tries++) await delay(2);
  assert.equal(replies.at(-1).error.code, -32800);
  handleHistoryImageRead({ id: 3, method: 'dsh-door/images/read', params: { token: image.id } }, state); closeImageCapabilityRequests(state);
  for (let tries = 0; state.imageReads.size && tries < 100; tries++) await delay(2);
  assert.equal(replies.length, 2); assert.equal(state.historyImageTokens.size, 0);
});
console.log(`\nPASS exact-route image capability diagnostics (${passed} checks)`);
