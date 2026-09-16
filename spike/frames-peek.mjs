#!/usr/bin/env node
/**
 * 看一眼抓下来的帧里，**响应**长什么样（跳过烦人的 session/update 通知流）。
 *
 * 用途：调试"为什么某个能力没生效"时，直接看内核回了什么，
 * 而不是靠猜。默认只打印响应帧，`--all` 才打印全部。
 *
 * 用法：node spike/frames-peek.mjs <frames.jsonl> [--all]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node spike/frames-peek.mjs <frames.jsonl> [--all]');
  process.exit(2);
}
const showAll = process.argv.includes('--all');

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
let shown = 0;

for (const raw of lines) {
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    continue;
  }
  let msg;
  try {
    msg = JSON.parse(rec.line);
  } catch {
    continue;
  }

  const isNotification = msg.method !== undefined && msg.id === undefined;
  const method = msg.method ?? '';
  const isUpdate = method.endsWith('session/update');

  if (!showAll && (isNotification || isUpdate)) continue;

  shown += 1;
  const dir = rec.dir === 'c2s' ? '→' : '←';
  const label =
    msg.error !== undefined
      ? `❌ 错误 ${msg.error.code}: ${msg.error.message}`
      : msg.method
        ? `请求 ${msg.method}`
        : '响应';
  console.log(`\n${dir} ${label}${msg.id !== undefined ? `  (id=${msg.id})` : ''}`);
  const body = msg.result ?? msg.params ?? msg.error;
  console.log(JSON.stringify(body, null, 2));
}

console.log(`\n（共打印 ${shown} 帧；用 --all 看全部）`);
