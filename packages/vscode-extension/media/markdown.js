/*
 * DSH Panel 的 Markdown 渲染器（纯函数，不涉及 DOM）。
 *
 * 拆分为独立文件的原因是可以**在 Node 中直接测试**：正确性、注入安全，以及渲染
 * 大段文本的实际耗时 —— 在无头浏览器中按帧计时受虚拟时钟影响，测得结果为
 * 0，会掩盖实际的性能问题。
 *
 * 安全模型：**先将整段文本转义，再执行语法替换**。因此模型输出的任何
 * HTML 标签都只会成为可见文字，不会被执行。唯一的「链接」出口
 * 也限制为 http/https。
 *
 * 用法（浏览器）：<script src="markdown.js"></script> → window.DshMarkdown
 * 用法（Node）：const { renderMarkdown } = require('./markdown.js')
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DshMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 行内语法。输入是**未转义**的原文，输出是转义后的 HTML。
   */
  function inline(text) {
    const tokens = [];
    // 先提取行内代码，避免其中的 `*` `_` 被识别为强调符号。
    let work = text.replace(/`([^`]+)`/g, (_, code) => {
      tokens.push(`<code>${escapeHtml(code)}</code>`);
      return `\u0000${tokens.length - 1}\u0000`;
    });
    work = escapeHtml(work);
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
      // 仅放行 http/https；javascript:、data: 之类的取值一律退化为纯文本。
      return `<a data-href="${href}" href="#">${label}</a>`;
    });
    work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    work = work.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
    return work;
  }

  /**
   * 仅支持必要的一小组语法：代码块、行内代码、粗体、斜体、链接、
   * 标题、有序/无序列表、引用。
   */
  function renderMarkdown(raw) {
    if (!raw) return '';
    const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块（未闭合时同样接收 —— 流式输出过程中代码不会反复闪烁）
      const fence = line.match(/^\s*```([\w+-]*)\s*$/);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length + 1, 6);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }

      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          i += 1;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
        continue;
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const para = [];
      while (i < lines.length && isParagraphLine(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      if (para.length === 0) {
        // 后备分支：执行到此处，说明该行既未被上面的分支处理，也不属于正常段落
        // （典型示例：以 ``` 开头但不构成合法围栏的行，例如模型输出残缺的代码块）。
        // 此处必须强制消费一行 —— 否则 i 永不前进，会形成死循环并耗尽内存，
        // 在 webview 中表现为整个面板冻结。该后备分支不是理论问题，而是已出现过的情况。
        para.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  /** 判断该行能否作为普通段落内容（块级语法的起始行均不计入）。 */
  function isParagraphLine(line) {
    if (!line.trim()) return false;
    if (/^\s*```/.test(line)) return false;
    if (/^(#{1,6})\s+/.test(line)) return false;
    if (/^\s*>\s?/.test(line)) return false;
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) return false;
    return true;
  }

  return { renderMarkdown, inline, escapeHtml };
});
