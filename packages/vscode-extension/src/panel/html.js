'use strict';

/**
 * 生成 webview 的 HTML 骨架。
 *
 * 有意不依赖 vscode：入参均为已计算完成的 URI 字符串，
 * 因此该函数可以在命令行中直接调用，并将产物保存后查看。
 *
 * 安全：使用严格的 CSP 与 nonce；不允许内联脚本，不允许外部资源。
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
      <button id="history-btn" class="icon-btn" type="button" title="历史会话" aria-label="历史会话" aria-expanded="false">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1.3A6.7 6.7 0 1 0 14.7 8 6.7 6.7 0 0 0 8 1.3Zm0 1.2A5.5 5.5 0 1 1 2.5 8 5.5 5.5 0 0 1 8 2.5ZM7.4 4.3v4l3.2 1.9.6-1-2.6-1.6V4.3Z"/></svg>
      </button>
    </div>
    <div class="bar-row" id="config-row" hidden>
      <label class="field" id="model-field">
        <span class="field-label">模型</span>
        <select id="model-select" class="select"></select>
      </label>
      <label class="field" id="preset-field" hidden>
        <span class="field-label">模式</span>
        <select id="preset-select" class="select" title="换模式需在新建对话时进行（会话进行中无法更换）"></select>
      </label>
      <div class="field" id="access-field" hidden>
        <span class="field-label">权限</span>
        <button id="access-btn" class="access-btn" type="button" aria-haspopup="dialog" aria-expanded="false"></button>
      </div>
      <div class="meter" id="meter" hidden title="上下文用量">
        <div class="meter-track"><div class="meter-fill" id="meter-fill"></div></div>
        <span class="meter-text" id="meter-text"></span>
      </div>
    </div>
  </header>

  <main id="messages" class="messages" tabindex="0" aria-live="polite">
    <div class="empty" id="empty">
      <p class="empty-title">DSH Panel</p>
      <p class="empty-hint">直接提问即可 —— DSH 会按需启动，不需要先启动桌面端。</p>
      <p class="empty-note">记忆与历史保留在本机；自启时使用已准备的 DSH 配置。</p>
    </div>
  </main>

  <!-- 历史会话浮层：覆盖整个面板；列表内容由 main.js 填充。
       role/aria-modal：该浮层覆盖其下方的全部内容（不仅是视觉层面），
       因此需告知读屏软件当前焦点仅位于该浮层内，避免其继续朗读下方的输入框。 -->
  <div id="history" class="history" role="dialog" aria-modal="true" aria-label="历史会话" hidden>
    <div class="history-head">
      <span class="history-title">历史会话</span>
      <span id="history-meta" class="history-meta"></span>
      <span class="spacer"></span>
      <button id="history-close" class="icon-btn" type="button" title="关闭" aria-label="关闭历史会话">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3.7 3 3 3.7 7.3 8 3 12.3l.7.7L8 8.7l4.3 4.3.7-.7L8.7 8 13 3.7l-.7-.7L8 7.3Z"/></svg>
      </button>
    </div>
    <div id="history-list" class="history-list"></div>
  </div>

  <footer class="composer">
    <div class="attachments" id="attachments" hidden></div>
    <div class="composer-box">
      <textarea id="input" class="input" rows="1" placeholder="向 DSH 发送消息…（Enter 发送，Shift+Enter 换行）"></textarea>
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

  <!-- 权限选择器：点击顶栏「权限」按钮后弹出的卡片。
       清单与当前值均由内核提供（dsh-door/permission/*，需要该插件 0.0.12 及以上版本），
       此处仅放置容器 —— 选项、说明与确认区域均由 main.js 渲染。 -->
  <div id="access-pop" class="access-pop" role="dialog" aria-label="选择权限" hidden>
    <div class="access-pop-head">
      <span class="access-pop-title">权限</span>
      <span id="access-pop-note" class="access-pop-note"></span>
    </div>
    <div id="access-list" class="access-list" role="listbox" aria-label="可选的权限"></div>
    <div id="access-confirm" class="access-confirm" hidden>
      <p id="access-confirm-title" class="access-confirm-title"></p>
      <p id="access-confirm-body" class="access-confirm-body"></p>
      <div class="access-confirm-actions">
        <button id="access-confirm-accept" class="access-confirm-accept" type="button"></button>
        <button id="access-confirm-cancel" class="access-confirm-cancel" type="button">取消</button>
      </div>
    </div>
  </div>

  <div id="permission" class="permission" hidden>
    <div class="permission-title" id="permission-title">DSH 需要授权</div>
    <div class="permission-body" id="permission-body"></div>
    <div class="permission-actions" id="permission-actions"></div>
  </div>

  <!-- markdown.js 必须位于 main.js 之前：main.js 启动时即会使用它 -->
  <script nonce="${nonce}" src="${markdownUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { renderHtml, makeNonce };
