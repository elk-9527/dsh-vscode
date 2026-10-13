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
      <span id="status-text" class="status" role="status" aria-live="polite" aria-atomic="true">正在连接…</span>
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
        <select id="model-select" class="select" aria-label="模型"></select>
      </label>
      <label class="field" id="reasoning-field" hidden>
        <span class="field-label">思考</span>
        <select id="reasoning-select" class="select" aria-label="思考强度"></select>
      </label>
      <label class="field" id="preset-field" hidden>
        <span class="field-label">模式</span>
        <select id="preset-select" class="select" aria-label="模式" title="当前对话的模式；更换后用于新对话"></select>
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
    <div id="preset-note" class="context-bar" hidden>
      <span id="preset-note-text"></span>
      <button id="preset-new" type="button">用此模式新建对话</button>
    </div>
  </header>

  <div id="history-context" class="context-bar" role="status" hidden>
    <span id="history-context-text">正在查看历史，输入已暂停。</span>
    <button id="history-resume" type="button">继续此对话</button>
    <button id="history-back" type="button">返回当前对话</button>
  </div>

  <main id="messages" class="messages" tabindex="0" aria-live="polite">
    <section id="empty" class="onboarding" aria-label="项目与连接状态">
      <h1>从当前项目开始</h1>
      <p id="onboarding-project" class="onboarding-project">正在读取对话目录…</p>
      <p id="onboarding-stage" class="onboarding-stage" role="status" aria-live="polite" aria-atomic="true">正在连接 DSH…</p>
      <p id="onboarding-next" class="onboarding-next">连接完成后，可以描述任务，或先添加当前文件与选区。</p>
    </section>
  </main>

  <details id="workflow" class="workflow" hidden>
    <summary id="workflow-summary">本轮改动与测试</summary>
    <div class="workflow-body">
      <p id="workflow-note" class="hint"></p>
      <div id="workflow-files" class="workflow-files"></div>
      <div id="workflow-test" class="workflow-test" role="status" aria-live="polite"></div>
      <div class="workflow-actions"><button id="workflow-run-test" type="button">运行测试</button><button id="workflow-stop-test" type="button" hidden>停止测试</button><button id="workflow-view-test" type="button" hidden>查看此次结果</button><button id="workflow-attach-test" type="button" hidden>附加测试结果</button><button id="workflow-prepare-test" type="button" hidden>准备修复草稿</button><button id="workflow-log-test" type="button" hidden>补充日志</button><button id="workflow-terminal" type="button" hidden>打开任务终端视图</button></div>
    </div>
  </details>

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
    <div class="history-filters">
      <input id="history-search" type="search" placeholder="搜索标题、目录或会话 ID" aria-label="搜索历史会话" maxlength="256">
      <label><input id="history-project" type="checkbox">仅当前项目</label>
    </div>
    <div id="history-list" class="history-list"></div>
    <div class="history-pages">
      <button id="history-prev" type="button" disabled>上一页</button>
      <span id="history-page" aria-live="polite"></span>
      <button id="history-next" type="button" disabled>下一页</button>
    </div>
  </div>

  <footer class="composer">
    <section id="queue" class="queue" aria-label="待发送消息" hidden>
      <div class="queue-head"><span id="queue-summary" role="status"></span><button id="queue-continue" type="button" hidden>继续队列</button></div>
      <div id="queue-list" class="queue-list"></div>
    </section>
    <div id="composer-menu" class="composer-menu" hidden>
      <div id="composer-title" class="composer-title"></div>
      <div id="composer-options" class="composer-options" role="listbox" aria-label="文件与技能候选"></div>
      <div id="composer-note" class="composer-note" role="status" aria-live="polite"></div>
    </div>
    <div class="attachments" id="attachments" hidden></div>
    <div class="composer-box">
      <textarea id="input" class="input" rows="1" aria-label="消息输入" aria-autocomplete="list" aria-haspopup="listbox" aria-controls="composer-options" aria-expanded="false" placeholder="输入消息，@ 文件 · / 技能 · # 上下文"></textarea>
      <button id="send" class="send" type="button" title="发送" aria-label="发送">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M2.2 7.3 13 2.2c.5-.2 1 .2.8.7l-5.1 10.8c-.2.5-1 .5-1.2 0L6 10.4a.8.8 0 0 0-.4-.4L2.2 8.5c-.5-.2-.5-1 0-1.2Z"/></svg>
      </button>
      <button id="stop" class="send stop" type="button" title="停止当前任务并暂停队列（Esc）" aria-label="停止当前任务" hidden>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor"/></svg>
      </button>
    </div>
    <div class="composer-foot">
      <span id="hint" class="hint" role="status" aria-live="polite" aria-atomic="true"></span>
      <button id="recover-draft" type="button" hidden>恢复上次发送</button>
      <span id="usage-inline" class="hint mono"></span>
    </div>
    <div class="composer-shortcuts" aria-label="添加文件、技能或上下文">
      <button id="context-open" type="button" aria-haspopup="dialog" aria-expanded="false">＋ 添加上下文</button>
      <button type="button" data-context-add="file">当前文件</button>
      <button type="button" data-context-add="selection">当前选区</button>
      <button type="button" data-composer="/" title="执行命令或选择技能">/ 命令</button>
    </div>
  </footer>

  <div id="context-panel" class="context-panel" role="dialog" aria-modal="true" aria-label="添加上下文" hidden>
    <div class="context-head"><strong>添加上下文</strong><button id="context-close" type="button" aria-label="关闭添加上下文">关闭</button></div>
    <p class="context-help">附加加入时的正文快照，发送前可预览。DSH 也能按任务需要自主读取工作区。</p>
    <div class="context-actions">
      <button type="button" data-context-add="file">加入当前全文件</button><button type="button" data-context-add="selection">加入当前选区</button>
      <button type="button" data-context-source="search" aria-pressed="true">搜索文件</button><button type="button" data-context-source="skill" aria-pressed="false">选择技能</button>
    </div>
    <label for="context-search" id="context-search-label">搜索本次对话目录中的文件</label>
    <input id="context-search" type="search" maxlength="128" aria-controls="context-options" aria-autocomplete="list" placeholder="输入名称或路径">
    <div id="context-options" class="context-options" role="listbox" aria-label="上下文候选"></div>
    <p id="context-note" class="context-help" role="status" aria-live="polite"></p>
  </div>
  <div id="attachment-preview" class="attachment-preview" role="dialog" aria-modal="true" aria-label="附件正文预览" hidden>
    <div class="context-head"><strong id="preview-title">附件正文预览</strong><button id="preview-close" type="button">关闭预览</button></div>
    <dl id="preview-meta" class="preview-meta"></dl>
    <p id="preview-note" class="context-help"></p>
    <pre id="preview-body" tabindex="0" aria-label="只读附件快照正文"></pre>
  </div>
  <div id="test-log-panel" class="test-log-panel" role="dialog" aria-modal="true" aria-label="补充此次测试日志" hidden>
    <div class="context-head"><strong>补充此次测试日志</strong><button id="test-log-close" type="button">取消</button></div>
    <p class="context-help">从任务终端明确复制日志后粘贴。日志标记为用户提供，未自动核实属于此次执行；最多 128 KiB，控制字符会清理。</p>
    <label for="test-log-body">日志正文</label>
    <textarea id="test-log-body" maxlength="131072" spellcheck="false"></textarea>
    <p id="test-log-note" class="context-help" role="status"></p>
    <div class="context-actions"><button id="test-log-accept" type="button">保存并查看证据</button></div>
  </div>

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
