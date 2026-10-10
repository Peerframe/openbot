# Node 登记

[English](NODE_ENROLLMENT.md) · [简体中文](NODE_ENROLLMENT.zh-CN.md)

OpenBot 工作主机主动连接 Server。每台 Node 先用一个短时、单次 enrollment token，换取自己独有且
可以单独吊销的凭证。Server 只保存两类值经过域分隔的 SHA-256 摘要。

这是 M1 的启动身份边界，不是生产级设备认证。当前签发的仍是 bearer credential。Server 与 Node
必须放在可信私网中；所有非 loopback 连接必须使用 `wss:`，Node 必须使用专用系统账户。

## 登记一台 Node

1. 配置 `OPENBOT_OWNER_PASSWORD`，启动 PostgreSQL 与 Server。
2. 登录 Web，从侧栏打开**节点**，为准确的 Node id 创建令牌。可信 Server 主机也提供同一 CLI 操作：

   ```bash
   npm run node:enrollment-token -- office-linux-01
   ```

3. 在工作主机上配置同一个 `OPENBOT_NODE_ID`、Server WebSocket 地址和刚刚输出的单次值：

   ```dotenv
   OPENBOT_NODE_ID=office-linux-01
   OPENBOT_NODE_SERVER_URL=wss://openbot.internal.example/ws/nodes
   OPENBOT_NODE_ENROLLMENT_TOKEN=obenr_...
   ```

4. 首次启动 Node。它会先通过 HTTPS 兑换令牌，再建立 WebSocket；默认把 `identity.json` 写在
   `OPENBOT_NODE_WORK_DIRECTORY` 下。
5. 立即从环境中删除 `OPENBOT_NODE_ENROLLMENT_TOKEN`。重启 Node，确认它能使用已保存身份重连。

令牌默认十分钟过期、只显示一次且不能重放。为同一 Node 创建新令牌时，之前尚未使用的令牌会失效。
凭证文件使用原子写入，在 POSIX 系统上权限为 `0600`。如果之后出现 group 或 other 权限位，
OpenBot 也会拒绝加载；调查暴露原因并确认文件可信后，可执行 `chmod 600 identity.json` 再重启。
在 Windows 上，文件适配器（共享 `@openbot/windows-secret-acl`）会把凭据目录与文件限制为仅 Owner+SYSTEM 的 DACL（不允许继承的 Allow ACE），
校验失败则拒绝加载；这不等于 Windows Credential Manager 或 DPAPI。
OpenBot 还会拒绝符号链接、非普通文件、过大文件、格式错误的包和签发给其他 Node id 的凭证。

Owner 弹窗只列出安全的有效/已吊销身份元数据，不返回凭证摘要；在线状态与实时 Node 连接投影合并。
配对令牌只保留在当前打开的弹窗中，关闭后不能再次读取。

默认拒绝 `OPENBOT_NODE_CREDENTIAL`。优先使用一次性登记和配置的凭据存储；已有身份恢复不需要新增选项。
仅运维方管理的临时进程可在 `file` 配置下设置 `OPENBOT_NODE_ALLOW_ENV_CREDENTIAL=true`，明确启用注入。
启动会提示正在使用环境凭证，但不记录凭证值。Secret Service 和 macOS Host 即使设置该选项也不能被绕过。
凭证不得提交到 Git 或员工包；也可用 `OPENBOT_NODE_CREDENTIAL_PATH` 指向运维方控制的 secret volume。

原环境注入部署可移除旧凭证变量并登记一次，或恢复已有的存储身份；确实需要继续临时注入时，在启动配置中
明确启用上述选项。此项改变默认配置策略，不实现 PoP，也不消除已启用 bearer 凭证的可复制性。

## Linux 服务配置（实验性）

Linux 明确提供两种配置，因为 Secret Service 属于用户的 D-Bus 登录会话；系统级 daemon 通常
没有这种会话，也不能借用另一个用户的密钥库。

