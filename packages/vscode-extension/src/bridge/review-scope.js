'use strict';
const fs = require('node:fs');
const path = require('node:path');
const identity = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
function canonical(file) { try { return identity(fs.realpathSync(file)); } catch { return identity(file); } }
function relatedDocuments(vscode, cwd) {
  const root = canonical(cwd);
  return (vscode.workspace.textDocuments || []).filter(document => {
    if (document.uri?.scheme !== 'file' || !document.isDirty) return false;
    const relative = path.relative(root, canonical(document.uri.fsPath));
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
}
async function prepareReviewScope(vscode, cwd) {
  const documents = relatedDocuments(vscode, cwd);
  if (!documents.length) return '审查依据 Git 磁盘内容；启动时范围内没有未保存编辑。';
  const save = '保存这些文件后审查', disk = '仅审查磁盘内容';
  const choice = await vscode.window.showWarningMessage('审查目录中有未保存编辑', {
    modal: true, detail: documents.map(document => path.relative(cwd, document.uri.fsPath)).join('\n'),
  }, save, disk, '取消');
  if (choice === disk) return `仅审查磁盘内容，未包含启动时 ${documents.length} 个文件的未保存编辑。`;
  if (choice !== save) throw Object.assign(new Error('审查已取消'), { code: -32800 });
  for (const document of documents) {
    if (!await document.save() || document.isDirty) throw new Error('相关文件未能保存，审查已停止。');
  }
  if (relatedDocuments(vscode, cwd).length) throw new Error('保存期间出现新的未保存编辑，请重新开始审查。');
  return `已保存列出的 ${documents.length} 个文件后生成磁盘快照；后续未保存编辑不在审查范围内。`;
}
module.exports = { relatedDocuments, prepareReviewScope, identity: canonical };
