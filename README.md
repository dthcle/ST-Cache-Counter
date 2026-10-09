# ST-Cache-Counter

针对 **SillyTavern 1.19.0** 开发并检查源码兼容性的第三方前端扩展（同时参考了 1.14.0 的接口）。每个 AI 回复楼层显示非缓存输入、缓存输入、输出 token 和缓存命中率，使用 API 实际返回的 usage，而不是本地 tokenizer 估算。

## 安装

在酒馆「扩展 → 安装扩展」中粘贴：

```text
https://github.com/dthcle/ST-Cache-Counter
```

安装后刷新页面。也可以使用 Git 克隆到上述扩展目录，后续用 `git pull --ff-only` 更新。

本地安装：将仓库整个目录复制到酒馆 `public/scripts/extensions/third-party/ST-Cache-Counter/`，刷新页面。在扩展设置中的「楼层 Token / 缓存统计」启用或停用。

不修改酒馆核心，不需要服务端插件或 npm 依赖。开发测试需要 Node.js 20+；运行 `npm test` 与 `npm run check`。版本号同步维护在 manifest.json 和 package.json，GitHub Actions 自动运行测试。

## 统计口径

- **输入总量**：整个 API 请求上下文，不仅是上一条用户消息。用户楼层、系统消息和开场白不单独记账。
- **缓存输入**：读取已有缓存的 token。
- **非缓存输入**：输入总量减缓存读取，**包括缓存写入**；写入成本可能与普通输入不同，不能据此直接计算费用。
- **输出**：API 报告的输出总量。OpenAI completion_tokens 通常已含推理，不再次相加；Gemini candidatesTokenCount 与 thoughtsTokenCount 相加。
- **命中率**：缓存读取 / 输入总量；零输入或缺少缓存统计显示「未知」。缺失字段不伪造为 0。
- 鼠标悬停统计行可查看请求数、输入总量和缓存写入。续写累加独立请求，重生成/候选回复保存在相应 swipe 的 extra 中。编辑文本后保留原始请求用量并提示，不重新估算。

例如输入总量 1000、缓存读取 800、输出 100：非缓存 200，命中率 80%。Anthropic 原始 input_tokens=100、cache_creation_input_tokens=200、cache_read_input_tokens=700：输入总量 1000，非缓存 300，命中率 70%。

## 支持的数据格式

| API 格式 | 读取字段 |
| --- | --- |
| OpenAI / Azure / 兼容中转站、xAI 等 | usage.prompt_tokens、completion_tokens、prompt_tokens_details.cached_tokens |
| DeepSeek | prompt_cache_hit_tokens、prompt_cache_miss_tokens、prompt_tokens、completion_tokens |
| Anthropic Claude | input_tokens、cache_read_input_tokens、cache_creation_input_tokens、output_tokens；合并流式 message_start / message_delta |
| Gemini / Vertex | usageMetadata.promptTokenCount、cachedContentTokenCount、candidatesTokenCount、thoughtsTokenCount |
| OpenRouter | OpenAI 格式和 prompt_tokens_details.cache_write_tokens / cached_tokens |
| Cohere | usage.tokens 或 billed_units，缓存数据缺失时未知 |

以上是**格式兼容**，并不保证每家服务或中转站都会返回所有字段。前端只观察同源 `/api/backends/chat-completions/generate` 响应，不拦截其他网页请求、不发送额外模型请求。JSON 与 SSE 流式均支持，流事件的累计 usage 覆盖旧值，不把快照重复相加。

### SillyTavern 1.19.0 / 1.14.0 的 usage 限制

本版本后端重新构造上游请求体，不会转发前端任意 `stream_options`。OpenAI 常需 `stream_options: {include_usage: true}` 才返回流式 usage：

1. 使用 Chat Completion 的「自定义（OpenAI 兼容）」连接，在附加请求体 YAML 中填入：
   ```yaml
   stream_options:
     include_usage: true
   ```
2. 若中转站不支持该字段，移除它；可改用非流式。
3. 原生 OpenAI 连接在本版可能需要升级酒馆，或改用自定义连接。扩展**不声称**仅设置前端参数即可让旧后端返回 usage。

本地 1.19.0 原生 Claude / Gemini **非流式**后端会重组回复并丢弃 usage；纯前端扩展无法恢复，因此显示未知。建议使用能透传 usage 的流式连接，或能返回 OpenAI 兼容 usage 的自定义接口。其他缺失字段同样显示未知。插件不会自动修改 API 配置或增加额外费用。

1.19.0 的流式 GENERATION_ENDED 是 UI 解锁事件，会早于 MESSAGE_RECEIVED；插件保留请求归属直到楼层收到回复，并按原始生成类型处理非流式 appendFinal 续写。quiet/impersonate 后台生成不覆盖前台请求；目标存在歧义时不猜测归属。

## 边界与数据保存

- 只统计启用之后实际生成的 AI 回复。历史记录若没有 API usage，无法准确补算。
- 统计保存在消息 `extra.st_cache_counter`，并同步到当前 `swipe_info[].extra`，随聊天保存。仅存模型名、来源、时间和数字，不保存请求正文、密钥或完整响应。
- quiet（后台生成）和 impersonate（冒充用户）不计入楼层；切换聊天会丢弃未绑定的请求，防止串楼。
- 多候选 `n > 1` 的 usage 是整个请求总量，不能按候选准确拆分：仅在接收该请求的活动回复记录总量并提示，其他候选若继承它不能解读为独立费用。
- 中途取消、断网或服务错误可能没有最终 usage；只记录已观察到的数据，complete=false 表示未正常读到流结束。部分取消路径未触发 MESSAGE_RECEIVED 时无法绑定，不承诺统计所有失败请求。
- 续写总计中只要任何请求某字段未知，该字段总计也显示未知，避免把部分已知量当完整量。
- Text Completion / Kobold 等非 Chat Completion 接口目前不支持。计费明细、汇率、缓存 TTL 和跨聊天用量不在本插件范围内。
- 尚未使用你的真实付费 API 做端到端验证；仓库包含格式、流解析和模拟酒馆事件测试。SillyTavern 升级后请验证接口兼容性。

## 许可证

MIT。详见 LICENSE。
