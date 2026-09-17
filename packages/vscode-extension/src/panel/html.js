'use strict';

/**
 * 生成 webview 的 HTML 骨架。
 *
 * 刻意不依赖 vscode：入参都是已经算好的 URI 字符串，
 * 这样这个函数可以在命令行里直接调用、把产物存下来看。
 *
 * 安全：严格的 CSP + nonce；不允许内联脚本、不允许外部资源。
 */

/** 生成一个一次性 nonce。 */
function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * @param {object} options
 * @param {string} options.cspSource webview.cspSource
 * @param {string} options.styleUri main.css 的 webview URI
 * @param {string} options.markdownUri markdown.js 的 webview URI
 * @param {string} options.scriptUri main.js 的 webview URI
 * @param {string} options.nonce
 * @returns {string} HTML
 */
function renderHtml({ cspSource, styleUri, markdownUri, scriptUri, nonce }) {
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>DSH Panel</title>
</head>
<body>
  <header class="bar">
    <div class="bar-row">
      <span id="status-dot" class="dot" aria-hidden="true"></span>
      <span id="status-text" class="status">正在连接…</span>
      <span class="spacer"></span>
      <span id="bar-cwd" class="bar-meta" hidden></span>
      <span id="bar-clock" class="bar-meta" hidden></span>
    </div>
    <div class="bar-row" id="config-row" hidden>
      <label class="field">
        <span class="field-label">模型</span>
        <select id="model-select" class="select"></select>
      </label>
      <label class="field" id="preset-field" hidden>
        <span class="field-label">模式</span>
        <select id="preset-select" class="select" title="agent preset：只能在新建对话时生效（内核不允许一段对话中途换）"></select>
      </label>
      <div class="meter" id="meter" hidden title="上下文用量">
        <div class="meter-track"><div class="meter-fill" id="meter-fill"></div></div>
        <span class="meter-text" id="meter-text"></span>
      </div>
    </div>
  </header>

  <main id="messages" class="messages" tabindex="0" aria-live="polite">
    <div class="empty" id="empty">
      <p class="empty-title">DSH Panel</p>
      <p class="empty-hint">直接提问即可。它用的是你正在运行的 DSH —— 同一份记忆、同一份会话记录、同一套工具。</p>
    </div>
  </main>

  <footer class="composer">
    <div class="attachments" id="attachments" hidden></div>
    <div class="composer-box">
      <textarea id="input" class="input" rows="1" placeholder="给 DSH 发条消息…（Enter 发送，Shift+Enter 换行）"></textarea>
      <button id="send" class="send" type="button" title="发送" aria-label="发送">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M2.2 7.3 13 2.2c.5-.2 1 .2.8.7l-5.1 10.8c-.2.5-1 .5-1.2 0L6 10.4a.8.8 0 0 0-.4-.4L2.2 8.5c-.5-.2-.5-1 0-1.2Z"/></svg>
      </button>
      <button id="stop" class="send stop" type="button" title="中断当前回合" aria-label="中断" hidden>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor"/></svg>
      </button>
    </div>
    <div class="composer-foot">
      <span id="hint" class="hint"></span>
      <span id="usage-inline" class="hint mono"></span>
    </div>
  </footer>

  <div id="permission" class="permission" hidden>
    <div class="permission-title" id="permission-title">DSH 需要你的许可</div>
    <div class="permission-body" id="permission-body"></div>
    <div class="permission-actions" id="permission-actions"></div>
  </div>

  <!-- markdown.js 必须在 main.js 之前：main.js 启动时就要用到它 -->
  <script nonce="${nonce}" src="${markdownUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { renderHtml, makeNonce };
