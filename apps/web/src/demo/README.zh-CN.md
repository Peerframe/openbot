# 官网交互演示

[English](README.md)

这个独立静态入口直接复用正式产品的 `Sidebar`、`ChannelWorkspace`、`RobotAvatar`、消息操作、表情、任务详情与全部产品样式，不是截图或另画的界面。一组固定示例展示交代任务、两位 Bot 分工、逐段回复和 Markdown 交付，顶部始终说明“不连接模型”。

在仓库根目录运行：

```sh
npm run build:demo -w @openbot/web
npm exec --workspace @openbot/web -- vite preview --config vite.demo.config.ts --port 5178
```

产物为 `apps/web/dist-demo/index.html` 和资源文件。把**整个目录**复制到官网构建产物的 `demo/`；相对资源路径支持 `/demo/` 与项目 Pages 子路径。官网构建应先重新构建演示，再复制，避免发布旧文件。不要复制到 Desktop renderer，也不要修改正式应用入口。

建议嵌入方式（按父页面位置调整地址）：

```html
<iframe src="./demo/index.html" title="OpenBot 交互演示 · 示例数据"
  loading="lazy" referrerpolicy="no-referrer"
  allow="clipboard-write; microphone 'none'; camera 'none'; geolocation 'none'"
  style="width:100%;height:780px;border:0"></iframe>
```

可在进入视口时使用 `?autoplay=1`；偏好减少动效的用户仍需手动播放。标签页隐藏时会暂停。播放、暂停、重播、看交付均由 iframe 内按钮控制，不需要父页面读 DOM 或发消息。宽度低于 700px 时，“频道”按钮打开真实侧栏浮层。隔离由受限 adapter 和内容安全策略实现；缺少 `allow-same-origin` 的 iframe sandbox 会阻止模块或复制，缺少 `allow-downloads` 会阻止下载，不要添加会破坏所示功能的配置。

## 范围

- 仅演示入口会在动态加载产品组件前替换 fetch/EventSource。未知路径、外部地址直接拒绝，永不回退正式请求。HTML 使用 `connect-src 'none'`，禁用 iframe、worker 和表单外发。没有 Service Worker、Server、密钥、真实模型或遥测。
- 产品偏好加载前，浏览器存储替换为这个页面的内存版本。刷新或重播清空状态。输入框的文字只留在本页，返回内容明确说明是固定示例，不冒充模型生成。
- 可操作播放控制、滚动、侧栏搜索、Bot 身份卡、引用回复、复制、六种 Owner 表情、协作任务链接、详情和停止，以及下载固定文件。创建和设置等其他入口说明完整工作区的范围。上传、插件调用、录音不会向服务发送内容；未支持写入直接拒绝。演示不能替代对应正式功能测试。
- 文件链接仅在演示中转为固定 Markdown Blob，不包含用户数据。复制只在访客点击后写入剪贴板；跨域嵌入时父页面需允许 clipboard-write。
- 不编造人数、token、真实模型耗时等统计。产品“实时连接”指示在这里对应本地事件适配器，顶部演示标识始终可见。

适配器测试随正常 Web 测试运行。[研究记录](../../../../docs/research/website-component-demo.md)解释了复用决定。浏览器验证记录在下方；截图不入仓库。

## 验证记录（2026-09-10）

独立生产构建和 6 项适配器／真实组件测试通过。集成测试直接使用正式 API 模块，检查逐段事件进入 ChannelWorkspace、真实表情 chip、复制内容、任务链接打开任务详情（当时为 `RunInspector`，现为 `TaskSheet`），以及重播清空对话。Chrome 实测默认桌面、1060×640、390×780 和 390×640：侧栏搜索／浮层、播放与暂停、Nova／Otto 逐段回复、看交付、实际引用发送、复制成功反馈、表情、协作详情链接，并核对下载的 Markdown 正文。控制台检查没有错误。截图仅保留为临时验收证据，不提交仓库；此记录不代表全浏览器或真实模型验收。

## 更新（2026-10-03）

- 演示已经用上重新设计的组件。
- 侧栏随宽度伸缩：窄的嵌入里是 212 像素，宽到 1440 时和产品一样是 300 像素。
- 固定的示例任务会报告 C13 步数，所以任务卡显示「已完成 N 步 · 现在：…」，协作者那几行也有各自的步数。`GET /api/v1/runs/:id/progress` 用同一组固定步骤回答，不显示计划总数。
- 验证：独立构建、7 项演示测试，以及播放中途在 1440×900 的 Chromium 截图。
