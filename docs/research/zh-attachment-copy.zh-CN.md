# 调研：空 PDF 提取失败与保存原件对话框的中文文案

- 状态：实现前已接受
- 日期：2026-09-13
- 负责人：@yxflc11
- 验收路径：中文界面提取纯扫描或空白 PDF 时，看到“可能是扫描件或空白文档”的中文原因；
  保存原件时系统对话框标题为中文。未知 Server 错误不得被说成扫描件原因。
- 安全边界：仅展示层。Server 英文错误语义、415/空提取拒绝、原文件保留、取消/重试、
  解析器、OCR 与权限检查均不改。不得伪造成功。

## 搜索证据

- 搜索日期：2026-09-13（Asia/Shanghai）
- GitHub / 文档：`repo:i18next/i18next fallback keys unknown error`、
  `electron showSaveDialog title buttonLabel`、既有 `nativeRunFailure` 精确键映射
- 已核对账本与调研：[空附件提取](attachment-empty-extraction.md)、
  [附件处理](attachment-processing-completion.md)、
  [频道附件展示](channel-attachment-presentation.md)、
  Desktop Electron 44.2.0 基础，以及 `NativeRunControls.tsx` 的精确错误码映射
- 一手来源：
  - [i18next fallback keys](https://www.i18next.com/principles/fallback)：已知码对应具体文案，
    未知码走通用回退，不得落到相邻原因
  - i18next **26.4.2** / `4dba50f20669c3678db0812255716eb7693ad2da`（MIT）
  - Electron **44.2.0** `showSaveDialog` 的 `title` / `buttonLabel` / `message`，
    标签对象 `369b0d9d3afdd5b8c0bdb0ad42391443947a7424` → 提交
    `aa650d74597c652878629df0038a50485e156a09`

## 候选比较

| 候选 | 精确版本或 commit | 许可证 | 维护与测试 | 平台/API/安全适配 | 决定 |
| --- | --- | --- | --- | --- | --- |
| 既有精确键展示映射（`nativeRunFailure`） | 当前 OpenBot `main` | MIT | 仓库内已有；未知码保留原文 | 符合中文优先 Web UI | **选用**提取失败文案 |
| Electron `showSaveDialog` 标题/按钮/说明 | 44.2.0 / `aa650d74597c652878629df0038a50485e156a09` | MIT | 已锁定的 Desktop 壳；报告/图片/员工对话框已是中文 | 同一不覆盖保存路径 | **选用**对话框文案 |
| i18next 文案目录 | 26.4.2 / `4dba50f20669c3678db0812255716eb7693ad2da` | MIT | 有 fallback 文档；为两句文案引入运行时过重 | 仓库无 i18n 栈 | 拒绝 |
| 把 Server 错误改成中文或新增错误码 | 不适用 | 不适用 | 会改变 API 语义 | 任务要求保持 Server 错误语义 | 拒绝 |
| 子串 / `includes("PDF")` 匹配 | 不适用 | 不适用 | 会把密码、超时等误判为扫描件 | 违反未知错误诚实性 | 拒绝 |

## 复用决定

选用本地差集：对 Server 英文空提取句子做精确映射，并把原件保存对话框改成与兄弟对话框一致的中文。
未知、前缀或后缀文本原样展示，不得变成“扫描件”原因。提取失败仍不标记成功、不替换原文件；
取消仍只中止处理。

未复制上游源码。

## 验证计划

精确映射与未知/前缀/密码/超时/解析失败负向测试；`updateAttachment` 415；AttachmentActions
中文提示且不调用 `onChange`；取消不视为成功；桌面对话框辅助函数为中文。不宣称原生 GUI 验收。
