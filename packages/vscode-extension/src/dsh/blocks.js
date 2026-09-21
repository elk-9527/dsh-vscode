'use strict';

/**
 * 将「用户输入的文字 + 一并携带的编辑器上下文」组装为 ACP 的 prompt 内容块。
 *
 * 单独作为一个文件的原因：该模块为纯函数，可在数毫秒内完成全部测试（见 test/blocks.js），
 * 不需要编辑器，也不需要内核。
 *
 * 设计上有两项选择，均有依据：
 *
 * 1. **已落盘且没有未保存修改的当前文件使用 `resource_link`，不写入正文。** ACP 支持
 *    `{type:'resource_link', name, uri}`；内核（`dsh-acp` 的 `admitAcpPrompt`）
 *    会将其渲染为一行 `[resource_link name="…" uri="…"]` 并**并入正文文本**。
 *    这样 DSH 会**使用自身的工具读取**该文件 —— 不需要将整个文件写入上下文，
 *    大文件也不会导致上下文超限。未保存的新文件没有可读地址，已修改文件的磁盘版本
 *    又不是编辑器里的当前版本；这两种情况改为直接发送编辑器快照，避免模型读到空内容或旧内容。
 *    同时记录同一段源码中的事实，以免后续再次推测：
 *    - 可接受的块仅有 `text`、`resource_link`，以及 `image`（需要先在 initialize
 *      中声明相应能力，否则抛出 `inline image prompts were not advertised`）；
 *    - `audio` 与 `resource`（内嵌资源）被**明确拒绝**，
 *      分别抛出 `audio prompt content is not supported` /
 *      `embedded resource prompt content is not supported`，因此不可使用。
 *
 * 2. **选中的代码直接携带正文。** 选区通常很小，用户的意图通常也是
 *    「仅这几行」，直接给出正文最为准确；同时**也**附带 resource_link，
 *    使其在需要上下文时可以自行读取整个文件。两种信息同时提供，覆盖更完整。
 *
 * @module dsh-panel/blocks
 */

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
  const where = item.name || item.uri || '（未知位置）';
  const fence = fenceFor(item.text);
  const language = SAFE_LANGUAGE.test(String(item.language || '')) ? item.language : '';
  return [
    `以下是在编辑器里选中的代码（${where}）：`,
    `${fence}${language}`,
    String(item.text).replace(/\s+$/, ''),
    fence,
  ].join('\n');
}

/** 把未保存或已修改文件的编辑器快照转换为正文。 */
function contentText(item) {
  const where = item.name || '（未命名文件）';
  const content = String(item.text);
  const fence = fenceFor(content);
  const language = SAFE_LANGUAGE.test(String(item.language || '')) ? item.language : '';
  return [
    `以下是编辑器中的当前文件内容（${where}，可能尚未保存）：`,
    `${fence}${language}`,
    content.replace(/\s+$/, ''),
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
    // 选区正文只要非空即携带 —— 正文是用户实际要提供的内容，
    // 位置信息为附加项（无法确定位置时记为「未知位置」）。
    if (item.kind === 'selection' && hasText) blocks.push({ type: 'text', text: selectionText(item) });
    // 未保存/已修改文件必须使用编辑器快照；即使文件为空，也保留位置与空内容这一事实。
    if (item.kind === 'content' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: contentText(item) });
    }
    // 选中代码时同时附带一条链接：需要更多上下文时模型可自行读取。
    if (hasUri) {
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
