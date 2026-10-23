'use strict';
const { StringDecoder } = require('node:string_decoder');
// History decodes up to 64 MiB; JSON and attachments require a larger transport
// envelope than the independent 1 MiB Bridge argument/result contract.
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_SEND_BYTES = 256 * 1024 * 1024;
/** @param {string} kind */
const overflow = kind => Object.assign(new Error(`ACP ${kind}超过传输预算，连接已关闭。`), { code: 'ACP_TRANSPORT_LIMIT' });

class FrameReader {
  decoder = new StringDecoder('utf8');
  text = '';
  bytes = 0;
  /** @param {{maxBytes?: number, receive: (line: string) => void}} options */
  constructor({ maxBytes = MAX_FRAME_BYTES, receive }) { this.maxBytes = maxBytes; this.receive = receive; this.clear(); }
  clear() { this.decoder = new StringDecoder('utf8'); this.text = ''; this.bytes = 0; }
  /** @param {Buffer | string} value */
  push(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      this.bytes += end - start;
      if (this.bytes > this.maxBytes) { this.clear(); throw overflow('消息帧'); }
      this.text += this.decoder.write(chunk.subarray(start, end));
      if (newline < 0) return;
      const line = this.text + this.decoder.end(); this.clear();
      this.receive(line); start = newline + 1;
    }
  }
}

/** Stop writing after backpressure; budget includes the blocked frame and queue. */
class SocketWriter {
  /** @param {Pick<import('node:net').Socket, 'write'|'on'|'off'|'writableLength'>} socket
   * @param {{maxBytes?: number}} [options] */
  constructor(socket, { maxBytes = MAX_SEND_BYTES } = {}) {
    this.socket = socket; this.maxBytes = maxBytes;
    /** @type {{text: string, bytes: number}[]} */
    this.queue = []; this.bytes = 0; this.inflight = 0; this.blocked = false;
    this.drain = () => {
      this.inflight = 0; this.blocked = false;
      while (this.queue.length && !this.blocked) {
        const item = this.queue.shift(); if (!item) break;
        this.bytes -= item.bytes; this.writeNow(item);
      }
    };
    socket.on('drain', this.drain);
  }
  /** @param {string} text */
  write(text) {
    const item = { text, bytes: Buffer.byteLength(text) };
    if (item.bytes + this.bytes + Math.max(this.inflight, this.socket.writableLength || 0) > this.maxBytes) throw overflow('发送队列');
    if (this.blocked) { this.queue.push(item); this.bytes += item.bytes; }
    else this.writeNow(item);
  }
  /** @param {{text: string, bytes: number}} item */
  writeNow(item) { if (this.socket.write(item.text) === false) { this.blocked = true; this.inflight = Math.max(item.bytes, this.socket.writableLength || 0); } }
  dispose() { this.socket.off('drain', this.drain); this.queue.length = 0; this.bytes = 0; this.inflight = 0; }
}
module.exports = { FrameReader, SocketWriter, MAX_FRAME_BYTES, MAX_SEND_BYTES };
