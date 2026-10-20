'use strict';

/** Assemble ACP blocks from user text and explicit context snapshots. Source
 * metadata identifies the captured body; it never requests a later file read.
 * Legacy resource links remain supported for existing external callers. */

/** 仅允许常规语言名进入代码围栏（避免异常字符破坏排版）。 */
const SAFE_LANGUAGE = /^[\w+#.-]{1,20}$/;

/**
 * 计算安全的围栏长度：比内容中最长的连续反引号再长一个字符。
 *
 * 不固定使用三个反引号的原因：选中的代码本身可能是 Markdown（其中包含 ```），
 * 三个反引号会被提前闭合，模型接收到的内容即出现错误。
 *
 * @param {string} text
 * @returns {string} 例如 "```"
 */
function fenceFor(text) {
  let longest = 0;
  for (const run of String(text).matchAll(/`+/g)) {
    if (run[0].length > longest) longest = run[0].length;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * 将一处选区转换为一段面向模型的文本。
 *
 * @param {object} item
 * @returns {string}
 */
function selectionText(item) {
  const where = item.sourcePath || item.name || item.uri || '（未知位置）';
  const fence = fenceFor(item.text);
  const language = SAFE_LANGUAGE.test(String(item.language || '')) ? item.language : '';
  return [
    `以下是在编辑器里选中的代码快照（${where}${item.startLine ? `，${item.startLine}–${item.endLine || item.startLine} 行` : ''}${snapshotDetail(item)}）：`,
    `${fence}${language}`,
    String(item.text),
    fence,
  ].join('\n');
}

function snapshotDetail(item) {
  const parts = [];
  if (item.isUntitled) parts.push('未保存文件');
  else if (item.isDirty === true) parts.push('含未保存修改');
  else if (item.isDirty === false) parts.push('加入时已保存');
  if (item.snapshotAt) parts.push(`快照时间 ${item.snapshotAt}`);
  return parts.length ? '，' + parts.join('，') : '';
}

/** 按明确的来源范围描述附加正文，不能将测试摘要或日志冒充完整文件。 */
function contentText(item) {
  if (item.scope === 'selection') return selectionText(item);
  const where = item.sourcePath || item.name || (item.scope === 'file' ? '（未命名文件）' : '（未知来源）');
  const content = String(item.text);
  const fence = fenceFor(content);
  const language = SAFE_LANGUAGE.test(String(item.language || '')) ? item.language : '';
  const description = item.scope === 'file' ? '完整文件正文快照' : item.scope === 'git-diff' ? 'Git 变更补丁快照' : item.scope === 'diagnostics' ? 'VS Code 问题诊断快照' : '附加正文快照';
  return [
    `以下是${description}（${where}${snapshotDetail(item)}）：`,
    `${fence}${language}`,
    content,
    fence,
  ].join('\n');
}

/**
 * 组装本次 `session/prompt` 发送的内容块。
 *
 * 顺序：先上下文、后用户输入 —— 使用户的问题紧随上下文之后，便于阅读。
 *
 * @param {string} text 用户输入的文字。
 * @param {Array<object>} [attachments] 编辑器上下文，数据结构见上方模块注释。
 * @returns {Array<object>} ACP 内容块数组。
 */
function buildPromptBlocks(text, attachments = []) {
  const blocks = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (!item || typeof item !== 'object') continue;
    const hasText = typeof item.text === 'string' && item.text.trim();
    const hasUri = typeof item.uri === 'string' && item.uri;
    if (item.kind === 'skill' && hasText) {
      blocks.push({ type: 'text', text: `用户显式选择使用以下技能（${item.name || '技能'}）。请按照技能正文处理本次请求。\n\n${item.text}\n\n` });
    }
    // 选区正文只要非空即携带 —— 正文是用户实际要提供的内容，
    // 位置信息为附加项（无法确定位置时记为「未知位置」）。
    if (item.kind === 'selection' && (hasText || item.snapshotAt && typeof item.text === 'string')) blocks.push({ type: 'text', text: selectionText(item) + '\n\n' });
    // 未保存/已修改文件必须使用编辑器快照；即使文件为空，也保留位置与空内容这一事实。
    if (item.kind === 'content' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: contentText(item) + '\n\n' });
    }
    // 审查报告只在显式发送附件时进入对话，保留其历史快照含义。
    if (item.kind === 'review' && hasText) {
      blocks.push({ type: 'text', text: `以下是已完成的代码审查报告。报告针对审查时的代码快照，后续修改需重新核对。\n${item.finishedAt ? `审查时间：${item.finishedAt}\n` : ''}\n${item.text}` });
    }
    // 选中代码时同时附带一条链接：需要更多上下文时模型可自行读取。
    if (hasUri && !item.snapshotAt && !['review', 'skill'].includes(item.kind)) {
      const link = { type: 'resource_link', name: item.name || item.uri, uri: item.uri };
      if (typeof item.mimeType === 'string' && item.mimeType) link.mimeType = item.mimeType;
      blocks.push(link);
    }
  }
  // 末尾始终补充一个 text 块。内核会按顺序将 text 与 resource_link 并成一段正文，
  // 输入为空时提供一句完整的话，可避免仅传入空字符串（从而不会出现"只有链接、
  // 没有一句话"的异常 prompt）。
  const trimmed = typeof text === 'string' ? text : '';
  blocks.push({ type: 'text', text: trimmed.trim() ? trimmed : '（参见上文带入的内容）' });
  return blocks;
}

module.exports = { buildPromptBlocks, selectionText, contentText, fenceFor };
