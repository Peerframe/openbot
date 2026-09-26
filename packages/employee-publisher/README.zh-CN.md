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

旧 Server 暂时保留现有运行时所需、未修改的密钥库与模板辅助代码，已不再拥有 CLI 入口。
这些辅助代码将在另行验收的旧运行时退役时一并移除，不作为第二套实现长期维护。本包不是
生产 Server 替代品，也不代表 Linux 或浏览器验收完成。
