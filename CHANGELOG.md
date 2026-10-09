# Changelog

## 1.0.1

- 按 SillyTavern 1.19.0 源码修正流式 ENDED → MESSAGE_RECEIVED 时序。
- 兼容非流式 appendFinal 续写，保存各候选回复及编辑标记。
- 请求归属检查、后台生成排除、聊天切换隔离及有界 pending 清理。
- 清理新生成候选继承的旧统计，保留历史候选记录。
- 支持已观察到的取消请求部分用量，终止标记早于 EOF 时仍完成记录。
- 隔离统计回调错误，避免影响原始 JSON/SSE 响应消费。
- 61 项自动测试通过；浏览器模拟验证正常流式、续写和设置开关。
- 明确原生 Claude/Gemini 非流式后端丢弃 usage 的限制。

## 1.0.0

- 初始版本：逐楼层非缓存输入、缓存输入、输出 token 和缓存命中率。
- 支持 OpenAI 兼容、DeepSeek、Anthropic、Gemini、OpenRouter、Cohere 常见 usage 格式。
- 保存消息与候选回复扩展字段；53 项格式/捕获/事件测试。
