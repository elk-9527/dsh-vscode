'use strict';
const { fenceFor } = require('./blocks');
function historyMarkdown(result) {
  const card = result.card || {};
  const parts = [`# ${String(card.title || card.fallbackTitle || 'DSH 对话').replace(/[\r\n]/g, ' ')}`,
    `会话：${card.id || ''}`, card.cwd ? `工作目录：${card.cwd}` : '',
    result.truncated ? '此导出包含当前可回放的内容；原会话较长，部分内容已截断。' : ''];
  for (const entry of result.entries || []) {
    const role = entry.kind === 'user' ? '用户' : entry.kind === 'assistant' ? 'DSH' : '工具';
    parts.push(`## ${role}`);
    if (entry.thinking) parts.push(`### 思考\n\n${entry.thinking}`);
    if (entry.text) parts.push(String(entry.text));
    if (entry.kind === 'tool') {
      const text = JSON.stringify(entry.tool || entry, null, 2), fence = fenceFor(text);
      parts.push(`${fence}json\n${text}\n${fence}`);
    }
  }
  return parts.filter(Boolean).join('\n\n') + '\n';
}
module.exports = { historyMarkdown };
