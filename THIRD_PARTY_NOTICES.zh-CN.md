# 第三方声明

[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

本页是依赖清单的中文说明。版权及 MIT、BSD 2-Clause、ISC 等许可的完整英文原文见
[规范声明](THIRD_PARTY_NOTICES.md)，随发布包保留，不由本页摘要替代。精确解析版本以
提交的锁文件为准；发布产物还须包含生成的 SBOM 和第三方声明。

| 组件 | 版本 | 版权归属及许可 |
| --- | --- | --- |
| Microsoft .NET、`Microsoft.Extensions.*`、`System.*` | 锁文件及发布运行时确定 | .NET Foundation 与贡献者；MIT |
| `Meziantou.Framework.Win32.Jobs` | 4.0.0 | Gérald Barré；MIT |
| Electron | 44.3.0 | Electron 贡献者及 GitHub Inc.；MIT；保留 `LICENSE` 与 `LICENSES.chromium.html` |
| `@electron/fuses` | 2.1.3 | 2020 Electron Maintainers；MIT |
| `@electron/packager` | 20.3.0 | 2015 Max Ogden 与贡献者；BSD 2-Clause |
| `@electron/asar` | 4.3.0 | 2014 GitHub Inc.；MIT |
| `write-file-atomic` | 8.0.0 | 2015 Rebecca Turner；ISC |
| `signal-exit` | 4.1.0 | 2015–2023 Benjamin Coe、Isaac Z. Schlueter 与贡献者；ISC |
| `@modelcontextprotocol/sdk` | 1.30.0 | 2024 Anthropic, PBC；MIT |
| Vercel AI SDK `ai` | 7.0.93 | 2023 Vercel, Inc.；Apache-2.0 |
| `@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/moonshotai` | 4.0.66、4.0.53、3.0.49 | Vercel, Inc.；Apache-2.0 |
| `@ai-sdk/provider`、`@ai-sdk/provider-utils` | 4.0.10 / 4.0.14、5.0.36 / 5.0.40 | Vercel, Inc.；Apache-2.0 |
| `@ai-sdk/gateway`（传递依赖） | 4.0.75 | Vercel, Inc.；Apache-2.0 |
| `@openrouter/ai-sdk-provider` | 3.0.0；提交 `c1ce69ab9dfe9ca87a57e1db5faf35ee78f6fa1a` | OpenRouter 贡献者；Apache-2.0 |

Fuses、Packager 与 ASAR 工具用于构建和校验，不进入应用 ASAR。`write-file-atomic` 及其
运行时依赖 `signal-exit` 用于原子保存公开来源配置，会包含在应用中。

Server 使用显式 OpenAI、Anthropic、OpenRouter 和 Moonshot 适配器；SDK gateway 并非
实际调用入口。生产依赖树及产物保留各包的 `LICENSE`。未复制上游实现源码。

研究依据：[MCP 插件](docs/research/third-party-mcp-plugins.md)、[原生 Agent](docs/research/native-agent-loop.md)、
[OpenRouter](docs/research/openrouter-model-entry.md)、[本次 SDK 补丁](docs/research/ai-sdk-patches-september15.zh-CN.md)、
[Electron 更新](docs/research/electron-44.3-ci-review.zh-CN.md)。
