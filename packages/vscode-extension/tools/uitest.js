'use strict';

/**
 * 界面层自动化测试：在**真实浏览器**中执行断言。
 *
 * 采用该方式的原因：VS Code 的 webview 无法自动打开并截图，而同一套
 * HTML/CSS/JS 可以传入无头 Chrome，在页面内执行断言并取回结果。
 * 因此可覆盖人工检查容易遗漏、但必然出现的问题：
 *   - 横向溢出、元素重叠、输入框被挤出屏幕；
 *   - Markdown 是否渲染为真实结构（代码块/列表/粗体/引用）；
 *   - 工具卡片是否正确合并（而非每帧新增一张卡片）；
 *   - 文字对比度是否低于可辨识阈值；
 *   - 点击工具卡片是否可折叠、Enter 是否发送、Shift+Enter 是否误发；
 *   - 渲染一屏 Markdown 所需的毫秒数（防止出现 O(n²) 复杂度的实现）。
 *
 * 用法：node tools/uitest.js [场景名]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { SCENARIOS, buildHtml, buildReplayScript, OUT, ROOT } = require('./preview');
const { findChrome, missingChromeMessage } = require('./chrome.cjs');

const CHROME = findChrome();
const WORK = process.env.DSH_PANEL_UI_WORK ? path.resolve(process.env.DSH_PANEL_UI_WORK) : path.resolve(ROOT, '../../build/uitest');
const CHROME_TIMEOUT_MS = 45000;
const TEST_SCENARIOS = {
  ...SCENARIOS,
  usability() { return SCENARIOS.composer(); },
  testrepair() { return SCENARIOS.composer(); },
  controls() { return SCENARIOS.composer(); },
  lifecycle() { return SCENARIOS.composer(); },
};

/** 每个场景特有的额外期望。 */
const EXPECTATIONS = {
  lifecycle: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, lifecycleScene: true },
  controls: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, controlsScene: true },
  testrepair: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, testRepairScene: true },
  usability: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, usabilityScene: true },
  composer: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, composerScene: true },
  drafts: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, draftScene: true },
  // 未发送任何内容：所有「按需出现」的控件均需保持隐藏状态。
  bare: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, emptyChrome: true, minAssistantChars: 0 },
  empty: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0 },
  chat: { needsUser: true, needsAssistant: true, needsTools: 2, needsCaret: false, needsPermission: false, minAssistantChars: 300 },
  streaming: { needsUser: true, needsAssistant: true, needsTools: 1, needsCaret: true, needsPermission: false, minAssistantChars: 10 },
  // 权限场景中回合尚未结束（等待用户点选许可），因此光标仍然存在。
  permission: { needsUser: true, needsAssistant: true, needsTools: 0, needsCaret: true, needsPermission: true, needsOptions: 3, minAssistantChars: 5 },
  // 带编辑器上下文：输入框上方应有两块，已发送的消息中也应有两块。
  context: { needsUser: true, needsAssistant: true, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 10, needsAttachments: 2 },
  // 压力场景：正文由断言脚本自行注入（需要计时），因此此处不要求已有正文与光标。
  perf: { needsUser: true, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, perf: true },
  // 内核报错：可读说明在前，内核原文在后。本场景只有一条用户消息与一个错误块。
  error: { needsUser: true, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, errorShape: true },
  // 历史会话：浮层、清单、回放、接回 —— 均由断言脚本现场注入（见该场景的说明）。
  history: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, historyScene: true },
  // 权限选择器：清单由扩展（内核）提供，界面只负责渲染与点击 —— 点击动作全部在断言脚本中执行。
  access: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, accessScene: true },
};

/**
 * 注入页面的断言脚本。
 *
 * 所有输出都写入 document.title 和一个 <pre id="__results">，
 * 同时转义非 ASCII 字符 —— 即使中间经过 PowerShell 管道，
 * 也不会因编码问题使中文变为乱码。
 */
