# 原生 Task 范围与附件接口

[English](NATIVE_TASK_SCOPE.md) · [简体中文](NATIVE_TASK_SCOPE.zh-CN.md)

Server 适配器已实现全部显式 scope 能力。实际 UI、Temporal 与 Linux 验收仍由主控单独完成。固定 owner namespace 只表示当前单 Owner 控制域；所有写入沿用 session cookie 与 Origin 校验，不接受请求体里的身份或 token。

## 上传与处理

`POST /api/v1/task-attachments`：使用 `application/octet-stream` 原始字节，并在 `X-OpenBot-Filename` 提供百分号编码的安全文件名。成功返回 201：

```json
{"attachment":{"id":"uuid","scopeKind":"owner","ownerId":"owner","name":"evidence.csv","mediaType":"text/plain","sizeBytes":19,"sha256":"hex64","createdAt":"ISO timestamp"}}
```

没有 channelId。服务端校验字节、MIME、名称和 SHA。保留原限制：文本 256 KiB、图片 5 MiB、PDF／其他支持文件 10 MiB；每 Task 最多 8 个文件，共 20 MiB。

- `GET /api/v1/task-attachments` 返回 `{attachments: [...]}`，包括 deletedAt。
- `GET /api/v1/task-attachments/{id}` 返回 `{attachment: ...}`。
- `GET /api/v1/task-attachments/{id}/content` 下载原始字节；已删除附件返回 404。
- `DELETE /api/v1/task-attachments/{id}` 携带 `{}` 软删除。
- `POST /api/v1/task-attachments/{id}/restore` 携带 `{}` 恢复。
- `POST /api/v1/task-attachments/{id}/process` 携带既有 `{operation: extract|ocr|transcribe, password?: string}`，返回带 processing 的附件。若 Task 要读提取文本，须在创建 Task 前处理。密码不持久化；转录沿用已有配置和明确授权。

未处理图片／PDF 复用原模型二进制输入，附件描述不代表已阅读内容。音视频／办公文档仍须经过对应的显式处理流程，UI 不应自动发起 OCR 或转录。

## 创建与查询

`POST /api/v1/tasks` 保留 botId、objective、tokenLimit、requestKey，并支持可选 scope：

```json
{"botId":"bot-uuid","objective":"核对附件事实","tokenLimit":100000,"requestKey":"unique-owner-request","scope":{"version":1,"attachmentIds":["asset-uuid"],"collaboratorBotIds":["peer-bot-uuid"],"knowledge":true,"plugins":true,"web":true}}
```

提供 scope 时其中所有键均必填。ID 是唯一 UUID，服务端排序规范化。最多 32 个候选协作者，不含当前 Bot，只接受 none／model Employee。实际协作仍限制为四个后代、两级与固定 300 秒。UI 应把这些选项表述为 Owner 对本 Task 的授权。

省略 scope 保留 model／report／result_review；空列表与 false 不增加权限。同一个 requestKey 改变 scope 返回 409；完全相同的重试读取原 Task，即使附件已删除或 Bot 配置改变也不会重新绑定。corrections 不能加入附件或协作者，扩大范围须创建新 Task。不会隐式读取或创建频道，也不能提交频道附件 ID。

原 202 WorkSnapshot 保持不变。`GET /api/v1/tasks/{taskId}/scope` 返回 `{scope:null}` 或冻结范围：

```json
{"scope":{"version":1,"attachmentIds":["asset-uuid"],"collaboratorBotIds":[],"knowledge":false,"plugins":false,"web":false,"sha256":"scope-hex64","attachments":[{"id":"asset-uuid","name":"evidence.csv","mediaType":"text/plain","sizeBytes":19,"sha256":"original-hex64","metadataSha256":"metadata-hex64"}]}}
```

UI 分别展示提交范围、当前任务状态和 Action 审批。删除／恢复附件不会恢复已取消的 Task。既有取消、修正、精确 Action 审批与 unknown 对账接口语义不变。

## 能力与权限

- `knowledge:true` 开放当前 Employee 已审核的技能与 Owner 允许模型使用的记忆。Runtime 只能起草一条经验；只有任务验证完成后才插入待审提案，Owner 显式审核后才能成为记忆。Employee 学习方向继续注明受 Hermes Agent 启发。
- `plugins:true` 与当前 Owner／Bot 插件授权及精确版本共同生效。confirm 工具仍须原有持久 Action 审批。MCP 响应只证明观察到了返回值，不证明外部业务效果。
- `web:true` 开放有界公共 HTTPS 读取。搜索还须已有明确配置。保留 SSRF、重定向、次数、响应与 unknown 规则。
- 非空 `collaboratorBotIds` 开放 `list_collaborators`、`start_task`、`delegate_task`、`wait_for_task`。只能列出冻结名单中当前可用的 Employee。子任务仅获得分派正文以 `[OpenBot attachment: UUID]` 明确引用且属于父范围的附件；继承已允许的 knowledge／plugins／web 标记，并从协作者名单去掉自身与祖先。插件授权和模型连接仍须实时有效。每个子 Task 的 token 上限等于父 Task，各自记账；最多四个后代、两级，统一以最初根 Work Run 的首次 claim 加 300 秒为截止，重试不能延长。

原生子任务返回 `{sourceKind:"task",taskId,runId,botId,status}`，runId 是真实 Work Run。频道返回保持原 legacy Run 语义。确认丢失时只恢复已提交的原子任务；没有 SQL 事实则维持 unknown，不再创建。取消／撤权复核整条祖先链。原生协作不伪造频道、成员、legacy Run 或分派消息。

原生待审提案以 `source:{kind:"task",taskId,runId}` 代替 sourceRunId，其余字段与审核输入不变；频道提案继续使用 sourceRunId。Owner 接受后的记忆 provenance 为 reviewed-work-proposal，并记录 sourceTaskId、sourceWorkRunId、proposalId 与 actor:"owner"。原生私有知识回执 v2 绑定冻结 profile／scope 摘要，频道 v1 回执原字段保持不变。模型不能提供私有回执，摘要也不能授予权限。

省略或显式为空的 scope 仍仅开放 model／report／result_review。Python／SQL／SDK 检查证明适配边界，不代表 UI、真实 Temporal 或 Linux 已验收；这些组合必须复用同一冻结范围与实时门禁。
