![OpenBot — 黑色机器人与像素字标](docs/design/openbot-readme-banner.png)

# OpenBot

<p align="center">
  <a href="https://yxflc11.github.io/openbot-website/zh-cn/"><img src="https://img.shields.io/badge/WEB-OpenBot-57A639?style=for-the-badge&amp;labelColor=555555" alt="OpenBot 官网" height="28"></a>
  <a href="https://yxflc11.github.io/openbot-website/zh-cn/manual/installation/"><img src="https://img.shields.io/badge/DOCS-%E4%BD%BF%E7%94%A8%E6%89%8B%E5%86%8C-E7B416?style=for-the-badge&amp;labelColor=555555" alt="使用手册" height="28"></a>
  <a href="https://yxflc11.github.io/openbot-website/demo/index.html"><img src="https://img.shields.io/badge/DEMO-%E4%BD%93%E9%AA%8C%E6%BC%94%E7%A4%BA-5865F2?style=for-the-badge&amp;labelColor=555555" alt="体验交互演示" height="28"></a>
  <a href="#下载"><img src="https://img.shields.io/badge/DESKTOP-macOS%20%C2%B7%20Windows-168AAD?style=for-the-badge&amp;labelColor=555555" alt="下载 macOS 与 Windows 版" height="28"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-69A807?style=for-the-badge&amp;labelColor=555555" alt="MIT license" height="28"></a>
  <a href="https://github.com/Peerframe/openbot/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Peerframe/openbot/ci.yml?branch=main&amp;style=for-the-badge&amp;label=CI&amp;labelColor=555555" alt="CI status" height="28"></a>
  <br>
  <a href="README.md"><img src="https://img.shields.io/badge/LANG-English-3478C5?style=for-the-badge&amp;labelColor=555555" alt="Read in English" height="28"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/LANG-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-D94848?style=for-the-badge&amp;labelColor=555555" alt="阅读简体中文版" height="28"></a>
</p>

### 让 Bot 成为你的协作团队。

一个可以自托管的 Bot 工作区。为 Bot 定义职责，让它们在频道中交流、分工，并交付可用的文件。

