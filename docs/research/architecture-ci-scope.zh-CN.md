# 研究：让 CI 明确验收 Python 产品

- 日期：2026-09-26
- 状态：接受 CI 接线方案，新托管检查通过前不能算验收完成。
- 范围：PR #96 的 CI；不切默认后端、不部署、不访问付费模型或远程私有环境。

核对实际入口后，旧 CI 不能整体当作新架构的验收：

| 检查 | 实际对象与证据范围 |
| --- | --- |
| 仓库 `check`、Portable | 保留客户端、共享包和仍在仓库中的 TS Server；默认 Desktop 打包仍选择旧 Server |
| database、旧容器和 Python 子进程容器 | 共享 SQL 与旧业务实现；Python 子进程不等于 Python 产品 Server |
| `Dockerfile.product` | 实际 Python 产品入口，已有 Linux amd64/arm64 HTTP、解析、迁移和生命周期验收 |
| Python control/Worker | Python 测试、真实 PostgreSQL、公开 HTTP 和 mTLS Temporal；其中旧契约比较使用冻结的测试对照 |
| S7 | 合成迁移与配对恢复，原先没有计入受保护的 `check` |

已存在的 Python Preview 准备、打包和生命周期脚本没有进入 CI。Windows 旧安装器通过，不能
替代它们。冻结的旧实现只验证需保留的历史契约，不能决定新产品行为。

本轮复用已有能力修正接线：

1. 把直接 Python 产品容器从旧容器兼容检查中拆成独立结果。
2. 增加 macOS arm64 Python Preview：构建保留包，显式准备 Python 运行时，验证后用 Python
   与 Preview 标志打包，再对包内资源执行真实启动、登录、重启保留、父进程退出和清理检查。
3. 用 GitHub 官方 `workflow_call` 调用同提交的 S7 流程，将其结果纳入必需 `check`，避免重复运行。
4. 明确标识旧实现兼容检查。产品默认及退役边界尚未改变，暂时保留原检查，不能静默删掉覆盖。
5. 扩展现有门禁守卫，实际执行汇总 shell 的成功、失败、取消、跳过及缺失结果反例。

精确提交、来源、复用比较与验证计划见[英文研究](architecture-ci-scope.md)。没有新增依赖、
复制上游代码或修改产品行为。macOS smoke 使用合成加密回调，不证明 Keychain、GUI、签名或
安装；Windows/Linux Python Desktop 不新增支持声明。真实产品命令/runsc、浏览器接管、私有
远程回放、在线迁移仍有独立未完成门槛。npm 漏洞扫描也不能代表 Python 依赖漏洞扫描，锁文件
和 `pip check` 证明的是另一件事。旧 CI 全绿不能填补这些缺口。
