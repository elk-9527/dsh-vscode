'use strict';

/**
 * 把内核/网络抛出来的原始错误文本，翻成「发生了什么 + 你能做什么」。
 *
 * 为什么要有这个文件：内核的错误是**原样**穿过 ACP 传到面板的，用户看到的
 * 是一段英文 JSON（最典型的是 429 额度限制）。那段文字对用户没有用 ——
 * 它既不说发生了什么，也不说下一步该干什么，看多了只会得出
 * 「这插件根本没法用」的结论。
 *
 * 两条不能破的规矩：
 * 1. **不吞信息**：原文永远跟在人话后面一起给用户（认不出来的时候更是如此）；
 * 2. **不猜**：只按能明确指认的特征分类。认不出来就老实说「认不出来」，
 *    而不是硬套一个类别 —— 那会把用户带向错误的方向。
 *
 * 这里是纯函数（不碰 vscode、不碰 DOM），所以能在命令行里直接测，
 * 也就不需要为它起一个编辑器或浏览器。
 */

/** 从 429 那段文本里抠出「还有多久恢复」。抠不到就返回空。 */
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
 * 分类规则。**顺序有意义**：第一个命中的说了算，所以「能明确指认的」
 * 排在「泛泛的」前面（429 里也可能夹着别的字样，但它就是额度问题）。
 */
const RULES = [
  {
    kind: 'usage-limit',
    test: /GoUsageLimitError|usage limit|rate ?limit|too many requests|\b429\b|quota|insufficient (?:balance|credit|quota)|额度|频率限制|限流|余额不足/i,
    title: '额度或频率到上限了，这一回合没跑完。',
    advice: (text) => {
      const reset = resetHint(text);
      const tail = '也可以先换个模型再发。';
      return reset ? `约 ${reset}后恢复；${tail}` : `等一会儿再试；${tail}`;
    },
  },
  {
    kind: 'auth',
    test: /\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|incorrect api key|authentication|鉴权|未授权/i,
    title: '服务商拒绝了：密钥不对或没有权限。',
    advice: () =>
      '看内核 settings.yaml 里这个服务商的 apiKeyEnv 指向哪个环境变量，确认它有值；换过密钥要重启内核。',
  },
  {
    kind: 'port',
    test: /EADDRINUSE|address already in use|only one usage of each socket address|端口(?:已)?被占/i,
    title: '要用的端口被别的程序占着了。',
    advice: (text) => {
      const port = String(text).match(/\b(\d{4,5})\b/);
      const which = port ? port[1] : '47821';
      return `先确认 ${which} 上是谁在监听；要换端口，dshPanel.port 和门插件里的 port 得改成同一个。`;
    },
  },
  {
    kind: 'command',
    test: /ENOENT|command not found|不是内部或外部命令|is not recognized as an internal|无法将.+识别为/i,
    title: '要执行的命令没找到。',
    advice: (text) => {
      const name = String(text).match(/(?:ENOENT[^\n]*?['"]([^'"]+)['"])|(?:'([^']+)' is not recognized)/i);
      const which = (name && (name[1] || name[2])) || 'dsh';
      return `多半是「${which}」不在 PATH，或 dshPanel.dshCommand 指错了。`;
    },
  },
  {
    kind: 'connection',
    test: /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang ?up|fetch failed|other side closed|连接(?:被对方)?关闭|连接断了|connection refused/i,
    title: '连不上内核，或连接中途断了。',
    advice: () => '直接发消息即可自动重连；不行就执行「DSH：重新连接」。',
  },
  {
    kind: 'preset-locked',
    test: /agent-preset\/locked|预设[^\n]*锁|preset[^\n]*locked/i,
    title: '内核不允许中途换模式。',
    advice: () => '点顶栏「新建对话」，新模式在新对话里生效（内核的规矩）。',
  },
  {
    kind: 'model',
    test: /unknown model|model[^\n]*not (?:found|exist)|no such model|模型不存在/i,
    title: '这个模型名内核不认识。',
    advice: () => '核对 dshPanel.model 与内核 settings.yaml 里的 model id；拿不准就留空让内核自己定。',
  },
  {
    kind: 'timeout',
    test: /timed? ?out|timeout|超时/i,
    title: '这次请求超时了。',
    advice: () => '重发一次；一直超时就换个模型，或少给它读点东西。',
  },
];

/**
 * 认不出来时的兜底说法。
 *
 * 为什么还要有一句：原文（通常是一段 JSON）直接甩给用户，他会以为这就是
 * 全部信息、也不知道该拿它怎么办。前面加一句人话，至少说清「这是什么」
 * 和「下一步做什么」。
 */
const UNKNOWN = {
  kind: 'unknown',
  title: '内核报了一个错，这一回合没跑完。',
  advice: () => '下面是内核原话。看不懂就把这几行发我；或执行「DSH：显示日志」。',
};

/**
 * @param {unknown} message 原始错误文本（可能带「回合失败：」这种前缀）
 * @returns {{kind: string, known: boolean, title: string, advice: string, raw: string}}
 *   `raw` 永远是原文，一个字都不删 —— 认不出来的时候更要留着。
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
