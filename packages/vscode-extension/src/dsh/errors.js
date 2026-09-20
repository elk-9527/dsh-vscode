'use strict';

/**
 * 将内核/网络抛出的原始错误文本转换为「发生了什么 + 可以做什么」。
 *
 * 本文件存在的原因：内核的错误会原样穿过 ACP 传到面板，用户看到的是一段英文
 * JSON（最典型的是 429 额度限制）。该文本对用户没有用：既未说明发生了什么，
 * 也未说明下一步该做什么，长期只会得出「该插件不可用」的结论。
 *
 * 两条不可违反的规则：
 * 1. **不丢弃信息**：原文始终跟在说明之后一并提供给用户（无法识别时同样如此）；
 * 2. **不推测**：只按能够明确指认的特征分类。无法识别时如实说明「无法识别」，
 *    而不强行归入某一类别，否则会把用户带向错误的方向。
 *
 * 本文件为纯函数模块（不访问 vscode，不访问 DOM），可在命令行中直接测试，
 * 无需启动编辑器或浏览器。
 */

/** 从 429 文本中提取「还有多久恢复」。提取不到时返回空字符串。 */
function resetHint(text) {
  const match = String(text).match(
    /resets?\s+in\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i,
  );
  if (!match) return '';
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return '';
  const unit = match[2].toLowerCase();
  if (unit.startsWith('h')) return `${amount} 小时`;
  if (unit.startsWith('m')) return `${amount} 分钟`;
  return `${amount} 秒`;
}

/**
 * 分类规则。**顺序有意义**：以第一条命中的规则为准，因此「可明确指认的」
 * 排在「宽泛的」之前（429 文本中也可能夹带其他字样，但其性质仍为额度问题）。
 */
const RULES = [
  {
    kind: 'usage-limit',
    test: /GoUsageLimitError|usage limit|rate ?limit|too many requests|\b429\b|quota|insufficient (?:balance|credit|quota)|额度|频率限制|限流|余额不足/i,
    title: '额度或频率已达上限，本回合未完成。',
    advice: (text) => {
      const reset = resetHint(text);
      const tail = '也可先更换模型后重试。';
      return reset ? `约 ${reset}后恢复；${tail}` : `请稍后重试；${tail}`;
    },
  },
  {
    kind: 'auth',
    test: /\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|incorrect api key|authentication|鉴权|未授权/i,
    title: '服务商拒绝请求：密钥无效或权限不足。',
    advice: () =>
      '确认该服务商的密钥已配置（设置项或对应环境变量）；更换密钥后需重启 DSH。',
  },
  {
    kind: 'port',
    test: /EADDRINUSE|address already in use|only one usage of each socket address|端口(?:已)?被占/i,
    title: '所需端口已被其他程序占用。',
    advice: (text) => {
      const port = String(text).match(/\b(\d{4,5})\b/);
      const which = port ? port[1] : '47821';
      return `先确认 ${which} 被哪个程序占用；如需更换端口，设置与 DSH 两侧须改为同一值。`;
    },
  },
  {
    kind: 'command',
    test: /ENOENT|command not found|不是内部或外部命令|is not recognized as an internal|无法将.+识别为/i,
    title: '未找到需要执行的命令。',
    advice: (text) => {
      const name = String(text).match(/(?:ENOENT[^\n]*?['"]([^'"]+)['"])|(?:'([^']+)' is not recognized)/i);
      const which = (name && (name[1] || name[2])) || 'dsh';
      return `可能未找到「${which}」：请在设置中将 DSH 位置填写为完整路径。`;
    },
  },
  {
    kind: 'connection',
    test: /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang ?up|fetch failed|other side closed|连接(?:被对方)?关闭|连接断了|connection refused/i,
    title: '无法连接 DSH，或连接已中断。',
    advice: () => '直接发送消息即可自动重连；若仍失败，请执行「DSH：重新连接」。',
  },
  {
    kind: 'preset-locked',
    test: /agent-preset\/locked|预设[^\n]*锁|preset[^\n]*locked/i,
    title: '对话进行中无法切换模式。',
    advice: () => '请点击顶栏「新建对话」，新模式将在新对话中生效。',
  },
  {
    kind: 'model',
    test: /unknown model|model[^\n]*not (?:found|exist)|no such model|模型不存在/i,
    title: 'DSH 无法识别该模型名。',
    advice: () => '请在设置中核对模型名；无法确定时留空，由 DSH 自行选择。',
  },
  {
    kind: 'timeout',
    test: /timed? ?out|timeout|超时/i,
    title: '本次请求超时。',
    advice: () => '请重新发送；若持续超时，可更换模型或减少上下文。',
  },
];

/**
 * 无法识别时的后备说明。
 *
 * 仍需一句说明的原因：若只给出原文（通常是一段 JSON），用户会认为这就是全部
 * 信息，也不知道如何处理。在前面加一句说明，至少能说明「这是什么」
 * 与「下一步做什么」。
 */
const UNKNOWN = {
  kind: 'unknown',
  title: 'DSH 报告了一个错误，本回合未完成。',
  advice: () => '以下为其原始信息。若无法理解，可提供这几行内容，或执行「DSH：显示日志」。',
};

/**
 * @param {unknown} message 原始错误文本（可能带有「回合失败：」等前缀）
 * @returns {{kind: string, known: boolean, title: string, advice: string, raw: string}}
 *   `raw` 始终为原文，不删除任何字符 —— 无法识别时更需要保留。
 */
function describeError(message) {
  const raw = message === undefined || message === null ? '' : String(message);
  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      return {
        kind: rule.kind,
        known: true,
        title: rule.title,
        advice: rule.advice(raw),
        raw,
      };
    }
  }
  return { kind: UNKNOWN.kind, known: false, title: UNKNOWN.title, advice: UNKNOWN.advice(raw), raw };
}

module.exports = { describeError, resetHint };
