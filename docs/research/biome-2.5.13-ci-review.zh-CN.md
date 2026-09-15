# 研究：@biomejs/biome 2.5.13 CI 证据

[English](biome-2.5.13-ci-review.md) · [简体中文](biome-2.5.13-ci-review.zh-CN.md)

- 日期：2026-09-15
- 状态：已研究，合并前仍须完整 CI 通过
- 关联 PR：#73
- 目标：为现有 Dependabot 升级补齐真实研究证据，保留全部检查。

## 研究与选择

核对[复用账本](../OPEN_SOURCE_REUSE.zh-CN.md)、[既有研究](deps-patch-hono-biome-types-filename.md)、PR 中的依赖及锁文件、npm 元数据和[官方来源](https://github.com/biomejs/biome/blob/810ea565b87dc639b64805ebadb2e7d68b9d7cc7/packages/%40biomejs/biome/CHANGELOG.md)。

官方变更记录包含类型推断性能修复和规则修正；主包及八个可选平台二进制均精确锁定 2.5.13。Node 最低版本 14.21.3 与 CI 22.22.2 兼容。保留推荐规则，不启用新增 nursery 规则。上游问题搜索返回 #11782、#11744、#11745、#11786 等报告，因此仍以完整 lint 检查通过为准。

精确版本：@biomejs/biome 2.5.13；标识：810ea565b87dc639b64805ebadb2e7d68b9d7cc7；许可：MIT OR Apache-2.0。

继续复用已发布依赖，没有需要自建实现或 fork 的缺口。本次补充仅增加文档，不放松安全与测试；兼容性失败时回退完整依赖升级。开发工具与类型包不改变运行时权限；模型提供方仍受 Server 身份、审批和工具策略约束。

## 失败与验证

[原 CI](https://github.com/Peerframe/openbot/actions/runs/34935873986) 因 PR 缺少 `Open-source research` 章节失败。补齐 PR 字段后推送研究文档，让新的 PR 事件包含更新后的正文；不能用旧事件重跑替代新正文验证。

本地运行真实 PR 事件校验与文档检查。当前提交仍须通过完整 `npm run check`、安全审计、三平台、数据库和两种 Server 容器架构的 CI；历史通过结果不代替当前提交验收，也不增加平台支持声明。

未复制或实质改写上游源码，保留发布包许可证与既有声明。