[![OpenBot 频道工作区，使用示例数据](docs/design/openbot-channel-demo.png)](https://yxflc11.github.io/openbot-website/demo/index.html)

*实际频道组件截图，使用示例数据。点击可体验交互演示，演示不连接模型。*

## 下载

**Desktop 0.1.0-alpha.9**

| 平台 | 安装包 | 工作区 |
| --- | --- | --- |
| macOS · Apple Silicon | [下载 DMG](https://github.com/Peerframe/openbot/releases/download/desktop-v0.1.0-alpha.9/openbot-desktop-0.1.0-alpha.9-darwin-arm64.dmg) | 内置 Server 与 PostgreSQL，也可连接已有服务 |
| Windows · x64 | [下载 EXE](https://github.com/Peerframe/openbot/releases/download/desktop-v0.1.0-alpha.9/openbot-desktop-0.1.0-alpha.9-win32-x64.exe) | 内置 Server 与 PostgreSQL，也可连接已有服务 |

预览安装包尚未签名，macOS 包尚未公证。系统信任提示、升级方法及其他平台构建见[发行说明与校验值](https://github.com/Peerframe/openbot/releases/tag/desktop-v0.1.0-alpha.9)和[安装指南](docs/DESKTOP_INSTALLATION.zh-CN.md)。

## 开始使用

1. 安装 OpenBot，创建本地工作区，或连接已有的 Server。
2. 在 **设置 → 模型服务** 中选择提供方，保存密钥与模型，并启用 Agent。模型服务使用你自己的提供方账号。
3. 创建职责不同的 Bot，把它们加入频道。交代任务、附上材料，让 Bot 邀请同事协助。
4. 查看回复过程，在执行中补充指令，下载完成的文件。

再次打开时复用已保存的设置、加密凭据和工作区数据。本地服务随 Desktop 运行；无人值守的定时任务需要持续运行的 Server。

## 核心能力

- **组建团队。** 为每位 Bot 设置身份、职责与外观，审阅它的记忆、经验和技能版本。
- **频道协作。** 私聊或邀请多位 Bot 共同工作。Bot 以自己的身份分工，收齐结果再交付；支持引用回复、表情、成员管理和任务进度。
- **带上材料。** 添加文档、表格、PDF、图片或媒体，提取文字、使用本地 OCR、录制语音草稿，并明确选择受支持的转写。
- **带走成果。** 下载原始文件和产出报告，分享可复用 Bot 档案；分享包不包含私人对话、记忆、密钥和权限。
- **接入工具。** 审核 MCP 工具、资源、提示词和隔离的交互式 Apps，按 Bot 授予所需访问权限。
- **安排重复工作。** 创建固定间隔任务，暂停或恢复，查看最近一次执行结果。

当前工作区面向单一 Owner。Bot 分工有层级与并发限制；电脑控制需要另行登记 Worker 并连接兼容 Provider。具体用法与边界见[使用手册](https://yxflc11.github.io/openbot-website/zh-cn/manual/channels/)。

## 从源码运行

使用 **Node.js 22.22.2**、**npm 10.9.9**，并安装 Docker 运行本地 PostgreSQL。

```sh
git clone https://github.com/Peerframe/openbot.git
cd openbot
npm ci
cp .env.example .env
# 将 .env 中的 OPENBOT_OWNER_PASSWORD 设置为至少 15 个字符的随机密码。
npm run db:up
npm run dev
```

此命令先构建共享包，再启动 Server 与 Web。需要分开终端时使用 `npm run dev:server` 和 `npm run dev:web`，它们也会先构建各自依赖。可选 Worker 需先完成 [Node 登记](docs/NODE_ENROLLMENT.zh-CN.md)，再运行 `npm run dev:node`。

打开 [localhost:5173](http://localhost:5173)，用刚设置的密码登录。启动应用、修改界面和运行普通测试不需要模型账号；需要执行模型任务时，再到设置中连接模型并创建第一位 Bot。部署独立服务见 [Server 容器](docs/SERVER_CONTAINER.zh-CN.md)；构建原生桌面包见 [Desktop 安装指南](docs/DESKTOP_INSTALLATION.zh-CN.md#构建与准备发布)。

提交修改前，在仓库根目录运行 `npm run check`。

## 架构与目录

Desktop 和 Web 共用 React 界面。Server 统一管理 Bot 身份、路由、权限、审批与审计，执行模型任务和限定范围的 MCP 连接，通过 PostgreSQL 与对象存储保留数据，并把电脑任务分派给已登记的 Worker。

| 位置 | 职责 |
| --- | --- |
| [apps/web](apps/web) | 共享工作区界面 |
| [apps/desktop](apps/desktop) | Electron 桌面壳、本地服务与打包 |
| [apps/server](apps/server) | API、模型执行、协作调度与权限 |
| [apps/node](apps/node) · [Worker Hosts](docs/NODE_ENROLLMENT.zh-CN.md) | 已登记的执行节点与原生生命周期 |
| [packages](packages) · [providers](providers) | 共享契约与执行适配器 |
| [openbot-website](https://github.com/yxflc11/openbot-website) | 独立官网、手册与交互演示 |

模块职责与接入边界详见[仓库地图](docs/REPOSITORY_MAP.zh-CN.md)、[架构](docs/ARCHITECTURE.zh-CN.md)和[安全模型](docs/SECURITY.md)。

## 扩展与贡献

**开发插件：** 实现标准 MCP Streamable HTTP 接口，提供工具、资源、提示词或 Apps。依照[插件契约](docs/PLUGINS.zh-CN.md)，从[示例](apps/server/src/plugin-example.ts)开始，提交扩展供审核。无需 OpenBot 专属 SDK；安装插件和为 Bot 授权分开进行。

**参与核心开发：** 先阅读[贡献指南](CONTRIBUTING.zh-CN.md)、[开源复用规则](docs/OPEN_SOURCE_REUSE.zh-CN.md)和[文档索引](docs/README.zh-CN.md)。通过 [Issues](https://github.com/Peerframe/openbot/issues) 反馈问题与提案，通过 [Pull requests](https://github.com/Peerframe/openbot/pulls) 提交修改。安全问题请遵循[安全政策](SECURITY.md)。

## 许可与致谢

采用 [MIT](LICENSE) 许可，上游归属见[第三方声明](THIRD_PARTY_NOTICES.md)。Bot 演化与学习方向借鉴 [Hermes Agent 的学习图](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/agent/learning_graph.py)。

OpenBot 是其他项目也在使用的工作名称，本项目与 xAI、腾讯、CopilotKit、OpenClaw 无隶属关系。[日文](README.ja.md)和[葡萄牙文](README.pt-BR.md)翻译目前对应较早版本。
