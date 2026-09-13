export function originalAttachmentSaveDialog(name: string) {
  return {
    title: "保存原始附件",
    buttonLabel: "保存",
    defaultPath: name,
    message: "已有文件不会被覆盖。",
    showsTagField: false,
  } as const;
}