| 配置 | 凭证边界 | 为什么使用 | 好处 |
| --- | --- | --- | --- |
| 无人值守系统服务 | `/var/lib/openbot-node/identity.json`，由专用 `openbot` 账号拥有且权限为 `0600` | 服务器、VM 和无人值守开机 | 不依赖桌面登录，启动行为稳定可预测 |
| 专用桌面用户服务 | 用 `OPENBOT_NODE_CREDENTIAL_STORE=secret-service` 选择 Secret Service | 拥有活跃图形登录和已解锁密钥库的 Linux 专用用户 | bearer 身份不再放在普通配置文件中 |

已审查的部署文件包括[系统服务](../deploy/node/systemd/openbot-node.service)和
[用户服务](../deploy/node/systemd/openbot-node-user.service)。它们是经过契约测试的部署资产，
目前还不是签名安装器，也不代表已经支持 Linux。

系统服务只需在 `/etc/openbot/node.env` 写入 `OPENBOT_NODE_ID`、`OPENBOT_NODE_SERVER_URL` 和
首次使用的 `OPENBOT_NODE_ENROLLMENT_TOKEN`；服务单元会强制使用文件存储及专用状态目录。用户
服务需要安装发行版提供的 `libsecret-tools`；已审查的 Ubuntu 24.04 基线是
`0.21.4-1build3`，不要为此降级后续安全更新。在 `~/.config/openbot/node.env` 写入同样的首次
登记值，并通过该专用用户的 `systemctl --user` 启用。服务单元会强制使用 Secret Service，
绝不退回文件。

首次成功启动后，两种配置都要删除 enrollment token 并重启。`secret-tool` 缺失、D-Bus 会话
不存在、密钥库锁定或拒绝、超时、身份格式错误、工具报错或输出超限，都会中止身份初始化。
OpenBot 不会创建或自动解锁密钥库。不要让桌面配置使用 Owner 的主登录账号或主密码集合。

## macOS App 登记（源码已完成的候选）

macOS Worker Host 是供单个专用标准账号使用的用户级后台项。同一个 App 主程序在普通打开时显示
控制器，只有应用内 LaunchAgent 传入固定 `--worker-host` 参数时才运行原生 Host。因此两种模式
共享同一个签名 application identifier、provisioning profile 与 Keychain access group。

仓库可以从干净提交构建精确的 arm64 或 x64 未签名 App。需提供源码中已固定 SHA-256 的官方
Node `22.22.2` 压缩包、精确 npm `10.9.9` 可执行文件和一个已存在的真实输出目录：

```bash
npm run release:node-macos:candidate -- \
  --arch arm64 \
  --build-version 1 \
  --node-archive /trusted-inputs/node-v22.22.2-darwin-arm64.tar.gz \
  --npm-cli /trusted-tools/npm-10.9.9 \
  --out-dir /safe-output \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  --version 0.1.0
```

候选门槛会检查干净源码提交、Node 压缩包、npm 版本、ncc 清单、单一 Mach-O 架构、固定 App
文件、权限、property list 与运行时 SHA-256 清单。产物是 `signed: false` 的
`OpenBot Worker Host.app`，不能作为可安装分发证据。

发布人员还必须单独提供匹配的 Developer ID Application/Installer 身份、带 Team ID 前缀的
access group、面向 `com.openbot.worker-host` 的 Developer ID provisioning profile，以及已配置
的 `notarytool` Keychain profile：

```bash
npm run release:node-macos:package -- \
  --app "/safe-output/OpenBot Worker Host.app" \
  --access-group A1B2C3D4E5.com.openbot.worker-host.shared \
  --application-identity "Developer ID Application: OpenBot (A1B2C3D4E5)" \
  --installer-identity "Developer ID Installer: OpenBot (A1B2C3D4E5)" \
  --provisioning-profile /trusted-inputs/OpenBot-DeveloperID.provisionprofile \
  --entitlements-template "$PWD/apps/worker-host-macos/Resources/OpenBotWorkerHost.entitlements.template.plist" \
  --notary-profile openbot-notary \
  --output /safe-output/OpenBotWorkerHost-0.1.0-arm64.pkg
```

只有身份、Team ID、application identifier、access-group 授权、profile 类型与有效期、内层签名、
重算后的运行时清单、外层签名、安装包签名、公证、staple、Gatekeeper、payload 清单以及“不含
安装脚本”全部通过，打包才会成功；不存在 ad hoc 分发回退。

