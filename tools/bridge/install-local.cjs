'use strict';
/** 功能候选安装：共用维护版备份和核验流程，另安装两个显式注册能力的试点包。 */
const { argsOf, redact } = require('../compat/lib.cjs');
try { require('../compat/install-local.cjs').install({ ...argsOf(), pilots: true }); }
catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
