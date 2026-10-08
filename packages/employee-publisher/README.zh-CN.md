# 离线员工发布者工具

[English](README.md) · [简体中文](README.zh-CN.md)

此开发工具包保留离线 `employee:publisher-key` CLI 与原密钥库、模板依赖闭包。它不运行
Server、不访问数据库、不导入 `apps/server` 或冻结的测试 oracle。初始源码保持原 OpenBot
MIT 字节；`SOURCE.json` 记录来源与哈希，`LICENSE` 保留许可声明。

完成常规锁定安装后，在仓库根目录执行：

```sh
npm exec -- turbo run build --filter=@openbot/employee-publisher
npm run employee:publisher-key -- help
npm run test --workspace @openbot/employee-publisher
```

Owner 专属密钥位置、信任、轮换与 Python 配置见[签名指南](../../docs/EMPLOYEE_SIGNING.zh-CN.md)。
根启动器保留历史 `apps/server` 相对路径基准，但不要求该目录存在；新部署建议使用绝对路径。
私钥和口令不得放入员工包。

旧 TypeScript Server 已退役，冻结 oracle 仅作为测试证据。本包保留离线密钥生命周期、
模板格式和校验；原始依赖闭包中的旧 Store 契约、请求结构及任务调度函数已移除。
`SOURCE.json` 记录初始提取（含后续已退出的路径），属于历史来源证据，不是当前源码清单。
运行时权威继续由 Python 控制层持有。

P3 TS 候选通过 `agent-skills` 和 `sensitive-content` 子路径复用纯文本解析函数。这两个入口不读取数据库、文件系统或密钥库，不访问网络，也不启动离线 CLI。选中的 TS 服务负责认证后的 SQL 事务；迁移期间保留默认及反向切换的 Python 所有权。
