'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ImageStore, validateImage, validateImageDescriptor, MAX_IMAGE_BYTES } = require('../dsh/images');
const { imageMime, resolveImage } = require('./image-resources');

const reasons = {
  'model-route-unresolved': '当前模型尚未就绪，请重新选择模型。',
  'acp-image-unsupported': '当前 DSH ACP 版本尚未验证图片输入，请更新兼容的内核。',
  'attachment-service-unavailable': '当前 DSH 未启用图片附件服务。',
  'model-capability-unavailable': '无法确认当前模型的图片输入能力。',
  'model-does-not-declare-image': '当前模型没有声明支持图片输入，请切换支持图片的模型。',
  'connection-image-disabled': '当前连接建立时未启用图片输入，请重新连接 DSH。',
};

class PanelImages {
  constructor({ root, scope, post, pick, resolve = resolveImage }) {
    this.store = root ? new ImageStore({ root }) : undefined;
    this.scope = scope; this.post = post; this.pick = pick; this.resolve = resolve;
    this.epoch = 0; this.pending = new Set(); this.outputs = new Map();
  }
  reset() {
    this.epoch++;
    for (const controller of this.pending) controller.abort();
    this.pending.clear(); this.outputs.clear();
    this.post({ type: 'imageReset' });
    this.post({ type: 'imageCapabilities', input: false, mode: 'unsupported', reason: '正在检查当前模型的图片能力。' });
  }
  capture(message = {}) {
    const current = this.scope();
    if (!current.trusted || !current.view || !this.store || message.cwd && message.cwd !== current.cwd ||
        message.sessionId && message.sessionId !== current.sessionId) throw new Error('请在受信任的工作区中使用图片，原草稿已保留。');
    return { ...current, epoch: this.epoch };
  }
  current(scope) {
    const next = this.scope();
    return scope.epoch === this.epoch && next.trusted && next.view === scope.view && next.client === scope.client &&
      next.cwd === scope.cwd && next.sessionId === scope.sessionId;
  }
  async capabilities(scope = this.capture()) {
    if (!scope.client?.isConnected || !scope.sessionId) return { input: false, mode: 'unsupported', reason: '请连接 DSH 后检查图片输入能力。' };
    const controller = new AbortController(); this.pending.add(controller);
    try {
      const result = await scope.client.request('dsh-door/images/capabilities', { sessionId: scope.sessionId },
        { signal: controller.signal, timeoutMs: 7000, abortTimeoutMs: 1000 });
      if (!result || typeof result.input !== 'boolean') throw new Error('invalid capability');
      return { ...result, reason: reasons[result.reason] || (result.input ? '' : '当前模型不支持图片输入。') };
    } catch {
      return { input: false, mode: 'unsupported', reason: '无法核实当前模型的图片能力，请更新 dsh-acp-door 后重新连接。' };
    } finally { this.pending.delete(controller); }
  }
  async refresh() {
    let scope; try { scope = this.capture(); } catch { return; }
    const result = await this.capabilities(scope);
    if (this.current(scope)) this.post({ type: 'imageCapabilities', cwd: scope.cwd, sessionId: scope.sessionId, ...result });
    return result;
  }
  async assertInput(items) {
    if (!items?.some(item => item?.kind === 'image')) return;
    const scope = this.capture();
    const result = await this.capabilities(scope);
    if (!this.current(scope)) throw new Error('会话或工作区已变化，请重新发送图片。');
    if (!result.input) throw new Error(result.reason);
    const images = items.filter(item => item?.kind === 'image'), limits = result.limits;
    if (limits && (images.length > limits.maxImagesPerMessage || images.reduce((sum, item) => sum + item.byteLength, 0) > limits.maxMessageImageBytes ||
      images.some(item => item.byteLength > limits.maxImageBytes || !limits.mediaTypes?.includes(item.mimeType)))) throw new Error('图片超过当前 DSH 的格式、数量或大小限制，请调整后重试。');
    for (const item of items) if (item?.kind === 'image') await this.store.read(item);
    if (!this.current(scope)) throw new Error('会话或工作区已变化，请重新发送图片。');
  }
  async handle(message) {
    const responseType = { imageAdd: 'imageAdded', imagePick: 'imageAdded', imagePreview: 'imagePreview', imageResolve: 'imageResolved' }[message.type];
    let scope;
    try {
      scope = this.capture(message);
      if (this.pending.size >= 12) throw new Error('图片正在处理中，请稍后重试。');
      const controller = new AbortController(); this.pending.add(controller);
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const reply = { type: responseType, requestId: message.requestId, cwd: scope.cwd, sessionId: scope.sessionId };
        const guard = () => { controller.signal.throwIfAborted(); if (!this.current(scope)) throw new Error('图片请求范围已变化。'); };
        if (message.type === 'imageResolve') {
          let result;
          if (typeof message.source === 'string' && message.source.startsWith('dsh-image:')) {
            const token = message.source.slice('dsh-image:'.length);
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token) || !scope.client?.isConnected) throw new Error('历史图片引用无效。');
            const content = await scope.client.request('dsh-door/images/read', { token }, { signal: controller.signal, timeoutMs: 7000, abortTimeoutMs: 1000 });
            result = validateImage(content);
          } else {
            let localMeme;
            try {
              const url = new URL(message.source);
              if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.startsWith('/dsh-memes/') && !url.username && !url.password && !url.search && !url.hash) {
                if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
                localMeme = url;
              }
            } catch { /* Workspace paths are handled separately. */ }
            if (localMeme && scope.client?.isConnected) {
              const content = await scope.client.request('dsh-door/media/read', { provider: 'dsh-meme', id: localMeme.pathname, sourceOrigin: localMeme.origin },
                { signal: controller.signal, timeoutMs: 7000, abortTimeoutMs: 1000 });
              result = validateImage(content);
            } else result = await this.resolve(message.source, scope.cwd, { signal: controller.signal, guard });
          }
          guard();
          this.post({ ...reply, source: message.source, dataUrl: `data:${result.mimeType};base64,${result.data}` });
        } else if (message.type === 'imagePreview') {
          const item = validateImageDescriptor(message.item), result = await this.store.read(item); guard();
          this.post({ ...reply, id: item.id, dataUrl: `data:${result.mimeType};base64,${result.data}` });
        } else {
          let values;
          if (message.type === 'imagePick') {
            const files = await this.pick(); guard();
            if (!files?.length) { this.post({ ...reply, items: [], previews: [] }); return; }
            if (files.length > 4) throw new Error('每条消息最多附加 4 张图片。');
            values = [];
            for (const file of files) {
              const handle = await fs.open(file, 'r'); let bytes;
              try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 8 MiB。');
                const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1); let offset = 0;
                while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
                bytes = buffer.subarray(0, offset);
              } finally { await handle.close(); }
              values.push({ bytes, mimeType: imageMime(bytes), name: path.basename(file) }); guard();
            }
          } else values = [{ data: message.data, mimeType: message.mimeType, name: message.name }];
          const validated = values.map(value => ({ ...validateImage(value), name: typeof value.name === 'string' ? value.name : '图片' }));
          if (validated.reduce((sum, item) => sum + item.byteLength, 0) > 16 * 1024 * 1024) throw new Error('每条消息的图片总量不能超过 16 MiB。');
          const items = [], previews = [];
          for (const value of validated) { guard(); const item = await this.store.put(value); items.push(item); previews.push({ id: item.id, dataUrl: `data:${value.mimeType};base64,${value.data}` }); }
          guard(); this.post({ ...reply, items, previews });
        }
      } finally { clearTimeout(timer); this.pending.delete(controller); }
    } catch {
      if (!scope || this.current(scope)) this.post({ type: responseType, requestId: message.requestId, cwd: scope?.cwd, sessionId: scope?.sessionId,
        id: message.item?.id, source: message.source, items: [], error: message.type === 'imageResolve' ?
          '图片加载失败，请检查链接或工作区文件；原内容已保留。' : '图片处理失败，请检查格式、大小或缓存，原草稿已保留。' });
    }
  }
  async incoming(messageId, content) {
    let scope;
    try {
      scope = this.capture();
      const value = validateImage(content);
      const record = this.outputs.get(messageId) || { ids: new Set(), bytes: 0 };
      if (record.ids.has(value.sha256)) return;
      if (record.ids.size >= 4 || record.bytes + value.byteLength > 16 * 1024 * 1024) throw new Error('图片回复超过显示限制。');
      record.ids.add(value.sha256); record.bytes += value.byteLength; this.outputs.set(messageId, record);
      while (this.outputs.size > 256) this.outputs.delete(this.outputs.keys().next().value);
      const item = await this.store.put({ ...value, name: 'DSH 图片' });
      if (this.current(scope)) this.post({ type: 'image', id: messageId, image: { id: item.id, item } });
    } catch {
      if (scope && this.current(scope)) this.post({ type: 'image', id: messageId, image: { id: 'image-error', error: '图片回复无法显示或超过限制。' } });
    }
  }
}
module.exports = { PanelImages, reasons };
