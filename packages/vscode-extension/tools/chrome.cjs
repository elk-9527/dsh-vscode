'use strict';

const fs = require('node:fs');
const path = require('node:path');

function candidates() {
  return [
    process.env.DSH_PANEL_CHROME,
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}

function findChrome() {
  return candidates().find((candidate) => fs.existsSync(candidate)) || '';
}

function missingChromeMessage() {
  return '找不到可用的 Chrome。请安装 Chrome，或将 DSH_PANEL_CHROME 设置为 chrome.exe 的完整路径。';
}

module.exports = { findChrome, missingChromeMessage };