独立/手动路径会由验证过的安装包把 App 放入 `/Applications/OpenBot Worker Host.app`。专用用户
打开它，输入准确 Node id、`wss:` Server URL 和一次性登记令牌，然后选择 **Enroll & Enable**。
令牌会立即清空；返回的身份绑定 Server URL，并作为唯一一个不同步、
`WhenUnlockedThisDeviceOnly` 的数据保护 Keychain 条目保存。如果 macOS 显示
**requires approval**，请在 **系统设置 > 通用 > 登录项**中批准 OpenBot。Keychain 锁定/拒绝、
entitlement 缺失、App 被移动/篡改或批准未完成时，Host 都保持停止。

### Desktop 引导路径（实验性源码）

OpenBot Desktop 也可以在一个顶层安装中携带同一个独立签名的 `OpenBot Worker Host.app`。Owner
选择包含本机 Worker 的组合、连接一个 Server、登录、为当前电脑命名并明确开始配置后，renderer
只发送这个有界 Node id。Desktop main process 会先检查固定 companion 及其真实状态，再通过专用
的已鉴权 Session 申请十分钟有效、只能使用一次的登记 token。token 只通过私有子进程 stdin 写给
固定 companion，绝不进入 renderer 状态、argv、环境变量、文件或日志。

Swift companion 会复用独立控制器的登记、Keychain、严格配置与 `SMAppService` 注册逻辑。
Desktop 只显示白名单内的原生结果：未配置、已禁用、需要批准、已启用、不可用或无效。需要批准时，
Desktop 可以打开登录项设置，但只有 `SMAppService` 自己返回 enabled 才会显示成功。Desktop 重启
后重新读取原生状态，不保存成功标记。独立 App 继续作为高级自部署和恢复路径。

这条路径的本地源码已经完成，macOS CI 定义也要求先构建固定 companion 候选再打包 Desktop。
本机未签名 Desktop 包已经通过 companion 内嵌清单门槛并成功启动。它目前还不是受支持的安装方式：
托管内嵌安装包尚未观察，未签名构建也不能证明 Keychain access group、登记、登录/重启、替换、
回滚或卸载。必须通过下述签名、公证和受控真实设备门槛后才能作出这些声明。

替换 App 前先禁用后台项，替换后再启用。卸载时先选 **Disable**，可选 **Remove Local
Identity**，然后由管理员把固定 App 移到废纸篓并忘记其 package receipt。安装器不会选择用户、
处理登记令牌、修改 home 目录或启动服务。

这台开发 Mac 没有匹配的 Developer ID 身份、profile 或 notary 凭据。本机 arm64 候选校验和
ad hoc 签名机制已经通过。Desktop 引导的 Swift 源码也能用本机兼容 SDK 编译并链接，但这台机器的
beta Command Line Tools 无法加载匹配的 `TestingMacros` 原生测试插件。托管 Swift 测试执行、
Desktop 内嵌打包、分发、Keychain 授权、登记、安装/升级/回滚/卸载、重启与 Intel 仍属于证据门槛。

## 可验证的 Linux 发布候选目录

仓库现在可以在安装器获准使用前，生成一个有界、未签名的 x64 或 arm64 候选目录。设置这一层，
是为了让安装脚本不必猜测收到的运行时、依赖集合、服务文件或源码版本。

| 检查门 | 为什么要做 | 好处 |
| --- | --- | --- |
| 精确校验 Node 压缩包名称、大小和 SHA-256 | 使用主机自带或被替换的运行时会改变实际执行代码 | 候选目录始终携带对应架构、已审查的 Node `22.22.2` Linux 运行时 |
| 固定 ncc 和输出清单 | 静默外置依赖或新增配套文件会造成不完整包 | 每个运行时 JavaScript 文件都在白名单内，构建漂移会在暂存前停止 |
| 只含生产依赖的 SPDX SBOM | 整个 monorepo 的清单会混入测试 Provider，掩盖真实运行闭包 | 运维者看到的只是能从 Node 入口到达的包，不含测试工作区 |
| 干净源码提交和确定性源码时间 | 脏工作树、当前时钟和随机 SBOM 字段不能复现 | 相同的已审查输入会得到稳定清单、SBOM 和校验和集合 |
| 限制符号链接、路径、数量、权限和大小 | 打包输入仍是不可信文件系统数据 | 路径穿越或无界载荷会失败，不会产生看似可安装的结果 |
| 压缩前重新校验 manifest 和每个校验和 | 候选目录可能在暂存后、打包前被改变 | 文件被修改、缺失、重复、链接或未列出时都会在生成压缩包前停止 |
| 固定 Ubuntu、GNU tar、XZ 和系统包修订 | 压缩字节可能因工具、版本、构建方式和线程模式而变化 | 构建元数据会记录精确工具链，版本漂移会安全失败 |
| 同一任务内单线程构建两次 | 一次成功不能证明可复现 | 发布门能比较压缩包和伴随文件的每个字节，而不是相信口头声明 |

