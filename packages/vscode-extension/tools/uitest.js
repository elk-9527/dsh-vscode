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
const { SCENARIOS, buildHtml, buildReplayScript, OUT, ROOT } = require('./preview');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WORK = path.join(ROOT, 'build', 'uitest');
const PROFILE = path.join(ROOT, 'build', 'chrome-profile');

/** 每个场景特有的额外期望。 */
const EXPECTATIONS = {
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
    // 用户曾报告：「文字被挤在一起了，模型的占地有点大，其他两点有点小」。
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
      assert('发送后已附加的附件已清空', document.querySelectorAll('#attachments .chip').length === 0);
      assert('清空后附件块已隐藏', !visible(attachmentBox));

      // 回看对话记录：那条用户消息应当仍能看出当时携带的内容。
      var bubbleChips = document.querySelectorAll('.msg-user .bubble .chip');
      assert('已发送的消息中附件仍可见', bubbleChips.length === EXPECT.needsAttachments,
        '有 ' + bubbleChips.length + ' 块');
      assert('历史消息中的附件不带移除按钮（已发送）',
        document.querySelectorAll('.msg-user .bubble .chip-close').length === 0);
    }

    // ── 7.6 压力：几百个流式增量的耗时 ────────────────
    // 测量的是「注入耗时」与「渲染落定后 DOM 是否失控」。
    // 注意两点（均在出现问题后才确认）：
    // 1. 渲染是攒批的（rAF + 定时后备），因此注入完成后必须**让出事件循环**再测量，
    //    同步等待会永久阻塞 rAF；
    // 2. 阈值设置很宽松（真实值几百毫秒），仅拦截数量级的回归 —— 例如将
    //    渲染改为「每个增量都重渲染整棵树」。
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
        { id: 'session-alpha', title: '修门插件的依赖注入', turns: 12, lastTime: Date.now() - 3600e3, cwd: 'D:/dsh-vscode', preset: 'standard' },
        { id: 'session-beta', title: '重写界面的渲染循环', turns: 4, lastTime: Date.now() - 86400e3, cwd: 'D:/dsh-vscode/packages/vscode-extension', preset: 'ptc' },
        { id: 'session-gamma', title: '', fallbackTitle: '帮我看看这个报错', turns: 1, lastTime: Date.parse('2025-11-02T09:12:00'), cwd: 'C:/Users/Lenovo', decodeError: '有一帧解码失败' },
      ] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      var items = overlay.querySelectorAll('.history-item');
      assert('清单渲染出 3 段会话', items.length === 3, items.length + ' 段');
      assert('统计中写明更早的记录未列出', (document.getElementById('history-meta').textContent || '').indexOf('5') >= 0,
        document.getElementById('history-meta').textContent);
      var firstTitle = overlay.querySelector('.history-item-title');
      assert('第一条显示内核生成的标题', !!firstTitle && firstTitle.textContent.indexOf('修门插件') === 0,
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
      window.postMessage({ type: 'replay', truncated: false, card: { id: 'session-alpha', title: '修门插件的依赖注入', turns: 12, lastTime: Date.now() - 3600e3 }, entries: [
        { kind: 'user', text: '门插件报 cannot get property 是怎么回事？' },
        { kind: 'assistant', text: '原因是 cordis 不允许在没有 **inject** 的情况下读服务属性。', thinking: '先查 cordis 的服务解析规则。' },
        { kind: 'tool', name: 'read', args: { file_path: 'lib/index.js' }, output: 'export const inject = [];' },
        { kind: 'assistant', text: '补上 inject 就好了。' },
      ] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
      assert('回放开始后浮层收起来了', !visible(overlay));
      assert('回放重建了用户气泡', document.querySelectorAll('.msg-user .bubble').length === 1,
        document.querySelectorAll('.msg-user .bubble').length + ' 个');
      var bodies = document.querySelectorAll('.msg-assistant .body');
      assert('回放重建了两段回答', bodies.length === 2 && bodies[0].textContent.indexOf('cordis') >= 0,
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
        { id: 'session-alpha', title: '修门插件的依赖注入', turns: 12, lastTime: Date.now() - 3600e3, cwd: 'D:/dsh-vscode', preset: 'standard' },
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
      // ⚠️ 这段文案里**不得含内部词**（插件简称 / 包名 / 版本号 / 档位名）—— 用户提过意见，
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

    // ── 8. 交互：发送 / 换行 / 空输入 / 忙碌时不得发送 ──
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
      assert('发送后输入框清空', input.value === '');

      window.__received.length = 0;
      input.value = '回车发送';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert('Enter 会发送', window.__received.some(function (m) { return m.type === 'send'; }));

      window.__received.length = 0;
      input.value = '换行不发送';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      assert('Shift+Enter 不发送', !window.__received.some(function (m) { return m.type === 'send'; }));

      window.__received.length = 0;
      input.value = '   ';
      send.click();
      assert('空白输入不发送', !window.__received.some(function (m) { return m.type === 'send'; }));
    } else {
      // 回合执行期间，发送按钮应当让位于停止按钮。
      assert('忙碌时显示停止按钮、隐藏发送按钮', !stop.hidden && send.hidden);
      window.__received.length = 0;
      input.value = '忙碌时不该发出去';
      send.click();
      assert('忙碌时点发送不会发消息', !window.__received.some(function (m) { return m.type === 'send'; }));
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

function runChrome(scene) {
  const html = buildHtml('dark');
  const steps = SCENARIOS[scene]().steps;
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
  const url = `file:///${page.replace(/\\/g, '/')}`;
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `& '${CHROME}' --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check ` +
      `--force-device-scale-factor=1 --window-size=420,900 --virtual-time-budget=9000 ` +
      `--user-data-dir='${PROFILE}' --dump-dom '${url}' | Set-Content -Path '${dom}' -Encoding utf8`,
  ].join('; ');

  execFileSync('pwsh', ['-NoProfile', '-Command', script], { stdio: 'inherit' });

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
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'media', 'main.css'), path.join(WORK, 'main.css'));
  fs.copyFileSync(path.join(ROOT, 'media', 'main.js'), path.join(WORK, 'main.js'));
  fs.copyFileSync(path.join(ROOT, 'media', 'markdown.js'), path.join(WORK, 'markdown.js'));

  const only = process.argv[2];
  const scenes = Object.keys(SCENARIOS).filter((name) => !only || name === only);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const scene of scenes) {
    console.log(`\n── 场景：${scene} ${'─'.repeat(Math.max(0, 40 - scene.length))}`);
    let outcome;
    try {
      outcome = runChrome(scene);
    } catch (error) {
      outcome = { error: error.message };
    }
    if (outcome.error) {
      failed += 1;
      failures.push(`${scene}: ${outcome.error}`);
      console.log(`  ❌ ${outcome.error}`);
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
  process.exit(failed === 0 ? 0 : 1);
}

main();
