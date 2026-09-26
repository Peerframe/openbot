# 员工包签名

[English](EMPLOYEE_SIGNING.md) · [简体中文](EMPLOYEE_SIGNING.zh-CN.md)

OpenBot 可以使用 Owner 控制的 Ed25519 密钥，为现有的不含身份信息的
`openbot.employee/v1` 模板签名，生成 DSSE 信封。接收方 Server 只有在自己的本地信任库中已经
保存发布者公钥时，才会接受这个签名信封。

此功能仍为实验性。验签成功后先显示只读隔离预览；经过认证的 Owner 可以把人工审核过的准确
摘要激活为新的本地员工，全部技能仍保持候选禁用。激活不能复制记忆、绑定工作主机或授予权限。

离线 CLI 现位于 `packages/employee-publisher`，不会启动或导入旧 TypeScript Server，也不依赖
测试 oracle。完成仓库常规的锁定安装 `npm ci` 后，先运行
`npm exec -- turbo run build --filter=@openbot/employee-publisher` 构建共享契约。

根命令仍加载仓库根目录的 `.env`。为保持兼容，相对路径参数（`--keyring`、
`--passphrase-file`、`--public-key`、`--output`）与 `OPENBOT_EMPLOYEE_PUBLISHER_*`
路径继续以 `apps/server` 为基准，即使该目录已不存在。新安装建议使用绝对路径；例如下文的
`./data` 指向 `<checkout>/apps/server/data`，不是 `<checkout>/data`。

## 初始化本地发布者

为密钥库与口令选择两个不同的受保护位置：

```bash
npm run employee:publisher-key -- init \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

如果口令文件不存在，命令会生成随机口令并设置为仅 Owner 可读。命令只打印
`ed25519:<sha256-spki>` 密钥 ID，不打印私钥。然后配置两个路径并重启 Server：

```dotenv
OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH=./data/employee-publisher
OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE=./data/employee-publisher-secret/passphrase
```

上述两个变量配置 CLI 与旧 Server。Python product 入口使用另一组显式变量，必须设置为
上面选择的**同一组绝对路径**：

```dotenv
OPENBOT_CONTROL_PUBLISHER_DIRECTORY=/absolute/protected/employee-publisher
OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE=/absolute/protected/employee-publisher-secret/passphrase
```

Python 的两个变量必须同时提供，不会自动读取 CLI 变量，也不继承启动器的历史相对路径基准。
密钥或信任设置变化后，重启所选 Server。原加密密钥库、公钥信任清单与 DSSE 格式不变。参见
[迁移调研](research/retained-developer-tools.md)。

一旦显式配置，密钥库若不可读、权限过宽、使用符号链接、格式错误或公私钥不匹配，Server 将
拒绝启动，不会静默退回无签名导出。

## 分享并信任发布者

发布者只导出公钥：

```bash
npm run employee:publisher-key -- export-public \
  --output ./openbot-publisher.pub.pem \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

请通过两个不同的可信渠道发送 PEM 文件和命令打印的密钥 ID。接收方必须在带外核对指纹，再
显式加入信任：

```bash
npm run employee:publisher-key -- trust \
  --public-key ./openbot-publisher.pub.pem \
  --expected-key-id ed25519:<已核对的-sha256-spki-指纹> \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

随后重启接收方 Server。员工包不能让其中附带的公钥自动获得信任，Web API 也不能修改信任库。

## 轮换与撤销

```bash
npm run employee:publisher-key -- rotate \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase

npm run employee:publisher-key -- revoke \
  --key-id ed25519:<已退役密钥的指纹> \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

轮换会创建新的活动签名密钥，并保留旧公钥用于验证历史文件。活动密钥不能直接撤销，必须先
轮换。撤销会把已退役或外部信任的公钥排除在验签范围外。每次修改后都要重启 Server。

## 备份与恢复

- 密钥库和口令必须分别加密备份，并离开 Server 保存。
- 两者都不能进入员工包、Git 仓库、浏览器可读目录、共享工作主机卷或日志系统。
- 私钥丢失后不能再生成新的签名导出；信任清单丢失后不能识别之前信任的发布者。
- 恢复文件不会赋予员工权限；导入仍保持隔离。

这个本地信任库不能证明全球统一的人类身份，不能向其他用户自动发布撤销状态，也不提供门限
恢复或 Owner 账号失陷防护。公开分发需要未来的 TUF/Sigstore 注册表适配器。参见
[ADR-0024](decisions/0024-owner-employee-publisher-keys.md) 与
[上游调研记录](research/employee-publisher-key-lifecycle.md)。
