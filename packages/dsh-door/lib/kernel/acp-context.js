/**
 * ACP 会话的批准处理器需要先于已有 Web 处理器检查归属。
 * 内核使用 waterfall 派发批准请求；Web 处理器先接收时会等待网页，导致本机 ACP
 * 客户端无法收到授权问答。仅改变 ACP 的该项订阅顺序，保留作用域过滤及其原有
 * ownedRecord 检查；其他会话继续由 next() 交给原处理器。
 */
export function withAcpApprovalPriority(context) {
  return new Proxy(context, {
    get(target, property) {
      if (property === 'on') return (name, listener, options) => target.on(name, listener,
        name === 'approval/request' ? { ...(typeof options === 'object' ? options : {}), prepend: true } : options);
      return Reflect.get(target, property, target);
    },
  });
}
