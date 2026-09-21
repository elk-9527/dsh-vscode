import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeModelSelection, resolveInitialModel } from '../lib/model.js';
import {
  DOOR_STATUS_METHOD,
  DOOR_VERSION,
  doorStatusPayload,
  doorStatusResult,
  isDoorStatusRequest,
} from '../lib/status.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

check('模型字段会去掉首尾空白', () => {
  assert.deepEqual(normalizeModelSelection({ provider: ' p ', model: ' m ' }), {
    provider: 'p',
    model: 'm',
  });
});

check('缺少任一字段时不拼出半套模型配置', () => {
  assert.equal(normalizeModelSelection({ provider: 'p' }), undefined);
  assert.equal(normalizeModelSelection({ model: 'm' }), undefined);
});

check('完整的插件显式配置优先', () => {
  const actual = resolveInitialModel(
    { provider: 'explicit', model: 'chosen' },
    { currentSelection: () => ({ provider: 'dsh', model: 'default' }) },
  );
  assert.deepEqual(actual, {
    source: 'config',
    selection: { provider: 'explicit', model: 'chosen' },
  });
});

check('未显式配置时读取 DSH 当前默认模型', () => {
  const actual = resolveInitialModel({}, {
    currentSelection: () => ({ provider: 'user-provider', model: 'user-model' }),
  });
  assert.deepEqual(actual, {
    source: 'dsh-default',
    selection: { provider: 'user-provider', model: 'user-model' },
    partialConfig: false,
  });
});

check('半套显式配置被忽略并留下诊断标记', () => {
  const actual = resolveInitialModel(
    { provider: 'only-provider' },
    { currentSelection: () => ({ provider: 'dsh', model: 'default' }) },
  );
  assert.equal(actual.source, 'dsh-default');
  assert.equal(actual.partialConfig, true);
});

check('旧 DSH 没有默认模型服务时明确报告缺失', () => {
  assert.deepEqual(resolveInitialModel({}, undefined), {
    source: 'missing',
    partialConfig: false,
  });
});

check('默认模型服务抛错不会使接入点启动崩溃', () => {
  const actual = resolveInitialModel({}, {
    currentSelection() {
      throw new Error('broken settings');
    },
  });
  assert.equal(actual.source, 'missing');
  assert.equal(actual.error, 'broken settings');
});

check('状态方法只匹配精确且带 id 的请求', () => {
  assert.equal(isDoorStatusRequest({ id: 1, method: DOOR_STATUS_METHOD }), true);
  assert.equal(isDoorStatusRequest({ method: DOOR_STATUS_METHOD }), false);
  assert.equal(isDoorStatusRequest({ id: 1, method: `${DOOR_STATUS_METHOD}/extra` }), false);
});

check('状态载荷不包含服务对象或异常原文', () => {
  const model = {
    source: 'dsh-default',
    selection: { provider: 'p', model: 'm' },
    error: 'secret-like diagnostic',
  };
  assert.deepEqual(doorStatusPayload({ model, permissionAvailable: true }), {
    version: DOOR_VERSION,
    model: { ready: true, source: 'dsh-default', provider: 'p', model: 'm' },
    capabilities: { presets: true, history: true, permissionPresets: true },
  });
});

check('状态应答保持标准 JSON-RPC 形状', () => {
  assert.deepEqual(doorStatusResult(7, { ok: true }), {
    jsonrpc: '2.0',
    id: 7,
    result: { ok: true },
  });
});

check('代码中的版本号与包版本一致', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.equal(DOOR_VERSION, pkg.version);
});

console.log(`\n${passed} 项模型/状态测试全部通过。`);

