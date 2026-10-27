'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DshSession } = require('../src/dsh/session');
(async () => {
  const client = new EventEmitter();
  const content = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=' };
  client.prompt = async sessionId => {
    client.emit('update', 'another-session', { sessionUpdate: 'agent_message_chunk', content });
    client.emit('update', sessionId, { sessionUpdate: 'agent_message_chunk', content });
    client.emit('update', sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '图片回复完成' } });
    return { stopReason: 'end_turn' };
  };
  const session = new DshSession({ client }); session.sessionId = 'images';
  const images = [], text = []; session.on('image', event => images.push(event)); session.on('text', event => text.push(event));
  const result = await session.send('返回一张图片');
  assert.equal(result.stopReason, 'end_turn'); assert.equal(images.length, 1); assert.deepEqual(images[0].content, content);
  assert.equal(images[0].id, text[0].id); assert.equal(text[0].delta, '图片回复完成');
  assert(!JSON.stringify([...session.messages.values()]).includes(content.data), 'pixel content must not be duplicated in session text state');
  session.dispose(); console.log('PASS ACP image events: own-session routing, image/text coexistence and no raw pixels in message state');
})().catch(error=>{console.error(error);process.exitCode=1});
