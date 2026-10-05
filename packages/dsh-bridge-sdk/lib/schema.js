'use strict';
const path = require('node:path');

const PREFIX = 'dsh-door/bridge/';
const MAX_BYTES = 1024 * 1024;
class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new BridgeError(code, message); }
/** 以实际编码后的大小检查输入和产物，拒绝循环对象及无法编码的值。 */
function jsonValue(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(-32046, '数据无法编码'); }
  if (encoded === undefined) fail(-32046, '数据无法编码');
  if (Buffer.byteLength(encoded) > MAX_BYTES) fail(-32049, '数据超过大小限制');
  return JSON.parse(encoded);
}
function requiredString(value, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(-32046, '参数无效');
  return value;
}
/** 首版仅支持显式列出的 JSON Schema 子集；未知规则拒绝注册。 */
function checkSchema(schema, value, definition = false, depth = 0) {
  if (depth > 16 || !schema || typeof schema !== 'object' || Array.isArray(schema)) fail(-32046, '参数定义无效');
  const allowed = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'maxItems', 'minimum', 'maximum', 'description'];
  if (Object.keys(schema).some(k => !allowed.includes(k))) fail(-32046, '参数定义包含不支持的规则');
  if (schema.type && !['object', 'array', 'string', 'boolean', 'integer', 'number', 'null'].includes(schema.type)) fail(-32046, '参数类型无效');
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length)) fail(-32046, '枚举定义无效');
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string'))) fail(-32046, '必填字段定义无效');
  for (const key of ['maxLength', 'maxItems', 'minimum', 'maximum']) {
    if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || (key.startsWith('max') && schema[key] < 0))) fail(-32046, '数值规则无效');
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') fail(-32046, '字段规则无效');
  if (schema.properties) {
    if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) fail(-32046, '字段定义无效');
    for (const sub of Object.values(schema.properties)) checkSchema(sub, undefined, true, depth + 1);
  }
  if (schema.items) checkSchema(schema.items, undefined, true, depth + 1);
  if (definition) return;
  if (schema.type) {
    const match = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value) : schema.type === 'null' ? value === null
      : schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'number' ? Number.isFinite(value)
      : typeof value === schema.type;
    if (!match) fail(-32046, '参数类型不匹配');
  }
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) fail(-32046, '参数不在允许范围内');
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) fail(-32046, '文本参数过长');
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) fail(-32046, '数值参数超出范围');
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(-32046, '列表参数过长');
    if (schema.items) for (const v of value) checkSchema(schema.items, v, false, depth + 1);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) fail(-32046, '缺少必填参数');
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, k)) checkSchema(schema.properties[k], v, false, depth + 1);
      else if (schema.additionalProperties === false) fail(-32046, '存在未知参数');
    }
  }
}
function capabilityDescriptor(provider, capability) {
  const item = jsonValue(capability);
  requiredString(item.id);
  requiredString(item.title);
  if (!['read', 'execute', 'workspace-write', 'system'].includes(item.riskTier)) fail(-32046, '能力风险类型无效');
  if (!['action', 'resource', 'workflow'].includes(item.kind)) fail(-32046, '能力类型无效');
  checkSchema(item.inputSchema || {}, undefined, true);
  if (!Array.isArray(item.effects) || item.effects.some(v => typeof v !== 'string')) fail(-32046, '能力影响范围无效');
  // 目录只允许声明性字段，插件对象、命令及任意 UI 代码不会穿过协议。
  return { id: item.id, title: item.title, description: String(item.description || ''), kind: item.kind,
    riskTier: item.riskTier, effects: item.effects, requiresSession: Boolean(item.requiresSession),
    supportsCancellation: Boolean(item.supportsCancellation), inputSchema: item.inputSchema || {},
    outputKinds: Array.isArray(item.outputKinds) ? item.outputKinds.filter(v => typeof v === 'string') : [],
    provider: { id: provider.id, name: provider.name, version: provider.version },
    availability: item.availability || { state: 'available' } };
}
function absoluteCwd(value) {
  requiredString(value, 32768);
  if (!path.isAbsolute(value)) fail(-32046, '工作目录必须为绝对路径');
  return path.resolve(value);
}

module.exports = { PREFIX, MAX_BYTES, BridgeError, fail, jsonValue, requiredString, checkSchema, capabilityDescriptor, absoluteCwd };
