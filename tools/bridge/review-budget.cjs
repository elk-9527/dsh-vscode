'use strict';
/** 审查预算独立于用户取消；超限后停止模型和工具，保留失败记录。 */
function createReviewBudget({ signal, emit = () => {}, timeoutMs = 600000, maxCalls = 40, mode } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 200) throw new Error('审查预算无效');
  const controller = new AbortController(), started = Date.now(); let calls = 0;
  const stop = message => { if (controller.signal.aborted) return; emit({ message, calls, elapsedMs: Date.now() - started }); controller.abort(new Error(message)); };
  const timer = setTimeout(() => stop('审查已达到时间预算，本次运行未完成'), timeoutMs); timer.unref?.();
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    scope: mode === 'worktree' ? 'Review only the current staged, unstaged and untracked changes. Start with git status and check git rev-parse --verify HEAD. If HEAD exists, use git diff HEAD. In a repository before its first commit, use git diff --cached for staged files, git diff for unstaged changes and read untracked files; all initial files are changes. Do not create a commit or assume a fixed empty-tree hash. Read unchanged files only when needed to verify a specific changed line. Stop when the changed code has been checked; avoid repeated searches or unrelated repository exploration.' : '',
    record() {
      if (controller.signal.aborted || signal?.aborted) return '审查已停止';
      calls++;
      if (calls > maxCalls) { stop('审查已达到工具调用预算，本次运行未完成'); return '审查已达到工具调用预算'; }
      emit({ message: `检查代码 · 已调用 ${calls}/${maxCalls} 次工具`, calls, elapsedMs: Date.now() - started });
      return undefined;
    },
    dispose() { clearTimeout(timer); },
  };
}
module.exports = { createReviewBudget };
