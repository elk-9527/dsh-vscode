'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderHtml } = require('../src/panel/html');
const { describeError } = require('../src/dsh/errors');

/** Runs independently, and as part of the existing static suite. */
function run(check) {
  const cases = [
    ['401 未声明来源', '401 Unauthorized', 'auth-unknown'],
    ['403 未声明来源', 'Request failed with status code 403', 'auth-unknown'],
    ['unknown authentication', 'authentication failed', 'auth-unknown'],
    ['ACP 包装未声明服务商', 'ACP turn error: unauthorized', 'auth-unknown'],
    ['明确无效 API key', '401 Incorrect API key provided', 'auth'],
    ['明确缺少 API key', 'No API key configured', 'auth'],
    ['明确 service provider 拒绝', 'model provider: 403 forbidden', 'auth'],
    ['明确服务商拒绝', 'OpenAI authentication failed', 'auth'],
    ['插件授权过期', '插件操作尚未授权或授权已过期', 'access-auth'],
    ['本机接入身份失败', '无法确认本机接入点身份', 'access-auth'],
    ['Bridge 授权失败', 'bridge authentication expired', 'access-auth'],
    ['额度优先', '429 rate limit from provider, unauthorized', 'usage-limit'],
    ['连接拒绝', 'connect ECONNREFUSED 127.0.0.1:47901', 'connection'],
  ];
  for (const [name, raw, kind] of cases) {
    const result = describeError(raw);
    check(`${name} 使用正确来源分类并保留原文`, result.kind === kind && result.raw === raw, JSON.stringify(result));
    check(`${name} 说明保持可读长度`, result.title.length <= 32 && result.advice.length <= 48);
    if (kind === 'auth-unknown' || kind === 'access-auth') {
      check(`${name} 不断言模型密钥错误或强制重启`, !/密钥无效|更换密钥|需重启/.test(`${result.title} ${result.advice}`));
    }
  }
  const html = renderHtml({ cspSource: 'fixture:', styleUri: 'main.css', markdownUri: 'markdown.js', scriptUri: 'main.js', nonce: 'fixture' });
  check('首屏提供简短标题和下一步且初始内容不为空', ['onboarding-stage', 'onboarding-next'].every(id => new RegExp(`id="${id}"[^>]*>[^<]+<`).test(html)));
  check('连接状态由顶栏统一向读屏软件播报', /id="status-text"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/.test(html));
  check('窄栏隐藏字段标签时仍有模型与模式的可访问名称', /id="model-select"[^>]*aria-label="模型"/.test(html) && /id="preset-select"[^>]*aria-label="模式"/.test(html));
  check('设置与操作反馈可以被读屏软件播报', /id="hint"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
  check('首屏不声称已验证模型凭据或可取消准备', !/模型已可用|凭据已验证|取消准备/.test(html));
  const css = fs.readFileSync(path.join(__dirname, '../media/main.css'), 'utf8');
  const paragraphStyle = css.match(/\.onboarding p\s*\{([^}]*)\}/)?.[1] || '';
  check('首屏说明在窄栏换行，完整路径可以断行', /white-space:\s*normal/.test(paragraphStyle) && /overflow-wrap:\s*anywhere/.test(paragraphStyle) && !/text-overflow:\s*ellipsis|line-clamp/.test(paragraphStyle));
  const feedbackStyle = css.match(/#hint,\s*#workflow-note\s*\{([^}]*)\}/)?.[1] || '';
  check('输入操作与工作流下一步在窄栏完整换行', /white-space:\s*normal/.test(feedbackStyle) && /overflow-wrap:\s*anywhere/.test(feedbackStyle) && /text-overflow:\s*clip/.test(feedbackStyle));
  const webview = fs.readFileSync(path.join(__dirname, '../media/main.js'), 'utf8');
  const chooseSource = webview.match(/function chooseAccess\(option\) \{[\s\S]*?\n  \}/)?.[0];
  check('权限选择保留独立入口', Boolean(chooseSource));
  if (chooseSource) {
    const requests = [];
    const accessBtn = { disabled: false };
    const choose = vm.runInNewContext(`(${chooseSource})`, { el: { accessBtn }, state: {}, requestSetting: (...args) => requests.push(args), closeAccessPop() {} });
    choose(undefined); choose({ selectable: false, value: 'custom' });
    check('无选项与展示项不会发起权限变更', requests.length === 0);
    accessBtn.disabled = true; choose({ value: 'full' });
    check('权限控件锁定后旧入口不会发起变更', requests.length === 0);
    accessBtn.disabled = false; choose({ value: 'workspace' });
    check('兼容旧清单的可选权限只发一次请求', requests.length === 1 && requests[0].join(',') === 'setPermission,permission,workspace');
  }
}

if (require.main === module) {
  let count = 0;
  run((name, condition, detail) => { assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`); count += 1; });
  console.log(`首屏与鉴权来源回归通过：${count} 项`);
}

module.exports = { run };
