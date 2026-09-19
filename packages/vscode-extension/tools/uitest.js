'use strict';

/**
 * 界面层自动化测试：在**真浏览器**里跑断言。
 *
 * 为什么这么做：VS Code 的 webview 没法自动点开截图，但我可以把同一套
 * HTML/CSS/JS 丢进无头 Chrome，然后在页面里跑断言，把结果读回来。
 * 这样能测到肉眼容易漏、但一定会犯的东西：
 *   - 横向溢出、元素重叠、输入框被挤出屏幕；
 *   - Markdown 有没有真的渲染成结构（代码块/列表/粗体/引用）；
 *   - 工具卡片有没有正确合并（而不是每帧长一张新卡）；
 *   - 文字对比度是否低到看不清；
 *   - 点工具卡片能不能折叠、按 Enter 能不能发送、Shift+Enter 会不会误发；
 *   - 渲染一屏 Markdown 要多少毫秒（防住 O(n²) 那种写法）。
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

/** 每个场景期望看到的特殊东西。 */
const EXPECTATIONS = {
  // 什么都没发：所有「按需出现」的东西都必须真的藏着。
  bare: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, emptyChrome: true, minAssistantChars: 0 },
  empty: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0 },
  chat: { needsUser: true, needsAssistant: true, needsTools: 2, needsCaret: false, needsPermission: false, minAssistantChars: 300 },
  streaming: { needsUser: true, needsAssistant: true, needsTools: 1, needsCaret: true, needsPermission: false, minAssistantChars: 10 },
  // 权限场景里回合还没结束（在等用户点许可），所以光标应该还在。
  permission: { needsUser: true, needsAssistant: true, needsTools: 0, needsCaret: true, needsPermission: true, needsOptions: 3, minAssistantChars: 5 },
  // 带编辑器上下文：输入框上面该有两块，发出去的那条消息里也该有。
  context: { needsUser: true, needsAssistant: true, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 10, needsAttachments: 2 },
  // 压力场景：正文由断言脚本自己灌（要计时），所以这里不要求已有正文和光标。
  perf: { needsUser: true, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, perf: true },
  // 内核报错：人话在前、原文在后。这段只有一条用户消息 + 一个错误块。
  error: { needsUser: true, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, errorShape: true },
  // 历史会话：浮层、清单、回放、接回 —— 全在断言脚本里现场注入（见那个场景的说明）。
  history: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, historyScene: true },
  // 权限选择器：清单由扩展（内核）给，界面只负责画与点 —— 全在断言脚本里点。
  access: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0, accessScene: true },
};