使用精确、已审查的输入构建全部工作区并暂存候选目录：

```bash
npm run release:node-linux:candidate -- \
  --arch x64 \
  --node-archive /trusted-inputs/node-v22.22.2-linux-x64.tar.xz \
  --npm-cli /trusted-tools/npm-10.9.9 \
  --out-dir /safe-output \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  --source-date-epoch 1788480000 \
  --version 0.1.0
```

源码提交必须等于 `HEAD`，工作树必须干净，目标候选目录不能已经存在，npm 可执行文件必须准确
报告 `10.9.9`。结果包含打包后的应用及白名单 worker 配套文件、官方 Node 可执行文件和声明、两种
systemd 配置、中英文登记说明、SPDX SBOM、`manifest.json` 与 `SHA256SUMS`。

在 Ubuntu 24.04 上，把这个已验证目录转换成确定性传输压缩包：

```bash
npm run release:node-linux:archive -- \
  --candidate /safe-output/openbot-node-0.1.0-linux-x64-unsigned \
  --dpkg-query /usr/bin/dpkg-query \
  --gnu-tar /usr/bin/tar \
  --out-dir /safe-archives \
  --xz /usr/bin/xz
```

输出目录必须已经存在且不能是符号链接。打包器要求 Ubuntu `24.04`、GNU tar `1.35`、XZ Utils
`5.4.5` 和已审查的 `/usr/bin` 路径，并记录已安装的 `tar` 与 `xz-utils` 系统包修订。它会固定
所有权、权限、时间、排序、PAX header、压缩级别、SHA-256 流校验与单线程编码，随后测试压缩流和
压缩包根目录。已有输出绝不覆盖。可信发布任务必须分别写入两个空目录，并逐字节比较 `.tar.xz`、
`.build.json` 与 `.SHA256SUMS` 后才能发布。

目录和压缩包伴随元数据都明确标为 `unsigned`。它们不是发布、安装器或 Linux 支持声明，也不能
代替签名验证。[ADR-0033](decisions/0033-linux-worker-host-verifiable-archive.md)与
[ADR-0034](decisions/0034-linux-worker-host-recoverable-install.md)仍要求仅限 tag 的 GitHub 来源
证明、包住事务内核的可信高权限安装器，以及真实 x64/arm64 主机证据。

## 仅 tag 来源证明工作流（已实现，未远程观察）

公开仓库已有一个休眠的 [Node Linux 来源证明工作流](../.github/workflows/node-linux-release.yml)。
只有 Owner 明确推送 `node-v<SemVer>` tag 后，它才会执行。工作流要求被标记提交位于 `main` 历史，
在对应 `ubuntu-24.04` 与 `ubuntu-24.04-arm` 托管 CPU 上分别构建 x64 和 arm64 候选，每个压缩包
制作两次；只有压缩包及两个伴随文件逐字节一致时，才用包内 Node 启动包内应用，要求它完成符合
协议且不带额外权限的本地握手并干净退出。之后才生成 GitHub 构建来源和 SBOM attestation，并
上传三个原始文件供 14 天审查。

这个顺序的原因是：先比较，再证明，最后上传。好处是使用者可以把下载字节绑定到仓库、工作流、
触发事件和源码提交，而不必只相信文件名。但它仍不能证明源码安全，也不能证明两个架构能在真实
主机运行。

