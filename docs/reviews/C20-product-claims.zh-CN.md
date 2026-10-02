# C20：界面上的浏览器与附件承诺核实

基线 `cbf1700bf596f8f06f202005123e6d92cf7d59a1`，2026-10-03。
不改界面或运行代码；代码入口和测试名称完整列在[英文记录](C20-product-claims.md)。

| 当前承诺 | 核实结果 | 可直接替换的文案 |
| --- | --- | --- |
| 画面只在内存里保留 | 仅浏览器窗口实时画面路径成立；任务截图可保存成产出 | 这个窗口的实时画面不保存为文件；任务产生的截图可能保存为产出。 |
| 登录状态留在工作电脑 | 原工作主机的每 Bot 私有 profile 持久保存；清除数据会移除，换机不自动迁移 | 登录状态保存在运行浏览器的工作电脑；清除浏览数据会移除登录状态。 |
| 关闭窗口会暂停控制 | 界面只在已接管时显示，成立；纯查看关闭不会暂停 Bot，断线或过期不会自动恢复 | 接管后关闭窗口，Bot 会保持暂停；重新打开并点「交还 Bot」后才会继续。 |
| 移到回收站的文件不再发给 Bot | 拒绝新引用和后续读取；无法撤回已发送给模型的内容，Owner 历史下载仍保留 | 移到回收站后，Bot 不能再读取或新引用这个文件；已发送的内容无法撤回。 |
| 清理只删除满 7 天且无消息／任务引用的文件 | **不成立**：UI 调用的 `/attachments/cleanup` 没有服务端路由，也没有 7 天无引用清理器。删除整个频道时的清理是另一条授权路径，不受此规则约束 | 移入回收站后可恢复；永久清理暂未提供。 |
| 音频发给已配置的 OpenAI，原文件留在服务电脑 | 需当前启用的 OpenAI 配置和官方地址；仅保存连接还不够。明确转写时上传，原文件和转写结果本地保存 | 转写会使用当前启用的 OpenAI 配置，将这段音频发送到 OpenAI 官方服务；原文件保留在服务电脑。 |

关键出处：`BrowserSessionsService.command/close/_host_identity`、
`BrowserCoordinator.command/run`、固定浏览器上游的 `createProfiles`、
`OwnerFiles._validate_references/purge_channel`、`ProductWorkMedia._manifest`、
`read_attachment`、`AttachmentProcessingService.process/_audio_settings/_transcribe/_save`。
服务端只注册附件列表、上传、详情、下载、回收、恢复、处理，未注册清理。

现有浏览器会话／附件处理测试在新建的专属 PostgreSQL17.11 和真实 loopback HTTP/WS
上跑了 51 项，全部通过、无跳过；转写使用 MockTransport，无付费模型或真实登录。
第一次测试夹具缺少另一个频道和 Node 依赖，修正后重新跑完。登录持久性复用
[托管浏览器恢复任务](https://github.com/Peerframe/openbot/actions/runs/37030141750/job/110915830971)
的合成 cookie 证据，不声称本轮测试了真实第三方登录。Work 媒体删除测试已检查源码，
可选 Worker 套件未重跑。C9/C11 不动；不新增永久清理功能，不自动合并。