function assertionsScript(scene) {
  const expect = EXPECTATIONS[scene] || {};
  return `<script>
(function () {
  var EXPECT = ${JSON.stringify(expect)};
  var results = [];
  function assert(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  }

  // ── 辅助函数：颜色对比度 ──────────────────────────────
  function luminance(color) {
    var m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(color || '');
    if (!m) return null;
    var ch = [Number(m[1]), Number(m[2]), Number(m[3])].map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function bgOf(node) {
    var current = node;
    while (current && current.nodeType === 1) {
      var bg = getComputedStyle(current).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\\(0,\\s*0,\\s*0,\\s*0\\)/.test(bg)) return bg;
      current = current.parentElement;
    }
    return 'rgb(255, 255, 255)';
  }
  function contrastOf(node) {
    var a = luminance(getComputedStyle(node).color);
    var b = luminance(bgOf(node));
    if (a === null || b === null) return null;
    var hi = Math.max(a, b);
    var lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  function visible(node) {
    if (!node) return false;
    var rect = node.getBoundingClientRect();
    var style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  async function run() {
    var body = document.body;
    var viewportWidth = window.innerWidth;

    // ── 1. 页面结构 ──────────────────────────────────────
    assert('页面渲染出高度', body.getBoundingClientRect().height > 200, body.getBoundingClientRect().height);

    // ── 1.5 需隐藏的控件确实隐藏 ─────────────────────────
    // CSS 陷阱：元素一旦被作者样式设为 display:flex，浏览器默认的
    // [hidden] { display: none } 即被覆盖 —— hidden 属性不再生效。
    // 因此此处测量的是「实际不可见」，而不是仅检查该属性。
    var permissionBox = document.getElementById('permission');
    var configRow = document.getElementById('config-row');
    var presetField = document.getElementById('preset-field');
    var meter = document.getElementById('meter');
    var modelCount = document.querySelectorAll('#model-select option').length;
    var presetCount = document.querySelectorAll('#preset-select option').length;
    var meterText = (document.getElementById('meter-text').textContent || '').trim();

    assert('配置行只在有东西可调时才显示', visible(configRow) === (modelCount > 0 || presetCount > 0),
      'visible=' + visible(configRow) + ' model=' + modelCount + ' preset=' + presetCount);
    assert('模式下拉只在该插件返回清单时才显示', visible(presetField) === (presetCount > 0),
      'visible=' + visible(presetField) + ' preset=' + presetCount);
    assert('用量条只在有数据时才显示', visible(meter) === (meterText.length > 0),
      'visible=' + visible(meter) + ' text=' + meterText);
    // 附件块同为 flex 容器，存在同一问题 —— 此处一并测量。
    var attachmentBox = document.getElementById('attachments');
    var chipCount = document.querySelectorAll('#attachments .chip').length;
    assert('输入框上方的附件块：有附件时才显示',
      visible(attachmentBox) === (chipCount > 0),
      'visible=' + visible(attachmentBox) + ' 附件=' + chipCount);
    if (!EXPECT.needsPermission) {
      assert('权限区默认隐藏', !visible(permissionBox));
    }
    if (EXPECT.emptyChrome) {
      assert('没连上时头部不该挂空控件',
        !visible(configRow) && !visible(presetField) && !visible(meter) && !visible(permissionBox) && !visible(attachmentBox),
        'config=' + visible(configRow) + ' preset=' + visible(presetField) + ' meter=' + visible(meter) + ' permission=' + visible(permissionBox) + ' attachments=' + visible(attachmentBox));
    }
    if (presetCount > 0) {
      var presetSelect = document.getElementById('preset-select');
      assert('模式下拉显示中文名', presetSelect.options[0].textContent.indexOf('模式') >= 0, presetSelect.options[0].textContent);
      assert('模式下拉选中当前生效的那个', presetSelect.value === 'standard', presetSelect.value);
      assert('模式选项带说明', (presetSelect.options[0].title || '').length > 0);
      assert('模式下拉没有横向溢出', presetSelect.scrollWidth <= presetSelect.clientWidth + 2,
        presetSelect.scrollWidth + '>' + presetSelect.clientWidth);
    }

    // ── 1.6 顶栏配置行的宽度分配 ─────────────────────
    // 起因是三个格子均使用「flex: 1 1 auto」（基准取内容宽度），模型那个 <select>
    // 的基准为其最长选项，因此它占满整行、另两个被压到 40~60px 并截断文字。
    // 现在按 7:6:6 分配并各自设有下限 —— 这几条断言即用于固定该行为。
    // 仅在三个控件均存在的场景（access）中测量，其他场景不具备条件。
    if (EXPECT.accessScene) {
      var modelField = document.getElementById('model-field');
      var presetFieldEl = document.getElementById('preset-field');
      var accessFieldEl = document.getElementById('access-field');
      var accessBtn = document.getElementById('access-btn');
      var widths = {
        model: Math.round(modelField.getBoundingClientRect().width),
        preset: Math.round(presetFieldEl.getBoundingClientRect().width),
        access: Math.round(accessFieldEl.getBoundingClientRect().width),
      };
      var detail = '模型 ' + widths.model + ' / 模式 ' + widths.preset + ' / 权限 ' + widths.access;
      assert('三个控件都分到了足够的宽度（各 ≥100px）',
        widths.model >= 100 && widths.preset >= 100 && widths.access >= 100, detail);
      // 针对「模型的占地有点大」的反向约束：它是最宽的一项，但**不得**显著超出其他项。
      assert('模型那一格没有把整行吃满（不超过模式那格的 1.4 倍）',
        widths.model <= widths.preset * 1.4, detail);
      assert('模式下拉里的字没被切掉',
        presetSelect.scrollWidth <= presetSelect.clientWidth + 2,
        presetSelect.scrollWidth + '>' + presetSelect.clientWidth);
      assert('权限按钮里的字没被切掉（"工作区内修改"要能整个显示）',
        accessBtn.scrollWidth <= accessBtn.clientWidth + 2,
        accessBtn.scrollWidth + '>' + accessBtn.clientWidth + ' 宽 ' + widths.access);
      assert('权限那一格的宽度够放标签 + 值', widths.access >= 108, widths.access);
      // 用量条是第四个元素：空间不足时应当**换行**，而不是压缩前三个控件。
      var usageVisible = meterText.length > 0;
      assert('配置行没有横向溢出（挤不下就换行，不许撑破面板）',
        configRow.scrollWidth <= configRow.clientWidth + 2,
        configRow.scrollWidth + '>' + configRow.clientWidth);
      if (usageVisible) {
        var meterTop = Math.round(meter.getBoundingClientRect().top);
        var accessTop = Math.round(accessFieldEl.getBoundingClientRect().top);
        // 两种情形均判为合格：它自行换到第二行，或与控件同行且控件仍然足够宽。
        assert('用量条没把三个控件挤扁（要么换行，要么控件还是宽的）',
          meterTop > accessTop || widths.access >= 116,
          'meter.top=' + meterTop + ' access.top=' + accessTop + ' access 宽 ' + widths.access);
      }
    }

    // ── 2. 消息 ──────────────────────────────────────
    var users = document.querySelectorAll('.msg-user .bubble');
    var assistants = document.querySelectorAll('.msg-assistant .body');
    if (EXPECT.needsUser) {
      assert('有用户气泡', users.length === 1, users.length + ' 个');
      var bubble = users[0];
      if (bubble) {
        assert('用户气泡有文字', bubble.textContent.trim().length > 0);
        assert(
          '用户气泡靠右',
          Math.abs(bubble.parentElement.getBoundingClientRect().right - bubble.getBoundingClientRect().right) < 8,
          'right=' + Math.round(bubble.getBoundingClientRect().right),
        );
      }
    }
    if (EXPECT.needsAssistant) {
      var body0 = assistants[0];
      var minChars = EXPECT.minAssistantChars || 1;
      assert(
        '有助手正文',
        assistants.length >= 1 && body0.textContent.trim().length >= minChars,
        (body0 ? body0.textContent.length : 0) + ' 字，要求 >= ' + minChars,
      );
      var hasMarkdown = EXPECT.needsTools >= 2; // 仅 chat 场景包含完整 Markdown
      if (hasMarkdown) {
        assert('代码块渲染成 pre>code', document.querySelectorAll('.body pre code').length >= 1);
        assert('粗体渲染成 strong', document.querySelectorAll('.body strong').length >= 1);
        assert('有序列表渲染成 ol>li', document.querySelectorAll('.body ol li').length >= 3);
        assert('引用渲染成 blockquote', document.querySelectorAll('.body blockquote').length >= 1);
        assert('行内代码渲染成 code', document.querySelectorAll('.body p code').length >= 1);
        assert('没有未转义的 Markdown 星号', body0.textContent.indexOf('**') === -1, body0.textContent.slice(0, 60));
      }
      assert('思考块可折叠', document.querySelectorAll('details.thinking').length >= 1);
      var summary = document.querySelector('details.thinking > summary');
      assert('思考块标题正常', summary && summary.textContent.trim().length > 0, summary ? summary.textContent : '无');
    }

    // ── 3. 工具卡片 ──────────────────────────────────
    var cards = document.querySelectorAll('.tool');
    if (EXPECT.needsTools !== undefined) {
      assert('工具卡片数量正确（重复帧没有长出多余卡片）', cards.length === EXPECT.needsTools, cards.length + ' 张，期望 ' + EXPECT.needsTools);
    }
    if (cards.length > 0) {
      var card = cards[0];
      assert('工具卡片有名字', (card.querySelector('.tool-name').textContent || '').trim().length > 0);
      assert('工具卡片有状态', (card.querySelector('.tool-status').textContent || '').trim().length > 0);
      var head = card.querySelector('.tool-head');
      assert('工具卡片默认折叠', !card.classList.contains('open'));
      head.click();
      assert('点卡片能展开', card.classList.contains('open'));
      head.click();
      assert('再点一下能收起来', !card.classList.contains('open'));
    }

    // ── 4. 流式光标 ──────────────────────────────────
    if (EXPECT.needsCaret) {
      assert('流式中显示光标', document.querySelectorAll('.body .caret').length >= 1);
    } else if (EXPECT.needsAssistant) {
      assert('回合结束后光标消失', document.querySelectorAll('.body .caret').length === 0);
    }

    // ── 5. 权限询问 ──────────────────────────────────
    if (EXPECT.needsPermission) {
      var permission = document.getElementById('permission');
      assert('权限区可见', visible(permission));
      var buttons = permission.querySelectorAll('button');
      assert('权限选项数量正确', buttons.length === (EXPECT.needsOptions || 3), buttons.length + ' 个');
      assert('权限区有工具描述', permission.querySelector('#permission-body').textContent.trim().length > 0);

      // 停止回合、断线或面板侧取消队列时会发 permissionClear。这里在真实浏览器中
      // 验证它不只是改 hidden 属性，还会移除旧按钮，避免迟到点击回答上一轮请求。
      window.postMessage({ type: 'permissionClear' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      assert('取消权限请求后弹窗立即隐藏', !visible(permission));
      assert('取消权限请求后旧按钮已移除', permission.querySelectorAll('button').length === 0);

      // 清理后仍须能显示队列中的下一项；恢复三按钮也让场景截图保持原有内容。
      window.postMessage({
        type: 'permission',
        requestId: 8,
        params: {
          toolCall: { title: '执行命令：Remove-Item -Recurse build', rawInput: { command: 'Remove-Item -Recurse -Force build' } },
          options: [
            { optionId: 'allow_once', name: '允许这一次' },
            { optionId: 'allow_always', name: '以后都允许' },
            { optionId: 'reject_once', name: '拒绝' },
          ],
        },
      }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      assert('清理后可以正常显示下一项权限请求',
        visible(permission) && permission.querySelectorAll('button').length === 3);
    }

    // ── 6. 溢出与重叠 ────────────────────────────────
    assert('页面没有横向滚动条', document.documentElement.scrollWidth <= viewportWidth + 1, document.documentElement.scrollWidth + ' > ' + viewportWidth);
    var overflowing = [];
    ['.messages', '.tool', '.body pre', '.permission', '.composer-box'].forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (node) {
        if (node.scrollWidth > node.clientWidth + 2 && getComputedStyle(node).overflowX !== 'auto') {
          overflowing.push(selector + '(' + node.scrollWidth + '>' + node.clientWidth + ')');
        }
      });
    });
    assert('块级元素没有横向溢出', overflowing.length === 0, overflowing.join(', '));

    var messages = document.getElementById('messages');
    var composer = document.querySelector('.composer');
    var mRect = messages.getBoundingClientRect();
    var cRect = composer.getBoundingClientRect();
    assert('输入区在视口内', cRect.bottom <= window.innerHeight + 1, Math.round(cRect.bottom) + ' vs ' + window.innerHeight);
    assert('消息区与输入区不重叠', mRect.bottom <= cRect.top + 1, Math.round(mRect.bottom) + ' vs ' + Math.round(cRect.top));
    assert('消息区有可用高度', mRect.height > 100, Math.round(mRect.height));

    // ── 7. 对比度（仅低于阈值时判为失败，其余只记录数值）──
    var ratios = {};
    var assistantBody = document.querySelector('.msg-assistant .body');
    if (assistantBody) ratios['正文'] = contrastOf(assistantBody);
    var statusNode = document.getElementById('status-text');
    if (statusNode) ratios['状态行'] = contrastOf(statusNode);
    var toolStatus = document.querySelector('.tool-status');
    if (toolStatus) ratios['工具状态'] = contrastOf(toolStatus);
    for (var key in ratios) {
      var value = ratios[key];
      assert('对比度可读：' + key, value === null || value >= 2.5, value === null ? '算不出来' : value.toFixed(2) + ':1');
    }

    // ── 7.5 编辑器上下文（附件块）─────────────────────
    // 本段仅在带上下文的场景中执行：挂载后是否可见、点击 × 是否可移除、
    // 发送时是否携带、发送后是否清空、「已发送的那条消息」回看时是否仍可识别。
    if (EXPECT.needsAttachments) {
      var chips = document.querySelectorAll('#attachments .chip');
      assert('挂上的上下文都显示出来了', chips.length === EXPECT.needsAttachments,
        '有 ' + chips.length + ' 块，期望 ' + EXPECT.needsAttachments);

      var labels = Array.prototype.map.call(chips, function (chip) {
        return (chip.querySelector('.chip-label') || {}).textContent || '';
      });
      assert('文件那块写的是相对路径', labels.indexOf('src/panel/view.js') >= 0, labels.join(' | '));
      assert('选区那块也写清了是哪个文件', labels.indexOf('src/panel/html.js') >= 0, labels.join(' | '));

      var details = Array.prototype.map.call(chips, function (chip) {
        return (chip.querySelector('.chip-detail') || {}).textContent || '';
      });
      assert('文件那块标了「当前文件」', details.indexOf('当前文件') >= 0, details.join(' | '));
      assert('选区那块标了选了几行', details.some(function (d) { return d.indexOf('选中') >= 0; }), details.join(' | '));
      assert('选区那块和文件那块外观可区分（各有自己的类）',
        !!document.querySelector('#attachments .chip-sel') && !!document.querySelector('#attachments .chip-file'));

      // 再次挂载同一个文件时应刷新原项。未保存内容是挂载瞬间的快照，若这里只去重不替换，
      // 用户修改后重挂仍会把旧正文发给模型。
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'attach',
        items: [{
          kind: 'content', id: 'src/panel/view.js', name: 'src/panel/view.js',
          text: 'const refreshed = true;', detail: '当前文件（含未保存修改）'
        }]
      } }));
      chips = document.querySelectorAll('#attachments .chip');
      assert('重复挂载同一文件会刷新而不是新增一块', chips.length === EXPECT.needsAttachments, chips.length);
      details = Array.prototype.map.call(chips, function (chip) {
        return (chip.querySelector('.chip-detail') || {}).textContent || '';
      });
      assert('刷新后附件标签反映最新状态', details.some(function (d) { return d.indexOf('未保存修改') >= 0; }), details.join(' | '));
      assert('刷新已有附件时提示的是刚刷新的文件',
        document.getElementById('hint').textContent.includes('更新快照') && document.getElementById('hint').textContent.includes('src/panel/view.js'),
        document.getElementById('hint').textContent);

      // 每个已挂载的小块都需要可移除 —— 并且是就地移除，无需等待扩展回话。
      var closes = document.querySelectorAll('#attachments .chip-close');
      assert('每一块都有移除按钮', closes.length === chips.length, closes.length + ' vs ' + chips.length);
      var widthBefore = attachmentBox.getBoundingClientRect().width;
      closes[0].click();
      var after = document.querySelectorAll('#attachments .chip').length;
      assert('点击 × 可移除一块', after === chips.length - 1, '剩 ' + after);
      assert('移除一块后其余部分不受影响', after > 0);
      assert('移除一块后附件块仍显示（其中仍有内容）', visible(attachmentBox));
      assert('附件块没有横向溢出', attachmentBox.scrollWidth <= attachmentBox.clientWidth + 2,
        attachmentBox.scrollWidth + ' > ' + attachmentBox.clientWidth + '（宽度 ' + widthBefore + '）');

      // 发送：附件必须随消息一并发出。
      // 注意此处自行获取 DOM，不使用第 8 段的那两个变量 —— var 会提升，
      // 在本段仍为 undefined（曾出现该问题，整个断言脚本会静默不执行）。
      var ctxInput = document.getElementById('input');
      var ctxSend = document.getElementById('send');
      window.__received.length = 0;
      ctxInput.value = '这两个文件的作用是什么？';
      ctxInput.dispatchEvent(new Event('input', { bubbles: true }));
      ctxSend.click();
      var withAttach = window.__received.filter(function (m) { return m.type === 'send'; });
      assert('带附件时同样可发送', withAttach.length === 1, JSON.stringify(withAttach));
      if (withAttach.length === 1) {
        var carried = withAttach[0].attachments || [];
        assert('附件随消息一并发出', carried.length === 1, JSON.stringify(carried));
        assert('发出的是未被移除的那一块', carried[0] && carried[0].kind === 'selection', JSON.stringify(carried));
        assert('发走的附件带着正文（选区的内容不能丢）', carried[0] && carried[0].text === '<footer class="composer">',
          JSON.stringify(carried[0] && carried[0].text));
      }
      assert('接收确认前附件仍保留', document.querySelectorAll('#attachments .chip').length === 1);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: withAttach[0] && withAttach[0].requestId, success: true } }));
      assert('接收确认后已附加的附件已清空', document.querySelectorAll('#attachments .chip').length === 0);
      assert('清空后附件块已隐藏', !visible(attachmentBox));

      // 回看对话记录：那条用户消息应当仍能看出当时携带的内容。
      var bubbleChips = document.querySelectorAll('.msg-user .bubble .chip');
      assert('已发送的消息中附件仍可见', bubbleChips.length === EXPECT.needsAttachments,
        '有 ' + bubbleChips.length + ' 块');
      assert('历史消息中的附件不带移除按钮（已发送）',
        document.querySelectorAll('.msg-user .bubble .chip-close').length === 0);
      var reportAttachment = { kind: 'review', id: 'review:fixture', name: '代码审查报告', detail: '1 条发现', text: '# 代码审查\\n\\n报告正文标记' };
      window.__received.length = 0;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'busy', busy: false } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'attach', items: [reportAttachment] } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'attach', items: [reportAttachment] } }));
      assert('报告附加不自动发送', window.__received.filter(function (m) { return m.type === 'send'; }).length === 0);
      assert('同一报告只保留一个附件', document.querySelectorAll('#attachments .chip').length === 1);
      var reportChip = document.querySelector('#attachments .chip');
      assert('报告正文可从附件提示查看', reportChip && reportChip.title.indexOf('报告正文标记') >= 0);
      document.querySelector('#attachments .chip-close').click();
      assert('报告可在发送前移除', document.querySelectorAll('#attachments .chip').length === 0 && !visible(attachmentBox));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'attach', items: [reportAttachment] } }));
      ctxInput.value = '解释报告'; ctxSend.click();
      var reportSends = window.__received.filter(function (m) { return m.type === 'send'; });
      assert('显式发送才携带完整报告', reportSends.length === 1 && reportSends[0].attachments[0].text === reportAttachment.text);
      assert('接收报告前附件保留', document.querySelectorAll('#attachments .chip').length === 1);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: reportSends[0] && reportSends[0].requestId, success: true } }));
      assert('接收报告后附件清空', document.querySelectorAll('#attachments .chip').length === 0);
    }

    // ── 7.6 压力：几百个流式增量的耗时 ────────────────
    // 测量的是「注入耗时」与「渲染落定后 DOM 是否失控」。
    // 注意两点（均在出现问题后才确认）：
    // 1. 渲染是攒批的（rAF + 定时后备），因此注入完成后必须**让出事件循环**再测量，
    //    同步等待会永久阻塞 rAF；
    // 2. 阈值设置很宽松（真实值几百毫秒），仅拦截数量级的回归 —— 例如将
    //    渲染改为「每个增量都重渲染整棵树」。
    if (EXPECT.lifecycleScene) {
      var receiveLife = function (message) { window.dispatchEvent(new MessageEvent('message', { data: message })); };
      var settleLife = function () { return new Promise(function (resolve) { setTimeout(resolve, 160); }); };
      for (var orderLife of [['thinking', 'text'], ['text', 'thinking']]) {
        receiveLife({ type: 'reset' });
        for (var typeLife of orderLife) receiveLife({ type: typeLife, id: 'mixed', delta: typeLife === 'text' ? '正文尾部' : '思考尾部' });
        await settleLife();
        assert('同帧 ' + orderLife.join(' → ') + ' 两部分都刷新', document.querySelector('.think-body').textContent === '思考尾部' && document.querySelector('.msg-assistant .body').textContent.indexOf('正文尾部') >= 0);
      }
      for (var statusLife of ['completed', 'cancelled', 'error']) {
        receiveLife({ type: 'reset' });
        receiveLife({ type: 'text', id: 'end', delta: '正文结束' });
        receiveLife({ type: 'thinking', id: 'end', delta: '思考结束' });
        receiveLife({ type: 'done', id: 'end', status: statusLife });
        assert(statusLife + ' 同帧终态立即刷新思考与正文', document.querySelector('.think-body').textContent === '思考结束' && document.querySelector('.msg-assistant .body').textContent === '正文结束' && !document.querySelector('.caret'));
        await settleLife();
        assert(statusLife + ' 后备刷新不恢复光标', !document.querySelector('.caret'));
      }
      for (var lateEstablishLife of [true, false]) {
        receiveLife({ type: 'reset' });
        if (!lateEstablishLife) receiveLife({ type: 'assistant', id: 'established' });
        receiveLife({ type: 'text', id: 'established', delta: '已经接收的正文' });
        receiveLife({ type: 'thinking', id: 'established', delta: '已经接收的思考' });
        receiveLife({ type: 'assistant', id: 'established' });
        receiveLife({ type: 'done', id: 'established', status: 'completed' });
        await settleLife();
        assert((lateEstablishLife ? '建立前输出' : '重复建立') + '保留同一消息和两部分终态', document.querySelectorAll('.msg-assistant').length === 1 && document.querySelector('.msg-assistant .body').textContent === '已经接收的正文' && document.querySelector('.think-body').textContent === '已经接收的思考' && !document.querySelector('.caret'));
        receiveLife({ type: 'assistant', id: 'established' });
        assert('终态后重复建立不会重建节点或光标 ' + lateEstablishLife, document.querySelectorAll('.msg-assistant').length === 1 && !document.querySelector('.caret'));
      }
      receiveLife({ type: 'reset' });
      receiveLife({ type: 'tool', id: 'early-tool', tool: { toolCallId: 'same-tool', status: 'in_progress', rawInput: { command: 'fixture' }, content: [{ type: 'text', text: '部分输出' }] } });
      receiveLife({ type: 'assistant', id: 'early-tool' });
      receiveLife({ type: 'text', id: 'early-tool', delta: '同一消息正文' });
      receiveLife({ type: 'tool', id: 'early-tool', tool: { toolCallId: 'same-tool', status: 'completed', rawInput: { command: 'fixture' }, content: [{ type: 'text', text: '完整最终输出' }] } });
      receiveLife({ type: 'done', id: 'early-tool', status: 'completed' });
      await settleLife();
      assert('工具先于助手建立时增量与终态仍只有同一张卡', document.querySelectorAll('.msg-assistant').length === 1 && document.querySelectorAll('.tool').length === 1 && !document.querySelector('#messages > .tool') && document.querySelector('.tool-status').textContent === '完成' && !document.querySelector('.caret'));
      document.querySelector('.tool-head').click();
      assert('提前工具的最终输出可完整展开', document.querySelector('.tool-out').textContent === '完整最终输出' && document.querySelector('.msg-assistant .body').textContent === '同一消息正文');
      receiveLife({ type: 'reset' });
      receiveLife({ type: 'tool', tool: { toolCallId: 'unscoped', status: 'completed', rawInput: { command: 'standalone' } } });
      assert('没有消息身份的工具仍显示在转录根部', document.querySelectorAll('#messages > .tool').length === 1 && !document.querySelector('.msg-assistant'));
      receiveLife({ type: 'reset' });
      var realRafLife = window.requestAnimationFrame;
      window.requestAnimationFrame = function () { return 0; };
      receiveLife({ type: 'thinking', id: 'hidden', delta: '后台思考' });
      receiveLife({ type: 'text', id: 'hidden', delta: '后台正文' });
      await settleLife();
      assert('动画帧暂停时定时器完整刷新两部分', document.querySelector('.think-body').textContent === '后台思考' && document.querySelector('.msg-assistant .body').textContent.indexOf('后台正文') >= 0);
      receiveLife({ type: 'thinking', id: 'hidden', delta: '旧节点尾部' });
      var oldLife = document.querySelector('.msg-assistant');
      receiveLife({ type: 'reset' });
      var oldHtmlLife = oldLife.innerHTML;
      await settleLife();
      assert('重置取消已销毁节点的延迟刷新', oldLife.innerHTML === oldHtmlLife && !document.querySelector('.msg-assistant'));
      window.requestAnimationFrame = realRafLife;

      var historyLife = document.getElementById('history'), permissionLife = document.getElementById('permission');
      var inputLife = document.getElementById('input'), historyButtonLife = document.getElementById('history-btn');
      var keyLife = function (key, extra) { var e = new KeyboardEvent('keydown', Object.assign({ key: key, bubbles: true, cancelable: true }, extra)); document.activeElement.dispatchEvent(e); return e; };
      inputLife.focus(); historyButtonLife.click();
      assert('历史打开后焦点进入且背景不可操作', historyLife.contains(document.activeElement) && inputLife.closest('[inert]'));
      var historyTargetsLife = Array.from(historyLife.querySelectorAll('button:not(:disabled), input:not(:disabled)')).filter(visible);
      historyTargetsLife[historyTargetsLife.length - 1].focus(); keyLife('Tab');
      assert('历史 Tab 在末尾回到首项', document.activeElement === historyTargetsLife[0]);
      keyLife('Tab', { shiftKey: true });
      assert('历史 Shift+Tab 在首项回到末尾', document.activeElement === historyTargetsLife[historyTargetsLife.length - 1]);
      receiveLife({ type: 'busy', busy: true }); receiveLife({ type: 'busy', busy: false });
      assert('后台任务结束不抢历史焦点', historyLife.contains(document.activeElement));
      keyLife('Escape', { isComposing: true });
      assert('输入法组合 Escape 不关闭历史', !historyLife.hidden);
      keyLife('Escape');
      assert('历史关闭恢复打开前焦点并释放背景', historyLife.hidden && document.activeElement === inputLife && !inputLife.closest('[inert]'));
      receiveLife({ type: 'busy', busy: true });
      var askLife = function (id) { receiveLife({ type: 'permission', requestId: id, params: { toolCall: { title: id }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }, { optionId: 'deny', name: '拒绝', kind: 'reject_once' }] } }); };
      askLife('permission-one'); askLife('permission-two');
      assert('权限具有标题关联与可见初始焦点', permissionLife.getAttribute('role') === 'dialog' && permissionLife.getAttribute('aria-modal') === 'true' && permissionLife.getAttribute('aria-labelledby') === 'permission-title' && permissionLife.contains(document.activeElement));
      keyLife('Escape', { isComposing: true });
      assert('输入法组合 Escape 不答复权限', !window.__received.some(function (m) { return m.type === 'permission' && m.requestId === 'permission-one'; }));
      keyLife('Escape');
      assert('权限 Escape 明确取消当前请求', window.__received.some(function (m) { return m.type === 'permission' && m.requestId === 'permission-one' && m.optionId === null; }));
      assert('连续权限请求依次可处理', !permissionLife.hidden && document.getElementById('permission-title').textContent === 'permission-two' && permissionLife.contains(document.activeElement));
      receiveLife({ type: 'busy', busy: false });
      assert('任务结束不抢权限焦点', permissionLife.contains(document.activeElement));
      document.querySelector('#permission-actions button').click();
      assert('第二个权限请求答复后恢复输入焦点', permissionLife.hidden && document.activeElement === inputLife && window.__received.some(function (m) { return m.type === 'permission' && m.requestId === 'permission-two'; }));
      receiveLife({ type: 'reset' });
      receiveLife({ type: 'assistant', id: 'lazy' });
      receiveLife({ type: 'tool', id: 'lazy', tool: { toolCallId: 'lazy-tool', status: 'in_progress', rawInput: { command: 'fixture' }, content: [{ type: 'text', text: '第一次输出' }] } });
      var lazyLife = document.querySelector('.tool'), lazyHeadLife = lazyLife.querySelector('.tool-head'), lazyBodyLife = lazyLife.querySelector('.tool-body');
      assert('折叠工具不构建输出正文 DOM', lazyBodyLife.childNodes.length === 0);
      receiveLife({ type: 'tool', id: 'lazy', tool: { toolCallId: 'lazy-tool', status: 'completed', rawInput: { command: 'fixture' }, content: [{ type: 'text', text: '最终完整输出 <safe>' }] } });
      lazyHeadLife.click();
      assert('工具展开后渲染最新完整输出并正确转义', lazyBodyLife.textContent.indexOf('最终完整输出 <safe>') >= 0 && !lazyBodyLife.querySelector('safe'));
      assert('工具展开按钮可键盘访问且关联详情', lazyHeadLife.tagName === 'BUTTON' && lazyHeadLife.getAttribute('aria-controls') === lazyBodyLife.id && lazyHeadLife.getAttribute('aria-expanded') === 'true');
      var lazySelectionLife = window.getSelection(), lazyRangeLife = document.createRange();
      lazyRangeLife.selectNodeContents(lazyBodyLife.querySelector('.tool-out')); lazySelectionLife.removeAllRanges(); lazySelectionLife.addRange(lazyRangeLife);
      receiveLife({ type: 'text', id: 'unrelated', delta: '另一条消息' });
      receiveLife({ type: 'done', id: 'unrelated', status: 'cancelled' });
      assert('其他消息更新和取消不破坏工具文本选择', lazySelectionLife.toString() === '最终完整输出 <safe>');
      lazySelectionLife.removeAllRanges();
      lazyHeadLife.click();
      assert('折叠已展开工具保留详情且读屏隐藏', lazyBodyLife.textContent.indexOf('最终完整输出 <safe>') >= 0 && lazyBodyLife.parentElement.getAttribute('aria-hidden') === 'true');
      receiveLife({ type: 'reset' });
      receiveLife({ type: 'queueState', paused: true, items: [{ id: 'uncertain', text: '等待确认的消息', uncertain: true, restored: true }] });
      assert('恢复执行中消息明确显示结果待确认且不可继续', document.getElementById('queue').textContent.indexOf('执行结果待确认') >= 0 && document.getElementById('queue-continue').disabled);
      receiveLife({ type: 'queueState', paused: true, items: [], recoveryBlocked: true, reason: '旧恢复记录损坏' });
      assert('损坏恢复记录仍可见且有明确放弃操作', !document.getElementById('queue').hidden && document.getElementById('queue-summary').textContent.indexOf('损坏') >= 0);
      document.querySelector('#queue-list button').click();
      assert('放弃恢复明确提交discardRecovery', window.__received.some(function (m) { return m.type === 'queueAction' && m.action === 'discardRecovery'; }));
      receiveLife({ type: 'queueState', paused: false, items: [] });
      historyButtonLife.click();
      receiveLife({ type: 'history', via: 'cache', cachedAt: Date.now(), limitation: '连接不可用', sessions: [] });
      assert('离线缓存展示只读摘要时间与分页范围', document.getElementById('history-meta').textContent.indexOf('只读摘要缓存') >= 0 && document.getElementById('history-meta').textContent.indexOf('当前筛选与分页') >= 0);
      receiveLife({ type: 'history', unsupported: 2, emptyReason: 'unsupported-format', sessions: [] });
      assert('新版本地历史限制不会显示数据为空', document.getElementById('history-list').textContent.indexOf('连接内核') >= 0 && document.getElementById('history-list').textContent.indexOf('暂无历史') < 0);
      keyLife('Escape');
    }
    if (EXPECT.perf) {
      var messagesNode = document.getElementById('messages');
      var segments = [];
      for (var s = 0; s < 40; s += 1) {
        // 注意换行符必须写成双反斜杠：本段断言脚本本身位于模板字符串中，
        // 单反斜杠会在生成时变为实际换行，生成出的脚本直接语法错误（曾出现）。
        segments.push('## 第 ' + s + ' 节\\n\\n这是第 ' + s + ' 段正文，带 \`inline code\` 和一个列表：\\n\\n- 一\\n- 二\\n- 三\\n');
      }
      var fullText = segments.join('\\n');
      var bodySel = '.msg-assistant .body';

      function snapshot() {
        var node = document.querySelector(bodySel);
        return {
          nodes: messagesNode.querySelectorAll('*').length,
          // 面板中的标题规则是「# 变 h2、## 变 h3」（markdown.js 中 level = 井号数 + 1）。
          headings: node ? node.querySelectorAll('h3').length : 0,
          chars: node ? node.textContent.length : 0,
        };
      }

      // (1) 分片注入：模拟真实流式。
      var chunkSize = 20;
      var chunkCount = Math.ceil(fullText.length / chunkSize);
      var t0 = performance.now();
      for (var c = 0; c < chunkCount; c += 1) {
        window.postMessage(
          { type: 'text', id: 'a1', delta: fullText.slice(c * chunkSize, (c + 1) * chunkSize) },
          '*',
        );
      }
      var ingestMs = performance.now() - t0;
      // 让出事件循环，等待攒批渲染落定（同步等待会永久阻塞 rAF）。
      await new Promise(function (resolve) { setTimeout(resolve, 800); });
      var settleMs = performance.now() - t0;
      var chunked = snapshot();

      console.log('     流式：' + chunkCount + ' 个增量 / ' + fullText.length + ' 字 → 受理 '
        + Math.round(ingestMs) + 'ms，落定 ' + Math.round(settleMs) + 'ms，'
        + chunked.chars + ' 字、' + chunked.headings + ' 个标题、' + chunked.nodes + ' 个节点');

      assert('几百个增量受理得动（受理 < 1000ms）', ingestMs < 1000, Math.round(ingestMs) + 'ms');
      assert('渲染落定得也快（含 800ms 等待仍 < 3000ms）', settleMs < 3000, Math.round(settleMs) + 'ms');
      // 确认没有内容丢失：正文中的换行/井号会被 markdown 结构消耗，因此不比较总字数，
      // 而是确认「最后一片也已到达」（流式最需防范的是末尾丢失）。
      var tailText = document.querySelector(bodySel) ? document.querySelector(bodySel).textContent : '';
      assert('流式的最后一片也到了（尾巴没丢）',
        tailText.indexOf('第 39 节') >= 0 && tailText.indexOf('第 39 段正文') >= 0,
        '正文长度 ' + chunked.chars + ' 字');
      assert('markdown 结构是真的（40 个小节都成了标题）', chunked.headings === 40, chunked.headings + ' 个标题');

      // (2) 一次注入相同内容：DOM 必须与流式一致 ——
      // 这条才是需要保证的性质：无论分成多少片到达，结果都一致，无重复、无堆积。
      window.postMessage({ type: 'reset' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 200); });
      window.postMessage({ type: 'busy', busy: true }, '*');
      window.postMessage({ type: 'assistant', id: 'a2' }, '*');
      window.postMessage({ type: 'text', id: 'a2', delta: fullText }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 600); });
      var whole = snapshot();

      console.log('     一次喂完：' + whole.chars + ' 字、' + whole.headings + ' 个标题、' + whole.nodes + ' 个节点');
      assert('一次喂完的正文长度和流式一样', Math.abs(whole.chars - chunked.chars) <= 40,
        whole.chars + ' vs ' + chunked.chars);
      assert('一次喂完的标题数和流式一样', whole.headings === chunked.headings,
        whole.headings + ' vs ' + chunked.headings);
      // 此处比较的是「相同内容两种切分方式的 DOM 规模」，少量差异属正常（换行合并等），
      // 差异过大则说明流式路径在重复堆积。
      assert('流式没有堆出多余的 DOM（和一次喂完相比不超过 15%）',
        chunked.nodes <= whole.nodes * 1.15 + 5,
        '流式 ' + chunked.nodes + ' vs 一次喂完 ' + whole.nodes);

      // (3) 长对话：会话持续较久之后的表现。
      // 需要保证两点：一是不演变为「每来一条就重排整棵树」（那会随使用越来越卡），
      // 二是**不把正在往回翻记录的用户拽到底部** —— 这是聊天界面中影响最大的缺陷之一。
      window.postMessage({ type: 'reset' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 200); });

      var exchanges = 150;
      var tLong = performance.now();
      for (var e = 0; e < exchanges; e += 1) {
        window.postMessage({ type: 'user', text: '第 ' + e + ' 个问题，随便写点内容凑长度。' }, '*');
        window.postMessage({ type: 'busy', busy: true }, '*');
        window.postMessage({ type: 'assistant', id: 'long' + e }, '*');
        window.postMessage(
          { type: 'text', id: 'long' + e, delta: '第 ' + e + ' 个回答。' + '正文正文正文正文。'.repeat(8) },
          '*',
        );
        window.postMessage({ type: 'done', id: 'long' + e, status: 'completed' }, '*');
      }
      var longIngest = performance.now() - tLong;
      await new Promise(function (resolve) { setTimeout(resolve, 900); });
      var longSettle = performance.now() - tLong;
      var longNodes = messagesNode.querySelectorAll('*').length;
      var longMessages = messagesNode.querySelectorAll('.msg').length;

      console.log('     长对话：' + exchanges + ' 轮 → 受理 ' + Math.round(longIngest)
        + 'ms，落定 ' + Math.round(longSettle) + 'ms，' + longMessages + ' 条消息、'
        + longNodes + ' 个节点');

      assert('长对话长得出来（' + exchanges + ' 轮都在）', longMessages >= exchanges * 2,
        longMessages + ' 条消息');
      assert('长对话受理得动（受理 < 2000ms）', longIngest < 2000, Math.round(longIngest) + 'ms');
      assert('长对话落定不慢（含 900ms 等待仍 < 4000ms）', longSettle < 4000, Math.round(longSettle) + 'ms');
      // 线性增长：每轮（一问一答）产生的节点不超过 60 个，即说明没有重复堆积。
      assert('节点数随消息线性增长（不超过每轮 60 个）',
        longNodes <= exchanges * 60 + 200,
        longNodes + ' 个节点 / ' + exchanges + ' 轮');

      // 视图位于底部时，新消息应当继续使视图停留在底部。
      messagesNode.scrollTop = messagesNode.scrollHeight;
      await new Promise(function (resolve) { setTimeout(resolve, 120); });
      window.postMessage({ type: 'user', text: '贴底时的最后一句。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      var bottomGap = messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight;
      assert('贴着底时新消息继续贴底（差 < 40px）', bottomGap < 40, '差 ' + Math.round(bottomGap) + 'px');

      // 用户向上翻看记录时，**其自身的输出**不得将视图拉回底部。
      // 注意此处只注入 assistant 的流式正文，不带 user 消息 —— 区分两种情形：
      // 「用户自己发送了一句」把视图带回底部是合理的（该消息由用户发出，需要看到）；
      // 「其自身正在输出」而用户正在向上翻看记录，此时将视图拉下才属于缺陷。
      messagesNode.scrollTop = 0;
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      // 关于「视图不被拉回底部」这条的测量方式：
      // 界面依赖 scroll 事件判断「用户是否在往回翻」。但该无头环境**不会**
      // 为程序化修改 scrollTop 派发 scroll 事件（实测 0 次 —— 该结果曾一度
      // 被误判为「界面存在缺陷」，实际为环境特性）。因此此处手动派发一个：
      // 界面收到的是一个正常的 scroll 事件，与真实使用滚轮往回翻没有区别，
      // 区别仅在于「由谁触发」。真实的滚轮需要真实浏览器，该步骤在
      // tools/vscode-check.js 中由人工确认。
      var sawScrollEvent = 0;
      var countScroll = function () { sawScrollEvent += 1; };
      messagesNode.addEventListener('scroll', countScroll);
      messagesNode.scrollTop = 0;
      await new Promise(function (resolve) { setTimeout(resolve, 200); });
      messagesNode.removeEventListener('scroll', countScroll);
      console.log('     程序化滚动派发的 scroll 事件数：' + sawScrollEvent + '（这个环境是 0，下面手动补一个）');
      messagesNode.dispatchEvent(new Event('scroll'));
      await new Promise(function (resolve) { setTimeout(resolve, 120); });

      var scrollBefore = Math.round(messagesNode.scrollTop);
      window.postMessage({ type: 'assistant', id: 'whileReading' }, '*');
      window.postMessage({ type: 'text', id: 'whileReading', delta: '这条不该把用户拽到底部。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 350); });
      assert('用户翻看历史时，它自己的输出不会把他拽到底部',
        messagesNode.scrollTop < 60,
        'scrollTop 从 ' + scrollBefore + ' 变成了 ' + Math.round(messagesNode.scrollTop) + 'px');

      // 反向情形：用户自己发送一句，视图回到底部属于预期行为（否则无法看到刚发送的内容）。
      window.postMessage({ type: 'user', text: '我发一句，应该能看见它。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      var afterSendGap = messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight;
      assert('你自己发消息时，视图会回到底部（差 < 40px）', afterSendGap < 40,
        '差 ' + Math.round(afterSendGap) + 'px');
    }

    // ── 7.6 内核报错：可读说明在前，原始报文在后 ──────────────
    // 本段为「错误提示改为中文可读说明」设立的护栏。此前内核的 429 是原样贴出的，
    // 用户看到的是一段英文 JSON，只会得出「该插件无法使用」。此处测量三点：
    // 可读说明在前、原始报文一字未少、长 JSON 不会撑破面板。
    if (EXPECT.errorShape) {
      var errBox = document.querySelector('.msg-error');
      assert('错误块渲染出来了', !!errBox);
      if (errBox) {
        var errTitle = errBox.querySelector('.err-title');
        var errAdvice = errBox.querySelector('.err-advice');
        var errRaw = errBox.querySelector('.err-raw');
        assert('先用一句人话说清发生了什么', !!errTitle && errTitle.textContent.trim().length > 0,
          errTitle ? errTitle.textContent : '没有');
        assert('人话里没有把英文 JSON 当正文', !!errTitle && errTitle.textContent.indexOf('{') === -1,
          errTitle ? errTitle.textContent : '没有');
        assert('再说清你能做什么', !!errAdvice && errAdvice.textContent.trim().length > 0,
          errAdvice ? errAdvice.textContent : '没有');
        assert('内核原文也留着（没被吞掉）',
          !!errRaw && errRaw.textContent.indexOf('GoUsageLimitError') >= 0,
          errRaw ? errRaw.textContent.slice(0, 48) : '没有');
        assert('人话排在原文前面',
          !!errTitle && !!errRaw && (errTitle.compareDocumentPosition(errRaw) & 4) !== 0);
        assert('原文块是等宽 + 自动换行的（长 JSON 不横向溢出）',
          !!errRaw && getComputedStyle(errRaw).whiteSpace === 'pre-wrap');
        assert('人话的对比度可读', !!errAdvice && contrastOf(errAdvice) >= 2.5,
          errAdvice ? String(contrastOf(errAdvice)) : '没有');
      }
    }

    // ── 7.7 历史会话：浮层 → 清单 → 回放 → 接回 ────────
    // 真实链路为「点开浮层 → 界面向扩展请求清单 → ACP 接入点插件（dsh-acp-door）读盘应答」。
    // 此处模拟扩展的那一半：点击按钮后由断言脚本 postMessage 应答，
    // 测量的是界面的这一半（浮层、渲染、护栏、按钮发送正确的消息）。
    if (EXPECT.historyScene) {
      var overlay = document.getElementById('history');
      assert('历史浮层默认隐藏', !visible(overlay));
      var hbtn = document.getElementById('history-btn');
      assert('历史按钮可见', visible(hbtn));

      window.__received.length = 0;
      hbtn.click();
      assert('点历史按钮浮层打开', visible(overlay));
      assert('打开时向扩展要了清单', window.__received.some(function (m) { return m.type === 'historyList'; }));

      // 模拟扩展应答（形状对齐 ACP 接入点插件（dsh-acp-door）0.0.8 版的应答）。
      window.postMessage({ type: 'history', skipped: 5, sessions: [
        { id: 'session-alpha', title: '检查示例加法函数', turns: 12, lastTime: Date.now() - 3600e3, cwd: '<仓库根目录>', preset: 'standard' },
        { id: 'session-beta', title: '重写界面的渲染循环', turns: 4, lastTime: Date.now() - 86400e3, cwd: '<仓库根目录>/packages/vscode-extension', preset: 'ptc' },
        { id: 'session-gamma', title: '', fallbackTitle: '帮我看看这个报错', turns: 1, lastTime: Date.parse('2025-11-02T09:12:00'), cwd: '<用户目录>', decodeError: '有一帧解码失败' },
      ] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      var items = overlay.querySelectorAll('.history-item');
      assert('清单渲染出 3 段会话', items.length === 3, items.length + ' 段');
      assert('统计中写明更早的记录未列出', (document.getElementById('history-meta').textContent || '').indexOf('5') >= 0,
        document.getElementById('history-meta').textContent);
      var firstTitle = overlay.querySelector('.history-item-title');
      assert('第一条显示内核生成的标题', !!firstTitle && firstTitle.textContent.indexOf('检查示例') === 0,
        firstTitle ? firstTitle.textContent : '无');
      var sub2 = overlay.querySelectorAll('.history-item-sub')[1];
      assert('非默认模式的名字显示在副行', !!sub2 && sub2.textContent.indexOf('ptc') >= 0, sub2 ? sub2.textContent : '无');
      assert('没标题的会话用第一句话顶上',
        items[2].querySelector('.history-item-title').textContent.indexOf('帮我看看') >= 0,
        items[2].querySelector('.history-item-title').textContent);
      assert('解码出错的会话把原因挂在副行提示里',
        (items[2].querySelector('.history-item-sub').title || '').indexOf('解码失败') >= 0,
        items[2].querySelector('.history-item-sub').title);

      // 回放：点击「回放」→ 界面发送 historyOpen → 扩展送回 replay。
      window.__received.length = 0;
      items[0].querySelectorAll('button')[0].click();
      assert('点回放会向扩展要这段会话（带 id）',
        window.__received.some(function (m) { return m.type === 'historyOpen' && m.id === 'session-alpha'; }),
        JSON.stringify(window.__received));
      window.postMessage({ type: 'replay', truncated: false, card: { id: 'session-alpha', title: '检查示例加法函数', turns: 12, lastTime: Date.now() - 3600e3 }, entries: [
        { kind: 'user', text: '示例加法函数为什么返回错误结果？' },
        { kind: 'assistant', text: '示例函数使用了**减法**运算，需要按加法规则检查。', thinking: '检查示例函数的返回值。' },
        { kind: 'tool', name: 'read', args: { file_path: 'lib/index.js' }, output: 'export const inject = [];' },
        { kind: 'assistant', text: '将返回表达式改为加法。' },
      ] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
      assert('回放开始后浮层收起来了', !visible(overlay));
      assert('回放重建了用户气泡', document.querySelectorAll('.msg-user .bubble').length === 1,
        document.querySelectorAll('.msg-user .bubble').length + ' 个');
      var bodies = document.querySelectorAll('.msg-assistant .body');
      assert('回放重建了两段回答', bodies.length === 2 && bodies[0].textContent.indexOf('减法') >= 0
        && bodies[1].textContent.indexOf('加法') >= 0,
        bodies.length + ' 段');
      assert('回放的思考块也在（且默认可见）', document.querySelectorAll('details.thinking:not([hidden])').length === 1);
      var replayTools = document.querySelectorAll('.tool');
      assert('回放重建了工具卡（默认折叠）', replayTools.length === 1 && !replayTools[0].classList.contains('open'),
        replayTools.length + ' 张');
      assert('回放的工具卡写着工具名', replayTools[0] && replayTools[0].querySelector('.tool-name').textContent === 'read',
        replayTools[0] ? replayTools[0].querySelector('.tool-name').textContent : '无');
      var noteText = (document.querySelector('.msg-note') || {}).textContent || '';
      assert('回放开头即说明内容为回放（无需滚动到底部）',
        noteText.indexOf('回放') >= 0
          && document.querySelector('.msg-note').closest('.msg') === document.querySelector('#messages .msg'),
        noteText);
      assert('回放停在开头，不是底部',
        document.getElementById('messages').scrollTop === 0,
        'scrollTop=' + document.getElementById('messages').scrollTop);

      // 接回：重新打开浮层并点击「接回」——界面需要发送 historyResume。
      // 重新打开会清空列表并显示「正在读取…」，因此再应答一次清单。
      window.__received.length = 0;
      hbtn.click();
      assert('回放之后还能再打开浮层', visible(overlay));
      window.postMessage({ type: 'history', skipped: 5, sessions: [
        { id: 'session-alpha', title: '检查示例加法函数', turns: 12, lastTime: Date.now() - 3600e3, cwd: '<仓库根目录>', preset: 'standard' },
      ] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      var again = overlay.querySelectorAll('.history-item');
      var resumeBtn = again[0] ? again[0].querySelectorAll('button')[1] : null;
      if (resumeBtn) resumeBtn.click();
      assert('点接回会发 historyResume（带 id）',
        window.__received.some(function (m) { return m.type === 'historyResume' && m.id === 'session-alpha'; }),
        JSON.stringify(window.__received));
      document.getElementById('history-close').click();
      assert('关闭按钮能收起浮层', !visible(overlay));

      // 焦点与键盘：浮层覆盖整个面板，因此焦点必须随之移动 ——
      // 打开时进入浮层，关闭时回到该按钮（否则焦点落到 body，键盘用户将失去位置）。
      hbtn.focus();
      hbtn.click();
      assert('打开浮层时焦点移进了浮层（不在底下的控件上）',
        overlay.contains(document.activeElement),
        document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '无');

      // Esc 关闭浮层：浮层的通用约定，缺少该行为时键盘用户只能逐次 Tab 至关闭按钮。
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert('按 Esc 可关闭浮层', !visible(overlay));
      assert('关闭后焦点回到历史按钮', document.activeElement === hbtn,
        document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '无');

      // 读取失败需要呈现为「发生错误」，而不能呈现为「暂无历史会话」。
      hbtn.click();
      window.postMessage({ type: 'history', error: '连着的门插件太旧了，读不了历史会话。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      var errBox = document.querySelector('#history-list .history-error');
      assert('读失败渲染成错误块（不是空状态）', !!errBox, errBox ? errBox.textContent : '（没有 .history-error）');
      assert('错误块与「暂无历史会话」不是同一套样式',
        !!errBox && errBox.className.indexOf('history-empty') < 0, errBox ? errBox.className : '无');
      assert('错误块带 role=alert（读屏会念出来）', !!errBox && errBox.getAttribute('role') === 'alert');

      // 仅存在 class 不足以判定：选择器写错、或被后续规则覆盖时，class 依然存在，
      // 用户看到的却仍是「什么都没有」的外观。本项目曾出现过一次同类问题
      // （hidden 属性被组件自身的 display 覆盖，空控件一直显示在界面上）。
      // 因此此处读取**计算后的样式**，并以空状态作为对照组。
      window.postMessage({ type: 'history', sessions: [] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      var emptyBox = document.querySelector('#history-list .history-empty');
      assert('空列表渲染成空状态块（对照组成立）', !!emptyBox,
        emptyBox ? emptyBox.textContent : '（没有 .history-empty）');
      var emptyStyle = emptyBox ? window.getComputedStyle(emptyBox) : null;
      assert('空状态是居中的', !!emptyStyle && emptyStyle.textAlign === 'center',
        emptyStyle ? emptyStyle.textAlign : '取不到');
      // 取值需**当场取为字符串**：该节点被错误块替换之后，
      // 对应的 CSSStyleDeclaration 会解析为空串 —— 用它比较会「因空而不等」，
      // 断言表面通过、实际未验证任何内容（本套件中曾出现一次）。
      var emptyColor = emptyStyle ? emptyStyle.color : '';

      window.postMessage({ type: 'history', error: '连着的门插件太旧了，读不了历史会话。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      var errStyled = document.querySelector('#history-list .history-error');
      var errStyle = errStyled ? window.getComputedStyle(errStyled) : null;
      assert('错误块靠左（跟居中的空状态分得开）',
        !!errStyle && errStyle.textAlign === 'left', errStyle ? errStyle.textAlign : '取不到');
      assert('错误块真有一条左边线（说明规则生效了）',
        !!errStyle && parseFloat(errStyle.borderLeftWidth) > 0, errStyle ? errStyle.borderLeftWidth : '取不到');
      var probe = document.createElement('span');
      probe.style.color = 'var(--vscode-testing-iconFailed)';
      document.body.appendChild(probe);
      var warnColor = window.getComputedStyle(probe).color;
      document.body.removeChild(probe);
      assert('那条边用的是主题里的警示色（不是写死的颜色）',
        !!errStyle && errStyle.borderLeftColor === warnColor,
        errStyle ? (errStyle.borderLeftColor + ' vs ' + warnColor) : '取不到');
      assert('错误块的正文颜色跟空状态不一样（两件事语气不同）',
        !!errStyle && emptyColor !== '' && errStyle.color !== emptyColor,
        errStyle ? (errStyle.color + ' vs ' + (emptyColor || '（空状态的颜色没取到）')) : '取不到');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert('出错之后 Esc 同样可关闭', !visible(overlay));
      hbtn.click();
      var search=document.getElementById('history-search'),project=document.getElementById('history-project');
      search.value='needle';search.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(function(resolve){setTimeout(resolve,300);});
      var queryRequest=window.__received.filter(function(message){return message.type==='historyList';}).pop();
      assert('搜索正文传给扩展且重置页码',queryRequest.query==='needle'&&queryRequest.offset===0);
      project.checked=true;project.dispatchEvent(new Event('change',{bubbles:true}));
      var projectRequest=window.__received.filter(function(message){return message.type==='historyList';}).pop();
      assert('项目筛选传给扩展',projectRequest.projectOnly===true);
      window.postMessage({type:'history',requestId:projectRequest.requestId,total:205,offset:0,nextOffset:100,sessions:[{id:'paged',title:'Current page'}]},'*');
      await new Promise(function(resolve){setTimeout(resolve,30);});
      window.postMessage({type:'history',requestId:queryRequest.requestId,total:0,sessions:[]},'*');
      await new Promise(function(resolve){setTimeout(resolve,30);});
      assert('旧搜索应答不覆盖当前结果',overlay.querySelector('.history-item-title').textContent==='Current page');
      overlay.querySelectorAll('.history-item-actions button')[2].click();
      assert('导出发送会话 ID',window.__received.some(function(message){return message.type==='historyExport'&&message.id==='paged';}));
      document.getElementById('history-next').click();
      var nextRequest=window.__received.filter(function(message){return message.type==='historyList';}).pop();
      assert('下一页使用接入点返回的位置',nextRequest.offset===100);
      window.postMessage({type:'history',requestId:nextRequest.requestId,total:205,offset:100,nextOffset:200,sessions:[{id:'paged-next',title:'Next page'}]},'*');
      await new Promise(function(resolve){setTimeout(resolve,30);});
      assert('分页统计及上一页可用',!document.getElementById('history-prev').disabled&&document.getElementById('history-page').textContent.indexOf('101')===0);
      document.getElementById('history-prev').click();
      assert('上一页回到前一页',window.__received.filter(function(message){return message.type==='historyList';}).pop().offset===0);
      document.getElementById('history-close').click();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'historyState', readonly: false } }));
    }

    // ── 7.8 权限选择器：清单由扩展（内核）提供，界面只负责渲染与点击 ──────────
    // 本段中的清单来自 tools/preview.js 的 access 场景，该载荷由
    // **生产环境的翻译函数**（src/dsh/permission.js）生成 —— 因此此处验证的
    // 标签、说明、确认步骤，与真实面板上所见为同一套。
    if (EXPECT.accessScene) {
      var accessField = document.getElementById('access-field');
      var accessBtn = document.getElementById('access-btn');
      var accessPop = document.getElementById('access-pop');
      var accessList = document.getElementById('access-list');
      var accessConfirm = document.getElementById('access-confirm');

      assert('权限栏已显示', visible(accessField));
      assert('按钮上写的是当前档（中文）', (accessBtn.textContent || '').indexOf('工作区内修改') >= 0,
        accessBtn.textContent);
      assert('按钮带悬浮提示', (accessBtn.title || '').length > 0, accessBtn.title);
      assert('小卡片默认隐藏', !visible(accessPop));
      assert('按钮说自己是弹窗触发器', accessBtn.getAttribute('aria-haspopup') === 'dialog');

      accessBtn.click();
      assert('点一下弹出清单', visible(accessPop));
      assert('弹出时 aria-expanded 跟着变', accessBtn.getAttribute('aria-expanded') === 'true');
      var accessItems = accessPop.querySelectorAll('.access-item');
      assert('四档都在（含插件加的 Auto Approval）', accessItems.length === 4,
        accessItems.length + ' 项：' + [].map.call(accessItems, function (n) {
          return n.querySelector('.access-item-name').textContent;
        }).join(' / '));
      var accessNames = [].map.call(accessItems, function (n) {
        return (n.querySelector('.access-item-name') || {}).textContent || '';
      });
      assert('标签跟桌面端一致（仅可查看 / 工作区内修改 / Auto Approval / 完全权限）',
        accessNames.join('|') === '仅可查看|工作区内修改|Auto Approval|完全权限',
        accessNames.join('|'));
      assert('每一档都带一行说明',
        [].every.call(accessItems, function (n) {
          var d = n.querySelector('.access-item-desc');
          return !!d && d.textContent.trim().length > 0;
        }),
        [].map.call(accessItems, function (n) {
          var d = n.querySelector('.access-item-desc');
          return d ? d.textContent.length : 0;
        }).join(','));
      assert('当前那一档打了勾（只有一项 active）',
        accessPop.querySelectorAll('.access-item.active').length === 1,
        accessPop.querySelectorAll('.access-item.active').length + ' 项');
      assert('选项对读屏是 listbox 里的 option',
        accessItems[0].getAttribute('role') === 'option'
          && accessItems[0].getAttribute('aria-selected') === 'false'
          && accessPop.querySelector('.access-item.active').getAttribute('aria-selected') === 'true');
      var popRect = accessPop.getBoundingClientRect();
      assert('小卡片没有跑出窗口',
        popRect.left >= 0 && popRect.right <= window.innerWidth + 1 && popRect.bottom <= window.innerHeight + 1,
        Math.round(popRect.left) + ',' + Math.round(popRect.top) + ' → ' + Math.round(popRect.right) + ',' + Math.round(popRect.bottom)
          + ' (窗口 ' + window.innerWidth + 'x' + window.innerHeight + ')');

      // 普通档位：点击一次即切换，不需要确认。
      window.__received.length = 0;
      accessItems[0].click();
      assert('点普通档直接发 setPermission',
        window.__received.some(function (m) { return m.type === 'setPermission' && m.value === 'read-only'; }),
        JSON.stringify(window.__received));
      assert('发完就收起来了', !visible(accessPop));
      var normalPermissionRequest = window.__received.filter(function (m) { return m.type === 'setPermission'; }).pop();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'settingResult', requestId: normalPermissionRequest.requestId, phase: 'completed', success: true, text: '权限已确认' } }));

      // 完全权限：必须先通过确认步骤 —— 该档位一经选定即不再逐条询问用户，误选代价较大。
      window.__received.length = 0;
      accessBtn.click();
      var dangerItem = null;
      for (var ai = 0; ai < accessItems.length; ai += 1) {
        if (accessItems[ai].dataset.value === 'danger-full-access') dangerItem = accessItems[ai];
      }
      assert('找得到「完全权限」那一项', !!dangerItem);
      dangerItem.click();
      assert('完全权限不会直接切（一条消息都没发）', window.__received.length === 0,
        JSON.stringify(window.__received));
      assert('确认框顶掉了清单', visible(accessConfirm) && !visible(accessList));
      assert('确认框说明了后果（不再逐条询问）',
        (document.getElementById('access-confirm-body').textContent || '').indexOf('不再逐条') >= 0,
        document.getElementById('access-confirm-body').textContent);
      assert('确认按钮写的是「启用完全权限」',
        document.getElementById('access-confirm-accept').textContent.indexOf('启用完全权限') >= 0,
        document.getElementById('access-confirm-accept').textContent);
      document.getElementById('access-confirm-cancel').click();
      assert('点「取消」回到清单，仍然没有发送消息',
        window.__received.length === 0 && visible(accessList) && !visible(accessConfirm));
      dangerItem.click();
      document.getElementById('access-confirm-accept').click();
      assert('确认之后才真的发 setPermission',
        window.__received.some(function (m) { return m.type === 'setPermission' && m.value === 'danger-full-access'; }),
        JSON.stringify(window.__received));
      assert('确认后小卡片收起', !visible(accessPop));
      var dangerPermissionRequest = window.__received.filter(function (m) { return m.type === 'setPermission'; }).pop();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'settingResult', requestId: dangerPermissionRequest.requestId, phase: 'completed', success: true, text: '权限已确认' } }));

      // Esc 与点击外部区域：这两种习惯性操作都需要生效。
      accessBtn.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert('按 Esc 可关闭小卡片', !visible(accessPop));
      accessBtn.click();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      assert('点击其它位置同样可关闭', !visible(accessPop));

      // 内核将 custom 附在清单末尾时（当前取值不匹配任何预设）：它是**展示态**，
      // 不是可切换的目标 —— 内核的 resolve() 对它直接抛出，桌面端也将其滤出可选行。
      // 面板这边由扩展标记 selectable: false，界面据此渲染为灰色的当前项。
      // 该项原本是一个可点击的按钮：点击会发出 setPermission('custom')，用户看到的是
      // 「无法读取当前权限 / 请点击「重新连接」后重试」，而重新连接无法修复该状态。
      window.__received.length = 0;
      window.postMessage({ type: 'permissionState', currentValue: 'custom', label: '自定义',
        options: [
          { value: 'read-only', label: '仅可查看', selectable: true, needsConfirm: false, active: false },
          { value: 'workspace-write', label: '工作区内修改', selectable: true, needsConfirm: false, active: false },
          { value: 'danger-full-access', label: '完全权限', selectable: true, needsConfirm: true, active: false },
          { value: 'custom', label: '自定义', selectable: false, needsConfirm: false, active: true }
        ] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 150); });
      assert('当前是展示态时顶栏跟着改（自定义）',
        (accessBtn.textContent || '').indexOf('自定义') >= 0, accessBtn.textContent);
      accessBtn.click();
      var customRows = accessPop.querySelectorAll('.access-item');
      assert('展示项同样列出（否则用户无法看出当前所处的档）',
        customRows.length === 4, customRows.length + ' 行');
      var customRow = null;
      for (var ci = 0; ci < customRows.length; ci += 1) {
        if (customRows[ci].dataset.value === 'custom') customRow = customRows[ci];
      }
      assert('找得到展示项那一行', !!customRow);
      assert('展示项是灰的（点不了）', customRow.disabled === true);
      assert('展示项打了勾（它就是当前状态）', customRow.classList.contains('active'));
      assert('展示项标了 display-only（给样式和测试看）',
        customRow.dataset.displayOnly === 'true', customRow.dataset.displayOnly);
      assert('「共 N 种」只数能切的（不把展示项算进去）',
        (document.getElementById('access-pop-note').textContent || '').indexOf('共 3 种') >= 0,
        document.getElementById('access-pop-note').textContent);
      window.__received.length = 0;
      customRow.disabled = false;
      customRow.click();
      assert('展示项根本没有点击监听（就算硬点也不发一条消息）',
        window.__received.length === 0, JSON.stringify(window.__received));
      accessBtn.click();

      // 无法切换时（所连版本较旧 / 未提供权限设置）：按钮置灰 + 给出可读说明，
      // 并且该说明挂在悬浮提示上（顶栏该行容不下长文本，完整原因走对话流）。
      // 这段提示不使用内部词（插件简称 / 包名 / 版本号 / 档位名），
      // 此处即用扩展实际会发送的那两句作为素材（见 src/dsh/permission.js）。
      window.postMessage({ type: 'permissionState', unavailable: {
        state: 'old-door',
        text: '该 DSH 版本过低，此处无法切换权限',
        detail: '请在桌面端界面中切换，或将 DSH 升级到最新版',
      } }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 200); });
      assert('无法切换时按钮置灰', accessBtn.disabled === true);
      // 按钮上只写结论（「不可切换」）—— 顶栏该格很窄，写全会显示不全；
      // 理由存放在 data-why 与悬浮提示中，完整说明在对话流里。
      assert('按钮上只写结论「不可切换」（不放长句）',
        (accessBtn.textContent || '').trim() === '不可切换', accessBtn.textContent);
      assert('按钮记着是哪一种无法切换', accessBtn.dataset.why === '版本过低', accessBtn.dataset.why);
      assert('无法切换时按钮文字未被截断',
        accessBtn.scrollWidth <= accessBtn.clientWidth + 2,
        accessBtn.scrollWidth + '>' + accessBtn.clientWidth);
      assert('完整原因挂在悬浮提示里', /无法切换权限/.test(accessBtn.title || ''), accessBtn.title);
      assert('悬浮提示里没有内部词（门 / 包名 / 版本号）',
        !/门|dsh-acp-door|0\.0\.\d+|档/.test(accessBtn.title || ''), accessBtn.title);
      window.__received.length = 0;
      accessBtn.click();
      assert('置灰后点击也不弹出清单', !visible(accessPop));
    }


    if (EXPECT.testRepairScene) {
      var recv = function (message) { window.dispatchEvent(new MessageEvent('message', { data: message })); };
      var input = document.getElementById('input'), preview = document.getElementById('attachment-preview');
      var count = function (type) { return window.__received.filter(function (m) { return m.type === type; }).length; };
      var last = function (type) { return window.__received.filter(function (m) { return m.type === type; }).pop(); };
      var answer = function (request, changes) { recv(Object.assign({}, request, { type: 'workflowResult' }, changes)); };
      var attachment = { id: 'file-snapshot', kind: 'content', scope: 'file', name: 'current.js', sourcePath: '/test-project/current.js', text: 'A', isDirty: false };
      recv({ type: 'meta', cwd: '/test-project', trusted: true, sessionId: 's1' });
      recv({ type: 'attach', cwd: '/test-project', sessionId: 's1', items: [attachment] });
      document.querySelector('#attachments .chip-label').click();
      assert('重新加入前真实预览显示A', document.getElementById('preview-body').textContent === 'A');
      recv({ type: 'attach', cwd: '/test-project', sessionId: 's1', items: [Object.assign({}, attachment, { text: 'B', isDirty: true })] });
      assert('右键回执更新同ID时关闭旧预览要求重看', preview.hidden);
      document.querySelector('#attachments .chip-label').click();
      assert('重看准确显示更新B及未保存元数据', document.getElementById('preview-body').textContent === 'B' && document.getElementById('preview-meta').textContent.includes('未保存'));
      document.getElementById('preview-close').click(); input.value = '明确发送'; input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      var send = last('send'); assert('用户Enter实际发送更新快照B', send.attachments[0].text === 'B');
      recv({ type: 'sendResult', requestId: send.requestId, cwd: '/test-project', success: true, phase: 'accepted' });
      recv({ type: 'sendCompleted', requestId: send.requestId, cwd: '/test-project', success: true });
      recv({ type: 'workflow', files: [], turns: [], test: { id: 'pre-initial', turnId: '', status: 'passed', label: 'previous' } });
      document.getElementById('workflow-run-test').click(); var initialRequest = last('workflowAction');
      assert('无轮次总览测试请求使用空字符串轮次契约', initialRequest.turnId === '' && initialRequest.testId === '');
      answer(initialRequest, {});
      var initialTest = { id: 'initial-test', turnId: '', status: 'passed', label: 'initial', exitCode: 0 };
      recv({ type: 'workflow', files: [], test: initialTest }); document.getElementById('workflow-view-test').click(); initialRequest = last('workflowAction');
      answer(initialRequest, { items: [{ id: 'initial-evidence', kind: 'content', name: 'initial', scope: 'test', text: '无轮次真实测试结果' }] });
      assert('无轮次测试结果可精确查看不被null拒绝', initialRequest.turnId === '' && initialRequest.testId === 'initial-test' && !preview.hidden && document.getElementById('preview-body').textContent === '无轮次真实测试结果');
      document.getElementById('preview-close').click();
      var sends = count('send');
      var test = { id: 'test1', label: '<img src=x> long test task', cwd: '/test-project', turnId: 'turn1', status: 'failed', exitCode: 1, duration: 1200, freshness: 'unknown' };
      var evidence = { id: 'test:test1', kind: 'content', scope: 'test', source: 'vscode-task', name: '测试结果：失败', text: '执行ID：test1\\n退出码：1\\n未自动取得终端输出。\\n<img src=x>\\n编辑器诊断可能与任务无关', sourcePath: '/test-project', snapshotAt: '2026-10-12T03:00:00.000Z' };
      recv({ type: 'workflow', turnId: 'turn1', files: [], test: test });
      assert('失败卡明确缺输出且标签不解析HTML', document.getElementById('workflow-test').textContent.includes('未自动取得终端输出') && !document.querySelector('#workflow-test img'));
      document.getElementById('workflow-view-test').click(); var request = last('workflowAction');
      assert('查看带精确轮次执行请求目录会话身份', request.turnId === 'turn1' && request.testId === 'test1' && request.requestId && request.cwd === '/test-project' && request.sessionId === 's1');
      answer(request, { items: [evidence] });
      assert('结果预览只读且不冒充文件日志', !preview.hidden && document.getElementById('preview-body').textContent === evidence.text && !preview.querySelector('img') && document.getElementById('preview-note').textContent.includes('未自动核实'));
      document.getElementById('preview-close').click();
      input.value = '原有正文'; input.dispatchEvent(new Event('input')); recv({ type: 'attach', items: [Object.assign({}, attachment, { text: '原有附件' })] });
      document.getElementById('workflow-attach-test').click(); request = last('workflowAction'); answer(request, { items: [evidence] });
      assert('附加保留正文和已有附件', input.value === '原有正文' && document.querySelectorAll('#attachments .chip').length === 2);
      document.getElementById('workflow-prepare-test').click(); request = last('workflowAction');
      input.value = '等待回执时新增正文'; input.dispatchEvent(new Event('input'));
      answer(request, { items: [evidence], text: '请修复此次失败。修复后重新验证。' });
      assert('准备失败草稿准确显示且提醒重验', input.value.includes('请修复此次失败') && document.getElementById('hint').textContent.includes('重新运行测试'));
      assert('等待期间新输入及完整旧附件进入保留草稿', window.__draftState.recoveries.some(function (draft) { return draft.text === '等待回执时新增正文' && draft.attachments.length === 2 && draft.attachments[0].text === '原有附件'; }));
      assert('查看附加准备全过程发送与排队为零', count('send') === sends && count('queueAction') === 0);
      document.getElementById('recover-draft').click();
      assert('恢复旧草稿带回全部正文附件', input.value === '等待回执时新增正文' && document.querySelectorAll('#attachments .chip').length === 2);
      document.getElementById('workflow-log-test').click();
      assert('日志浮层说明用户提供和归属限制', !document.getElementById('test-log-panel').hidden && document.getElementById('test-log-panel').textContent.includes('未自动核实'));
      document.getElementById('test-log-body').value = '汉'.repeat(44000); document.getElementById('test-log-accept').click();
      assert('日志按UTF8拒绝128KiB超限且保留输入', !document.getElementById('test-log-panel').hidden && document.getElementById('test-log-note').textContent.includes('128 KiB'));
      document.getElementById('test-log-body').value = '<img src=x> assertion failed'; document.getElementById('test-log-accept').click(); request = last('workflowAction');
      assert('明确日志提交带执行身份且没有发送', request.action === 'logTest' && request.testId === 'test1' && request.logText.includes('<img') && count('send') === sends);
      var log = { id: 'test-log:test1', kind: 'content', scope: 'test-log', source: 'user-provided', name: '用户提供日志（归属未核实）', text: '用户提供；未自动核实属于此次执行\\n<img src=x> assertion failed' };
      answer(request, { items: [evidence, log] });
      assert('补充后预览全部证据且HTML为文本', document.getElementById('preview-body').textContent.includes(log.text) && !preview.querySelector('img'));
      document.getElementById('preview-close').click();
      document.getElementById('workflow-terminal').click(); request = last('workflowAction');
      assert('通用任务终端视图请求仍按本执行寻址', request.action === 'taskTerminals' && request.testId === 'test1'); answer(request, {});
      document.getElementById('workflow-view-test').click(); request = last('workflowAction');
      recv({ type: 'workflow', turnId: 'turn1', files: [], test: Object.assign({}, test, { id: 'test2' }) }); answer(request, { items: [evidence] });
      assert('同轮重跑覆盖后拒绝迟到旧结果', preview.hidden && document.getElementById('hint').textContent.includes('覆盖'));
      document.getElementById('workflow-prepare-test').click(); request = last('workflowAction'); var original = input.value;
      recv({ type: 'meta', cwd: '/test-project', trusted: true, sessionId: 's2' }); answer(request, { text: '迟到修复', items: [evidence] });
      assert('会话变化后迟到草稿不能覆盖新输入', input.value === original);
      document.getElementById('workflow-view-test').click(); request = last('workflowAction');
      recv({ type: 'meta', cwd: '/other-project', trusted: true, sessionId: 's2' }); answer(request, { items: [evidence] });
      assert('目录变化后迟到证据不能进入另一段草稿', preview.hidden && document.getElementById('attachments').hidden);
      recv({ type: 'meta', cwd: '/test-project', trusted: true, sessionId: 's2' });
      document.getElementById('workflow-attach-test').click(); request = last('workflowAction');
      recv({ type: 'meta', cwd: '/test-project', trusted: false, sessionId: 's2' }); answer(request, { items: [evidence] });
      assert('信任撤销后迟到附件被拒绝', document.getElementById('attachments').hidden);
      recv({ type: 'meta', cwd: '/limits', trusted: true, sessionId: 's3' });
      recv({ type: 'workflow', turnId: 'turn1', files: [], test: test });
      input.value = '限额原正文'; input.dispatchEvent(new Event('input'));
      recv({ type: 'attach', items: Array.from({ length: 20 }, function (_, i) { return { id: 'limit' + i, name: 'limit' + i, kind: 'content', text: 'x' }; }) });
      document.getElementById('workflow-attach-test').click(); request = last('workflowAction'); answer(request, { items: [evidence] });
      assert('测试附加计入已有20项且原内容不丢', document.querySelectorAll('#attachments .chip').length === 20 && input.value === '限额原正文' && document.getElementById('hint').textContent.includes('20 项'));
      recv({ type: 'meta', cwd: '/bytes', trusted: true, sessionId: 's3' }); input.value = '字节限额原正文'; input.dispatchEvent(new Event('input'));
      recv({ type: 'attach', items: [{ id: 'full', name: 'full', kind: 'content', text: 'x'.repeat(256 * 1024) }] });
      document.getElementById('workflow-attach-test').click(); request = last('workflowAction'); answer(request, { items: [evidence] });
      assert('测试证据计入256KiB且不覆盖既有正文', document.querySelectorAll('#attachments .chip').length === 1 && input.value === '字节限额原正文' && document.getElementById('hint').textContent.includes('256 KiB'));
      recv({ type: 'meta', cwd: '/draft-budget', trusted: true, sessionId: 's3' });
      recv({ type: 'draftRestore', cwd: '/draft-budget', draft: { version: 1, cwd: '/draft-budget', savedAt: Date.now(), text: 'x'.repeat(100000), attachments: [], recoveries: [{ text: 'a'.repeat(120000), attachments: [] }, { text: 'b'.repeat(120000), attachments: [] }, { text: 'c'.repeat(120000), attachments: [] }] } });
      document.getElementById('workflow-prepare-test').click(); request = last('workflowAction'); answer(request, { items: [Object.assign({}, evidence, { text: 'y'.repeat(80000) })], text: '准备修复' });
      assert('准备计入512KiB保留草稿总量且原正文不丢', input.value.length === 100000 && document.getElementById('hint').textContent.includes('512 KiB'));
      assert('全部证据与日志操作未触发额外send或queue', count('send') === sends && count('queueAction') === 0);
      var old = { id: 'old-turn', finished: true, status: 'completed', files: [], test: Object.assign({}, test, { id: 'old-test', status: 'passed', exitCode: 0, stale: true }) };
      var current = { id: 'current-turn', finished: true, status: 'completed', files: [], test: Object.assign({}, test, { id: 'current-test', status: 'cancelled' }) };
      recv({ type: 'workflow', turnId: 'current-turn', test: current.test, files: [], turns: [old, current] });
      var oldCard = document.querySelector('[data-turn="old-turn"]'); oldCard.open = true;
      assert('陈旧通过仍保留真实通过和需重跑状态', oldCard.querySelector('summary').textContent.includes('测试通过') && oldCard.querySelector('summary').textContent.includes('需重跑'));
      Array.from(oldCard.querySelectorAll('button')).find(function (button) { return button.textContent === '查看此次结果'; }).click(); request = last('workflowAction');
      assert('旧轮查看精确寻址旧结果而非最新', request.turnId === 'old-turn' && request.testId === 'old-test');
      assert('取消结果准备明确称排查而非失败修复', Array.from(document.querySelector('[data-turn="current-turn"]').querySelectorAll('button')).some(function (button) { return button.textContent === '准备排查草稿'; }));
      recv({ type: 'workflow', turnId: 'current-turn', test: current.test, files: [], turns: [current] }); answer(request, { items: [evidence] });
      assert('旧轮淘汰后迟到查看不显示', preview.hidden);
      var raceTest = Object.assign({}, test, { id: 'race-test', turnId: 'race-turn' });
      recv({ type: 'meta', cwd: '/preview-race', trusted: true, sessionId: 's4' });
      recv({ type: 'workflow', turnId: 'race-turn', files: [], test: raceTest, turns: [] });
      input.value = '只在明确发送后执行'; input.dispatchEvent(new Event('input'));
      document.getElementById('workflow-view-test').click(); var previewRequest = last('workflowAction');
      document.getElementById('workflow-attach-test').click(); var attachRequest = last('workflowAction');
      var raceEvidence = Object.assign({}, evidence, { id: 'test:race-test', text: 'A:变化文件当前' });
      answer(previewRequest, { items: [raceEvidence] });
      assert('并发查看先返回准确显示A证据', !preview.hidden && document.getElementById('preview-body').textContent === raceEvidence.text);
      recv({ type: 'workflow', turnId: 'race-turn', files: [], test: Object.assign({}, raceTest, { stale: true }), turns: [] });
      answer(attachRequest, { items: [Object.assign({}, raceEvidence, { text: 'B:代码已变化需要重验' })] });
      assert('并发附加新鲜度变化B回执关闭同执行旧A预览', preview.hidden && document.getElementById('hint').textContent.includes('附加快照'));
      document.querySelector('#attachments .chip-label').click();
      assert('同执行重看实际待发证据B', document.getElementById('preview-body').textContent === 'B:代码已变化需要重验');
      assert('并发查看附加仍未自动发送', count('send') === sends);
      document.getElementById('preview-close').click(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      var raceSend = last('send'); assert('同执行并发更新后用户Enter确实发送B', raceSend.attachments[0].text === 'B:代码已变化需要重验');
      recv({ type: 'sendResult', requestId: raceSend.requestId, success: true, cwd: '/preview-race', phase: 'accepted' });
      recv({ type: 'sendCompleted', requestId: raceSend.requestId, success: true, cwd: '/preview-race' });

      recv({ type: 'workflow', files: [], turns: [] });
    }

    if (EXPECT.composerScene) {
      var ci = document.getElementById('input'), menu = document.getElementById('composer-menu');
      var receive = function (data) { window.dispatchEvent(new MessageEvent('message', { data: data })); };
      var type = async function (value) { ci.focus(); ci.value = value; ci.setSelectionRange(value.length, value.length); ci.dispatchEvent(new Event('input')); await new Promise(function (r) { setTimeout(r, 140); }); return window.__received.filter(function (m) { return m.type === 'composerQuery'; }).pop(); };
      var key = function (value, extra) { ci.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: value, bubbles: true, cancelable: true }, extra))); };
      var sentCount = function () { return window.__received.filter(function (m) { return m.type === 'send'; }).length; };
      await type('mail@example.com'); assert('邮箱不打开候选', menu.hidden);
      await type('https://example.com'); assert('URL 不打开技能候选', menu.hidden);
      var cq = await type('解释 @src/'); assert('路径查询来自光标前的 @', cq.trigger === '@' && cq.query === 'src/');
      receive({ type: 'composerSuggestions', requestId: cq.requestId - 1, items: [{ id: 'stale', label: '旧候选' }] });
      assert('迟到搜索不覆盖新候选', !document.querySelector('.composer-option'));
      var before = sentCount(); key('Enter'); assert('加载时 Enter 不发送', sentCount() === before);
      receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'one', label: 'src/one.js' }, { id: 'two', label: '<img src=x onerror=alert(1)>.js' }] });
      assert('文件名作为纯文本显示', !document.querySelector('#composer-options img'));
      key('ArrowDown'); assert('方向键更新活动候选', ci.getAttribute('aria-activedescendant') === 'composer-option-1');
      key('Enter'); var select = window.__received.filter(function (m) { return m.type === 'composerSelect'; }).pop();
      assert('Enter 选中候选而不发送', select.id === 'two' && sentCount() === before);
      document.getElementById('send').click(); assert('附加尚未完成不能误发', sentCount() === before);
      receive({ type: 'composerSelected', requestId: select.requestId, item: { kind: 'content', id: 'file-one', name: 'src/one.js', text: 'unsaved snapshot' } });
      assert('成功后只移除快捷查询，保留原消息', ci.value === '解释 ' && document.querySelectorAll('#attachments .chip').length === 1);
      cq = await type('/review'); receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'skill', label: 'code-review' }] });
      key('Tab'); select = window.__received.filter(function (m) { return m.type === 'composerSelect'; }).pop();
      receive({ type: 'composerSelected', requestId: select.requestId, item: { kind: 'skill', id: 'skill-one', name: 'code-review', text: 'skill instructions' } });
      assert('Tab 附加技能正文且不自动发送', document.querySelectorAll('#attachments .chip').length === 2 && sentCount() === before);
      document.getElementById('send').click(); var sent = window.__received.filter(function (m) { return m.type === 'send'; }).pop();
      assert('显式发送携带文件和技能', sent.attachments.length === 2 && sent.attachments[1].kind === 'skill');
      receive({ type: 'sendResult', requestId: sent.requestId, success: false });
      assert('失败发送恢复技能附件', document.querySelectorAll('#attachments .chip').length === 2);
      cq = await type('#selection'); receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'selection', label: '当前选区' }] });
      document.querySelector('.composer-option').click(); select = window.__received.filter(function (m) { return m.type === 'composerSelect'; }).pop();
      receive({ type: 'composerSelected', requestId: select.requestId, error: '选区已变化' });
      assert('读取失败保留输入', ci.value === '#selection');
      cq = await type('@one'); receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'one', label: 'one' }] }); key('Enter');
      select = window.__received.filter(function (m) { return m.type === 'composerSelect'; }).pop(); ci.value = '新的输入'; ci.dispatchEvent(new Event('input'));
      receive({ type: 'composerSelected', requestId: select.requestId, item: { kind: 'content', id: 'file-one', name: 'src/one.js', text: 'updated' } });
      assert('异步附加不覆盖新输入且同一文件去重', ci.value === '新的输入' && document.querySelectorAll('#attachments .chip').length === 2);
      await type('@'); key('Escape'); assert('Esc 关闭候选并保留文字', menu.hidden && ci.value === '@');
      key(' ', { ctrlKey: true }); assert('Ctrl+Space 重新打开候选', !menu.hidden);
      key('Escape'); await type('继续解释'); document.querySelector('[data-composer="/"]').click();
      await new Promise(function (r) { setTimeout(r, 140); });
      cq = window.__received.filter(function (m) { return m.type === 'composerQuery'; }).pop();
      assert('点击技能按钮保留原消息并补上分隔空格', ci.value === '继续解释 /' && cq.trigger === '/');
      receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'local', label: 'local-skill' }] }); key('Enter');
      select = window.__received.filter(function (m) { return m.type === 'composerSelect'; }).pop();
      ci.value += ' 后续文字'; ci.setSelectionRange(ci.value.length, ci.value.length); ci.dispatchEvent(new Event('input'));
      receive({ type: 'composerSelected', requestId: select.requestId, item: { kind: 'skill', id: 'skill-one', name: 'local-skill', text: 'local skill' } });
      assert('异步附加保留新增文字且只移除原查询', ci.value === '继续解释  后续文字');
      assert('统一上下文与编辑器一步入口可点击', document.querySelectorAll('.composer-shortcuts button').length === 4 && visible(document.getElementById('context-open')) && visible(document.querySelector('[data-context-add="selection"]')));
      ci.dispatchEvent(new CompositionEvent('compositionstart')); await type('@中'); key('Enter', { isComposing: true });
      assert('中文输入期间不打开候选或发送', menu.hidden && sentCount() === before + 1);
      ci.dispatchEvent(new CompositionEvent('compositionend')); await new Promise(function (r) { setTimeout(r, 140); });
      assert('中文输入完成后恢复搜索', !menu.hidden);
      key('Escape'); document.querySelectorAll('#attachments .chip-close').forEach(function (button) { button.click(); }); ci.value = ''; ci.dispatchEvent(new Event('input'));
      cq = await type('/help'); receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'command:help', kind: 'command', label: '/help · 使用帮助' }] });
      before = sentCount(); key('Enter'); var command = window.__received.filter(function (m) { return m.type === 'composerCommand'; }).pop();
      assert('命令走单独入口且不发送模型消息', command.id === 'command:help' && sentCount() === before);
      receive({ type: 'composerSelected', requestId: command.requestId, command: true });
      assert('命令完成后移除查询且不创建附件', ci.value === '' && document.querySelectorAll('#attachments .chip').length === 0);
      cq = await type('/model'); receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'command:model', kind: 'command', label: '/model', disabled: true }] });
      key('Enter'); assert('不可用命令不能执行', window.__received.filter(function (m) { return m.type === 'composerCommand'; }).pop() === command);
      key('Escape');
      receive({ type: 'workflow', turnId: 'turn1', finished: true, files: [{ id: 'f1', name: '<img>.js', kind: 'modified', added: 1, removed: 1, canUndo: true }], note: '保留本轮开始前的修改' });
      receive({ type: 'workflowFocus' });
      assert('本轮改动可展开且文件名按文本显示', document.getElementById('workflow').open && !document.querySelector('#workflow-files img'));
      document.querySelector('#workflow-files button').click();
      assert('差异按钮带上候选标识', window.__received.filter(function (m) { return m.type === 'workflowAction'; }).pop().id === 'f1');
      receive({ type: 'workflow', turnId: 'turn1', files: [], test: { label: 'test-task', status: 'running' } });
      assert('运行时禁用重复测试并显示停止', document.getElementById('workflow-run-test').disabled && !document.getElementById('workflow-stop-test').hidden && document.getElementById('workflow-attach-test').hidden);
      receive({ type: 'workflow', turnId: 'turn1', files: [], test: { label: 'test-task', status: 'failed', exitCode: 1, duration: 1200 } });
      assert('测试失败展示真实退出码及耗时', document.getElementById('workflow-test').textContent.includes('失败') && document.getElementById('workflow-test').textContent.includes('退出码 1') && document.getElementById('workflow-test').textContent.includes('1.2 秒'));
      document.getElementById('workflow-attach-test').click();
      assert('测试摘要只附加不自动发送', window.__received.filter(function (m) { return m.type === 'workflowAction'; }).pop().action === 'attachTest' && sentCount() === before);
      receive({ type: 'workflow', files: [] }); ci.value = ''; ci.dispatchEvent(new Event('input'));

      // 独立上下文入口不改变消息，也不执行命令或自动发送。
      receive({ type: 'meta', cwd: '/context-project', trusted: true, sessionId: 'context-session' });
      await type('保留这段消息'); before = sentCount();
      var contextPanel = document.getElementById('context-panel'), contextSearch = document.getElementById('context-search');
      var latestContext = function (kind) { return window.__received.filter(function (m) { return m.type === kind; }).pop(); };
      var contextWait = function () { return new Promise(function (r) { setTimeout(r, 150); }); };
      document.getElementById('context-open').click(); await contextWait(); cq = latestContext('composerQuery');
      assert('上下文入口独立搜索且保留消息', !contextPanel.hidden && cq.origin === 'context' && cq.source === 'search' && ci.value === '保留这段消息' && sentCount() === before);
      receive({ type: 'composerSuggestions', origin: 'context', source: 'search', requestId: cq.requestId, items: [{ id: 'context-file', kind: 'file', label: '<img>.js', description: '全文件' }] });
      assert('独立候选仍按文本显示', document.querySelectorAll('#context-options button').length === 1 && !document.querySelector('#context-options img'));
      contextSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); select = latestContext('composerSelect');
      var snapshotBody = '中文正文\\r\\n尾部空白  \\n<img src=x>\\n';
      var snapshotItem = { id: 'context-file', kind: 'content', scope: 'file', name: 'very-long-file-name.js', sourcePath: '/context-project/src/a-long-folder/very-long-file-name.js', text: snapshotBody, isDirty: true, snapshotAt: '2026-10-12T03:00:00.000Z', byteLength: new TextEncoder().encode(snapshotBody).length };
      receive({ type: 'composerSelected', origin: 'context', source: 'search', cwd: '/context-project', requestId: select.requestId, item: snapshotItem });
      assert('独立选择仅附加且不移除消息正文', ci.value === '保留这段消息' && document.querySelectorAll('#attachments .chip').length === 1 && sentCount() === before);
      var previewTrigger = document.querySelector('#attachments .chip-label'); previewTrigger.click();
      var preview = document.getElementById('attachment-preview'), previewBody = document.getElementById('preview-body');
      assert('预览只读且正文逐字一致', !preview.hidden && previewBody.tagName === 'PRE' && !previewBody.isContentEditable && previewBody.textContent === snapshotBody && !preview.querySelector('img'));
      assert('预览包含实际来源范围保存状态时间和字节', document.getElementById('preview-meta').textContent.includes(snapshotItem.sourcePath) && document.getElementById('preview-meta').textContent.includes('全文件') && document.getElementById('preview-meta').textContent.includes('未保存') && document.getElementById('preview-meta').textContent.includes('字节'));
      document.getElementById('preview-close').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      assert('预览键盘焦点可到达正文并循环', document.activeElement === previewBody);
      receive({ type: 'busy', busy: true }); var stops = window.__received.filter(function (m) { return m.type === 'stop'; }).length;
      previewBody.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert('预览 Esc 消费按键恢复附件焦点且不停止任务', preview.hidden && document.activeElement === previewTrigger && window.__received.filter(function (m) { return m.type === 'stop'; }).length === stops);
      document.getElementById('context-open').click();
      contextSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert('上下文 Esc 优先关闭且恢复按钮焦点', contextPanel.hidden && document.activeElement === document.getElementById('context-open') && window.__received.filter(function (m) { return m.type === 'stop'; }).length === stops);
      receive({ type: 'busy', busy: false });
      document.querySelector('.composer-shortcuts [data-context-add="file"]').click(); select = latestContext('contextAdd');
      assert('当前文件一步加入使用明确全文件来源', select.source === 'file' && select.origin === 'context' && ci.value === '保留这段消息');
      var cancelCount = window.__received.filter(function (m) { return m.type === 'composerCancel'; }).length;
      ci.value += '，补充问题'; ci.dispatchEvent(new Event('input'));
      assert('读取快照期间继续编辑不取消读取或误发送', window.__received.filter(function (m) { return m.type === 'composerCancel'; }).length === cancelCount && sentCount() === before);
      receive({ type: 'composerSelected', origin: 'context', requestId: select.requestId, cwd: '/context-project', item: Object.assign({}, snapshotItem, { text: '更新后的快照' }) });
      assert('再次加入更新快照且给出明确反馈', document.querySelectorAll('#attachments .chip').length === 1 && document.getElementById('hint').textContent.includes('更新快照'));
      document.querySelector('.composer-shortcuts [data-context-add="selection"]').click(); select = latestContext('contextAdd');
      receive({ type: 'composerSelected', origin: 'context', requestId: select.requestId, cwd: '/context-project', item: { id: 'selection-snapshot', kind: 'selection', scope: 'selection', name: 'a.js', text: '仅选区', sourcePath: '/context-project/a.js', startLine: 2, endLine: 3, startCharacter: 1, endCharacter: 0, snapshotAt: snapshotItem.snapshotAt, isDirty: false } });
      assert('全文件与选区分别加入且不覆盖消息', select.source === 'selection' && document.querySelectorAll('#attachments .chip').length === 2 && ci.value === '保留这段消息，补充问题');
      document.getElementById('context-open').click(); document.querySelector('[data-context-source="skill"]').click(); await contextWait(); cq = latestContext('composerQuery');
      receive({ type: 'composerSuggestions', origin: 'context', source: 'skill', requestId: cq.requestId, items: [{ id: 'command:help', kind: 'command', label: '不应执行' }, { id: 'only-skill', kind: 'skill', label: '技能' }] });
      assert('独立技能入口只展示技能不混入命令', cq.source === 'skill' && document.querySelectorAll('#context-options button').length === 1 && document.getElementById('context-options').textContent === '技能');
      document.querySelector('#context-options button').click(); select = latestContext('composerSelect');
      receive({ type: 'meta', cwd: '/context-project', trusted: true, sessionId: 'another-session' });
      receive({ type: 'composerSelected', origin: 'context', requestId: select.requestId, cwd: '/context-project', item: { id: 'late-skill', kind: 'skill', name: '迟到技能', text: 'late' } });
      assert('同目录会话变化丢弃迟到添加', !document.getElementById('attachments').textContent.includes('迟到技能'));
      document.getElementById('send').click(); sent = latestContext('send');
      assert('最终发送附件仍为已确认快照和元数据', sent.attachments[0].text === '更新后的快照' && sent.attachments[0].sourcePath === snapshotItem.sourcePath && sent.attachments[1].text === '仅选区' && sent.attachments[1].endLine === 3);
      receive({ type: 'sendResult', requestId: sent.requestId, success: false });
      receive({ type: 'meta', cwd: '/context-project', trusted: true });
      document.querySelector('.composer-shortcuts [data-context-add="file"]').click(); select = latestContext('contextAdd');
      receive({ type: 'meta', cwd: '/context-project', trusted: true, sessionId: 'initial-connected-session' });
      receive({ type: 'composerSelected', origin: 'context', requestId: select.requestId, item: { id: 'initial-late', kind: 'content', name: 'initial-late.txt', text: 'late' } });
      assert('首次连接改变会话身份也解除旧读取等待', !document.getElementById('send').disabled && !document.getElementById('attachments').textContent.includes('initial-late'));
      var extras = Array.from({ length: 18 }, function (_, n) { return { id: 'limit-' + n, kind: 'content', name: n + '.txt', text: '小附件' }; });
      receive({ type: 'attach', items: extras });
      assert('20项附件上限允许恰好20项', document.querySelectorAll('#attachments .chip').length === 20);
      receive({ type: 'attach', items: [{ id: 'limit-21', kind: 'content', name: '21.txt', text: '超限' }] });
      assert('第21项拒绝并保留现有正文附件', document.querySelectorAll('#attachments .chip').length === 20 && ci.value === '保留这段消息，补充问题' && document.getElementById('hint').textContent.includes('20 项'));
      document.querySelectorAll('#attachments .chip-close').forEach(function (button) { button.click(); });
      var exactUtf8 = '中'.repeat(87381) + 'a';
      receive({ type: 'attach', items: [{ id: 'utf8', kind: 'content', name: 'utf8.txt', text: exactUtf8 }] });
      assert('UTF-8总量恰好256KiB允许加入', document.querySelectorAll('#attachments .chip').length === 1 && new TextEncoder().encode(exactUtf8).length === 256 * 1024);
      receive({ type: 'attach', items: [{ id: 'utf8', kind: 'content', name: 'utf8.txt', text: exactUtf8 + '中' }] });
      document.querySelector('#attachments .chip-label').click();
      assert('UTF-8超限更新不破坏原快照', document.getElementById('preview-body').textContent === exactUtf8 && ci.value === '保留这段消息，补充问题');
      document.getElementById('preview-close').click();
      document.querySelectorAll('#attachments .chip-close').forEach(function (button) { button.click(); });
      receive({ type: 'attach', items: [{ id: 'legacy', kind: 'file', name: 'legacy.txt', uri: 'file:///context-project/legacy.txt' }] });
      document.querySelector('#attachments .chip-label').click();
      assert('旧链接明确提示重新添加且不假预览磁盘正文', document.getElementById('preview-body').hidden && document.getElementById('preview-note').textContent.includes('重新添加'));
      document.getElementById('preview-close').click();
      document.querySelectorAll('#attachments .chip-close').forEach(function (button) { button.click(); });
      before = sentCount();
      for (var contextKind of ['diff', 'diagnostics']) {
        document.getElementById('context-open').click(); document.querySelector('[data-context-source="' + contextKind + '"]').click(); await contextWait(); cq = latestContext('composerQuery');
        assert('工作区上下文来源独立筛选 ' + contextKind, cq.source === contextKind && document.getElementById('context-search-label').textContent.includes('按文件名') && sentCount() === before);
        receive({ type: 'composerSuggestions', origin: 'context', source: contextKind, requestId: cq.requestId, items: [{ id: contextKind, kind: contextKind === 'diff' ? 'git-diff' : 'diagnostics', label: contextKind === 'diff' ? '未暂存变更' : '问题诊断' }] });
        document.querySelector('#context-options button').click(); select = latestContext('composerSelect');
        receive({ type: 'composerSelected', origin: 'context', source: contextKind, cwd: '/context-project', requestId: select.requestId, item: { id: contextKind, kind: 'content', scope: contextKind === 'diff' ? 'git-diff' : 'diagnostics', name: contextKind, sourcePath: '/context-project', text: 'snapshot <img> safe', snapshotAt: snapshotItem.snapshotAt } });
        document.querySelectorAll('#attachments .chip-label')[contextKind === 'diff' ? 0 : 1].click();
        assert('工作区上下文可预览且明确来源限制 ' + contextKind, document.getElementById('preview-body').textContent === 'snapshot <img> safe' && document.getElementById('preview-note').textContent.includes(contextKind === 'diff' ? '未跟踪文件' : '没有运行测试') && sentCount() === before);
        document.getElementById('preview-close').click();
      }
      receive({ type: 'meta', cwd: '/untrusted', trusted: false });
      assert('信任撤销清附件并禁用新入口', document.getElementById('attachments').hidden && document.getElementById('context-open').disabled);
      cq = await type('/help'); receive({ type: 'composerSuggestions', requestId: cq.requestId, items: [{ id: 'command:help', kind: 'command', label: '/help' }] }); key('Enter'); command = latestContext('composerCommand');
      receive({ type: 'composerSelected', requestId: command.requestId, command: true });
      assert('受限工作区仍正确处理允许的命令回执', ci.value === '' && !document.getElementById('hint').textContent.includes('正在执行'));
    }
    if (EXPECT.usabilityScene) {
      var uiInput = document.getElementById('input'), uiSend = document.getElementById('send'), uiStop = document.getElementById('stop');
      function receiveUi(message) { window.dispatchEvent(new MessageEvent('message', { data: message })); }
      function countUi(type) { return window.__received.filter(function (message) { return message.type === type; }).length; }
      function latestUi(type) { return window.__received.filter(function (message) { return message.type === type; }).pop(); }
      function setUiText(text) { uiInput.value = text; uiInput.setSelectionRange(text.length, text.length); uiInput.dispatchEvent(new Event('input')); }
      function uiEscape(target, options) { (target || document).dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: 'Escape', bubbles: true, cancelable: true }, options || {}))); }
      receiveUi({ type: 'busy', busy: true });
      setUiText('排队请求一'); uiSend.click();
      var firstQueued = latestUi('send');
      assert('排队接受前保留草稿并禁止重复提交', uiInput.value === '排队请求一' && uiSend.disabled);
      setUiText('后续尚未提交的草稿');
      receiveUi({ type: 'sendResult', requestId: firstQueued.requestId, success: true, phase: 'accepted', queued: true, id: 'queued-one' });
      assert('迟到的接受确认不会清空更新后的草稿', uiInput.value === '后续尚未提交的草稿');
      receiveUi({ type: 'sendCompleted', requestId: firstQueued.requestId, id: 'queued-one', success: false, retained: true });
      assert('失败项保留队列时不重复恢复到输入框', uiInput.value === '后续尚未提交的草稿' && document.getElementById('recover-draft').hidden);
      var queueItems = [{ id: 'queued-one', text: '<img src=x>排队请求一', attachmentCount: 1, cwd: '/fixture', sessionId: 'session-active' }, { id: 'queued-two', text: '排队请求二', attachmentCount: 0, cwd: '/fixture', sessionId: 'session-active' }];
      receiveUi({ type: 'queueState', items: queueItems, paused: false });
      var queueList = document.getElementById('queue-list');
      assert('队列显示顺序和附件数量且正文作为文本', queueList.querySelectorAll('.queue-item').length === 2 && queueList.textContent.indexOf('1 个附件') >= 0 && !queueList.querySelector('img'));
      queueList.querySelector('[data-action="remove"][data-id="queued-two"]').click();
      assert('移除待发项带正确身份', latestUi('queueAction').action === 'remove' && latestUi('queueAction').id === 'queued-two');
      queueList.querySelector('[data-action="edit"][data-id="queued-one"]').click();
      assert('取回编辑只请求指定队列项', latestUi('queueAction').action === 'edit' && latestUi('queueAction').id === 'queued-one');
      receiveUi({ type: 'queueState', items: [queueItems[1]], paused: false });
      receiveUi({ type: 'queueEdit', id: 'queued-one', text: '取回的消息', attachments: [{ id: 'queued-file', kind: 'content', name: 'queued.js', text: 'queued snapshot' }] });
      assert('队列取回不覆盖正在编辑的草稿', uiInput.value === '后续尚未提交的草稿' && !document.getElementById('recover-draft').hidden);
      assert('当前和恢复草稿都占用时禁用继续取回', queueList.querySelector('[data-action="edit"][data-id="queued-two"]').disabled);
      setUiText('');
      document.getElementById('recover-draft').click();
      assert('取回消息恢复正文和附件而不自动发送', uiInput.value === '取回的消息' && document.querySelectorAll('#attachments .chip').length === 1 && countUi('send') === 1);
      receiveUi({ type: 'queueState', items: [queueItems[1]], paused: true, reason: '上一个任务未完成' });
      receiveUi({ type: 'busy', busy: false });
      assert('暂停队列显示原因和继续入口', document.getElementById('queue-summary').textContent.indexOf('未完成') >= 0 && visible(document.getElementById('queue-continue')));
      document.getElementById('queue-continue').click();
      assert('继续队列是独立动作不重发草稿', latestUi('queueAction').action === 'continue' && countUi('send') === 1);
      receiveUi({ type: 'queueState', items: [], paused: false });
      assert('后端清空队列后入口隐藏', !visible(document.getElementById('queue')));
      document.querySelectorAll('#attachments .chip-close').forEach(function (button) { button.click(); }); setUiText('');

      receiveUi({ type: 'replay', card: { id: 'read-only-history', title: '历史只读测试' }, entries: [{ kind: 'assistant', text: '历史内容' }] });
      receiveUi({ type: 'historyState', readonly: true, id: 'read-only-history' });
      var readOnlySends = countUi('send'); setUiText('不得发送到原会话'); uiSend.click();
      uiInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert('历史回放持续显示只读上下文且不能发送', uiInput.readOnly && uiSend.disabled && visible(document.getElementById('history-context')) && countUi('send') === readOnlySends);
      document.getElementById('history-resume').click();
      assert('继续此历史会话发送正确身份', latestUi('historyResume').id === 'read-only-history');
      receiveUi({ type: 'historyState', readonly: true, id: 'read-only-history', reason: '上下文未能恢复' });
      assert('恢复失败仍保持只读并说明原因', uiInput.readOnly && document.getElementById('history-context-text').textContent.indexOf('未能恢复') >= 0);
      document.getElementById('history-back').click();
      assert('返回当前对话使用独立动作', !!latestUi('historyBack'));
      receiveUi({ type: 'conversationSnapshot', events: [{ type: 'assistant', id: 'active-restored' }, { type: 'text', id: 'active-restored', delta: '活动对话正文' }, { type: 'done', id: 'active-restored', status: 'done' }] });
      receiveUi({ type: 'historyState', readonly: false });
      assert('实际恢复状态到达后才解除只读', !uiInput.readOnly && !uiSend.disabled && !visible(document.getElementById('history-context')));
      receiveUi({ type: 'conversationSnapshot', events: [{ type: 'replay', readonly: false, card: { id: 'resumed-live', title: '已接回的会话' }, entries: [{ kind: 'assistant', text: '恢复后的上下文' }] }] });
      assert('恢复到活动对话的回放说明可以直接继续', document.getElementById('messages').textContent.indexOf('已恢复的对话') >= 0 && document.getElementById('messages').textContent.indexOf('可在下方继续对话') >= 0 && !uiInput.readOnly);

      var presetItems = [{ id: 'standard', name: '标准模式', description: '日常工作' }, { id: 'ptc', name: '工具模式', description: '使用工具' }];
      receiveUi({ type: 'presets', current: 'standard', pending: 'ptc', presets: presetItems });
      var pendingPreset = document.getElementById('preset-note');
      assert('当前模式保持真实值并持续显示待生效模式', document.getElementById('preset-select').value === 'standard' && visible(pendingPreset) && pendingPreset.textContent.indexOf('工具模式') >= 0);
      document.getElementById('preset-new').click();
      assert('待生效模式提供明确新建入口', !!latestUi('newSession'));
      receiveUi({ type: 'presets', current: 'ptc', pending: undefined, presets: presetItems });
      assert('实际生效后更新模式并清掉待生效提示', document.getElementById('preset-select').value === 'ptc' && !visible(pendingPreset));

      receiveUi({ type: 'busy', busy: true }); setUiText('Esc 保留的草稿');
      receiveUi({ type: 'attach', items: [{ id: 'esc-preserved-file', kind: 'content', name: 'escape-context.js', text: 'escaped context' }] }); uiInput.focus();
      var stopCount = countUi('stop'); uiEscape(uiInput);
      assert('输入区 Esc 可以停止但不会清空草稿或附件', countUi('stop') === stopCount + 1 && uiInput.value === 'Esc 保留的草稿' && document.querySelectorAll('#attachments .chip').length === 1);
      stopCount = countUi('stop');
      setUiText('@'); await new Promise(function (resolve) { setTimeout(resolve, 150); });
      uiEscape(uiInput);
      assert('忙时 Esc 优先关闭候选', document.getElementById('composer-menu').hidden && countUi('stop') === stopCount);
      document.getElementById('history-btn').click(); uiEscape(document);
      assert('忙时 Esc 优先关闭历史', !visible(document.getElementById('history')) && countUi('stop') === stopCount);
      receiveUi({ type: 'permissionState', currentValue: 'workspace-write', label: '工作区内修改', options: [{ value: 'workspace-write', label: '工作区内修改', description: '工作区', active: true }] });
      document.getElementById('access-btn').click(); uiEscape(document);
      assert('忙时 Esc 优先关闭权限设置', !visible(document.getElementById('access-pop')) && countUi('stop') === stopCount);
      document.getElementById('messages').focus();
      uiInput.dispatchEvent(new CompositionEvent('compositionstart')); uiEscape(document, { isComposing: true });
      assert('输入法组合期间 Esc 不请求停止', countUi('stop') === stopCount);
      uiInput.dispatchEvent(new CompositionEvent('compositionend'));
      setUiText('保留的停止草稿'); document.getElementById('messages').focus(); uiEscape(document);
      assert('非编辑焦点 Esc 请求停止并保留草稿', countUi('stop') === stopCount + 1 && uiInput.value === '保留的停止草稿');
      receiveUi({ type: 'busy', busy: false }); uiEscape(document);
      assert('空闲 Esc 不产生额外停止请求', countUi('stop') === stopCount + 1);
      document.querySelectorAll('#attachments .chip-close').forEach(function (button) { button.click(); });

      receiveUi({ type: 'queueState', active: { id: 'preparing-turn', text: '准备文件基线', attachments: [] }, items: [], paused: false });
      receiveUi({ type: 'busy', busy: false });
      document.getElementById('history-btn').click();
      receiveUi({ type: 'history', sessions: [{ id: 'preparing-history', title: '准备阶段历史', cwd: '/fixture', turns: 1 }] });
      var preparingResume = document.querySelector('#history-list [data-history-resume]');
      document.getElementById('history-close').click();
      assert('准备阶段保持停止和排队入口并暂停切换', !uiStop.hidden && uiSend.getAttribute('aria-label').indexOf('排队') >= 0 && document.getElementById('model-select').disabled && !!preparingResume && preparingResume.disabled);
      setUiText('保留的停止草稿');
      receiveUi({ type: 'attach', items: [{ id: 'preparing-file', kind: 'content', name: 'preparing-context.js', text: 'preparing context' }] });
      var preparingStops = countUi('stop'); uiEscape(uiInput);
      assert('准备阶段 Esc 请求停止且保留草稿与附件', countUi('stop') === preparingStops + 1 && uiInput.value === '保留的停止草稿' && document.querySelectorAll('#attachments .chip').length === 1);
      receiveUi({ type: 'queueState', items: [], paused: false });
      assert('活动队列真正结束后才隐藏停止并恢复切换', uiStop.hidden && !document.getElementById('model-select').disabled && !preparingResume.disabled);
      document.querySelectorAll('#attachments .chip-close').forEach(function (button) { button.click(); });

      receiveUi({ type: 'assistant', id: 'result-old' }); receiveUi({ type: 'done', id: 'result-old', status: 'done' });
      receiveUi({ type: 'assistant', id: 'result-new' }); receiveUi({ type: 'done', id: 'result-new', status: 'done' });
      var priorTurn = { id: 'turn-old', messageId: 'result-old', status: 'done', started: Date.now() - 2000, finished: true, finishedAt: Date.now() - 1000, files: [{ id: 'old-file', name: 'old.js', kind: 'modified', canUndo: true, added: 1, removed: 1 }], test: { label: 'unit-test', status: 'passed', exitCode: 0, stale: true, freshness: 'stale', freshnessNote: '测试后文件发生修改', trackedFilesCount: 1 } };
      var newestTurn = { id: 'turn-new', messageId: 'result-new', status: 'done', started: Date.now(), finished: true, files: [{ id: 'new-file', name: 'new.js', kind: 'added', canUndo: true }], test: { label: 'unit-test', status: 'failed', exitCode: 1, stale: false, freshness: 'fresh', trackedFilesCount: 1 } };
      receiveUi({ type: 'workflow', turnId: newestTurn.id, files: newestTurn.files, test: newestTurn.test, turns: [priorTurn, newestTurn] });
      var oldCard = document.querySelector('.turn-result[data-turn="turn-old"]'), newCard = document.querySelector('.turn-result[data-turn="turn-new"]');
      assert('连续两轮结果卡挂在各自回答内', !!oldCard && !!newCard && oldCard.closest('.msg-assistant') !== newCard.closest('.msg-assistant'));
      assert('旧轮陈旧测试不冒充当前通过', !!oldCard && oldCard.textContent.indexOf('old.js') >= 0 && /陈旧|需要重新|需重新|不再代表/.test(oldCard.textContent));
      assert('新轮测试显示实际失败与退出码', !!newCard && newCard.textContent.indexOf('失败') >= 0 && /退出码[^0-9]*1/.test(newCard.textContent));
      if (oldCard) {
        oldCard.open = true;
        var oldDiff = Array.from(oldCard.querySelectorAll('button')).find(function (button) { return button.textContent.indexOf('差异') >= 0; });
        assert('旧轮提供就地差异按钮', !!oldDiff);
        if (oldDiff) oldDiff.click();
        assert('旧轮差异动作定位对应的文件记录', latestUi('workflowAction') && latestUi('workflowAction').action === 'preview' && latestUi('workflowAction').id === 'old-file');
      }
      receiveUi({ type: 'historyState', readonly: true, id: 'read-only-history' });
      assert('历史只读时旧轮撤销不可点击', Array.from(document.querySelectorAll('.turn-result button')).filter(function (button) { return button.textContent.indexOf('撤销') >= 0; }).every(function (button) { return button.disabled; }));
      receiveUi({ type: 'historyState', readonly: false });

      assert('返回当前对话后最新结果卡动作恢复', Array.from(newCard.querySelectorAll('button')).filter(function (button) { return button.textContent.indexOf('差异') >= 0 || button.textContent.indexOf('运行测试') >= 0; }).every(function (button) { return !button.disabled; }));

      receiveUi({ type: 'queueState', active: { id: 'finishing-turn', requestId: 'finishing-request' }, items: [], paused: false });
      var workflowButtons = function () { return Array.from(document.querySelectorAll('.workflow button')).filter(function (button) { return /撤销|运行测试/.test(button.textContent); }); };
      assert('内核空闲但队列仍活动时结果卡和总览禁止测试撤销', workflowButtons().length >= 4 && workflowButtons().every(function (button) { return button.disabled; }));
      receiveUi({ type: 'queueState', items: [], paused: false });
      assert('活动队列收尾结束后最新轮测试和撤销恢复', Array.from(newCard.querySelectorAll('button')).filter(function (button) { return /撤销|运行测试/.test(button.textContent); }).every(function (button) { return !button.disabled; }));

      receiveUi({ type: 'error', message: 'ECONNRESET', human: { title: '连接中断', advice: '可以重新连接', actions: [{ id: 'reconnect', label: '重新连接' }, { id: 'log', label: '查看日志' }] } });
      var actionError = Array.from(document.querySelectorAll('.msg-error')).pop();
      var errorButtons = actionError.querySelectorAll('button'), beforeRepair = countUi('send');
      assert('错误卡有就地恢复动作', errorButtons.length === 2 && errorButtons[0].textContent === '重新连接');
      if (errorButtons[0]) errorButtons[0].click();
      assert('恢复动作只提交允许的动作标识', latestUi('errorAction') && latestUi('errorAction').action === 'reconnect' && countUi('send') === beforeRepair);
      assert('恢复动作保留草稿', uiInput.value === '保留的停止草稿');
      var usabilityRecovery = latestUi('errorAction');
      receiveUi({ type: 'recoveryResult', requestId: usabilityRecovery.requestId, phase: 'completed', success: true, text: '连接已恢复，队列保持暂停' });
      receiveUi({ type: 'queueState', items: [{ id: 'edit-first', text: '第一份取回内容', attachmentCount: 0 }, { id: 'edit-second', text: '第二份取回内容', attachmentCount: 0 }], paused: true });
      queueList.querySelector('[data-action="edit"][data-id="edit-first"]').click();
      queueList.querySelector('[data-action="edit"][data-id="edit-second"]').click();
      assert('取回响应到达前不允许再取回另一项', !window.__received.some(function (message) { return message.type === 'queueAction' && message.action === 'edit' && message.id === 'edit-second'; }));
      assert('发起取回立即禁止发送与继续队列', uiSend.disabled && document.getElementById('queue-continue').disabled);
      receiveUi({ type: 'queueEdit', phase: 'prepared', token: 'edit-first-token', id: 'edit-first', text: '第一份取回内容', attachments: [] });
      assert('取回响应保留当前草稿并提供切换', uiInput.value === '保留的停止草稿' && !document.getElementById('recover-draft').hidden);
      var preparedEdit = latestUi('queueAction'), editActions = countUi('queueAction');
      assert('取回确认携带原消息及当前草稿', preparedEdit.action === 'confirmEdit' && preparedEdit.token === 'edit-first-token' && preparedEdit.draft.text === '保留的停止草稿' && preparedEdit.draft.recoveries.some(function (draft) { return draft.text === '第一份取回内容'; }));
      receiveUi({ type: 'queueEdit', phase: 'prepared', token: 'edit-first-token', id: 'edit-first', text: '第一份取回内容', attachments: [] });
      assert('重复取回准备不重复保存或加入草稿', countUi('queueAction') === editActions && preparedEdit.draft.recoveries.length === 1);
      receiveUi({ type: 'queueEdit', phase: 'completed', token: 'stale-token', id: 'edit-first' });
      assert('旧确认不能解除当前取回等待', uiSend.disabled && document.getElementById('recover-draft').disabled);
      receiveUi({ type: 'queueState', items: [{ id: 'edit-second', text: '第二份取回内容', attachmentCount: 0 }], paused: true });
      receiveUi({ type: 'queueEdit', phase: 'completed', token: 'edit-first-token', id: 'edit-first' });
      assert('持久化完成后解除取回等待', !uiSend.disabled && !document.getElementById('recover-draft').disabled && !document.getElementById('queue-continue').disabled);
      receiveUi({ type: 'queueState', items: [], paused: false });
      setUiText(''); document.getElementById('recover-draft').click();
      uiSend.click(); var editedSend = latestUi('send');
      receiveUi({ type: 'sendResult', requestId: editedSend.requestId, success: true });
      receiveUi({ type: 'queueState', items: [{ id: 'edit-error', text: '取回失败仍留在队列', attachmentCount: 0 }], paused: true });
      setUiText('取回失败时的草稿');
      queueList.querySelector('[data-action="edit"][data-id="edit-error"]').click();
      receiveUi({ type: 'queueEdit', id: 'edit-error', error: '队列项暂时不可取回' });
      assert('取回失败解除等待并保留当前草稿', !queueList.querySelector('[data-action="edit"][data-id="edit-error"]').disabled && uiInput.value === '取回失败时的草稿' && document.getElementById('recover-draft').hidden);
      var retryEditCount = countUi('queueAction');
      queueList.querySelector('[data-action="edit"][data-id="edit-error"]').click();
      assert('取回失败后可以再次请求', countUi('queueAction') === retryEditCount + 1 && latestUi('queueAction').id === 'edit-error');
      receiveUi({ type: 'queueEdit', id: 'edit-error', error: '队列项已不存在' });
      receiveUi({ type: 'queueState', items: [], paused: false });
      setUiText('正在发送的正文');
      receiveUi({ type: 'queueEdit', id: 'draft-conflict', text: '之前取回的恢复正文', attachments: [] });
      uiSend.click(); var conflictingSend = latestUi('send');
      assert('发送等待确认仍保存已有恢复正文', JSON.stringify(window.__draftState).indexOf('之前取回的恢复正文') >= 0);
      document.getElementById('recover-draft').click();
      assert('发送等待确认不能切换待确认草稿', uiInput.value === '正在发送的正文');
      setUiText('等待确认期间写的新正文');
      receiveUi({ type: 'sendResult', requestId: conflictingSend.requestId, success: false });
      assert('发送被拒绝完整保留三份正文', JSON.stringify(window.__draftState).indexOf('之前取回的恢复正文') >= 0 && JSON.stringify(window.__draftState).indexOf('正在发送的正文') >= 0 && uiInput.value === '等待确认期间写的新正文');
      var recoveredTexts = [], beforeRecoverySends = countUi('send');
      for (var recoveryIndex = 0; recoveryIndex < 3; recoveryIndex += 1) { document.getElementById('recover-draft').click(); recoveredTexts.push(uiInput.value); }
      assert('三份保留正文均可通过切换找回', ['正在发送的正文', '之前取回的恢复正文', '等待确认期间写的新正文'].every(function (text) { return recoveredTexts.indexOf(text) >= 0; }));
      assert('循环切换保留草稿不会自动发送', countUi('send') === beforeRecoverySends);
      setUiText('');
      for (var cleanupIndex = 0; cleanupIndex < 4 && !document.getElementById('recover-draft').hidden; cleanupIndex += 1) {
        document.getElementById('recover-draft').click(); uiSend.click(); var conflictCleanup = latestUi('send');
        receiveUi({ type: 'sendResult', requestId: conflictCleanup.requestId, success: true });
      }
      receiveUi({ type: 'workflow', files: [], turns: [] });
      receiveUi({ type: 'presets', presets: [] }); receiveUi({ type: 'permissionState' });
      receiveUi({ type: 'reset' }); setUiText('');
    }
    if (EXPECT.controlsScene) {
      var controlsRecv = function (message) { window.dispatchEvent(new MessageEvent('message', { data: message })); };
      var controlsCount = function (type) { return window.__received.filter(function (message) { return message.type === type; }).length; };
      var controlsLast = function (type) { return window.__received.filter(function (message) { return message.type === type; }).pop(); };
      controlsRecv({ type: 'meta', cwd: '/fixture/long-project-name', sessionId: 'controls-session', trusted: true });
      var onset = document.getElementById('onboarding-stage'), onnext = document.getElementById('onboarding-next');
      assert('顶栏保留完整目录且只展示目录名', document.getElementById('bar-cwd').title === '/fixture/long-project-name' && document.getElementById('bar-cwd').textContent === 'long-project-name');
      assert('连接阶段由顶栏向辅助技术播报', document.getElementById('status-text').getAttribute('role') === 'status' && document.getElementById('status-text').getAttribute('aria-live') === 'polite');
      controlsRecv({ type: 'status', state: 'connecting', detail: '正在同步准备 DSH…' });
      assert('同步阶段保留完整进度并提示等待', document.getElementById('status-text').textContent.indexOf('同步') >= 0 && onnext.textContent.indexOf('请稍候') >= 0);
      controlsRecv({ type: 'status', state: 'ready', detail: '会话已建立' });
      assert('会话连接后移除状态与引导文案且保留连接播报与验证说明', document.getElementById('status-text').textContent === '' && document.getElementById('status-text').getAttribute('aria-label') === '会话已连接' && onnext.hidden && onnext.textContent === '' && document.getElementById('status-text').title.indexOf('实际任务') >= 0);
      controlsRecv({ type: 'notice', text: '已完成同步准备' });
      controlsRecv({ type: 'status', state: 'connecting', detail: '正在建立新会话：等待内核返回当前项目的实际会话身份' });
      assert('首次系统notice不隐藏引导与完整连接阶段', visible(document.getElementById('empty')) && document.getElementById('status-text').textContent.indexOf('建立') >= 0);
      var controlsStatus = document.getElementById('status-text');
      assert('顶栏完整连接阶段换行且可播报', controlsStatus.textContent.indexOf('实际会话身份') >= 0 && controlsStatus.getAttribute('aria-live') === 'polite' && getComputedStyle(controlsStatus).whiteSpace !== 'nowrap');
      controlsRecv({ type: 'error', message: '401 Unauthorized', human: { title: '认证来源待核对', advice: '先查日志', actions: [{ id: 'log', label: '查看日志' }] } });
      assert('首次错误后项目与必要阶段仍可见', visible(document.getElementById('empty')));
      controlsRecv({ type: 'status', state: 'ready', detail: '会话已建立' });
      var controlsConfig = [
        { id: 'model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
        { id: 'reasoning_effort', currentValue: 'low', options: [{ value: 'low', name: '低' }, { value: 'high', name: '高' }] }
      ];
      controlsRecv({ type: 'config', configOptions: controlsConfig });
      var controlsModel = document.getElementById('model-select'), controlsReason = document.getElementById('reasoning-select');
      controlsModel.value = 'model-b'; controlsModel.dispatchEvent(new Event('change'));
      var settingRequest = controlsLast('setModel'), settingCount = controlsCount('setModel');
      assert('设置请求携带当前来源和请求身份', settingRequest && settingRequest.requestId && settingRequest.cwd === '/fixture/long-project-name' && settingRequest.sessionId === 'controls-session');
      assert('等待模型回读显示最后确认值和等待提示', controlsModel.value === 'model-a' && controlsModel.disabled && document.getElementById('hint').textContent.indexOf('确认') >= 0);
      controlsModel.value = 'model-b'; controlsModel.dispatchEvent(new Event('change'));
      assert('快速重复设置等待时不重复请求', controlsCount('setModel') === settingCount && controlsModel.value === 'model-a');
      controlsRecv({ type: 'settingResult', requestId: 'old-setting', phase: 'completed', success: true, text: '旧成功' });
      assert('旧设置回执不能解除当前等待', controlsModel.disabled);
      controlsRecv({ type: 'settingResult', requestId: settingRequest.requestId, phase: 'completed', success: false, error: '实际回读失败' });
      assert('设置失败解锁并保留确认值', !controlsModel.disabled && controlsModel.value === 'model-a' && document.getElementById('hint').textContent.indexOf('回读失败') >= 0);
      controlsReason.value = 'high'; controlsReason.dispatchEvent(new Event('change'));
      var reasonRequest = controlsLast('setOption');
      assert('思考请求等待时仍显示确认值', controlsReason.value === 'low' && controlsReason.disabled && reasonRequest.value === 'high');
      controlsConfig[1].currentValue = 'high'; controlsRecv({ type: 'config', configOptions: controlsConfig });
      assert('真实config更新等待期间的有效值', controlsReason.value === 'high' && controlsReason.disabled);
      controlsRecv({ type: 'settingResult', requestId: reasonRequest.requestId, phase: 'completed', success: true, text: '已确认：高' });
      assert('确认完成后思考恢复可选且显示成功', !controlsReason.disabled && controlsReason.value === 'high' && document.getElementById('hint').textContent.indexOf('已确认') >= 0);
      controlsRecv({ type: 'settingResult', requestId: 'model-command-external', setting: 'model', cwd: '/fixture/long-project-name', sessionId: 'controls-session', phase: 'pending', text: '正在确认原生命令的模型设置' });
      assert('外部模型pending直接入站也锁控件和发送并显示等待', controlsModel.disabled && controlsReason.disabled && document.getElementById('send').disabled && document.getElementById('hint').textContent.indexOf('原生命令') >= 0);
      var externalInput = document.getElementById('input'); externalInput.value = '外部设置等待时的草稿'; externalInput.dispatchEvent(new Event('input'));
      var externalSends = controlsCount('send'); externalInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert('外部模型等待时Enter保留草稿且不发送', controlsCount('send') === externalSends && externalInput.value === '外部设置等待时的草稿');
      controlsConfig[0].currentValue = 'model-b'; controlsRecv({ type: 'config', configOptions: controlsConfig });
      controlsRecv({ type: 'settingResult', requestId: 'model-command-external', setting: 'model', cwd: '/fixture/long-project-name', sessionId: 'controls-session', phase: 'completed', success: true, currentValue: 'model-b', text: '原生命令模型已确认：B' });
      assert('外部模型完成解锁并保留实际回读值', !controlsModel.disabled && !document.getElementById('send').disabled && controlsModel.value === 'model-b' && document.getElementById('hint').textContent.indexOf('已确认') >= 0);
      controlsRecv({ type: 'settingResult', requestId: 'reloaded-setting', setting: 'reasoning_effort', cwd: '/fixture/long-project-name', sessionId: 'controls-session', phase: 'pending', text: '重载界面收到仍在等待的设置' });
      assert('没有本地请求的重载pending也保持设置锁', controlsModel.disabled && controlsReason.disabled && document.getElementById('send').disabled);
      controlsRecv({ type: 'settingResult', requestId: 'reloaded-setting', phase: 'completed', success: false, text: '重载设置未确认' });
      assert('重载设置失败解锁并保留最后确认值', !controlsModel.disabled && !controlsReason.disabled && controlsReason.value === 'high' && document.getElementById('hint').textContent.indexOf('未确认') >= 0);
      var confirmedHint = document.getElementById('hint').textContent;
      controlsRecv({ type: 'settingResult', requestId: 'old-cwd-pending', setting: 'model', cwd: '/fixture/other-project', sessionId: 'controls-session', phase: 'pending', text: '旧目录设置等待' });
      assert('不同目录的旧pending不锁当前界面或替换反馈', !controlsModel.disabled && !document.getElementById('send').disabled && document.getElementById('hint').textContent === confirmedHint);
      controlsRecv({ type: 'settingResult', requestId: 'old-session-pending', setting: 'model', cwd: '/fixture/long-project-name', sessionId: 'old-session', phase: 'pending', text: '旧会话设置等待' });
      assert('不同会话的旧pending不锁当前界面或替换反馈', !controlsModel.disabled && !document.getElementById('send').disabled && document.getElementById('hint').textContent === confirmedHint);
      controlsRecv({ type: 'historyState', readonly: true, id: 'controls-history' }); controlsRecv({ type: 'config', configOptions: controlsConfig });
      assert('历史只读收到config仍锁模型和思考', controlsModel.disabled && controlsReason.disabled);
      var readonlySettingCount = controlsCount('setModel'); controlsModel.value = 'model-b'; controlsModel.dispatchEvent(new Event('change'));
      assert('历史界面无法触发隐藏活动会话模型变更', controlsCount('setModel') === readonlySettingCount);
      controlsRecv({ type: 'historyState', readonly: false });
      controlsRecv({ type: 'queueState', active: { id: 'controls-preparation' }, items: [], paused: false }); controlsRecv({ type: 'config', configOptions: controlsConfig });
      assert('准备收尾收到config仍锁模型思考', controlsModel.disabled && controlsReason.disabled);
      controlsRecv({ type: 'queueState', items: [], paused: true, reason: '恢复后需显式继续' });
      var controlsInput = document.getElementById('input'); controlsInput.value = '恢复必须保留的草稿'; controlsInput.dispatchEvent(new Event('input'));
      controlsRecv({ type: 'error', message: 'ECONNRESET', human: { title: '连接中断', advice: '修复后恢复', recoveryScope: 'controls-error-scope', actions: [{ id: 'reconnect', label: '重新连接' }, { id: 'settings', label: '打开扩展设置' }, { id: 'log', label: '查看日志' }] } });
      var controlsCard = Array.from(document.querySelectorAll('.msg-error')).pop(), controlsButtons = controlsCard.querySelectorAll('button');
      var recoveryBefore = controlsCount('errorAction'); controlsButtons[0].click(); controlsButtons[0].click();
      var recoveryRequest = controlsLast('errorAction');
      assert('重复恢复仅提交一次且绑定错误来源', controlsCount('errorAction') === recoveryBefore + 1 && recoveryRequest.recoveryScope === 'controls-error-scope' && !!recoveryRequest.requestId);
      assert('恢复等待只锁连接动作设置和日志仍可用', controlsButtons[0].disabled && !controlsButtons[1].disabled && !controlsButtons[2].disabled);
      assert('恢复等待保留草稿且没有自动发送', controlsInput.value === '恢复必须保留的草稿' && controlsCount('send') === 0);
      controlsRecv({ type: 'recoveryResult', requestId: 'old-recovery', phase: 'completed', success: true, text: '旧成功' });
      assert('旧恢复回执不能解锁当前恢复', controlsButtons[0].disabled);
      controlsRecv({ type: 'recoveryResult', requestId: recoveryRequest.requestId, phase: 'completed', success: false, text: '恢复失败，请核对设置' });
      assert('恢复失败显示回执且重新允许恢复', !controlsButtons[0].disabled && document.getElementById('hint').textContent.indexOf('恢复失败') >= 0 && controlsInput.value === '恢复必须保留的草稿');
      controlsButtons[0].click(); recoveryRequest = controlsLast('errorAction');
      controlsRecv({ type: 'recoveryResult', requestId: recoveryRequest.requestId, phase: 'completed', success: true, text: '连接已恢复，队列保持暂停' });
      assert('恢复成功明确完成且不重发任务', !controlsButtons[0].disabled && controlsCount('send') === 0 && document.getElementById('hint').textContent.indexOf('保持暂停') >= 0);
      controlsRecv({ type: 'historyState', readonly: true, id: 'controls-history' });
      controlsButtons[0].click(); recoveryRequest = controlsLast('errorAction');
      controlsRecv({ type: 'recoveryResult', requestId: recoveryRequest.requestId, phase: 'completed', success: true, text: '连接已恢复，仍在阅读历史' });
      assert('恢复回执不解除历史只读且日志设置仍可用', controlsInput.readOnly && !controlsButtons[1].disabled && !controlsButtons[2].disabled);
      controlsRecv({ type: 'historyState', readonly: false });
      controlsRecv({ type: 'presets', current: 'standard', pending: 'ptc', presets: [{ id: 'standard', name: '标准模式' }, { id: 'ptc', name: '工具模式' }] });
      controlsRecv({ type: 'permissionState', currentValue: 'workspace-write', label: '工作区内修改', options: [{ value: 'workspace-write', label: '工作区内修改', active: true }] });
      controlsRecv({ type: 'settingResult', requestId: 'permission-controls', setting: 'permission', cwd: '/fixture/long-project-name', sessionId: 'controls-session', phase: 'pending', text: '正在等待权限回读' });
      assert('权限等待锁重连与新建而不锁发送', controlsButtons[0].disabled && document.getElementById('preset-new').disabled && document.getElementById('preset-select').disabled && !document.getElementById('send').disabled);
      var blockedRecoveryCount = controlsCount('errorAction'), blockedNewCount = controlsCount('newSession');
      controlsButtons[0].click(); document.getElementById('preset-new').click();
      assert('权限等待点击切换按钮不会提交恢复或新建', controlsCount('errorAction') === blockedRecoveryCount && controlsCount('newSession') === blockedNewCount);
      if (controlsCount('errorAction') !== blockedRecoveryCount) {
        var unexpectedRecovery = controlsLast('errorAction');
        controlsRecv({ type: 'recoveryResult', requestId: unexpectedRecovery.requestId, phase: 'completed', success: false, text: '未执行恢复' });
      }
      document.getElementById('history-btn').click();
      controlsRecv({ type: 'history', sessions: [{ id: 'permission-history', title: '权限等待中的历史', cwd: '/fixture/long-project-name' }] });
      var permissionHistoryResume = document.querySelector('[data-history-resume]');
      assert('权限等待时新渲染的历史接回按钮也禁用', permissionHistoryResume && permissionHistoryResume.disabled);
      document.getElementById('history-close').click();
      controlsRecv({ type: 'historyState', readonly: true, id: 'permission-history' });
      assert('权限等待中的持续历史继续按钮禁用', document.getElementById('history-resume').disabled);
      controlsRecv({ type: 'historyState', readonly: false });
      controlsRecv({ type: 'queueState', items: [{ id: 'permission-queued', text: '权限等待中的下一条', attachments: [] }], paused: true });
      var permissionQueueContinue = document.getElementById('queue-continue'), continueBefore = controlsCount('queueAction');
      assert('权限等待不锁已暂停队列的显式继续', !permissionQueueContinue.disabled);
      permissionQueueContinue.click();
      assert('权限等待仍可显式请求继续队列', controlsCount('queueAction') === continueBefore + 1 && controlsLast('queueAction').action === 'continue');
      controlsRecv({ type: 'queueState', active: { id: 'permission-active' }, items: [], paused: false });
      assert('权限等待时活动回合仍可排队和停止', !document.getElementById('send').disabled && visible(document.getElementById('stop')) && !document.getElementById('stop').disabled);
      controlsInput.value = '权限确认中仍可排队'; controlsInput.dispatchEvent(new Event('input'));
      var permissionSends = controlsCount('send'), permissionStops = controlsCount('stop');
      controlsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      var permissionSendRequest = controlsLast('send');
      assert('权限等待Enter可以提交下一条排队正文', controlsCount('send') === permissionSends + 1 && permissionSendRequest.text === '权限确认中仍可排队');
      controlsRecv({ type: 'sendResult', requestId: permissionSendRequest.requestId, success: true, phase: 'accepted', queued: true, id: 'permission-next' });
      document.getElementById('stop').click();
      assert('权限等待仍可请求停止当前回合', controlsCount('stop') === permissionStops + 1);
      controlsRecv({ type: 'queueState', items: [], paused: true });
      controlsRecv({ type: 'settingResult', requestId: 'permission-controls', phase: 'completed', success: false, text: '权限回读结束，设置未确认' });
      assert('权限失败完成后会话控制与权限选择重新可用', !controlsButtons[0].disabled && !document.getElementById('preset-new').disabled && !document.getElementById('access-btn').disabled);
      controlsRecv({ type: 'presets', current: 'standard', presets: [] });
      var expiredTest = { id: 'expired-test', turnId: 'expired-turn', label: 'unit', status: 'failed', exitCode: 3, sourceCurrent: false, sourceNote: '测试来源已变化，请重新测试。' };
      controlsRecv({ type: 'workflow', turnId: 'expired-turn', test: expiredTest, files: [], turns: [{ id: 'expired-turn', finished: true, test: expiredTest, files: [] }] });
      var expiredCard = document.querySelector('.turn-result'); expiredCard.open = true;
      assert('连接来源变化的旧结果说明需重跑并禁用证据操作', expiredCard.textContent.indexOf('来源已变化') >= 0 && Array.from(expiredCard.querySelectorAll('button')).filter(function (button) { return /查看此次|附加测试|准备修复|补充日志/.test(button.textContent); }).every(function (button) { return button.disabled; }));
      assert('旧退出状态依然如实显示失败', expiredCard.textContent.indexOf('失败') >= 0 && expiredCard.textContent.indexOf('退出码 3') >= 0);
      assert('关键反馈允许换行而不省略', getComputedStyle(document.getElementById('hint')).whiteSpace !== 'nowrap' && getComputedStyle(onnext).textOverflow !== 'ellipsis');
      controlsRecv({ type: 'workflow', files: [], turns: [] }); controlsRecv({ type: 'reset' });
    }
    if (EXPECT.draftScene) {
      var draftInput = document.getElementById('input'), draftSend = document.getElementById('send');
      assert('窗口恢复文字和未保存附件快照', draftInput.value === '恢复的草稿' && document.querySelectorAll('#attachments .chip').length === 1);
      var reasoning = document.getElementById('reasoning-select');
      assert('思考选项来自内核', reasoning.options.length === 2 && reasoning.value === 'low');
      reasoning.value = 'high'; reasoning.dispatchEvent(new Event('change'));
      assert('思考选择原样发送', window.__received.some(function(m) { return m.type === 'setOption' && m.id === 'reasoning_effort' && m.value === 'high'; }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'busy', busy: true } }));
      assert('模型运行时禁止切换思考强度', reasoning.disabled);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'busy', busy: false } }));
      var draftSetting = window.__received.filter(function (m) { return m.type === 'setOption'; }).pop();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'settingResult', requestId: draftSetting.requestId, phase: 'completed', success: true, text: '思考已确认' } }));
      draftSend.click(); var draftSent = window.__received.filter(function(m) { return m.type === 'send'; }).pop();
      assert('待发送内容在窗口状态中保存', JSON.stringify(window.__draftState).indexOf('恢复的草稿') >= 0);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: draftSent.requestId + 1, success: false } }));
      assert('过期发送结果不会改变待确认的输入', draftInput.value === '恢复的草稿');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: draftSent.requestId, success: false } }));
      assert('发送失败恢复文字和附件', draftInput.value === '恢复的草稿' && document.querySelectorAll('#attachments .chip').length === 1);
      draftSend.click(); draftSent = window.__received.filter(function(m) { return m.type === 'send'; }).pop();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: draftSent.requestId, success: true, phase: 'accepted', id: 'draft-turn' } }));
      assert('接受消息后才清空原草稿', draftInput.value === '' && document.querySelectorAll('#attachments .chip').length === 0);
      draftInput.value = '新的草稿'; draftInput.dispatchEvent(new Event('input'));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendCompleted', requestId: draftSent.requestId, id: 'draft-turn', success: false } }));
      assert('恢复不会覆盖新的输入', draftInput.value === '新的草稿' && !document.getElementById('recover-draft').hidden);
      document.getElementById('recover-draft').click();
      assert('可以手动切回失败的内容', draftInput.value === '恢复的草稿');
      document.getElementById('recover-draft').click();
      assert('新草稿仍然保留', draftInput.value === '新的草稿');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'draftRestore', draft: { version: 1, cwd: '/fixture', savedAt: Date.now(), text: '迟到的旧草稿' } } }));
      assert('迟到的恢复消息不覆盖正在编辑的草稿', draftInput.value === '新的草稿');
      function draftReceive(message) { window.dispatchEvent(new MessageEvent('message', { data: message })); }
      function draftText(text) { draftInput.value = text; draftInput.dispatchEvent(new Event('input')); }
      var projectB = { version: 1, cwd: '/fixture-b', savedAt: Date.now(), text: 'B 已有正文', attachments: [{ kind: 'content', id: 'b-file', name: 'b.txt', text: 'B 附件快照' }], recoveries: [{ text: 'B 保留正文', attachments: [{ kind: 'content', id: 'b-held', name: 'held.txt', text: 'B 保留附件' }] }] };
      draftReceive({ type: 'meta', cwd: '/fixture-b', trusted: true });
      assert('首次切换工作目录清空旧项目正文附件和恢复按钮', draftInput.value === '' && document.querySelectorAll('#attachments .chip').length === 0 && document.getElementById('recover-draft').hidden);
      var departingA = window.__received.filter(function(m) { return m.type === 'draft' && m.draft.cwd === '/fixture'; }).pop();
      assert('离开目录保存原目录完整草稿而非覆盖目标', departingA && departingA.draft.text === '新的草稿' && departingA.draft.recoveries.some(function(d) { return d.text === '恢复的草稿' && d.attachments.length === 1; }));
      draftReceive({ type: 'draftRestore', cwd: '/fixture', draft: { version: 1, cwd: '/fixture', savedAt: Date.now(), text: '迟到的 A' } });
      assert('新目录尚未编辑时也拒绝迟到其他目录恢复', draftInput.value === '' && document.getElementById('recover-draft').hidden);
      draftReceive({ type: 'draftRestore', cwd: '/fixture-b', draft: projectB });
      assert('首次目标目录恢复既有正文附件和保留草稿', draftInput.value === 'B 已有正文' && document.querySelectorAll('#attachments .chip').length === 1 && !document.getElementById('recover-draft').hidden);
      draftText('B 新编辑正文');
      draftReceive({ type: 'meta', cwd: '/fixture', trusted: true });
      assert('返回 A 恢复 A 正文和恢复集合', draftInput.value === '新的草稿' && !document.getElementById('recover-draft').hidden && document.querySelectorAll('#attachments .chip').length === 0);
      document.getElementById('recover-draft').click();
      assert('往返后 A 保留正文仍有原附件', draftInput.value === '恢复的草稿' && document.querySelectorAll('#attachments .chip').length === 1);
      draftReceive({ type: 'meta', cwd: '/fixture-b', trusted: true });
      assert('返回 B 保留 B 新编辑与附件', draftInput.value === 'B 新编辑正文' && document.querySelectorAll('#attachments .chip').length === 1);
      draftReceive({ type: 'draftRestore', cwd: '/fixture-b', draft: projectB });
      assert('返回 B 编辑标记仍阻止旧持久化正文覆盖', draftInput.value === 'B 新编辑正文');
      document.getElementById('recover-draft').click();
      assert('B 保留正文附件独立于 A', draftInput.value === 'B 保留正文' && document.querySelector('#attachments .chip').textContent.indexOf('held.txt') >= 0);
      draftSend.click(); var delayedB = window.__received.filter(function(m) { return m.type === 'send'; }).pop();
      draftReceive({ type: 'meta', cwd: '/fixture-c', trusted: true });
      draftReceive({ type: 'draftRestore', cwd: '/fixture-c', draft: { version: 1, cwd: '/fixture-c', savedAt: Date.now(), text: 'C 正文', attachments: [] } });
      draftReceive({ type: 'sendResult', requestId: delayedB.requestId, success: true, phase: 'accepted' });
      draftReceive({ type: 'sendCompleted', requestId: delayedB.requestId, success: false, cwd: '/fixture-b' });
      assert('跨目录迟到发送确认和失败不清空或混入 C 草稿', draftInput.value === 'C 正文' && document.getElementById('recover-draft').hidden);
      draftReceive({ type: 'meta', cwd: '/fixture-b', trusted: true });
      assert('迟到失败正文及附件只恢复原 B 目录', draftInput.value === 'B 保留正文' && document.querySelector('#attachments .chip').textContent.indexOf('held.txt') >= 0);
      draftReceive({ type: 'meta', cwd: '/fixture-b', trusted: false });
      assert('同目录信任撤销清理当前与保留草稿附件', draftInput.value === 'B 保留正文' && document.querySelectorAll('#attachments .chip').length === 0 && window.__draftState.attachments.length === 0 && window.__draftState.recoveries.every(function(d) { return d.attachments.length === 0; }));
      draftReceive({ type: 'queueEdit', cwd: '/fixture-b', text: '迟到取回正文', attachments: [{ kind: 'content', name: 'private.txt', text: '旧附件' }] });
      assert('信任撤销后迟到取回不恢复旧附件', window.__draftState.recoveries.some(function(d) { return d.text === '迟到取回正文' && d.attachments.length === 0; }));
      draftReceive({ type: 'meta', cwd: '/fixture-limit', trusted: true });
      draftText('小草稿');
      var beforeLargeRecovery = JSON.stringify(window.__draftState), largeRecovery = '大'.repeat(128 * 1024 + 1);
      draftReceive({ type: 'queueEdit', text: largeRecovery, attachments: [] });
      assert('任一保留正文超限时不声称完整持久化', JSON.stringify(window.__draftState) === beforeLargeRecovery && document.getElementById('hint').textContent.indexOf('当前窗口') >= 0);
      draftReceive({ type: 'meta', cwd: '/fixture-limit-other', trusted: true });
      draftReceive({ type: 'meta', cwd: '/fixture-limit', trusted: true });
      document.getElementById('recover-draft').click();
      assert('超限内容在当前窗口跨目录往返仍完整保留', draftInput.value === largeRecovery);
      draftReceive({ type: 'meta', cwd: '/fixture-prune', trusted: true });
      for (var pruneAction of ['remove', 'edit']) {
        draftText('仅队列保留 ' + pruneAction); draftSend.click();
        var pruneSend = window.__received.filter(function(m) { return m.type === 'send'; }).pop();
        draftReceive({ type: 'queueState', items: [{ id: 'prune-' + pruneAction, requestId: pruneSend.requestId, text: '仅队列保留 ' + pruneAction, cwd: '/fixture-prune' }] });
        draftReceive({ type: 'sendResult', requestId: pruneSend.requestId, success: true, phase: 'accepted' });
        draftReceive({ type: 'queueState', items: [] });
        if (pruneAction === 'edit') draftReceive({ type: 'queueEdit', cwd: '/fixture-prune', text: '取回后编辑', attachments: [] });
        draftText('当前正文 ' + pruneAction);
        draftReceive({ type: 'sendCompleted', requestId: pruneSend.requestId, success: false });
        assert('队列' + (pruneAction === 'edit' ? '取回' : '移除') + '后清理已接收草稿索引', draftInput.value === '当前正文 ' + pruneAction && document.getElementById('recover-draft').hidden);
      }
      draftReceive({ type: 'meta', cwd: '/fixture-ack', trusted: true });
      draftText('保存期间的新正文');
      draftReceive({ type: 'queueState', items: [{ id: 'ack-error', text: '需要持久化的取回正文', cwd: '/fixture-ack' }], paused: true });
      document.querySelector('[data-action="edit"][data-id="ack-error"]').click();
      draftReceive({ type: 'queueEdit', phase: 'prepared', token: 'ack-token', id: 'ack-error', cwd: '/fixture-ack', text: '需要持久化的取回正文', attachments: [] });
      draftReceive({ type: 'queueEdit', phase: 'completed', token: 'ack-token', id: 'ack-error', error: '草稿保存失败，原消息仍保留在队列中' });
      assert('取回保存失败解除等待并同时保留队列和两份正文', !draftSend.disabled && document.querySelector('[data-action="remove"][data-id="ack-error"]') && draftInput.value === '保存期间的新正文' && window.__draftState.recoveries.some(function(d) { return d.text === '需要持久化的取回正文'; }) && document.getElementById('hint').textContent.indexOf('保存失败') >= 0);
      draftReceive({ type: 'meta', cwd: '/fixture-ack-other', trusted: true });
      draftText('另一个项目的正文');
      draftReceive({ type: 'queueEdit', phase: 'prepared', token: 'other-cwd-token', id: 'other-cwd', cwd: '/fixture-ack', text: '原目录取回正文', attachments: [] });
      var crossCwdAck = window.__received.filter(function(m) { return m.type === 'queueAction' && m.action === 'confirmEdit'; }).pop();
      assert('跨目录取回确认保存原目录的完整草稿', crossCwdAck.draft.cwd === '/fixture-ack' && crossCwdAck.draft.text === '保存期间的新正文' && crossCwdAck.draft.recoveries.some(function(d) { return d.text === '原目录取回正文'; }) && draftInput.value === '另一个项目的正文');
      draftReceive({ type: 'queueEdit', phase: 'completed', token: 'other-cwd-token', id: 'other-cwd' });
      draftReceive({ type: 'queueState', items: [], paused: false });
      draftReceive({ type: 'meta', cwd: '/fixture', trusted: true });
    }
    // ── 8. 交互：发送 / 换行 / 空输入 / 忙碌时排队 ──
    var input = document.getElementById('input');
    var send = document.getElementById('send');
    var stop = document.getElementById('stop');
    var busying = !stop.hidden;

    if (!busying) {
      window.__received.length = 0;
      input.value = '测试发送';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
      var sent = window.__received.filter(function (m) { return m.type === 'send'; });
      assert('点发送按钮会发出消息', sent.length === 1 && sent[0].text === '测试发送', JSON.stringify(sent));
      assert('接收确认前输入框保留内容', input.value === '测试发送');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: sent[0].requestId, success: true } }));
      assert('接收确认后输入框清空', input.value === '');

      window.__received.length = 0;
      input.value = '回车发送';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert('Enter 会发送', window.__received.some(function (m) { return m.type === 'send'; }));
      var enterSend = window.__received.find(function(m) { return m.type === 'send'; });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: enterSend && enterSend.requestId, success: true } }));

      window.__received.length = 0;
      input.value = '换行不发送';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      assert('Shift+Enter 不发送', !window.__received.some(function (m) { return m.type === 'send'; }));

      window.__received.length = 0;
      input.value = '   ';
      send.click();
      assert('空白输入不发送', !window.__received.some(function (m) { return m.type === 'send'; }));
    } else {
      // 回合执行期间仍可提交下一轮，当前停止动作保持独立。
      assert('忙碌时显示停止和排队入口', !stop.hidden && !send.hidden && send.getAttribute('aria-label').indexOf('排队') >= 0);
      window.__received.length = 0;
      input.value = '忙碌时的下一条';
      send.click();
      var queuedSend = window.__received.filter(function (m) { return m.type === 'send'; }).pop();
      assert('忙碌时提交下一条交由后端排队', !!queuedSend && queuedSend.text === '忙碌时的下一条');
      assert('排队被接收前内容仍保留', input.value === '忙碌时的下一条');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'sendResult', requestId: queuedSend && queuedSend.requestId, success: true, phase: 'accepted', queued: true, id: 'queue-fixture' } }));
      input.value = '忙碌时还能打字';
      assert('忙碌时输入框没被禁用', !input.disabled);
      window.__received.length = 0;
      stop.click();
      assert('点停止会发中断请求', window.__received.some(function (m) { return m.type === 'stop'; }));
    }

    // ── 9. Markdown 脚本是否加载成功 ────────────
    // 此处仅验证「加载顺序 + CSP 放行」，因为**渲染耗时不能在此处测量**：
    // 无头浏览器的虚拟时钟会使同步 CPU 耗时恒为 0。耗时在 test/markdown.js 中测量。
    assert(
      'markdown.js 已加载且早于 main.js 生效',
      Boolean(window.DshMarkdown) && typeof window.DshMarkdown.renderMarkdown === 'function',
      window.DshMarkdown ? '正常' : 'window.DshMarkdown 不存在',
    );
    assert(
      '界面用的是 markdown.js 里的渲染器（不是降级分支）',
      document.getElementById('status-text').textContent.indexOf('界面脚本缺失') === -1,
      document.getElementById('status-text').textContent,
    );

    // ── 10. 将攻击性文本实际注入 DOM，由浏览器解析器判定 ──
    // Node 中只能用正则推测；此处是真实 DOM 解析，结论可靠性最高。
    if (window.DshMarkdown) {
      var host = document.createElement('div');
      // 反引号由 fromCharCode 拼接生成：否则三连反引号会截断 Node 侧的模板字符串。
      var ticks = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
      host.innerHTML = window.DshMarkdown.renderMarkdown(
        '<script>window.__pwned = 1;<\\/script>\\n\\n' +
          '<img src=x onerror="window.__pwned = 2">\\n\\n' +
          '[x](https://a.com"onmouseover="window.__pwned=3)\\n\\n' +
          ticks + 'js" onload="window.__pwned=4\\ncode\\n' + ticks,
      );
      document.body.appendChild(host);
      var created = host.querySelectorAll('script,img,iframe,object,embed,style,link');
      assert('注入的标签没有变成真元素', created.length === 0, '多出了 ' + created.length + ' 个元素');
      var suspicious = 0;
      host.querySelectorAll('*').forEach(function (node) {
        for (var i = 0; i < node.attributes.length; i += 1) {
          var name = node.attributes[i].name.toLowerCase();
          if (name.indexOf('on') === 0 || ['data-href', 'href', 'class'].indexOf(name) === -1) {
            suspicious += 1;
          }
        }
      });
      assert('没有多出 on* 事件属性', suspicious === 0, suspicious + ' 个可疑属性');
      assert('没有任何代码被执行', typeof window.__pwned === 'undefined');
      host.remove();
    }

    // ── 11. 通用视觉检查（每个场景都执行）────────────────
    // 本段替代「人工目视检查」中**可机器判定**的部分：文字被截断、元素横向溢出、
    // 无法点击的按钮、超出面板范围的浮层。外观是否美观无法机器判定（需等待样稿），
    // 但「布局被挤坏」必须每次都能自动发现。
    var root = document.querySelector('.panel') || document.body;
    var clipped = [];
    var undersized = [];
    var escaped = [];
    var rootBox = root.getBoundingClientRect();

    function scrollable(node) {
      if (!node) return false;
      var style = window.getComputedStyle(node);
      return style.overflowX === 'auto' || style.overflowX === 'scroll';
    }

    root.querySelectorAll('*').forEach(function (node) {
      var style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
      var box = node.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;

      // 1) 文字被横向截断（本来就应横向滚动的除外：代码块、pre）。
      var isText = !node.children.length && (node.textContent || '').trim().length > 0;
      var exempt = node.tagName === 'PRE' || scrollable(node) || scrollable(node.parentElement);
      if (isText && !exempt && node.scrollWidth > node.clientWidth + 1) {
        clipped.push(node.className || node.tagName);
      }

      // 2) 可点击元素过小（按钮、关闭叉）：手指/鼠标均难以点中。
      if (node.tagName === 'BUTTON' && (box.height < 20 || box.width < 20)) {
        undersized.push((node.id || node.className || 'button') + ' ' + Math.round(box.width) + '×' + Math.round(box.height));
      }

      // 3) 超出面板范围的浮层（向右或向下越界）。
      if (style.position === 'absolute' || style.position === 'fixed') {
        if (box.right > rootBox.right + 1 || box.bottom > rootBox.bottom + 1) {
          escaped.push(node.className || node.tagName);
        }
      }
    });

    assert('没有文字被横向截断', clipped.length === 0, clipped.join(', '));
    assert('按钮都点得到（不小于 20×20）', undersized.length === 0, undersized.join(', '));
    assert('没有浮层跑到面板外面', escaped.length === 0, escaped.join(', '));

    // 4) 相邻消息之间的间距应当一致（不一致会出现「有的挤有的松」的观感）。
    // 注意判定阈值为 2：消息的类名是 'msg msg-user' / 'msg msg-assistant'，
    // 最初写为 >= 3，而多数场景只有 2 条，该检查从未执行（死代码）。
    var bubbles = [].slice.call(document.querySelectorAll('.msg'));
    if (bubbles.length >= 2) {
      var gaps = [];
      for (var b = 1; b < bubbles.length; b += 1) {
        gaps.push(Math.round(bubbles[b].getBoundingClientRect().top - bubbles[b - 1].getBoundingClientRect().bottom));
      }
      var min = Math.min.apply(null, gaps);
      var max = Math.max.apply(null, gaps);
      assert('消息之间的间距一致（最大最小差不超过 8px）', max - min <= 8, '间距 ' + gaps.join('/') + 'px');
    }

    finish();
  }

  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    var payload = JSON.stringify({ scene: EXPECT.__name || '', results: results });
    // 强制 ASCII 转义：中间可能经过 PowerShell 管道，避免编码破坏中文。
    var ascii = payload.replace(/[\\u0080-\\uffff]/g, function (ch) {
      return '\\\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    });
    var pre = document.createElement('pre');
    pre.id = '__results';
    pre.textContent = ascii;
    document.body.appendChild(pre);
  }

  // 回放脚本最长执行约 1.5s，此处等待其执行完毕后再断言。
  // run() 是 async 的（压力那一段需要让出事件循环等待渲染落定），
  // 因此此处捕获异常 —— 否则一处错误即表现为「页面里没找到断言结果」，难以定位。
  setTimeout(function () {
    run().catch(function (error) {
      results.push({ name: '断言脚本自己抛错了', ok: false, detail: String(error && error.message ? error.message : error) });
      finish();
    });
  }, 2600);
})();
</script>`;
}

