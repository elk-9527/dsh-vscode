'use strict';

const assert = require('node:assert/strict');
const { DOOR_STREAM_METHOD, DoorLiveStream } = require('../src/door/live-stream');

let passed = 0;
function check(name, run) {
  run();
  passed += 1;
  console.log(`  ✅ ${name}`);
}

const start = (tracker, sessionId = 's1', attemptId = `${sessionId}:1`) =>
  tracker.accept({ sessionId, attemptId, kind: 'start' });
const delta = (tracker, kind, text, block = 0, sessionId = 's1', attemptId = `${sessionId}:1`) =>
  tracker.accept({ sessionId, attemptId, kind, block, delta: text });
const end = (tracker, sessionId = 's1', attemptId = `${sessionId}:1`, eventType = 'assistant/message') =>
  tracker.accept({ sessionId, attemptId, kind: 'end', committed: true, eventType });
const standard = (kind, text) => ({
  sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
  content: { type: 'text', text },
});

check('方法名与该插件一致', () => {
  assert.equal(DOOR_STREAM_METHOD, 'dsh-door/stream');
});

check('正文 token 立即投影成普通 ACP update', () => {
  const tracker = new DoorLiveStream();
  start(tracker);
  assert.deepEqual(delta(tracker, 'text', '你'), {
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } },
  });
  assert.equal(delta(tracker, 'text', '好').update.content.text, '好');
});

check('思考 token 使用 agent_thought_chunk', () => {
  const tracker = new DoorLiveStream();
  start(tracker);
  assert.equal(delta(tracker, 'thinking', '分析').update.sessionUpdate, 'agent_thought_chunk');
});

check('提交后完全相同的标准完整块被抑制，避免显示两遍', () => {
  const tracker = new DoorLiveStream();
  start(tracker);
  delta(tracker, 'text', '你');
  delta(tracker, 'text', '好');
  end(tracker);
  assert.equal(tracker.shouldForward('s1', standard('text', '你好')), false);
});

check('旧插件只有标准 ACP 时原样通过', () => {
  const tracker = new DoorLiveStream();
  assert.equal(tracker.shouldForward('s1', standard('text', '完整回复')), true);
});

check('最终文本与实时文本不一致时宁可保留，不误删内容', () => {
  const tracker = new DoorLiveStream();
  start(tracker);
  delta(tracker, 'text', '草稿');
  end(tracker);
  assert.equal(tracker.shouldForward('s1', standard('text', '最终稿')), true);
  // 不匹配的候选已核销，未来相同文本也不会被误判成这一回合的副本。
  assert.equal(tracker.shouldForward('s1', standard('text', '草稿')), true);
});

check('思考与正文多个块按类型分别去重', () => {
  const tracker = new DoorLiveStream();
  start(tracker);
  delta(tracker, 'thinking', '先想', 0);
  delta(tracker, 'text', '答案一', 1);
  delta(tracker, 'text', '答案二', 1);
  end(tracker);
  assert.equal(tracker.shouldForward('s1', standard('thinking', '先想')), false);
  assert.equal(tracker.shouldForward('s1', standard('text', '答案一答案二')), false);
});

check('标准完整块先于 end 的极端时序也能去重', () => {
  const tracker = new DoorLiveStream();
  start(tracker);
  delta(tracker, 'text', '提前到达');
  assert.equal(tracker.shouldForward('s1', standard('text', '提前到达')), false);
  end(tracker);
  assert.equal(tracker.shouldForward('s1', standard('text', '提前到达')), true);
});

check('assistant/attempt 不等待并不存在的标准正文副本', () => {
  const tracker = new DoorLiveStream();
  start(tracker);
  delta(tracker, 'text', '失败尝试');
  end(tracker, 's1', 's1:1', 'assistant/attempt');
  assert.equal(tracker.shouldForward('s1', standard('text', '失败尝试')), true);
});

check('不同会话互不影响，reset 会清除待去重状态', () => {
  const tracker = new DoorLiveStream();
  start(tracker, 's1');
  delta(tracker, 'text', '甲', 0, 's1');
  end(tracker, 's1');
  assert.equal(tracker.shouldForward('s2', standard('text', '甲')), true);
  tracker.reset();
  assert.equal(tracker.shouldForward('s1', standard('text', '甲')), true);
});

console.log(`\n${passed} 项实时输出测试全部通过。`);
