# ACP 探测工具

这些脚本用于检查 DSH 的 ACP 握手、能力声明、会话、模式、工具调用和历史读取。

```sh
node spike/acp-probe.mjs
node spike/acp-capabilities.mjs
node spike/acp-verify.mjs
```

运行前准备独立测试配置集，并核对脚本参数。包含会话正文、文件内容或本机配置的抓包只保存于忽略的 `spike/capture/` 目录。
以目标 DSH 版本的实际协议响应和测试结果判定支持范围。
