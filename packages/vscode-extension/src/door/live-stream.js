'use strict';

/** 与 dsh-acp-door 的私有实时通知方法保持一致。 */
const DOOR_STREAM_METHOD = 'dsh-door/stream';

const STANDARD_KIND = {
  text: 'agent_message_chunk',
  thinking: 'agent_thought_chunk',
};

/**
 * 把该插件的实时通知投影成普通 ACP update，并消除稍后到达的完整提交消息。
 *
 * DSH 0.2 会先发布进程内 token 增量，提交会话记录后再由标准 ACP 发送一份
 * 完整块。不去重会令面板显示两遍。本类只在“会话、类型、完整文本”全部相等时
 * 抑制标准块；旧插件没有实时通知，标准 ACP 因而始终原样通过。
 */
class DoorLiveStream {
  constructor() {
    this.reset();
  }

  reset() {
    /** sessionId -> (attemptId -> attempt) */
    this.attempts = new Map();
    /** sessionId -> 已实时显示、等待标准 ACP 完整块来核销的块 */
    this.pending = new Map();
  }

  /**
   * @returns {{sessionId: string, update: object}|undefined}
   */
  accept(params) {
    if (!params || typeof params !== 'object') return undefined;
    const { sessionId, attemptId, kind } = params;
    if (typeof sessionId !== 'string' || !sessionId || typeof attemptId !== 'string' || !attemptId) {
      return undefined;
    }

    if (kind === 'start') {
      this.#attemptsFor(sessionId).set(attemptId, { nextOrder: 0, blocks: new Map() });
      return undefined;
    }

    if (kind === 'text' || kind === 'thinking') {
      if (typeof params.delta !== 'string' || !params.delta) return undefined;
      const attempts = this.#attemptsFor(sessionId);
      let attempt = attempts.get(attemptId);
      if (!attempt) {
        // 即使连接恰好从 start 与首个 chunk 之间开始，也不丢掉有效增量。
        attempt = { nextOrder: 0, blocks: new Map() };
        attempts.set(attemptId, attempt);
      }
      const block = Number.isSafeInteger(params.block) && params.block >= 0 ? params.block : 0;
      const key = `${kind}:${block}`;
      let entry = attempt.blocks.get(key);
      if (!entry) {
        entry = { kind, block, text: '', order: attempt.nextOrder++ };
        attempt.blocks.set(key, entry);
      }
      entry.text += params.delta;
      return {
        sessionId,
        update: {
          sessionUpdate: STANDARD_KIND[kind],
          content: { type: 'text', text: params.delta },
        },
      };
    }

    if (kind === 'end') {
      const attempts = this.attempts.get(sessionId);
      const attempt = attempts?.get(attemptId);
      attempts?.delete(attemptId);
      if (attempts?.size === 0) this.attempts.delete(sessionId);

      if (attempt && params.committed === true && params.eventType === 'assistant/message') {
        const queue = this.pending.get(sessionId) || [];
        const blocks = [...attempt.blocks.values()]
          .filter((entry) => entry.text)
          .sort((left, right) => left.order - right.order);
        queue.push(...blocks);
        // 防止异常对端不再发送标准消息时无限增长；正常情况会马上逐块核销。
        if (queue.length > 64) queue.splice(0, queue.length - 64);
        if (queue.length) this.pending.set(sessionId, queue);
      }
    }
    return undefined;
  }

  /** 标准 ACP update 是否仍应交给上层。 */
  shouldForward(sessionId, update) {
    const kind = update?.sessionUpdate === 'agent_message_chunk'
      ? 'text'
      : update?.sessionUpdate === 'agent_thought_chunk'
        ? 'thinking'
        : undefined;
    const text = update?.content?.type === 'text' && typeof update.content.text === 'string'
      ? update.content.text
      : undefined;
    if (!kind || text === undefined || typeof sessionId !== 'string') return true;

    // 正常时序：private end 先到，标准 ACP 完整块随后到达。
    const queued = this.pending.get(sessionId);
    const queuedIndex = queued?.findIndex((entry) => entry.kind === kind) ?? -1;
    if (queuedIndex >= 0) {
      const [candidate] = queued.splice(queuedIndex, 1);
      if (queued.length === 0) this.pending.delete(sessionId);
      return candidate.text !== text;
    }

    // 防御极端调度时序：标准块若先于 private end 到达，也要核销活动 attempt 中的块。
    const attempts = this.attempts.get(sessionId);
    if (attempts) {
      for (const attempt of attempts.values()) {
        const candidate = [...attempt.blocks.entries()]
          .filter(([, entry]) => entry.kind === kind)
          .sort((left, right) => left[1].order - right[1].order)[0];
        if (!candidate) continue;
        attempt.blocks.delete(candidate[0]);
        return candidate[1].text !== text;
      }
    }
    return true;
  }

  #attemptsFor(sessionId) {
    let attempts = this.attempts.get(sessionId);
    if (!attempts) {
      attempts = new Map();
      this.attempts.set(sessionId, attempts);
    }
    return attempts;
  }
}

module.exports = { DOOR_STREAM_METHOD, DoorLiveStream };
