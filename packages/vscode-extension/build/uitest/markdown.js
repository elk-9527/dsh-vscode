/*
 * DSH Panel 的 Markdown 渲染器（纯函数，不碰 DOM）。
 *
 * 单独一个文件是为了能**在 Node 里直接测**：正确性、注入安全、以及渲染
 * 一大段文本的真实耗时 —— 在无头浏览器里按帧计时受虚拟时钟影响，量出来
 * 是 0，那样会掩盖真实的性能问题。
 *
 * 安全模型：**先把整段文本转义，再做语法替换**。所以模型输出的任何
 * HTML 标签都只会变成可见的文字，不可能被执行。唯一的「链接」出口
 * 也限制成 http/https。
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
    // 先把行内代码抠出来，免得里面的 `*` `_` 被当成强调符号。
    let work = text.replace(/`([^`]+)`/g, (_, code) => {
      tokens.push(`<code>${escapeHtml(code)}</code>`);
      return `\u0000${tokens.length - 1}\u0000`;
    });
    work = escapeHtml(work);
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
      // 只放行 http/https；javascript:、data: 之类一律退化成纯文本。
      return `<a data-href="${href}" href="#">${label}</a>`;
    });
    work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    work = work.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
    return work;
  }

  /**
   * 只支持够用的一小撮语法：代码块、行内代码、粗体、斜体、链接、
   * 标题、有序/无序列表、引用。
   */
  function renderMarkdown(raw) {
    if (!raw) return '';
    const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块（未闭合也照收 —— 流式输出时代码不会闪来闪去）
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
        // 兜底：能走到这里，说明这一行既没被上面的分支消费、也不算正常段落
        // （典型例子：以 ``` 开头但不是合法围栏的行，比如模型吐出残缺的代码块）。
        // 必须强行吃掉一行 —— 否则 i 永远不前进，会死循环把内存吃光，
        // 在 webview 里就是整个面板被冻死。这个兜底不是理论问题，是踩过的坑。
        para.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  /** 这一行能不能当普通段落内容（块级语法的开头都不算）。 */
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
