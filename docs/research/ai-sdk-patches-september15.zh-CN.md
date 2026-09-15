# 研究：9 月 15 日 AI SDK Provider 补丁

[English](ai-sdk-patches-september15.md) · [简体中文](ai-sdk-patches-september15.zh-CN.md)

- 状态：已审查；合并前仍须完成最终集成检查
- 日期：2026-09-15
- 负责人：OpenBot 贡献者
- 相关 PR：[#82](https://github.com/Peerframe/openbot/pull/82)、[#83](https://github.com/Peerframe/openbot/pull/83)
- 验收流程：升级后，现有 Moonshot、Anthropic 原生 Agent 请求、工具反馈、输出限制和失败处理继续正常工作。
- 安全边界：Server 掌握身份、凭据、端点策略、工具范围、取消、审批和审计；Provider 响应及私有推理始终是不可信的模型数据。

## 检索证据

接受现有依赖升级前，检查了[复用清单](../OPEN_SOURCE_REUSE.md)、[原生 Agent 研究](native-agent-loop.md)、
[Kimi 接入研究](kimi-desktop-model.md)，以及当前 `apps/server/src/native-agent.ts` 适配器和契约测试。

2026-09-15 在 GitHub 检索 `repo:vercel/ai is:issue is:open anthropic`、
`repo:vercel/ai is:issue is:open moonshot`，并搜索
`@ai-sdk/anthropic@4.0.53`、`@ai-sdk/moonshotai@3.0.49` 精确发布标签。
查阅官方 [Anthropic Provider 文档](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)
和 [Moonshot Provider 文档](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai)。

[Anthropic 发布](https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fanthropic%404.0.53)
和 [Moonshot 发布](https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fmoonshotai%403.0.49)
均发布于 2026-09-11，两个标签都指向 `9ed46d2da5df1394079c66d422bc553fd0c34376`。
实际阅读了该提交下的包声明、变更记录、Provider 工厂、相关语言模型实现和测试；下文源码链接固定到该提交。
同时阅读了上游 Apache-2.0 许可证及两个发布包中的 `LICENSE`。

## 候选比较与精确版本

| 候选 | 精确版本与源码 | 许可证 | 维护、兼容性与结论 |
| --- | --- | --- | --- |
| 现有 Moonshot Provider | `@ai-sdk/moonshotai` 3.0.45 → 3.0.49；`9ed46d2da5df1394079c66d422bc553fd0c34376` | Apache-2.0 | 活跃发布，提供 Node、Edge 测试脚本；原生 Kimi 推理及工具映射符合现有适配器。选择正式补丁版本。 |
| 现有 Anthropic Provider | `@ai-sdk/anthropic` 4.0.49 → 4.0.53；同一提交 | Apache-2.0 | 活跃维护的 Messages API Provider，包含语言模型、批处理及类型测试。选择正式补丁版本。 |
| 通用 OpenAI 兼容映射 | 现有已审查 OpenAI 适配器 | Apache-2.0 | 无法替代两者的原生消息及推理契约；本次补丁审查不需要迁移 Provider。 |
| 本地替代或分叉 | 未选择 | 未引入 | 没有需要复制源码或自建 Provider 的实现缺口。 |

两个 npm 包都要求 Node `>=22`，保留 Provider v4 接口，依赖
`@ai-sdk/provider` 4.0.14 和 `@ai-sdk/provider-utils` 5.0.40，接受 Zod
`^3.25.76 || ^4.1.8`。与 OpenBot 的 Node 22、AI SDK 7、Zod 4 系列匹配；最终仍须验证依赖解析及契约测试。

读取了精确 [Anthropic npm 元数据](https://registry.npmjs.org/@ai-sdk%2fanthropic/4.0.53)
和 [Moonshot npm 元数据](https://registry.npmjs.org/@ai-sdk%2fmoonshotai/3.0.49)。
下载官方发布包，未安装或执行其中代码；独立计算 SHA-512，并与 npm 元数据及对应 Dependabot 锁文件记录核对一致：

```text
@ai-sdk/anthropic 4.0.53
sha512-JMxAuCFte6mFOvoaUcig3Dp2LObin0wU2Li8ncsveh7hHKW7cG3g1bFjooxn1paxeT8UUf5XMSjhxtXG9wFLig==
@ai-sdk/moonshotai 3.0.49
sha512-t/WlDfCelV8jZDv2kjr1C9Begk0rt1apNqSMqzWB+Y76uW3oncOfvZOxkLST8XoGF8a2zv5BVFqtNi+ESYAKoQ==
```

## 变更与风险判断

Moonshot 3.0.46–48 更新共享 Provider 依赖；3.0.49 包含
[空工具调用增量修复](https://github.com/vercel/ai/commit/00968508b7f47e5b1e7faa0bf001c2288abb8098)。
[流式实现](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/moonshotai/src/moonshotai-chat-language-model.ts)
只在工具调用数组含有条目时结束推理片段。
[回归测试](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/moonshotai/src/moonshotai-chat-language-model.test.ts)
检查连续携带空工具数组的推理增量属于同一推理生命周期；同一文件也覆盖原始用量字段及非法工具索引。
这会影响 OpenBot 使用的流式路径，因此必须保留 Kimi 工具续接及私有推理不外泄的测试。

Anthropic 4.0.50–53 更新批处理逐请求模型选择、取消和列表、不支持请求类型的拒绝，以及显式推理绑定选项。
阅读了[语言模型实现](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/anthropic/src/anthropic-language-model.ts)
和[推理序列化测试](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/anthropic/src/anthropic-language-model.test.ts)。
[批处理测试](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/anthropic/src/anthropic-batch.test.ts)
断言不支持的图像请求在发出 HTTP 前被拒绝。OpenBot 当前使用语言模型适配器，未启用批处理、原生上下文压缩或这些推理绑定选项。
上游更广的批处理、图像能力不会因此增加 OpenBot 的权限。

两者的工厂都保留显式 `apiKey`、`baseURL` 和自定义 `fetch`。OpenBot 继续传入已配置端点和受保护的 fetch，
关闭自动重试和遥测。共享 provider-utils 补丁包括减少 Base64 编码内存开销、改善媒体识别和 OAuth 重定向验证辅助函数；
[OAuth SSRF 补丁](https://github.com/vercel/ai/commit/c43e4b71387cc4f10ec6ae973e6f441786f6c247)
还修改了独立的 MCP 包。本次不启用 MCP OAuth，也不声称仅升级 Provider 即证明 OpenBot 网络隔离。

实际阅读的开放问题：

- [#13907](https://github.com/vercel/ai/issues/13907)：Moonshot 通过 AI Gateway 的缓存 token 计费问题。
  OpenBot 已审查的适配器使用直接配置的 Provider 端点。
- [#19632](https://github.com/vercel/ai/issues/19632)：跨 Provider 原始用量保留审计仍开放。
  保留 OpenBot 用量测试；模拟响应或本次发布不能证明真实计费完全准确。
- [#13335](https://github.com/vercel/ai/issues/13335)：Anthropic 空压缩块重发遭拒。
  报告针对较旧 Provider 版本及 OpenBot 未启用的选项，不能据此宣称此次升级已修复全部压缩问题。

## 复用决定与失败行为

选择正式依赖，沿用现有 Provider 和轻量 Server 适配器。明确缺口是自动依赖 PR 缺少研究证据，
不是缺少运行时实现。补充证据并验证最终锁文件，不放宽研究门禁或安全测试。
若契约失败，推迟或回退有问题的包升级及锁文件变更，保留当前失败关闭行为和 Owner 配置。

没有复制或实质改编上游源码。保留包内 `LICENSE` 和 `THIRD_PARTY_NOTICES.md` 中的 Vercel 归属，
按最终解析出的依赖集合同步所列版本。不新增平台、真实 Provider 或安全支持声明。

## 验证证据与验收计划

审查时，[#82 原始运行](https://github.com/Peerframe/openbot/actions/runs/34969569151)
对应 `9d4fc898c3cf8a6f15e157941a44b09013643e0e`，
[#83 原始运行](https://github.com/Peerframe/openbot/actions/runs/34969632041)
对应 `964cf1c11ba761e0d31cc3e34e930bf032e64d72`，各有八项检查通过。
两份日志均指出 PR 缺少 `Open-source research` 一节，导致 `validate` 失败并连带使汇总 `check` 失败。
这不能作为 Provider 执行发生新故障的证据。

本次阅读了上述上游测试，没有运行上游测试套件；实际执行了发布包校验和及许可证核对。
未使用 Provider 凭据、付费请求或用户对话。合并前最终集成提交必须通过干净依赖安装、
`npm run check`、安全审计、三个便携平台、Windows Worker Host 构建、数据库检查及两种 Server 容器架构。
合并证据必须使用当前提交的结果替代原始运行。与英文版本在同一改动中维护本译文。
