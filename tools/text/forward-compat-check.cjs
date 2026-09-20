/*
 * 向前兼容校验（质量门禁工具，已纳入版本控制：tools/text/）。
 *
 * 校验目标：扩展对权限失败的分类，在新版插件报文与旧版插件报文下必须给出相同结果。
 * 用户机器上可能仍装着我改动之前的旧版插件，因此两个版本的报文都要能被正确分类。
 *
 * 用法：node tools/text/forward-compat-check.cjs
 */
'use strict';
const path = require('node:path');
const { explainPermissionFailure } = require(
  path.join(__dirname, '..', '..', 'packages', 'vscode-extension', 'src', 'dsh', 'permission.js'),
);

/** [分组名, 旧版报文, 新版报文] */
const CASES = [
  [
    '方法名不在清单里（-32601）',
    '门不支持 dsh-door/permission/nope（门版本太旧或方法名不对）',
    '该插件不支持 dsh-door/permission/nope（插件版本过低或方法名不符）',
  ],
  [
    '该方法名不是权限方法（-32601）',
    '门不认识权限方法 dsh-door/permission/nope',
    '该插件不认识权限方法 dsh-door/permission/nope',
  ],
  [
    '内核未挂载权限预设服务（-32601）',
    '这个内核里没有权限预设服务（@deepseek-ai/dsh-permission-presets 没挂）',
    '这个内核里没有权限预设服务（@deepseek-ai/dsh-permission-presets 没挂）',
  ],
  [
    '内核并非 JSON-RPC 之外的协议错误',
    'Method not found',
    'Method not found',
  ],
  [
    '会话不存在（-32003）',
    '没有会话 abc（该会话可能已被关闭）',
    '没有会话 abc（该会话可能已被关闭）',
  ],
];

let failures = 0;
for (const [name, oldText, newText] of CASES) {
  const code = name.includes('-32003') ? -32003 : -32601;
  const oldResult = explainPermissionFailure({ code, message: oldText });
  const newResult = explainPermissionFailure({ code, message: newText });
  const same =
    oldResult.state === newResult.state &&
    oldResult.text === newResult.text &&
    oldResult.detail === newResult.detail;
  if (!same) failures += 1;
  console.log(`${same ? '✅' : '❌'} ${name}`);
  console.log(`     旧版文本 → state=${oldResult.state}  text=${JSON.stringify(oldResult.text)}`);
  console.log(`     新版文本 → state=${newResult.state}  text=${JSON.stringify(newResult.text)}`);
  const leaked = /门|dsh-acp-door|dsh-base|@deepseek-ai|0\.0\.\d|档|profile|dshPanel\.|node_modules|:\d{4,5}/.exec(
    `${newResult.text || ''}${newResult.detail || ''}`,
  );
  if (leaked) {
    failures += 1;
    console.log(`     ❌ 新版对外文案含内部词：${leaked[0]}`);
  }
}
console.log(`\n${failures === 0 ? '✅ 新旧报文分类一致，且对外文案无内部词' : `❌ ${failures} 项不符合预期`}`);
process.exit(failures === 0 ? 0 : 1);
