'use strict';
const path = require('node:path');
function historyOptions(options = {}) {
  return { limit: Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 500) : 100,
    offset: Number.isInteger(options.offset) && options.offset >= 0 ? Math.min(options.offset, 1000000) : 0,
    query: typeof options.query === 'string' ? options.query.trim().slice(0, 256).toLocaleLowerCase() : '',
    cwd: typeof options.cwd === 'string' && path.isAbsolute(options.cwd) ? path.resolve(options.cwd) : '', archived: options.archived === true,
    unlisted: options.archived !== true && options.unlisted === true };
}
function matchesHistory(card, options) {
  const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return (!options.cwd || (card.cwd && identity(card.cwd) === identity(options.cwd))) &&
    (!options.query || `${card.title || ''}\n${card.fallbackTitle || ''}\n${card.cwd || ''}\n${card.id || ''}`.toLocaleLowerCase().includes(options.query));
}
function historyPage(cards, options) {
  const matched = cards.filter(card => matchesHistory(card, options));
  const sessions = matched.slice(options.offset, options.offset + options.limit);
  return pageMetadata(sessions, matched.length, options);
}
function pageMetadata(sessions, total, options) {
  const end = Math.min(total, options.offset + sessions.length);
  return { sessions, total, offset: options.offset, skipped: Math.max(0, total - end),
    ...(end < total ? { nextOffset: end } : {}) };
}
module.exports = { historyOptions, matchesHistory, historyPage, pageMetadata };
