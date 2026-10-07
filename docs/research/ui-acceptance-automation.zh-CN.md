# 调研：自动化的整体界面验收

[English](ui-acceptance-automation.md) · 简体中文

- 状态：已采纳（所有者 2026-10-07 决定）
- 日期：2026-10-07
- 负责人：OpenBot 维护者
- 验收场景：一条命令搭起临时环境，在真实浏览器里操作真正构建出来的网页界面。临时环境包括：Docker 里的 PostgreSQL、
  提供网页的 Python 产品，以及存在时的 TS 入口。要走的流程：
  - 登录；
  - 建两个 Bot 并回答分工卡；
  - 检查右栏分页，给 Bot 改名；
  - 建频道，发消息和附件，取消一个任务；
  - 打开设置的每个分区；
  - 重启对外入口，确认页面自己重连、不用重新登录。

  最后给出通过或不通过的报告、截图，以及每个接口响应的统计。
- 安全边界：
  - 只用临时数据和自动生成的凭证；不安装任何东西，不调用模型；
  - 用 Owner 已安装的 Chrome 或明确指定的路径，工具本身不下载任何东西；
  - 报告里会遮盖生成的密码和数据库地址。

## 触发原因与已有决定

- 触发：新增一个开发依赖。
- 已有决定：
  - [Linux 浏览器验证](linux-browser-qualification.md)把 Playwright 1.62.1 当作员工浏览器运行时的容器镜像审核过；
  - [入门级 DOM 回归](starter-dom-regressions.md)把 axe/Playwright 无障碍 CI 关卡推迟了。

  两者都没有往仓库里加 Node 的浏览器自动化包。
- 变化：控制面迁回 TypeScript（见[迁移计划](typescript-control-plane-plan.md)，P2–P5）每切换一组接口，都要做一次整体界面验收。
  2026-10-07 的 P2 验收手工做了约一小时，而且发现了一个接口契约测试没覆盖到、原本就缺的接口。所有者要求把验收做成可重复的。
- 本次范围：选浏览器驱动，以及它怎么搭环境。无障碍审计和接入云端 CI 不在本次范围内。

## 检索证据

- 检索日期：2026-10-07。
- npm 与 GitHub：`playwright-core`、`@playwright/test`、`puppeteer-core`、`webdriverio`、`cypress`（npm 元数据、发布标签、
  许可、依赖列表、未解决问题数）。
- 检查过的 OpenBot 现有工具：
  - `scripts/python-acceptance-fixture.ts`（自管 Docker PostgreSQL、环境变量白名单）；
  - `scripts/dev-processes.ts`（自管子进程）；
  - `deploy/server/product-migrate.ts`；
  - Python 的 `OPENBOT_CONTROL_WEB_ROOT` 静态挂载。

## 候选对比

| 候选 | 版本 | 许可 | 维护与测试 | 适配 | 决定 |
| --- | --- | --- | --- | --- | --- |
| playwright-core | 1.63.0（2026-09-04），标签 `v1.63.0` / `1b025d7e20a026371cd5f98ba0cdce48892737c8`，npm 完整性 `sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==` | Apache-2.0 | 微软维护；发布频繁；约 180 个未解决问题 | 没有任何依赖，也没有安装脚本（解压后 13.4 MB）；不下载浏览器；通过 `channel` 或 `executablePath` 使用已安装的 Chrome；以后还能直接启动 Electron 做桌面版验收 | **采用** |
| @playwright/test | 1.63.0 | Apache-2.0 | 同一项目 | 自带测试框架和配置；仓库已经在用 `node --test` 和 Vitest | 不需要 |
| puppeteer-core | 25.12.0 | Apache-2.0 | 谷歌维护；约 280 个未解决问题 | 有 6 个运行时依赖；不能启动 Electron | 不采用 |
| webdriverio | 10.0.0 | MIT | 项目较小（约 9.8k 星） | WebDriver/BiDi 服务层，对本机流程来说太重 | 不采用 |
| cypress | 16.1.1 | MIT | 大项目 | 自带测试框架，要下载应用程序，并在浏览器内运行，不适合编排多个进程 | 不采用 |

## 复用决定

- 选择：已发布的依赖 `playwright-core` 1.63.0，作为根目录的开发依赖，锁定确切版本。
- 原因：没有依赖链，不用下载浏览器，也是唯一一个以后还能驱动 Electron 桌面版的候选。
- OpenBot 自己要写的部分：
  - 流程本身，用 OpenBot 自己的文字和选择器；
  - 复用现有的自管 PostgreSQL 和进程管理来搭环境；
  - 一份报告，对每个接口响应分类。已知并记录在案的缺口按确切接口加原因放行，其他一律判失败。
- 升级或退出：浏览器驱动只用在两个文件里。替换它只需重写流程步骤，环境编排和报告都不依赖它。
- 失败时：
  - 找不到浏览器、Docker 不可用或缺少构建产物，会在启动任何产品进程之前给出明确提示并停止；
  - 出现意外的响应状态、页面报错或某一步失败，都判为不通过，报告里保留证据；
  - 退出时，以及收到 SIGINT/SIGTERM 时，清理所有自管进程和容器。

## 源码引入

- 是否复制或大幅改编源码：否。
- 声明：`playwright-core` 只用于开发，不随任何产品一起发布。

## 验证计划

- 自动测试：参数解析和响应分类（`node --test`）。
- 负面测试：
  - 未知的状态码或接口判失败；
  - 放行规则只匹配确切的接口，范围之外的同类响应判失败；
  - 找不到浏览器时，在任何东西启动之前停止。
- 实际运行：在 main 上对 Python 产品跑完整流程（本机 macOS，已安装的 Chrome）。
- 文档：本记录（中英文）和 CONTRIBUTING 里的说明。
- 支持程度：给维护者和智能体用的本机验收工具，暂时不是 CI 关卡。

## 未决问题

- 接入云端 CI 需要给 Linux 运行环境固定浏览器来源，这是另一项改动。
