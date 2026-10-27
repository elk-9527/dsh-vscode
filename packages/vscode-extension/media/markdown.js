/*
 * DSH Panel 的 Markdown 渲染器（纯函数，不涉及 DOM）。
 *
 * 拆分为独立文件的原因是可以**在 Node 中直接测试**：正确性、注入安全，以及渲染
 * 大段文本的实际耗时 —— 在无头浏览器中按帧计时受虚拟时钟影响，测得结果为
 * 0，会掩盖实际的性能问题。
 *
 * 安全模型：**先将整段文本转义，再执行语法替换**。因此模型输出的任何
 * HTML 标签都只会成为可见文字，不会被执行。唯一的「链接」出口
 * 仅放行 http/https 与工作区相对文件链接；打开文件前由扩展重新核对工作区边界。
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
    const restore = value => value.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
    const imageToken = (label, href) => {
      const fallback = /^https?:\/\//i.test(href) || !/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(href)
        ? `<a data-href="${href}" href="#">${label || '图片'}</a>` : label || '图片';
      tokens.push(`<span class="chat-image-request" data-image-source="${href}" data-image-alt="${label}">${fallback}</span>`);
      return `\u0000${tokens.length - 1}\u0000`;
    };
    // Pixels are resolved by the extension; model text never becomes an img URL.
    work = work.replace(/!\[([^\]\r\n]*)\]\((?:&lt;([^\r\n]+?)&gt;|([^\s()]+(?:\([^\s()]*\)[^\s()]*)*))\)/g, (match, label, angled, plain) => {
      const href = angled || plain;
      const local = !/^(?:[a-z][a-z\d+.-]*:|[/\\]{2}|[#?])/i.test(href) || /^[a-z]:[/\\]/i.test(href) || /^file:\/\/\//i.test(href);
      if ((!/^https?:\/\//i.test(href) && !local) || /[\u0000-\u001f]/.test(href)) return match;
      return imageToken(label, href);
    });
    work = work.replace(/\[([^\]]+)\]\(([^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/g, (match, label, href) => {
      const relative = !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(href) && !/[\u0000-\u0020\\]/.test(href);
      if (!/^https?:\/\//i.test(href) && !relative) return match;
      if (/\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(href)) return imageToken(label, href);
      // Protect links from emphasis parsing in URLs, and retain code in labels.
      const content = restore(emphasis(label));
      tokens.push(`<a data-href="${href}" href="#">${content}</a>`);
      return `\u0000${tokens.length - 1}\u0000`;
    });
    work = work.replace(/(^|\s)(https?:\/\/[^\s<>\u0000]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>\u0000]*)?)(?=$|\s)/gi,
      (_, prefix, href) => prefix + imageToken(href, href));
    return restore(emphasis(work));
  }

  function emphasis(text) {
    return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  /** Split cells without mistaking escaped pipes or inline code for columns. */
  function tableCells(line) {
    const text = line.trim(), cells = [];
    let cell = '', codeLength = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '\\' && text[index + 1] === '|') { cell += '|'; index++; continue; }
      if (character === '`') {
        let length = 1;
        while (text[index + length] === '`') length++;
        if (!codeLength) codeLength = length;
        else if (codeLength === length) codeLength = 0;
        cell += '`'.repeat(length); index += length - 1; continue;
      }
      if (character === '|' && !codeLength) { cells.push(cell.trim()); cell = ''; }
      else cell += character;
    }
    cells.push(cell.trim());
    if (text.startsWith('|') && cells[0] === '') cells.shift();
    if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  }

  function tableHeader(lines, index) {
    if (index + 1 >= lines.length || (!lines[index].includes('|') && !lines[index + 1].includes('|'))) return null;
    const header = tableCells(lines[index]), separator = tableCells(lines[index + 1]);
    // Bound padding work for malformed model output with thousands of columns.
    if (!header.length || header.length > 64 || header.length !== separator.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
    return { header, align: separator.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left') };
  }

  /**
   * 仅支持必要的一小组语法：代码块、行内代码、粗体、斜体、链接、
   * 标题、有序/无序列表、引用和管道表格。
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

      const table = tableHeader(lines, i);
      if (table) {
        const cellHtml = (cell, column, tag) => `<${tag}${tag === 'th' ? ' scope="col"' : ''} class="align-${table.align[column]}">${inline(cell)}</${tag}>`;
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|') && isParagraphLine(lines[i])) {
          const cells = tableCells(lines[i]);
          rows.push(`<tr>${table.header.map((_, column) => cellHtml(cells[column] || '', column, 'td')).join('')}</tr>`);
          i++;
        }
        out.push(`<div class="md-table-wrap" role="region" aria-label="表格" tabindex="0"><table><thead><tr>${table.header.map((cell, column) => cellHtml(cell, column, 'th')).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
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
      while (i < lines.length && isParagraphLine(lines[i]) && !tableHeader(lines, i)) {
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

  /** Commit only blank-line boundaries outside fences; the growing final block stays replaceable. */
  function createStreamingRenderer({ maxChars = 128 * 1024 } = {}) {
    let previous = '', committed = 0;
    return {
      render(input) {
        const text = String(input || '').replace(/\r\n?/g, '\n');
        if (text.length > maxChars) {
          previous = ''; committed = 0;
          return { reset: true, appendHtml: '', tailHtml: renderMarkdown(text) };
        }
        const reset = !text.startsWith(previous);
        if (reset) committed = 0;
        let end = committed, position = committed, fenced = false;
        while (position < text.length) {
          const newline = text.indexOf('\n', position);
          if (newline < 0) break;
          const line = text.slice(position, newline);
          if (fenced) { if (/^\s*```\s*$/.test(line)) fenced = false; }
          else if (/^\s*```([\w+-]*)\s*$/.test(line)) fenced = true;
          else if (!line.trim()) end = newline + 1;
          position = newline + 1;
        }
        const appendHtml = renderMarkdown(text.slice(committed, end));
        committed = end; previous = text;
        return { reset, appendHtml, tailHtml: renderMarkdown(text.slice(end)) };
      },
      clear() { previous = ''; committed = 0; },
    };
  }
  return { renderMarkdown, createStreamingRenderer, inline, escapeHtml };
});
