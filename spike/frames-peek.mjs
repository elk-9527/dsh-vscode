#!/usr/bin/env node
/**
 * 查看抓取到的帧中**响应**的结构（跳过 session/update 通知流）。
 *
 * 用途：调试"某个能力未生效"时，直接查看内核返回的内容，
 * 而非推测。默认仅打印响应帧，`--all` 参数打印全部帧。
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
