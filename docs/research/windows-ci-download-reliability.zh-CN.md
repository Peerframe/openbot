# 研究：Electron 打包下载可靠性

- 状态：批准实施
- 日期：2026-09-15
- 负责人：@yxflc11
- 关联：PR #72；PR #71 的 CI 运行 34857235769
- 验收：Electron 下载遇到短暂故障时，在打包前有限重试；永久故障继续报错。
- 边界：仅构建时的 HTTPS 下载。校验和、缓存、TLS 校验、打包与签名仍由上游负责。

## 依据与选择

已检索 GitHub 的 `repo:electron/get retry`、`FetchDownloader retries` 和 Packager 的 `downloader downloadOptions`，核对复用清单内的桌面基础与安装交付记录。

核对锁内 [Packager 20.3.0 / 8c5cc941018b1d890c7152734972c44b9b98f268](https://github.com/electron/packager/tree/8c5cc941018b1d890c7152734972c44b9b98f268)（BSD-2-Clause），以及 [get 5.1.0 / da84467eacf58f36a8d43de64a09dd2cfe491d3f](https://github.com/electron/get/tree/da84467eacf58f36a8d43de64a09dd2cfe491d3f)（MIT）的下载实现、公开类型、校验流程、Fetch 与校验和测试、发布记录和许可证。公开的 FetchDownloader 与 HTTPError 可以通过 downloader 接口组合使用；现有 FetchDownloader 只请求一次，支持取消信号但没有内置重试参数。

[已关闭的问题 #205](https://github.com/electron/get/issues/205) 涉及 Windows 并发缓存写入；这不是本次 HTTP 504 的原因，所以文件系统与缓存错误不纳入重试。仅设置原有下载参数不能恢复 504；重跑整个打包命令会重复文件操作与签名，因此不采用。

## 实施边界

复用原有 FetchDownloader 完成网络和文件流写入，通过 Packager 的公开 download.downloader 接口加一层有限重试。把锁内已有 get 5.1.0 声明为直接开发依赖，不新增依赖树。

每次下载最多尝试三次，每次最多五分钟；短暂退避，Retry-After 最大接受 30 秒。只重试明确的临时 HTTP 状态和连接错误；永久 HTTP、证书、文件系统、校验和错误以及调用者取消均立即失败。失败响应体会取消，下一次下载重新写入临时文件。预览包的校验和及缓存配置保持有效，上游仍需验证文件后才接受结果。

未复制或实质改编上游源码；仅调用公开 API，沿用现有许可证记录，不增加运行时依赖或发行内容。上游提供等效有限重试后，可用同一回归测试替换适配器。

## 验证

使用真实发布版 FetchDownloader 和 downloadArtifact，配合合成响应、临时目录验证：504 后成功且校验通过、404 不重试、连续 504 达上限、短暂连接错误、校验和失败、取消、超时、部分下载覆盖及 Retry-After 上限。执行桌面定向测试和仓库检查。Windows 原生打包仍需 CI 验收，本地测试不能代表安装成功。

GitHub 下载服务可用性无法保证；达到上限后必须明确报错。
