'use strict';
/** @type {Set<import('./protocol-types').MessageType>} */
const MESSAGE_TYPES = new Set(['ready', 'send', 'queueAction', 'historyBack', 'errorAction', 'draft',
  'composerQuery', 'contextAdd', 'composerSelect', 'composerCommand', 'workflowAction', 'composerCancel',
  'stop', 'newSession', 'setModel', 'setOption', 'setPreset', 'setPermission', 'refreshPermission',
  'permission', 'historyList', 'historyOpen', 'historyResume', 'historyExport', 'openLink']);
/** Validate the shared envelope before dispatch; each handler validates its payload.
 * @param {unknown} value
 * @returns {value is import('./protocol-types').WebviewMessage}
 */
function validWebviewMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = /** @type {Record<string, unknown>} */ (value);
  if (typeof message.type !== 'string' || !MESSAGE_TYPES.has(/** @type {import('./protocol-types').MessageType} */ (message.type))) return false;
  if (message.requestId !== undefined && !(typeof message.requestId === 'string' && message.requestId.length > 0 && message.requestId.length <= 512) &&
    !(typeof message.requestId === 'number' && Number.isSafeInteger(message.requestId) && message.requestId >= 0)) return false;
  return true;
}
module.exports = { validWebviewMessage };
