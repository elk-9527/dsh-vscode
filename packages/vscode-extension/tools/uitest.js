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
  empty: { needsUser: false, needsAssistant: false, needsTools: 0, needsCaret: false, needsPermission: false, minAssistantChars: 0 },
  chat: { needsUser: true, needsAssistant: true, needsTools: 2, needsCaret: false, needsPermission: false, minAssistantChars: 300 },
  streaming: { needsUser: true, needsAssistant: true, needsTools: 1, needsCaret: true, needsPermission: false, minAssistantChars: 10 },
  // 权限场景里回合还没结束（在等用户点许可），所以光标应该还在。
  permission: { needsUser: true, needsAssistant: true, needsTools: 0, needsCaret: true, needsPermission: true, needsOptions: 3, minAssistantChars: 5 },
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

  function run() {
    var body = document.body;
    var viewportWidth = window.innerWidth;

    // ── 1. 骨架 ──────────────────────────────────────
    assert('页面渲染出高度', body.getBoundingClientRect().height > 200, body.getBoundingClientRect().height);

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
      var cardBody = card.querySelector('.tool-body');
      var before = cardBody.hidden;
      head.click();
      assert('点卡片能折叠/展开', cardBody.hidden !== before, before + ' → ' + cardBody.hidden);
      head.click();
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
  setTimeout(run, 2600);
})();
</script>`;
}

function runChrome(scene) {
  const html = buildHtml('dark');
  const steps = SCENARIOS[scene]().steps;
  const withReplay = html.replace('</body>', `${buildReplayScript(steps)}\n</body>`);
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
  if (!match) return { error: '页面里没找到断言结果（脚本可能没跑起来）', dumped };
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