function runChrome(scene, profile) {
  const html = buildHtml('dark');
  const steps = TEST_SCENARIOS[scene]().steps;
  // 错误捕获器需置于**最前面**：此后任何一段内联脚本（包括断言脚本）
  // 即使存在语法错误，也会被其捕获并写入 DOM，可从 dump 中读到原因。
  const catcher =
    '<script>window.addEventListener("error", function (e) {' +
    'var p = document.createElement("pre"); p.id = "__pageerror";' +
    'p.textContent = String((e && e.message) || "unknown error");' +
    'document.body.appendChild(p); });</script>';
  const withCatcher = html.replace('</body>', `${catcher}\n</body>`);
  const withReplay = withCatcher.replace('</body>', `${buildReplayScript(steps)}\n</body>`);
  const withChecks = withReplay.replace('</body>', `${assertionsScript(scene)}\n</body>`);

  const page = path.join(WORK, `${scene}.html`);
  fs.writeFileSync(page, withChecks, 'utf8');

  const dom = path.join(WORK, `${scene}.dom.html`);
  const url = pathToFileURL(page).href;
  const platformArgs = process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : [];
  fs.writeFileSync(dom, execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    ...platformArgs, '--force-device-scale-factor=1', '--window-size=420,900', '--virtual-time-budget=9000', `--user-data-dir=${profile}`, '--dump-dom', url],
  { maxBuffer: 16 * 1024 * 1024, timeout: CHROME_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true }));

  const dumped = fs.readFileSync(dom, 'utf8');
  const match = /<pre id="__results">([\s\S]*?)<\/pre>/.exec(dumped);
  if (!match) {
    // 断言脚本未执行完毕（多为生成出的脚本存在语法错误）。
    // 页面最前面已安装错误捕获器，此处将其内容一并返回 —— 否则只得到一句
    // 「没找到断言结果」，需要手动打开 Chrome 才能定位（曾出现该问题）。
    const pageError = /<pre id="__pageerror">([\s\S]*?)<\/pre>/.exec(dumped);
    return {
      error: `页面里没找到断言结果（脚本可能没跑起来）${pageError ? ` —— ${pageError[1]}` : ''}`,
      dumped,
    };
  }
  return { results: JSON.parse(match[1]).results };
}

