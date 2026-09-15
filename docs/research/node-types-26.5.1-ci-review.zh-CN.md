# 研究：@types/node 26.5.1 CI 证据

[English](node-types-26.5.1-ci-review.md) · [简体中文](node-types-26.5.1-ci-review.zh-CN.md)

- 日期：2026-09-15
- 状态：已研究，合并前仍须完整 CI 通过
- 关联 PR：#74
- 目标：为现有 Dependabot 升级补齐真实研究证据，保留全部检查。

## 研究与选择

核对[复用账本](../OPEN_SOURCE_REUSE.zh-CN.md)、[既有研究](dependency-ci-september12.md)、PR 中的依赖及锁文件、npm 元数据和[官方来源](https://www.npmjs.com/package/@types/node/v/26.5.1)。

未执行脚本，下载并检查精确 npm 包中的 package.json、LICENSE 和 index.d.ts。最低 TypeScript 5.6，保留 undici-types ~8.9.0 与 Node 文档许可说明；项目 TypeScript 7.0.2 满足要求。GitHub 对该版本的定向 PR 搜索无匹配，使用发布版本和完整 integrity 标识审核对象，不猜测源码提交。

精确版本：@types/node 26.5.1；标识：npm 26.5.1; integrity sha512-CzNm2FezW4VR/LjG6yUdiEgLE/rAQ9Slj5gCu/C2VrdcW7I0ahNZ8DRbHT7zOZ6r3ONgd/bsQIeSaoDGrd1C6g==；许可：MIT。

继续复用已发布依赖，没有需要自建实现或 fork 的缺口。本次补充仅增加文档，不放松安全与测试；兼容性失败时回退完整依赖升级。开发工具与类型包不改变运行时权限；模型提供方仍受 Server 身份、审批和工具策略约束。

## 失败与验证

[原 CI](https://github.com/Peerframe/openbot/actions/runs/34935880988) 因 PR 缺少 `Open-source research` 章节失败。补齐 PR 字段后推送研究文档，让新的 PR 事件包含更新后的正文；不能用旧事件重跑替代新正文验证。

本地运行真实 PR 事件校验与文档检查。当前提交仍须通过完整 `npm run check`、安全审计、三平台、数据库和两种 Server 容器架构的 CI；历史通过结果不代替当前提交验收，也不增加平台支持声明。

未复制或实质改写上游源码，保留发布包许可证与既有声明。