首次 tag 运行得到明确授权后，下载每个直接制品，检查 `SHA256SUMS`，再把压缩包绑定到精确仓库、
证书身份、tag、源码提交、签发者和托管 runner 策略。下面的版本与提交必须一起替换：

```bash
gh attestation verify openbot-node-0.1.0-linux-x64-unsigned.tar.xz \
  --repo yxflc11/openbot \
  --cert-identity https://github.com/yxflc11/openbot/.github/workflows/node-linux-release.yml@refs/tags/node-v0.1.0 \
  --source-ref refs/tags/node-v0.1.0 \
  --source-digest 0000000000000000000000000000000000000000 \
  --predicate-type https://slsa.dev/provenance/v1 \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --deny-self-hosted-runners
```

GitHub CLI `2.93.0` 内部把 `--signer-workflow` 当作前缀匹配，所以这里刻意不使用它。安装验证器
还会固定该 CLI 版本，并在上述精确命令策略之外只接受有界 JSON 输出。

该工作流不会创建或修改 GitHub Release、移动 tag、发布软件包或改变支持标签。推送分支、创建 tag
和长期发布仍是各自独立的 Owner 授权动作。第一次远程执行还必须验证制品确实可下载，并分别验证
两类 attestation。x64 烟雾路径已在 Ubuntu 容器模拟下通过；原生托管 x64/arm64 结果仍未观察，
本地策略测试不能代替这些证据。

## 可恢复安装事务内核（已实现，不是公开安装器）

无 root 事务内核会先验证最危险的状态变化，再开放高权限入口。它的来源证明适配器会先用上面的
精确 `gh 2.93.0` 命令策略检查尺寸受限的普通压缩包，同时限制进程输出和时间，只接受一个明确的
JSON statement，并要求验证前后 SHA-256 一致。随后事务只接受位于私有暂存目录直接子级的候选
版本和由该适配器生成的机器可读来源证明记录，再把不可变字节移入版本目录，并原子替换相对
`current` 符号链接。

如果 Worker Host 原来正在运行，事务会重启并再次检查它。失败时先恢复旧指针，再检查旧服务；
如果恢复也失败，两个版本和有界事务日志都会保留，等待人工恢复。首次安装不会静默登记、启用或
启动服务；配置和凭证位于二进制事务之外，整个过程都不会读取或修改它们。

明确的无 root 恢复操作现在只接受规范格式、权限私有的普通日志文件，并会重新验证日志引用的两个
版本目录；当前指针必须仍是日志中的新版本或旧版本。它只会恢复日志记录的旧目标，而且仅当升级前
服务正在运行时才重启并复查旧服务；升级前未运行的服务绝不会被擅自启动。出现意外状态时不修改
现场；恢复重试再次失败时保留两个版本，并把日志标记为需要人工处理。
独立安装和恢复操作现在使用同一把失败关闭的目录锁。未来引导程序可以在导入、验证、解压和激活
全程持有不透明 lease；激活过程只能复核，不能释放外层 lease。现有锁绝不会只按时间自动回收，
因为暂停中的高权限写入者不能与第二个写入者重叠。

无 root 私有导入适配器会在后续步骤组合之前关闭用户可写压缩包路径的竞态。它通过已打开句柄复制
尺寸受限的普通源文件，在 lease 保护的私有状态目录内排他创建 `0600` 文件，然后复核源文件身份、
已同步目标的身份、大小和 SHA-256。清理只删除摘要完全匹配的那一个私有文件。源文件变化、符号链接、
目标已存在、伪造 lease 或摘要不匹配都会在进入来源证明或解压前被拒绝或原样保留。

休眠的高权限包装器现在可以先创建缺失的固定目录，再验证完整布局。它会先检查所有可变祖先，然后
逐层非递归创建子目录；每个新目录都以不跟随链接的方式打开，只规范这个已打开 inode 的权限，并确认
路径仍指向它。已有目录绝不会被自动修改：所有者、权限、类型不符或出现链接都会失败关闭。Linux
有效 uid/gid 为 0、公开/私有子目录的精确权限以及原子移动所需的文件系统关系仍是强制条件。调用方
不能改用其他目标路径或“可信所有者”。

