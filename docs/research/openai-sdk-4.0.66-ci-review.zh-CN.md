# 研究：@ai-sdk/openai 4.0.66 CI 证据

[English](openai-sdk-4.0.66-ci-review.md) · [简体中文](openai-sdk-4.0.66-ci-review.zh-CN.md)

- 日期：2026-09-15
- 状态：已研究，合并前仍须完整 CI 通过
- 关联 PR：#76
- 目标：为现有 Dependabot 升级补齐真实研究证据，保留全部检查。

## 研究与选择

核对[复用账本](../OPEN_SOURCE_REUSE.zh-CN.md)、[既有研究](task-flow-refactor.md)、PR 中的依赖及锁文件、npm 元数据和[官方来源](https://github.com/vercel/ai/commit/9ed46d2da5df1394079c66d422bc553fd0c34376)。

核对官方发布提交的 package.json 与 CHANGELOG：4.0.66 包含批请求校验、图像批处理、搜索来源配置与 JSON Schema 兼容修正，同时更新 provider/provider-utils。最低 Node 22 与 CI 22.22.2 兼容。定向版本问题搜索无匹配并不表示不存在缺陷；继续运行 provider、Server 策略、工具审批和集成测试。

精确版本：@ai-sdk/openai 4.0.66；标识：9ed46d2da5df1394079c66d422bc553fd0c34376；许可：Apache-2.0。

继续复用已发布依赖，没有需要自建实现或 fork 的缺口。本次补充仅增加文档，不放松安全与测试；兼容性失败时回退完整依赖升级。开发工具与类型包不改变运行时权限；模型提供方仍受 Server 身份、审批和工具策略约束。

## 失败与验证

[原 CI](https://github.com/Peerframe/openbot/actions/runs/34935933346) 因 PR 缺少 `Open-source research` 章节失败。补齐 PR 字段后推送研究文档，让新的 PR 事件包含更新后的正文；不能用旧事件重跑替代新正文验证。

本地运行真实 PR 事件校验与文档检查。当前提交仍须通过完整 `npm run check`、安全审计、三平台、数据库和两种 Server 容器架构的 CI；历史通过结果不代替当前提交验收，也不增加平台支持声明。

未复制或实质改写上游源码，保留发布包许可证与既有声明。
