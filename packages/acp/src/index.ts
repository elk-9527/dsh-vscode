/**
 * @dsh-vscode/acp —— DSH 的 ACP 协议层。
 *
 * M0 阶段这里还只是占位：真实的 transport / client / locate 会在 M1 从
 * spike/acp-probe.mjs 里提炼进来，并补上 fixtures 契约测试。
 *
 * 设计约束（写死在这里，避免以后跑偏）：
 * 1. 本包不依赖 vscode，任何 VSCode 概念都不许进来；
 * 2. 所有对 dsh 的调用都经过 ACP，不读 $DSH_HOME 内部文件、不写 cordis.patch.yml；
 * 3. stdout 承载协议流量，日志一律走 stderr 或回调。
 */
export * as acp from '@agentclientprotocol/sdk';
