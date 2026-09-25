# 原生 Task 范围 UI

[English](native-task-ui.md) · [简体中文](native-task-ui.zh-CN.md)

- 状态：UI 候选，仍需主控完成真实浏览器与产品 API 集成验收。
- 日期：2026-09-25。
- 范围：现有 React 任务页面中的 Owner 附件与不可变能力授权。
- 边界：身份、范围快照、授权、审批与生命周期仍由 Server 独占判断。

## 复用审阅

继续使用 React/ReactDOM 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb`（MIT）、Zod 4.6.2（MIT）及仓库已有 Vitest/jsdom。实施前检查了[现有 React 审阅](react-19.3-version-coherence.md)、WorkTasksScreen 生命周期测试、Owner 附件 DTO 合同与频道附件处理交互。没有新增依赖或框架，没有复制上游源码，仅局部适配现有 OpenBot 代码，保留原依赖许可证。

2026-09-25 查阅的主要来源：[固定版本 React 源码](https://github.com/react/react/tree/v19.3.0)、[事件处理](https://react.dev/learn/responding-to-events)、[Effect 清理](https://react.dev/reference/react/useEffect)。修改操作只在显式事件中执行，有界读取在页面状态变化时中止并忽略晚到响应。现有发布版渲染器与表单/HTTP 适配器满足要求，无需重复引入上传器或状态框架；未采用现有 React 审阅所列上游问题涉及的新渲染 API。

## 行为与集成

表单支持上传 Owner 附件、选择/解除选择、软删除/恢复，并提供显式文字提取、OCR 与转写。上传不会自动选中或处理文件。PDF 密码在点击处理、离线、离开和卸载后清空，不进入 Task 请求。文本/图片/其他文件上限仍为 256 KiB/5 MiB/10 MiB，每任务最多八件、合计 20 MiB。Office/音频/视频须先显式处理；原始图片/PDF 可直接作为输入，但元数据不表示模型已消费文件。

完整 scope 与原 requestKey 一起冻结，提交结果未知时只允许原样显式重试；明确参数/413 拒绝允许修改后生成新请求。附件操作不自动重试，结果未知时须刷新已选元数据。新任务的列表为空，能力选项均为 false。仅显示 none/model Bot，协作范围排除当前 Bot，最多选择 32 个。原取消、纠正、审批与未知核验语义保持不变。

`WorkTasksScreen.nativeCapabilitiesEnabled` 默认 false。知识/插件/web/协作 adapter 集成验收后，由产品组合层显式启用；工作台与独立 WorkTasksEntry 均需明确接入。独立入口的 Bot reader 保留 computerProfile；工作台本来已包含该字段。UI 默认值不授予运行时权限。

查询任务另读不可变 `GET /api/v1/tasks/{id}/scope`，只读展示授权与哈希，拒绝错命名空间或不一致 DTO，忽略离线/旧任务的晚到响应。读取失败不能显示成没有权限。未添加本地存储、频道身份或隐式 provider 调用。

## 验证

WorkTasksScreen、WorkTasksScope、work-api、native-task-api 与 App.navigation 五个文件共 82 项通过，TypeScript 通过。这些是 mock HTTP 的 React DOM/jsdom 实际交互，不是浏览器/真实 API/provider 验收；最后一层由主控完成。

在已安装固定依赖的仓库根目录运行：

```sh
npm run typecheck --workspace @openbot/web
cd apps/web
../../node_modules/.bin/vitest run src/components/WorkTasksScreen.test.tsx src/components/WorkTasksScope.test.tsx src/native-task-api.test.ts src/work-api.test.ts src/App.navigation.test.tsx
```

覆盖原样重试、默认授权、Bot 过滤与排除自己、上传/选择/删除/恢复、显式处理与密码清空、单文件与总量限制、离线/卸载失效、旧任务响应、只读 scope、会话错误和原多字节 413 修正。没有使用 PG、Temporal、VPS、模型服务或用户配置，也未安装浏览器。

## 整合后的真实浏览器检查点

root扩展后的91项React／API检查与Web类型检查通过。真实Chrome连接Python Owner API，完成登录、
26字节CSV上传／选择、Task创建、不可变scope读回及显式取消关闭授权；桌面和390px均检查且无横向溢出。
另一个新Task取消后验证“创建另一个任务”正确重置表单，不再弹出此前HTML必填提示。
三个UI测试Task均已显式取消，最终控制台错误为空。该UI夹具没有Temporal／模型服务，证据仅覆盖界面／API；
真实原生HTTP／PG／mTLS编排另见native-capabilities流程记录。
