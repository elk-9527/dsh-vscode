import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createLegacyHistory,
  createSessionQueryHistory,
  eventsWithSessionHeader,
  historyFromQueryRead,
} from '../lib/kernel/history.js';
import {
  createPermissionHandler,
  permissionApiKind,
} from '../lib/kernel/permissions.js';
import {
  DOOR_ERR_NO_SESSION,
  DOOR_ERR_UNKNOWN_PRESET,
  doorErrorCode,
} from '../lib/permission.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const header = {
  version: 4,
  id: 'session-v4',
  createdAt: 100,
  cwd: 'D:\\workspace',
  agentPreset: 'standard',
};
const events = [
  { type: 'session/title', seq: 1, time: 101, data: { title: 'v4 会话' } },
  { type: 'turn/start', seq: 2, time: 102, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 3,
    time: 103,
    data: {
      source: { kind: 'user' },
      role: 'user',
      content: [{ type: 'text', text: '你好，0.2' }],
    },
  },
  {
    type: 'assistant/message',
    seq: 4,
    time: 104,
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text: '已连接。' }] },
    },
  },
];

await check('v4 的独立 header 会被合成为稳定的旧事件输入', () => {
  const merged = eventsWithSessionHeader(header, events);
  assert.equal(merged[0].type, 'session');
  assert.equal(merged[0].version, 4);
  assert.equal(merged[1], events[0]);
});

await check('sessionQuery 读取结果能生成名片和回放', () => {
  const actual = historyFromQueryRead({ session: header, events });
  assert.equal(actual.card.id, 'session-v4');
  assert.equal(actual.card.title, 'v4 会话');
  assert.equal(actual.card.turns, 1);
  assert.deepEqual(actual.entries.map((entry) => entry.kind), ['user', 'assistant']);
});

await check('sessionQuery 列表遵守 limit、保留单条读取错误并报告 skipped', async () => {
  const diagnostics = [];
  const handler = createSessionQueryHistory({
    async listSessions() {
      return [
        { header },
        { header: { ...header, id: 'session-broken', createdAt: 90 } },
        { header: { ...header, id: 'session-old', createdAt: 80 } },
      ];
    },
    async readSession(id) {
      if (id === 'session-broken') throw new Error('damaged');
      return { session: { ...header, id }, events };
    },
  }, (line) => diagnostics.push(line));

  assert.equal(handler.kind, 'session-query');
  const actual = await handler.list({ limit: 2 });
  assert.equal(actual.sessions.length, 2);
  assert.equal(actual.skipped, 1);
  assert.equal(actual.sessions[0].id, 'session-v4');
  assert.equal(actual.sessions[1].decodeError, 'damaged');
  assert.equal(diagnostics.length, 1);
});

await check('sessionQuery get 校验 id，并把找不到会话改成人话', async () => {
  const handler = createSessionQueryHistory({
    async listSessions() { return []; },
    async readSession() {
      const error = new Error('session not found');
      error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
      throw error;
    },
  });
  await assert.rejects(() => handler.get('../bad'), /id 不合法/);
  await assert.rejects(() => handler.get('missing'), /找不到会话 missing/);
});

await check('旧版历史回退在首次启动的空目录上返回空列表', async () => {
  const root = path.join(os.tmpdir(), `dsh-door-empty-${process.pid}-${Date.now()}`);
  try {
    const actual = await createLegacyHistory(root).list();
    assert.deepEqual(actual, { sessions: [], skipped: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeContext(service) {
  return {
    permissionPresets: service,
    sessions: new Map([['s1', { id: 's1' }]]),
  };
}

await check('权限接口版本能区分 DSH 0.2 catalog 与 DSH 0.1 selectFor', () => {
  assert.equal(permissionApiKind({ catalog() {}, current() {}, set() {} }), 'catalog');
  assert.equal(
    permissionApiKind({ selectFor() {}, permissionState() {}, current() {}, set() {} }),
    'select-for',
  );
  assert.equal(permissionApiKind({ current() {} }), undefined);
});

await check('DSH 0.2 catalog 权限接口可读、可切并使用 resolve 校验', async () => {
  let current = 'read-only';
  const calls = [];
  const handler = createPermissionHandler(makeContext({
    catalog() {
      return {
        options: [
          { value: 'read-only', name: '只读' },
          { value: 'workspace-write', name: '工作区写入' },
        ],
        defaultPreset: 'workspace-write',
      };
    },
    current() { return current; },
    resolve(value) {
      if (!['read-only', 'workspace-write'].includes(value)) throw new Error(`unknown ${value}`);
    },
    async set(session, value) {
      calls.push([session.id, value]);
      current = value;
    },
  }));

  assert.equal(handler.kind, 'catalog');
  assert.equal((await handler.get('s1')).currentValue, 'read-only');
  const changed = await handler.set('s1', 'workspace-write');
  assert.equal(changed.currentValue, 'workspace-write');
  assert.deepEqual(calls, [['s1', 'workspace-write']]);
  await assert.rejects(
    () => handler.set('s1', 'gone'),
    (error) => doorErrorCode(error) === DOOR_ERR_UNKNOWN_PRESET,
  );
});

await check('DSH 0.1 selectFor 权限接口继续受支持', async () => {
  let current = 'read-only';
  const handler = createPermissionHandler(makeContext({
    defaultPreset: 'read-only',
    permissionState(session) { return { session }; },
    selectFor() {
      return { options: [{ value: 'read-only' }, { value: 'danger-full-access' }] };
    },
    current() { return current; },
    async set(_session, value) { current = value; },
  }));
  assert.equal(handler.kind, 'select-for');
  assert.equal((await handler.set('s1', 'danger-full-access')).currentValue, 'danger-full-access');
});

await check('会话不存在与未知权限服务都明确失败', async () => {
  const handler = createPermissionHandler(makeContext({
    catalog() { return { options: [] }; },
    current() { return 'read-only'; },
    async set() {},
  }));
  await assert.rejects(
    () => handler.get('missing'),
    (error) => doorErrorCode(error) === DOOR_ERR_NO_SESSION,
  );
  assert.equal(createPermissionHandler(makeContext({ current() {} })), undefined);
});

console.log(`\n${passed} 项内核兼容适配器测试全部通过。`);
