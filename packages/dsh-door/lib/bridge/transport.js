import { Duplex } from 'node:stream';

/**
 * 活动运行结束前保留 ACP Agent 作用域。远端断开后不再写 socket，
 * 入站 EOF 延迟到 Bridge 空闲，再由 ACP 正常回收全部会话。
 */
export function bridgeTransport(socket, state) {
  const streams = Duplex.toWeb(socket);
  const reader = streams.readable.getReader();
  const writer = streams.writable.getWriter();
  const readable = new ReadableStream({
    async pull(controller) {
      let item;
      try { item = await reader.read(); }
      catch (error) { if (!socket.destroyed) throw error; item = { done: true }; }
      if (item.done) { await state.bridge.idle(state); controller.close(); }
      else controller.enqueue(item.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const writable = new WritableStream({
    async write(chunk) {
      if (socket.destroyed) return;
      try { await writer.write(chunk); } catch (error) { if (!socket.destroyed) throw error; }
    },
    async close() { if (!socket.destroyed) await writer.close(); },
    async abort(reason) { if (!socket.destroyed) await writer.abort(reason); },
  });
  return { readable, writable };
}
