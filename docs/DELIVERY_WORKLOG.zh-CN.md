# 可用 Agent 交付证据 — 2026 年 9 月 7–8 日

[English](DELIVERY_WORKLOG.md) · [简体中文](DELIVERY_WORKLOG.zh-CN.md)

这是从 `8868da1` 开始的 [PR #19](https://github.com/Peerframe/openbot/pull/19) 历史证据，
不代表当前待办或发布资格。[交付状态](DELIVERY_STATUS.zh-CN.md)保留当时的能力与限制；
当前工作查阅[仓库地图](REPOSITORY_MAP.zh-CN.md)和[贡献者任务](CONTRIBUTOR_TASKS.zh-CN.md)。
[原始流水](https://github.com/Peerframe/openbot/blob/6f8b6697eec815e3d54ee739dfae3bf0eb7000b0/docs/DELIVERY_WORKLOG.zh-CN.md)
保留中间提交、检查、首次 DMG 哈希及详细时间线。

## 可复用结论与证据

| 范围 | 当时实际验证 | 技术约束与未完成证据 |
| --- | --- | --- |
| 安装包与许可 | macOS DMG 实际挂载、ASAR/fuse、原生资源及许可；三端原生安装包 CI；Linux 复制失败、重试与并发目标夹具 | 许可须来自 Packager 实际解压的运行时，检查嵌套 app 布局。公开发布、签名/公证、源码对应与真实设备资格另行验收。见[安装研究](research/desktop-installable-delivery.md)。 |
| 下载安全 | PowerShell 7.5.0 的九项离线用例；CI 分别运行 Windows PowerShell/pwsh；覆盖 Linux coreutils no-clobber 不同返回行为 | 保留重定向拒绝/次数、流式大小界限、既有目标和传输中取消。curl 低于 8.4 无法约束未知长度正文，须在联网前拒绝并保留手动下载入口。 |
| 报告交付 | 实际构建 Web/Server/PostgreSQL：登录、中文文件名、来源、鉴权下载、未登录 401、刷新保留；12 项数据库用例 | 来源与模型使用确定性夹具。本地 DNS 映射到保留 `198.18.*`，读取器正确地在连接前拒绝。真实公网读取未验证，不因此放宽私网拒绝。 |
| 原生保存 | 真实 Electron renderer/preload/main/Server/磁盘链路、来源一致及拒绝覆盖 | 保留仅接受产物 UUID 的有界鉴权抓取、全局浏览器下载拒绝和独占新建。QA 拦截保存对话框选路，不等同于未插桩系统对话框认证。 |
| 执行与用量 | 实际界面停止/重提、新任务与旧历史分开、模型报告用量；16 项 PostgreSQL 用例 | 重提创建新任务；固定超时/Server 拒绝类别丢弃上游流错误。Token 夹具和持久化停止不证明真实账单或断点恢复。 |
| 经验审核 | 273 项 Server 测试含 22 项 PostgreSQL 用例；实际编辑/批准/拒绝、后续任务使用、撤销、刷新及宽窄屏 | 分享默认关闭，快照有界并绑定修订；私有/已撤销内容不发送。不宣称付费推理或自主技能执行，后续技能实现由状态页链接。 |
| 模型配置 | OpenRouter 3.0.0 元数据验证、持久化/刷新、无密钥摘要；公开目录 HTTP 200 | 推理仍是夹具；保留路由限制、私有加密配置及工作区草稿。 |
| 桌面事件流 | 打包 ASAR 经验审核/撤销、四个刷新间隔的不同报告任务、另四次刷新及零页面错误 | 旧 SSE 占满请求连接槽。参考固定 Electron 源码及上游 issue 47097 后确定单窗口归属；导航/替换/切换 Server/退出/关闭均须中止。隔离身份和对话框覆盖不证明签名应用资格。 |

凭据扫描未放宽：负向测试中的合成网址改为运行时构造；上游错误和测试夹具都不是削弱扫描的理由。
安装器加固检查点的本地 DMG 没有 Worker companion，原生 CI 包含该组件。构建安装包不等于真实
设备安装验收，模拟 Provider 不等于真实付费任务。

## 历史最终检查

- 运行时 `cb718fc`：[CI 34155768881](https://github.com/Peerframe/openbot/actions/runs/34155768881)
  九项全部通过。三种安装器和三种便携包当时保留 14 天，不保证历史产物今天仍可下载。
- 文档 `688fefb`：[CI 34156245222](https://github.com/Peerframe/openbot/actions/runs/34156245222)
  九项全部通过。下载后的安装文件核对了版本、源提交、大小和 SHA-256。后续 curl 最低版本门槛及
  拒绝用例通过完整仓库检查。
- 界面路径使用实际构建应用、真实 Server/数据库及隔离凭据；来源和模型仍是夹具。临时进程和数据
  已清理。本次交付没有公开发布或付费模型调用。

当前验收应绑定自己的候选提交和必需检查；不能把旧结果重报为本轮通过，也不重做已完成交付序列。