一个休眠的高权限包装器现在会把固定目录和 systemd 适配器接成单一有序路径：确认工作目录为空、
私有导入、只对导入路径做来源证明、安全解压、候选身份检查、事务激活，最后按摘要清理。任何失败都会
停止后续步骤并保留导入证据。高权限恢复使用相同的固定路径、服务和 lease。这只是本地契约测试过的
代码，并非已经分发或受支持的命令。

其休眠运维入口只接受两种动作：`install` 必须提供一个绝对压缩包路径、版本和 40 位十六进制源码
提交；`recover` 不接受安装参数。架构直接取自正在运行的 Linux 进程，各类操作 id 由程序生成，重复
或未知输入都会被拒绝，GitHub token 也绝不通过 argv 传入。输出只包含白名单结果；失败时只返回一个
通用错误码，避免把不可信路径、凭证或辅助工具诊断反射到日志。不要从任意 checkout 直接运行这个
文件：引导程序本身仍需独立认证的分发通道。

这样，后续 `.deb`、`.rpm`、Windows 和 macOS 安装器可以共用一套已测试生命周期，而不是各写
一套回滚逻辑。它现在还不能发布：发布安装命令前，仍需实现独立交付的可信引导，以及命令、目录和
systemd 适配器的原生 x64/arm64 证据。无 root 安全
解压适配器现已能拒绝危险清单、解压到私有空目录、复核压缩包摘要并重建候选 manifest；现有
x64 压缩包已在 Ubuntu 容器模拟中通过该路径。目前还没有接受过真实远程来源证明。system profile
命令适配器也已通过契约测试：它把 `/usr/bin/systemctl` 固定在 Ubuntu systemd 255 系列，只读取
loaded 且为 active/inactive 的机器状态，并且只重启固定的 `openbot-node.service`。它还没有在原生
systemd 主机运行，所以仍未进入已发布的高权限安装器。

## 吊销或重新登记

已登录的 Owner 可以调用 `POST /api/v1/nodes/:nodeId/revoke`。Server 会持久化吊销状态、追加身份
审计事件，并断开匹配的在线 Node。吊销后应删除或隔离旧的本地凭证文件。

要重新登记同一个 Node id，创建新令牌，并在不加载旧凭证的情况下启动 Node。新凭证会替换已吊销
记录，并立即断开仍使用旧凭证的会话；所有旧值继续无效。

## 运维规则

- 不要通过公开聊天、Issue、日志平台或 Git 传递 enrollment token。
- 不要在 Node id 之间复制 `identity.json`，也不要把它放入可移植员工包。
- POSIX 权限拒绝意味着需要调查凭证是否已经暴露，不能只当作普通启动错误。
- 安全备份 Server 数据库；其中只有凭证摘要与身份审计事件，没有可恢复的明文凭证。
- 公开兑换接口按直接对端地址的域分隔摘要限速。`enrolled` 审计事件只保存该摘要以及来源是直接连接
  还是唯一显式可信代理；不会保存原始地址、token 或 credential。
- 丢失 Node 凭证时应吊销后重新登记，不能“找回”。
- 登记成功不代表系统隔离、物理主机所有权或 Provider 权限可信。
- 原生桌面 Provider 必须通过对应平台的权限审查后才能启用。

## 当前安全边界

协议 `0.9.0` 能在连接时验证每台 Node 对独立 bearer 值的持有，并支持单节点吊销。Linux 现在有
面向专用登录会话、经过契约测试且明确选择的 Secret Service 适配器，但真实密钥库锁定/解锁以及
systemd x64/arm64 证据仍待完成。协议还不能证明 Node 持有不可导出的私钥，不能轮换短时证书、
给每条消息绑定序号，也没有接入 Windows Credential Manager 或 macOS Keychain。Node 通道进入
不受信任网络前必须补齐这些控制。详见
[ADR-0023](decisions/0023-one-time-node-enrollment.md)、
[权限审查](research/posix-node-credential-permissions.md)、
[Windows ACL 审查](research/windows-node-credential-acl.md)、[Server 共享机密 ACL](research/server-windows-secret-acl.md)、
[Linux 服务决策](decisions/0032-linux-worker-host-service-profiles.md)与[安全模型](SECURITY.md)。
