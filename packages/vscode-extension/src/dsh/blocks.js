'use strict';

/**
 * 把「用户打的字 + 一起带上的编辑器上下文」拼成 ACP 的 prompt 内容块。
 *
 * 为什么单独一个文件：这是纯函数，几毫秒就能全测（见 test/blocks.js），
 * 不需要编辑器、不需要内核。
 *
 * 设计上的两个选择，都是有依据的：
 *
 * 1. **当前文件用 `resource_link`，不塞正文。** ACP 支持
 *    `{type:'resource_link', name, uri}`；内核（`dsh-acp` 的 `admitAcpPrompt`）
 *    会把它渲染成一行 `[resource_link name="…" uri="…"]` 并**并进正文文本**。
 *    这样 DSH 会**用它自己的工具去读**那个文件 —— 不必把整份文件塞进上下文，
 *    大文件也不会炸；而且读到的永远是最新内容。
 *    顺带记下同一段源码里的事实，免得以后再猜：
 *    - 接受的块只有 `text`、`resource_link`，以及 `image`（要先在 initialize
 *      里声明过能力，否则抛 `inline image prompts were not advertised`）；
 *    - `audio` 和 `resource`（内嵌资源）是**明确拒绝**的，
 *      分别抛 `audio prompt content is not supported` /
 *      `embedded resource prompt content is not supported`，所以不能用。
 *
 * 2. **选中的代码直接把正文带过去。** 选区通常很小，用户的意思也往往就是
 *    「就这几行」，直接给正文最准；同时**也**附上 resource_link，
 *    让它需要上下文时可以自己读整个文件。两样都给，比二选一稳。
 *
 * @module dsh-panel/blocks
 */

/** 只允许正常的语言名进代码围栏（免得奇怪的字符破坏排版）。 */
const SAFE_LANGUAGE = /^[\w+#.-]{1,20}$/;

/**
 * 算一个安全的围栏长度：比内容里最长的一串反引号再长一个。
 *
 * 为什么不固定用三个：选中的代码本身可能是 Markdown（里面就有 ``` ），
 * 三个反引号会被提前闭合，模型看到的内容就乱了。
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
 * 把一处选区写成一段给模型看的话。
 *
 * @param {object} item
 * @returns {string}
 */
function selectionText(item) {
  const where = item.name || item.uri || '（未知位置）';
  const fence = fenceFor(item.text);
  const language = SAFE_LANGUAGE.test(String(item.language || '')) ? item.language : '';
  return [
    `下面是我在编辑器里选中的代码（${where}）：`,
    `${fence}${language}`,
    String(item.text).replace(/\s+$/, ''),
    fence,
  ].join('\n');
}

/**
 * 拼出这次 `session/prompt` 要发的内容块。
 *
 * 顺序：先上下文、后用户的话 —— 这样用户的问题紧跟在上下文后面，读起来自然。
 *
 * @param {string} text 用户输入的文字。
 * @param {Array<object>} [attachments] 编辑器上下文，形状见上面模块注释。
 * @returns {Array<object>} ACP 内容块数组。
 */
function buildPromptBlocks(text, attachments = []) {
  const blocks = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (!item || typeof item !== 'object') continue;
    const hasText = typeof item.text === 'string' && item.text.trim();
    const hasUri = typeof item.uri === 'string' && item.uri;
    // 选区的正文只要非空就带上 —— 正文才是用户真正想给的东西，
    // 位置只是锦上添花（写不出位置就写「未知位置」）。
    if (item.kind === 'selection' && hasText) blocks.push({ type: 'text', text: selectionText(item) });
    // 选了代码也给一条链接：需要更多上下文时它自己能去读。
    if (hasUri) {
      const link = { type: 'resource_link', name: item.name || item.uri, uri: item.uri };
      if (typeof item.mimeType === 'string' && item.mimeType) link.mimeType = item.mimeType;
      blocks.push(link);
    }
  }
  // 最后始终补一个 text 块。内核会把 text 与 resource_link 按顺序并成一段正文，
  // 空输入时给一句自然的话，比丢一个空字符串过去稳（也就不会出现"只有链接、
  // 没有一句话"的怪 prompt）。
  const trimmed = typeof text === 'string' ? text : '';
  blocks.push({ type: 'text', text: trimmed.trim() ? trimmed : '（看上面带进来的内容）' });
  return blocks;
}

module.exports = { buildPromptBlocks, selectionText, fenceFor };
