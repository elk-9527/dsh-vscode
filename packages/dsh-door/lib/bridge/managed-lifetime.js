/** 仅编辑器自行启动的 CLI 内核启用；桌面端和普通 ACP 服务不受影响。 */
export function managedLifetime({ bridge, live, exit = () => {
  bridge.endpoint?.dispose();
  if (!process.emit('SIGINT')) process.exit(0);
  setTimeout(() => process.exit(0), 5000).unref();
} }) {
  const idleMs = Number(process.env.DSH_BRIDGE_OWNED_IDLE_MS);
  if (!Number.isFinite(idleMs) || idleMs < 1000 || idleMs > 86400000) return { touch() {}, schedule() {}, dispose() {} };
  let timer;
  const touch = () => { clearTimeout(timer); timer = undefined; };
  const busy = () => live.size > 0 || [...bridge.operations.values()].some(op => op.status === 'running');
  const schedule = (delay = idleMs) => {
    touch();
    if (busy()) return;
    timer = setTimeout(() => { if (!busy()) exit(); }, delay); timer.unref();
  };
  // 扩展宿主退出时输出管道可能关闭，任务进程仍需完成正在进行的审查。
  const pipeError = error => { if (error.code !== 'EPIPE') throw error; };
  process.stdout.on('error', pipeError); process.stderr.on('error', pipeError);
  return { touch, schedule, dispose() {
    touch(); process.stdout.off('error', pipeError); process.stderr.off('error', pipeError);
  } };
}
