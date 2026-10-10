# 跨平台工作主机

[English](CROSS_PLATFORM.md) · [简体中文](CROSS_PLATFORM.zh-CN.md)

## 产品结论

Mac mini 是 OpenBot 首个实用工作主机，不是产品边界。工作主机是一台电脑或受管理运行环境，
数字员工可以在授权范围内使用它的浏览器、软件、文件、Shell、屏幕和输入能力。Windows、
macOS 和 Linux 必须通过同一套由 Server 授权的协议接入。

用户从其他设备上的 Client 指挥和监督员工。Client 不会继承工作主机凭证，也不能绕过 Server
直接控制 Node。

```text
Web / PWA / 移动伴侣端
            |
       HTTPS / 实时事件
            v
OpenBot Server + PostgreSQL
            ^
       出站 WSS / mTLS
            |
Windows | macOS | Linux | 容器 | VM | 受管理移动设备
                       工作主机
```

## 三种平台支持不能混淆

| 层 | 责任 | 第一阶段策略 |
| --- | --- | --- |
| Server 主机 | 频道、员工身份、策略、路由、审计和持久化 | 发布一套 Linux x64/arm64 OCI 镜像，可运行在 Linux、NAS、云、macOS 或 Windows 容器环境 |
| 工作主机 | 提供真实执行能力 | 原生 Node daemon 加窄范围平台 Provider |
| Client | 下达任务、查看、审批和接管 | 先用响应式 Web/PWA，后加可选伴侣外壳 |

Server 能在某个系统上运行，不等于 OpenBot 已经能控制该系统的原生桌面。每个原生 Provider
必须单独定义支持等级和威胁模型。

## 目标支持矩阵

| 平台或设备 | Server | Node | 原生能力 | 目标等级 |
| --- | --- | --- | --- | --- |
| Linux x64/arm64 | 正式 | 正式 | 浏览器、Shell、文件；桌面后加 | 首个 Certified |
| NAS 容器主机 | 正式 | 可选 | 容器任务 | Supported |
| Windows x64/arm64 | 容器/WSL 兼容 | 原生服务 | 浏览器、PowerShell、UI Automation | Supported |
| macOS arm64/x64 | 开发/兼容 | 原生 launchd | 浏览器、Cua/Accessibility、Apple Silicon Lume | Supported |
| 云虚拟机 | Linux 正式镜像 | Linux/Coder Node | 无头任务 | Supported |
| 受管理 Android | 不运行 Server | 设备桥接 | 明确设备所有权下的 UI Automator/ADB | Experimental |
| iPhone/iPad | 不运行 Server | 第一阶段只做伴侣端 | 审批、通知、查看和显式系统集成 | Companion |
| Raspberry Pi/边缘 Linux | 可选 | 轻量 arm64 Node | Shell、文件和已批准设备适配器 | Experimental |
| GPU 工作站 | 可选 | Compute/Coder Node | 模型、媒体和批处理 Provider | Experimental |

## 结构化工作主机身份

协议 `0.9.0` 已经声明：系统及版本、CPU 架构、设备类型、隔离类型、信任等级、容量、临时旧能力
别名，以及带 Provider 身份和约束的版本化能力。Provider 包版本、屏幕/输入传输、可用策略、
详细健康状态和更新通道仍待实现。握手只是执行能力声明，不是授权。

当前通道已经限制登记时间和消息体、用 ping/pong 判断存活，并由 Server 独占 Run 分配权。短时、
单次令牌会换取一台 Node 独有且可单独吊销的凭证，Server 只保存摘要。当前凭证仍是可复制的
bearer 值；持有证明、mTLS、轮换和防重放仍待完成。面向 Linux 登录会话、经过契约测试的
Secret Service 适配器已经存在，但真实密钥库/systemd 设备证据以及 Windows/macOS 密钥库存储
仍待完成，详见 [ADR-0023](decisions/0023-one-time-node-enrollment.md)和
[ADR-0032](decisions/0032-linux-worker-host-service-profiles.md)。

Bot 配置应选择能力策略，而不是操作系统枚举。用户可以将员工固定到某台工作主机，但模型不能
自行解除绑定或换机。

能力使用稳定名称和主版本，例如：

```text
browser.observe@1
browser.input@1
desktop.observe@1
desktop.input@1
shell.execute@1
filesystem.read@1
filesystem.write@1
computer.takeover@1
```

Provider 上报能力只说明“可能做到”；Server 策略与 Run 级短时租约才代表“这次允许做到”。

Run offer 现在要求精确能力主版本；Server 路由和工作主机都会拒绝缺失或不兼容的版本，旧能力
别名不能作为后备路径。可执行矩阵和真实支持等级见
[Provider 一致性测试](PROVIDER_CONFORMANCE.md)。

## 目标 Provider 布局

```text
providers/
  browser-playwright/     跨平台语义浏览器
  docker/                 隔离 Linux 浏览器与工作区
  shell/                  受限命令执行
  windows-uia/            Windows UI Automation
  macos-cua/              macOS Accessibility/Cua
  macos-lume/             隔离 macOS VM
  linux-desktop/          Linux 桌面辅助功能适配器
  android-uiautomator/    受管理 Android 设备
  coder/                  隔离编码运行时
```

这是目标结构，不代表这些 Provider 已经可用。每个 Provider 必须通过公开的一致性测试和真实设备
测试，才能从 Experimental 升级为 Supported 或 Certified。

## 跨平台边界

- 交互能力先做浏览器，因为 DOM、URL 和表单语义比纯像素更安全，也更容易跨平台。
- Windows、macOS、Linux 原生桌面统一使用 prepare/approve/commit，但不假装平台 API 相同。
- Linux 桌面环境差异较大，因此先认证浏览器和 Shell，再认证桌面。
- Android 只支持用户拥有并明确登记的受管理设备。
- iOS 先做审批、通知、查看和系统明确允许的伴侣功能，不承诺 V1 无人值守全设备控制。
- 工作主机使用员工专用账户，不能复用用户主浏览器、主密码库或管理员会话。

## 发布目标

| 目标 | 软件包 |
| --- | --- |
| Server | 多架构 OCI 镜像与 Docker Compose |
| Linux Node | 签名压缩包、systemd，随后提供 deb/rpm |
| Windows Node | 签名安装器与 Windows Service |
| macOS Node | 目标：签名、公证安装包与 launchd；当前：arm64 未签名候选源码已完成，等待分发与真实设备证据 |
| Android bridge | 面向受管理设备的签名伴侣/桥接包 |

所有发布必须附带校验和、第三方声明、SBOM、协议兼容性和明确支持等级。生产环境只使用固定版本，
不直接拉取 `main`。

macOS 候选现已包含原生双模式控制器/Host、固定应用内 LaunchAgent、官方固定 Node 运行时、
绑定 Server 的数据保护 Keychain 事务、严格运行时清单，以及失败关闭的签名、公证和打包门槛。
本机编译、Swift 测试、候选 staging、架构检查与 ad hoc 签名机制均已通过。这仍不代表 macOS
支持：Developer ID profile、公证、安装/升级/回滚/卸载、Keychain 锁定、后台项批准、重启与
Intel 仍需受控真实设备证据。

## 最终验收

跨平台 Beta 的过线标准是：Server 运行在 Linux、NAS 或云主机；用户从手机打开频道并把任务
交给员工；Server 在已授权的 Windows、macOS 或 Linux 工作主机中确定性选择；副作用先冻结并
等待审批；用户可以查看或独占接管；替换工作主机后，员工身份、技能、记忆和历史保持不变。
