# 独立 MCP 示例

[English](README.md) · [简体中文](README.zh-CN.md)

原 MIT 笔记示例与静态视图保持字节不变，现独立于旧 TypeScript Server 和测试 oracle。
`SOURCE.json` 记录原路径与哈希。示例使用已锁定的 MCP SDK1.30.0 与 Zod4.6.2，仅监听回环。

完成常规锁定安装后，在仓库根目录执行：

```sh
npm run start --workspace @openbot/mcp-example
npm run plugin:create -- /absolute/path/to/my-plugin
```

生成器把这两个源码文件与 MIT 许可复制到独立项目。[插件指南](../../docs/PLUGINS.zh-CN.md)
说明安装、显式回环地址许可、逐 Bot 授权和审批；启动 MCP 进程不会赋予 OpenBot 权限。

`npm run test --workspace @openbot/mcp-example` 创建自有临时独立项目，通过回环与真实 SDK
验证工具、资源、提示词及来源、请求大小、方法边界。历史目录中 alpha6 的源码路径保持不变，
因为其提交或标签与摘要指向已发布版本，不是当前源码树。
