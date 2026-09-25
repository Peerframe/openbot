# OpenBot 插件目录

[English](README.md) · [简体中文](README.zh-CN.md)

插件通过 MCP Streamable HTTP 提供能力。此目录保存经审核的元数据，不接受上传后立即执行的代码。安装连接、向 Bot 分配权限仍需用户单独审核。

- [协议与限制](../docs/PLUGINS.zh-CN.md)
- [可运行示例](../packages/mcp-example/src/plugin-example.ts)
- [目录数据](catalog.json) 与 [结构约束](catalog.schema.json)
- [提交插件](https://github.com/Peerframe/openbot/issues/new?template=plugin-submission.yml)

提交内容应包含源码、精确版本、许可证、配置、认证、外部影响、支持平台、成功与失败测试及维护者信息。维护者审核后通过 Pull Request 加入目录。条目保存审核版本与源文件校验值，不为将来变化的远程端点背书，不自动授权或执行代码。

初始条目是本地开发示例，不是在线托管服务。请按协议手册在服务电脑明确允许其回环端点。适合加入核心产品的通用能力，使用正常的先研究再实现的贡献流程。