function main() {
  if (!CHROME) {
    console.log(missingChromeMessage());
    process.exit(2);
  }
  fs.mkdirSync(WORK, { recursive: true });
  const profile = fs.mkdtempSync(path.join(WORK, 'chrome-profile-'));
  try {
  fs.copyFileSync(path.join(ROOT, 'media', 'main.css'), path.join(WORK, 'main.css'));
  fs.copyFileSync(path.join(ROOT, 'media', 'main.js'), path.join(WORK, 'main.js'));
  fs.copyFileSync(path.join(ROOT, 'media', 'markdown.js'), path.join(WORK, 'markdown.js'));

  const only = process.argv[2];
  const scenes = Object.keys(TEST_SCENARIOS).filter((name) => !only || name === only);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const scene of scenes) {
    console.log(`\n── 场景：${scene} ${'─'.repeat(Math.max(0, 40 - scene.length))}`);
    let outcome;
    try {
      outcome = runChrome(scene, profile);
    } catch (error) {
      outcome = { error: error.message, fatal: error.code === 'ETIMEDOUT' };
    }
    if (outcome.error) {
      failed += 1;
      failures.push(`${scene}: ${outcome.error}`);
      console.log(`  ❌ ${outcome.error}`);
      if (outcome.fatal) break;
      continue;
    }
    for (const item of outcome.results) {
      if (item.ok) {
        passed += 1;
        console.log(`  ✅ ${item.name}${item.detail ? `  （${item.detail}）` : ''}`);
      } else {
        failed += 1;
        failures.push(`${scene} / ${item.name} —— ${item.detail}`);
        console.log(`  ❌ ${item.name}${item.detail ? `  —— ${item.detail}` : ''}`);
      }
    }
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

main();