/**
 * 注入页面里的断言脚本。
 *
 * 所有输出都走 document.title 和一个 <pre id="__results">，
 * 并且把非 ASCII 转义掉 —— 这样即使中间经过 PowerShell 管道，
 * 也不会因为编码问题把中文变成乱码。
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

  // ── 小工具：颜色对比度 ──────────────────────────────
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

    // ── 1. 骨架 ──────────────────────────────────────
    assert('页面渲染出高度', body.getBoundingClientRect().height > 200, body.getBoundingClientRect().height);

    // ── 1.5 该藏的必须真藏住 ─────────────────────────
    // CSS 陷阱：元素一旦被作者样式设成 display:flex，浏览器默认的
    // [hidden] { display: none } 就被盖掉了 —— hidden 属性形同不存在。
    // 所以这里量的是「真的看不见」，而不是只看那个属性。
    var permissionBox = document.getElementById('permission');
    var configRow = document.getElementById('config-row');
    var presetField = document.getElementById('preset-field');
    var meter = document.getElementById('meter');
    var modelCount = document.querySelectorAll('#model-select option').length;
    var presetCount = document.querySelectorAll('#preset-select option').length;
    var meterText = (document.getElementById('meter-text').textContent || '').trim();

    assert('配置行只在有东西可调时才露出', visible(configRow) === (modelCount > 0 || presetCount > 0),
      'visible=' + visible(configRow) + ' model=' + modelCount + ' preset=' + presetCount);
    assert('模式下拉只在门报了清单时才露出', visible(presetField) === (presetCount > 0),
      'visible=' + visible(presetField) + ' preset=' + presetCount);
    assert('用量条只在有数据时才露出', visible(meter) === (meterText.length > 0),
      'visible=' + visible(meter) + ' text=' + meterText);
    // 附件块也是 flex 容器，同一个坑 —— 这里一并量。
    var attachmentBox = document.getElementById('attachments');
    var chipCount = document.querySelectorAll('#attachments .chip').length;
    assert('输入框上面的附件块：有附件才露出',
      visible(attachmentBox) === (chipCount > 0),
      'visible=' + visible(attachmentBox) + ' 附件=' + chipCount);
    if (!EXPECT.needsPermission) {
      assert('权限区默认是藏着的', !visible(permissionBox));
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
      var hasMarkdown = EXPECT.needsTools >= 2; // chat 场景才放了完整 Markdown
      if (hasMarkdown) {
        assert('代码块渲染成 pre>code', document.querySelectorAll('.body pre code').length >= 1);
        assert('粗体渲染成 strong', document.querySelectorAll('.body strong').length >= 1);
        assert('有序列表渲染成 ol>li', document.querySelectorAll('.body ol li').length >= 3);
        assert('引用渲染成 blockquote', document.querySelectorAll('.body blockquote').length >= 1);
        assert('行内代码渲染成 code', document.querySelectorAll('.body p code').length >= 1);
        assert('没有裸露的 Markdown 星号', body0.textContent.indexOf('**') === -1, body0.textContent.slice(0, 60));
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

    // ── 7. 对比度（低到看不清才算失败，其余只报数）──
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
    // 这一段只在带上下文的场景里跑：挂上去看得见吗、点 × 拿得掉吗、
    // 发出去时带上了吗、发完有没有清空、"发出去的那条消息"回头看还认不认得出。
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

      // 每个挂着的小块都要能拿掉 —— 并且是就地拿掉，不用等扩展回话。
      var closes = document.querySelectorAll('#attachments .chip-close');
      assert('每一块都有拿掉的按钮', closes.length === chips.length, closes.length + ' vs ' + chips.length);
      var widthBefore = attachmentBox.getBoundingClientRect().width;
      closes[0].click();
      var after = document.querySelectorAll('#attachments .chip').length;
      assert('点 × 能拿掉一块', after === chips.length - 1, '剩 ' + after);
      assert('拿掉一块之后没把另一块也弄没了', after > 0);
      assert('拿掉之后附件块还在（还剩着东西）', visible(attachmentBox));
      assert('附件块没有横向溢出', attachmentBox.scrollWidth <= attachmentBox.clientWidth + 2,
        attachmentBox.scrollWidth + ' > ' + attachmentBox.clientWidth + '（宽度 ' + widthBefore + '）');

      // 发出去：附件必须跟着走。
      // 注意这里自己取 DOM，不要用第 8 段那两个变量 —— var 会提升，
      // 在这一段还只是 undefined（踩过，整个断言脚本会静默不跑）。
      var ctxInput = document.getElementById('input');
      var ctxSend = document.getElementById('send');
      window.__received.length = 0;
      ctxInput.value = '这两个文件是干嘛的？';
      ctxInput.dispatchEvent(new Event('input', { bubbles: true }));
      ctxSend.click();
      var withAttach = window.__received.filter(function (m) { return m.type === 'send'; });
      assert('带附件时照样发得出去', withAttach.length === 1, JSON.stringify(withAttach));
      if (withAttach.length === 1) {
        var carried = withAttach[0].attachments || [];
        assert('附件跟着消息一起发走了', carried.length === 1, JSON.stringify(carried));
        assert('发走的是没被拿掉的那一块', carried[0] && carried[0].kind === 'selection', JSON.stringify(carried));
        assert('发走的附件带着正文（选区的内容不能丢）', carried[0] && carried[0].text === '<footer class="composer">',
          JSON.stringify(carried[0] && carried[0].text));
      }
      assert('发完之后挂着的附件清空了', document.querySelectorAll('#attachments .chip').length === 0);
      assert('清空之后附件块真的藏起来了', !visible(attachmentBox));

      // 回头看对话记录：那条用户消息应该还看得出当时带了什么。
      var bubbleChips = document.querySelectorAll('.msg-user .bubble .chip');
      assert('发出去的那条消息里，附件还看得见', bubbleChips.length === EXPECT.needsAttachments,
        '有 ' + bubbleChips.length + ' 块');
      assert('历史消息里的附件不带拿掉的按钮（已经发走了）',
        document.querySelectorAll('.msg-user .bubble .chip-close').length === 0);
    }

    // ── 7.6 压力：几百个流式增量的耗时 ────────────────
    // 量的是「灌进去要多久」和「渲染落定后 DOM 有没有失控」。
    // 注意两件事（都是踩过才明白的）：
    // 1. 渲染是攒批的（rAF + 定时兜底），所以灌完之后必须**让出事件循环**再量，
    //    同步死等会把 rAF 永远堵住；
    // 2. 阈值给得很宽松（真实值几百毫秒），只卡数量级的回归 —— 比如有人
    //    把渲染改成"每个增量都重渲染整棵树"。
    if (EXPECT.perf) {
      var messagesNode = document.getElementById('messages');
      var segments = [];
      for (var s = 0; s < 40; s += 1) {
        // 注意换行符必须写成双反斜杠：这段断言脚本本身是个模板字符串，
        // 单反斜杠会在生成时变成真换行，生成出来的脚本直接语法错（踩过）。
        segments.push('## 第 ' + s + ' 节\\n\\n这是第 ' + s + ' 段正文，带 \`inline code\` 和一个列表：\\n\\n- 一\\n- 二\\n- 三\\n');
      }
      var fullText = segments.join('\\n');
      var bodySel = '.msg-assistant .body';

      function snapshot() {
        var node = document.querySelector(bodySel);
        return {
          nodes: messagesNode.querySelectorAll('*').length,
          // 面板里的标题是「# 变 h2、## 变 h3」（markdown.js 里 level = 井号数 + 1）。
          headings: node ? node.querySelectorAll('h3').length : 0,
          chars: node ? node.textContent.length : 0,
        };
      }

      // (1) 一片一片喂：模拟真实流式。
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
      // 让出事件循环等攒批渲染落定（同步死等会把 rAF 永远堵住）。
      await new Promise(function (resolve) { setTimeout(resolve, 800); });
      var settleMs = performance.now() - t0;
      var chunked = snapshot();

      console.log('     流式：' + chunkCount + ' 个增量 / ' + fullText.length + ' 字 → 受理 '
        + Math.round(ingestMs) + 'ms，落定 ' + Math.round(settleMs) + 'ms，'
        + chunked.chars + ' 字、' + chunked.headings + ' 个标题、' + chunked.nodes + ' 个节点');

      assert('几百个增量受理得动（受理 < 1000ms）', ingestMs < 1000, Math.round(ingestMs) + 'ms');
      assert('渲染落定得也快（含 800ms 等待仍 < 3000ms）', settleMs < 3000, Math.round(settleMs) + 'ms');
      // 一个字没丢：正文里的换行/井号会被 markdown 结构吃掉，所以不去比总字数，
      // 而是确认「最后一片也到了」（流式最怕的是尾巴丢了）。
      var tailText = document.querySelector(bodySel) ? document.querySelector(bodySel).textContent : '';
      assert('流式的最后一片也到了（尾巴没丢）',
        tailText.indexOf('第 39 节') >= 0 && tailText.indexOf('第 39 段正文') >= 0,
        '正文长度 ' + chunked.chars + ' 字');
      assert('markdown 结构是真的（40 个小节都成了标题）', chunked.headings === 40, chunked.headings + ' 个标题');

      // (2) 一次喂完同样的内容：DOM 必须跟流式一样 ——
      // 这条才是真正要守的性质：不管分多少片到，结果都一样，没有重复、没有堆积。
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
      // 这里比的是「同样内容两种切法的 DOM 规模」，差一点点正常（换行合并等），
      // 差很多就说明流式路径在重复堆积。
      assert('流式没有堆出多余的 DOM（和一次喂完相比不超过 15%）',
        chunked.nodes <= whole.nodes * 1.15 + 5,
        '流式 ' + chunked.nodes + ' vs 一次喂完 ' + whole.nodes);

      // (3) 长对话：聊了很久之后会怎样。
      // 两件事要守：一是别变成"每来一条就重排整棵树"（那会越用越卡），
      // 二是**别把正在往回翻记录的人拽到底部** —— 这是聊天界面最招人烦的 bug。
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
      // 线性增长：每轮（一问一答）撑不起 60 个节点就说明没有重复堆积。
      assert('节点数随消息线性增长（不超过每轮 60 个）',
        longNodes <= exchanges * 60 + 200,
        longNodes + ' 个节点 / ' + exchanges + ' 轮');

      // 贴着底部时，新消息应当继续贴底。
      messagesNode.scrollTop = messagesNode.scrollHeight;
      await new Promise(function (resolve) { setTimeout(resolve, 120); });
      window.postMessage({ type: 'user', text: '贴底时的最后一句。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      var bottomGap = messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight;
      assert('贴着底时新消息继续贴底（差 < 40px）', bottomGap < 40, '差 ' + Math.round(bottomGap) + 'px');

      // 用户往上翻记录时，**它自己的输出**不许把人拽回底部。
      // 注意这里只喂 assistant 的流式正文，不带 user 消息 —— 分清两件事：
      // 「你自己发了一句」把视图带回底部是合理的（你发的，你要看见）；
      // 「它自己在输出」而你正在往回翻记录，把你拽下去才是招人烦的 bug。
      messagesNode.scrollTop = 0;
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      // 关于「别把我拽回去」这条要怎么测：
      // 界面靠 scroll 事件判断"用户是不是在往回翻"。但这个无头环境**不会**
      // 为程序化改 scrollTop 派发 scroll 事件（实测 0 次 —— 我差一点就把这个
      // 环境特性当成"界面有 bug"报出去了）。所以这里手动派发一个：
      // 界面收到的是一个正常的 scroll 事件，跟我们真的用滚轮往回翻没区别，
      // 区别只在"谁触发的"。真正的滚轮要看真浏览器，那一步在
      // tools/vscode-check.js 里由人眼确认。
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

      // 反过来：你自己发一句，视图回到底部是应该的（不然你会看不见自己刚发的）。
      window.postMessage({ type: 'user', text: '我发一句，应该能看见它。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      var afterSendGap = messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight;
      assert('你自己发消息时，视图会回到底部（差 < 40px）', afterSendGap < 40,
        '差 ' + Math.round(afterSendGap) + 'px');
    }

    // ── 7.6 内核报错：人话在前，原文在后 ──────────────
    // 这一段是给「错误提示改中文人话」立的护栏。以前内核的 429 是原样贴出来的，
    // 用户看到的是一段英文 JSON，只会得出「这插件没法用」。这里量三件事：
    // 人话在前、原文一个字都没少、长 JSON 不会把面板撑破。
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
    // 真实链路是「点开浮层 → 界面向扩展要清单 → 门读盘应答」。
    // 这里扮演扩展的那一半：点按钮后由断言脚本 postMessage 应答，
    // 量的是界面的这一半（浮层、渲染、护栏、按钮发对消息）。
    if (EXPECT.historyScene) {
      var overlay = document.getElementById('history');
      assert('历史浮层默认藏着', !visible(overlay));
      var hbtn = document.getElementById('history-btn');
      assert('历史按钮可见', visible(hbtn));

      window.__received.length = 0;
      hbtn.click();
      assert('点历史按钮浮层打开', visible(overlay));
      assert('打开时向扩展要了清单', window.__received.some(function (m) { return m.type === 'historyList'; }));

      // 扮演扩展应答（形状对着门 0.0.8 的应答抄）。
      window.postMessage({ type: 'history', skipped: 5, sessions: [
        { id: 'session-alpha', title: '修门插件的依赖注入', turns: 12, lastTime: Date.now() - 3600e3, cwd: 'D:/dsh-vscode', preset: 'standard' },
        { id: 'session-beta', title: '重写界面的渲染循环', turns: 4, lastTime: Date.now() - 86400e3, cwd: 'D:/dsh-vscode/packages/vscode-extension', preset: 'ptc' },
        { id: 'session-gamma', title: '', fallbackTitle: '帮我看看这个报错', turns: 1, lastTime: Date.parse('2025-11-02T09:12:00'), cwd: 'C:/Users/Lenovo', decodeError: '有一帧解码失败' },
      ] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      var items = overlay.querySelectorAll('.history-item');
      assert('清单渲染出 3 段会话', items.length === 3, items.length + ' 段');
      assert('统计里写明更早的没列出', (document.getElementById('history-meta').textContent || '').indexOf('5') >= 0,
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

      // 回放：点「回放」→ 界面发 historyOpen → 扩展送回 replay。
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
      assert('回放开头就说明了这是回放（不用先滚到底）',
        noteText.indexOf('回放') >= 0
          && document.querySelector('.msg-note').closest('.msg') === document.querySelector('#messages .msg'),
        noteText);
      assert('回放停在开头，不是底部',
        document.getElementById('messages').scrollTop === 0,
        'scrollTop=' + document.getElementById('messages').scrollTop);

      // 接回：重新打开浮层点「接回」——界面要发 historyResume。
      // 重新打开会清列表显示「正在读取…」，所以再应答一次清单。
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

      // 焦点与键盘：浮层盖住整个面板，所以焦点必须跟着走 ——
      // 打开时进浮层，关掉时回到那个按钮（不然焦点掉到 body，键盘用户就丢了位置）。
      hbtn.click();
      assert('打开浮层时焦点移进了浮层（不在底下的控件上）',
        overlay.contains(document.activeElement),
        document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '无');

      // Esc 关掉浮层：浮层的通用约定，没它键盘用户只能一路 Tab 到关闭按钮。
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert('按 Esc 能关掉浮层', !visible(overlay));
      assert('关掉后焦点还回了历史按钮', document.activeElement === hbtn,
        document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '无');

      // 读失败要长得像"出事了"，不能长得像"你没有历史会话"。
      hbtn.click();
      window.postMessage({ type: 'history', error: '连着的门插件太旧了，读不了历史会话。' }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      var errBox = document.querySelector('#history-list .history-error');
      assert('读失败渲染成错误块（不是空状态）', !!errBox, errBox ? errBox.textContent : '（没有 .history-error）');
      assert('错误块和"还没有历史会话"不是同一套样式',
        !!errBox && errBox.className.indexOf('history-empty') < 0, errBox ? errBox.className : '无');
      assert('错误块带 role=alert（读屏会念出来）', !!errBox && errBox.getAttribute('role') === 'alert');

      // 光有 class 不算数：选择器写错、或者被后面某条规则盖掉，class 照样在，
      // 用户看到的却还是"什么都没有"那套样子。这个项目真踩过一次同类坑
      // （hidden 属性被组件自己的 display 盖掉，空控件一直露在界面上）。
      // 所以这里读**计算出来的样式**，并且拿空状态当对照组。
      window.postMessage({ type: 'history', sessions: [] }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      var emptyBox = document.querySelector('#history-list .history-empty');
      assert('空列表渲染成空状态块（对照组成立）', !!emptyBox,
        emptyBox ? emptyBox.textContent : '（没有 .history-empty）');
      var emptyStyle = emptyBox ? window.getComputedStyle(emptyBox) : null;
      assert('空状态是居中的', !!emptyStyle && emptyStyle.textAlign === 'center',
        emptyStyle ? emptyStyle.textAlign : '取不到');
      // 取值要**当场取成字符串**：等这个节点被错误块替换掉之后，
      // 那个 CSSStyleDeclaration 会解析成空串 —— 拿它去比较会"因为空而不等"，
      // 断言看着通过、其实什么都没验（这个套件里真这么错过一次）。
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
      assert('出过错之后 Esc 照样能关', !visible(overlay));
    }

    // ── 7.8 权限选择器：清单由扩展（内核）给，界面只画与点 ──────────
    // 这一段里的清单来自 tools/preview.js 的 access 场景，而那份载荷是用
    // **生产的翻译函数**（src/dsh/permission.js）生成的 —— 所以这里验到的
    // 标签、说明、确认门，跟真面板上看到的是同一套。
    if (EXPECT.accessScene) {
      var accessField = document.getElementById('access-field');
      var accessBtn = document.getElementById('access-btn');
      var accessPop = document.getElementById('access-pop');
      var accessList = document.getElementById('access-list');
      var accessConfirm = document.getElementById('access-confirm');

      assert('权限那一栏露出来了', visible(accessField));
      assert('按钮上写的是当前档（中文）', (accessBtn.textContent || '').indexOf('工作区内修改') >= 0,
        accessBtn.textContent);
      assert('按钮带悬浮提示', (accessBtn.title || '').length > 0, accessBtn.title);
      assert('小卡片默认藏着', !visible(accessPop));
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

      // 普通档：点一下就切，不需要确认。
      window.__received.length = 0;
      accessItems[0].click();
      assert('点普通档直接发 setPermission',
        window.__received.some(function (m) { return m.type === 'setPermission' && m.value === 'read-only'; }),
        JSON.stringify(window.__received));
      assert('发完就收起来了', !visible(accessPop));

      // 完全权限：必须先过确认门 —— 这一档点了就不再逐条问用户，点错的代价太大。
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
      assert('确认框说清了后果（不再逐条问你）',
        (document.getElementById('access-confirm-body').textContent || '').indexOf('不再逐条') >= 0,
        document.getElementById('access-confirm-body').textContent);
      assert('确认按钮写的是「启用完全权限」',
        document.getElementById('access-confirm-accept').textContent.indexOf('启用完全权限') >= 0,
        document.getElementById('access-confirm-accept').textContent);
      document.getElementById('access-confirm-cancel').click();
      assert('点「算了」回到清单，仍然没发消息',
        window.__received.length === 0 && visible(accessList) && !visible(accessConfirm));
      dangerItem.click();
      document.getElementById('access-confirm-accept').click();
      assert('确认之后才真的发 setPermission',
        window.__received.some(function (m) { return m.type === 'setPermission' && m.value === 'danger-full-access'; }),
        JSON.stringify(window.__received));
      assert('确认后小卡片收起', !visible(accessPop));

      // Esc 与点外面：这两种肌肉记忆都得管用。
      accessBtn.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert('Esc 能关掉小卡片', !visible(accessPop));
      accessBtn.click();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      assert('点别处也能关掉', !visible(accessPop));

      // 切不了的时候（旧门 / 内核没装权限预设）：按钮灰掉 + 说人话，
      // 而且那句话挂在悬浮提示上（顶栏那行放不下长文，完整原因走对话流）。
      window.postMessage({ type: 'permissionState', unavailable: {
        state: 'old-door',
        text: '这里切不了权限（内核里的门太旧）',
        detail: '权限选择需要门插件 dsh-acp-door 0.0.12 以上；把内核那个档里的门升级一下。',
      } }, '*');
      await new Promise(function (resolve) { setTimeout(resolve, 200); });
      assert('切不了时按钮灰掉', accessBtn.disabled === true);
      assert('按钮上写了原因（几个字）', /门太旧/.test(accessBtn.textContent || ''), accessBtn.textContent);
      assert('完整原因挂在悬浮提示里', /0\.0\.12/.test(accessBtn.title || ''), accessBtn.title);
      window.__received.length = 0;
      accessBtn.click();
      assert('灰掉之后点它也不弹清单', !visible(accessPop));
    }

    // ── 8. 交互：发送 / 换行 / 空输入 / 忙碌时不许发 ──
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
      // 正在跑回合时，发送按钮应该让位给停止按钮。
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

    // ── 9. Markdown 脚本是否真的加载上了 ────────────
    // 这里只验「加载顺序 + CSP 放行」，因为**渲染耗时不能在这里量**：
    // 无头浏览器的虚拟时钟会让同步 CPU 耗时恒为 0。耗时在 test/markdown.js 里测。
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

    // ── 10. 把攻击性文本真的塞进 DOM，让浏览器解析器来判 ──
    // Node 里只能用正则猜；这里是真的 DOM 解析，结论最硬。
    if (window.DshMarkdown) {
      var host = document.createElement('div');
      // 反引号用 fromCharCode 拼出来：否则三连反引号会把 Node 这边的模板字符串截断。
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

    // ── 11. 通用视觉体检（每个场景都跑）────────────────
    // 这一段替代"用眼睛扫一遍"里**能机器判**的部分：文字被截断、元素横着溢出、
    // 点不到的按钮、跑到面板外面的浮层。丑不丑机器判不了（那要等样稿），
    // 但"挤坏了"必须每次都能自动发现。
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

      // 1) 文字被横向截断（允许本来就该横向滚动的：代码块、pre）。
      var isText = !node.children.length && (node.textContent || '').trim().length > 0;
      var exempt = node.tagName === 'PRE' || scrollable(node) || scrollable(node.parentElement);
      if (isText && !exempt && node.scrollWidth > node.clientWidth + 1) {
        clipped.push(node.className || node.tagName);
      }

      // 2) 能点的东西太小（按钮、关闭叉）：手指/鼠标都难点。
      if (node.tagName === 'BUTTON' && (box.height < 20 || box.width < 20)) {
        undersized.push((node.id || node.className || 'button') + ' ' + Math.round(box.width) + '×' + Math.round(box.height));
      }

      // 3) 跑到面板外面的浮层（右边或下边露出去）。
      if (style.position === 'absolute' || style.position === 'fixed') {
        if (box.right > rootBox.right + 1 || box.bottom > rootBox.bottom + 1) {
          escaped.push(node.className || node.tagName);
        }
      }
    });

    assert('没有文字被横向截断', clipped.length === 0, clipped.join(', '));
    assert('按钮都点得到（不小于 20×20）', undersized.length === 0, undersized.join(', '));
    assert('没有浮层跑到面板外面', escaped.length === 0, escaped.join(', '));

    // 4) 相邻消息之间的间距应该一致（不一致会看起来"有的挤有的松"）。
    // 注意门槛是 2：消息的类名是 'msg msg-user' / 'msg msg-assistant'，
    // 一开始我写了 >= 3，结果大多数场景只有 2 条，这条检查从来没跑过（死代码）。
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
    // 强制 ASCII 转义：中间可能经过 PowerShell 管道，别让编码毁掉中文。
    var ascii = payload.replace(/[\\u0080-\\uffff]/g, function (ch) {
      return '\\\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    });
    var pre = document.createElement('pre');
    pre.id = '__results';
    pre.textContent = ascii;
    document.body.appendChild(pre);
  }

  // 回放脚本最多跑到约 1.5s，这里等它跑完再断言。
  // run() 是 async 的（压力那一段要让出事件循环等渲染落定），
  // 所以这里接住异常 —— 不然一个错就变成"页面里没找到断言结果"，很难查。
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
  // 错误捕获器要放在**最前面**：这样后面任何一段内联脚本（包括断言脚本）
  // 就算有语法错，也会被它接住、写进 DOM，我们能从 dump 里读到原因。
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
    // 断言脚本没跑完（多半是生成出来的脚本有语法错）。
    // 页面最前面装了错误捕获器，这里把它的内容带回来 —— 否则只有一句
    // "没找到断言结果"，得手动开 Chrome 才查得到（踩过）。
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
