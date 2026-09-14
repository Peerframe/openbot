# 运行依赖许可声明

[English](README.md) · [简体中文](README.zh-CN.md)

本目录保留新增文档解析、OCR、MCP Apps 依赖的完整上游许可原文。
`sources.json` 记录版本、来源路径及每份文件 SHA-256。Desktop 打包将整个目录复制到
`native-server/runtime-notices`。MCP Apps 虽不被 Server 引用，已进入浏览器构建，也必须附带声明。

- officeparser 7.8.0：MIT。
- PDF.js / pdfjs-dist 6.3.289：Apache-2.0，同时包含独立许可的字体、CMap、ICC 和图像/WASM 解码器；
  保留包内全部许可文件，不能只带根目录 LICENSE。
- Tesseract.js 7.0.0、tesseract.js-core 7.0.0：保留 Apache-2.0 包许可。
- 英文、简体中文训练数据 1.0.0：npm 包没有许可文件，元数据写 MIT；实际数据源仓库标明 Apache-2.0。
  因此单独保留数据源许可及精确提交，不用包元数据替代数据许可。
- MCP Apps 1.7.5：实际 LICENSE 说明 Apache-2.0/MIT 过渡，文档 CC-BY-4.0；npm 简写 MIT 不完整。

本目录不包含上游实现源码。保留许可不等于证明原生二进制的完整来源，也不代表所有传递依赖都已完成审计。
Electron、Node、PostgreSQL 原有许可继续保留。Windows PostgreSQL 包装器的 MIT 许可不覆盖所有 DLL；
独立的原生依赖清单明确记录对外二进制发布仍需完成的来源与许可核对。
