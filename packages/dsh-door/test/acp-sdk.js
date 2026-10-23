import assert from 'node:assert/strict';
import { ndJsonStream, agent, methods, RequestError } from '@agentclientprotocol/sdk';
import { MAX_FRAME_BYTES } from '../lib/frames.js';
// Exercise the actual SDK entry used by Door, including a valid history frame
// above the SDK's default 32 MiB and below Door's independent raw frame budget.
const history = 'a'.repeat(33 * 1024 * 1024);
const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { history } }) + '\n');
const output = [];
const stream = ndJsonStream(new WritableStream({ write: chunk => { output.push(chunk); } }),
  new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { maxMessageBytes: MAX_FRAME_BYTES });
const reader = stream.readable.getReader();
assert.equal((await reader.read()).value.result.history.length, history.length);
assert((await reader.read()).done); assert.equal(output.length, 0);
assert.equal(typeof agent, 'function'); assert(methods); assert.equal(typeof RequestError, 'function');
const small = ndJsonStream(new WritableStream(), new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(513)); controller.close(); } }), { maxMessageBytes: 512 });
await assert.rejects(small.readable.getReader().read(), /512 byte limit/);
console.log('PASS actual ACP v1 SDK, DSH app API exports, large legal history and configured limits');
