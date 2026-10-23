'use strict';
const assert = require('node:assert/strict');
const { validWebviewMessage } = require('../src/panel/protocol');
for (const value of [null, [], { type: 'constructor' }, { type: 'send', requestId: {} }, { type: 'send', requestId: NaN }, { type: 'send', requestId: -1 }]) assert(!validWebviewMessage(value));
for (const value of [{ type: 'ready' }, { type: 'send', requestId: 'one' }, { type: 'permission', requestId: 42, optionId: null }, { type: 'historyList', requestId: 1 }]) assert(validWebviewMessage(value));
console.log('PASS Webview envelope, command namespace and request identity validation');
