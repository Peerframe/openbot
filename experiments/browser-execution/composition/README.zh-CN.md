# Linux 隔离浏览器产品验收

[English](README.md) · [简体中文](README.zh-CN.md)

这里保留浏览器退役门槛使用的一次性原生测试夹具，不是生产 Host 安装器。
`deadline-a1-comp5` 身份已经消耗，不得重跑或延长原始 600 秒期限。
依赖版本、源码证据及失败尝试见[研究记录](../../../docs/research/browser-egress-policy.md)。

本地实际 Work API、PostgreSQL、mTLS Temporal 和保留的 Node 通过 SSH 回环连接
Bun/Chromium 服务。Control 和 Node 凭据留在本地。Linux 私有 Docker29.8.1/runsc
单元内的浏览器、Squid 和合成站点使用独立网络，没有外部路由，不访问生产 Docker，
不修改宿主防火墙。除有界临时空间外，只有私有浏览器配置 tmpfs 可写。

`run.py` 核对文件哈希、运行时身份、Unix socket 长度、原始 cgroup 期限、容器参数及挂载。
实际检查覆盖合法 HTTPS、错误域名与未知 CA 拒绝、13 项 socket 检查、浏览器容器有序替换，
以及撤销已有 TLS 代理连接后站点不再收到请求。本地产品流程覆盖四次审批、单次点击、
报告下载、离线回放、人工接管暂停和 localStorage、持久 Cookie、IndexedDB 恢复；
会话 Cookie 必须消失。最终通过还要求原始期限到期、cgroup 清空、独占资源删除，以及
生产容器、防火墙和转发参数不变。合成模型响应不是真实模型推理。

在另行授权的可丢弃 Linux 环境复现时，准备新的已审阅清单和短名称原生身份；
这里不提供自动远程安装器。常规贡献复用 CI 中的 `native-network/` 和 `qualify_egress.py` 检查。
本地探针使用 `--recovery linux-replacement --remote-host-config /absolute/private/relay.json`，
私有配置必须明确提供 `sshTarget`、`computerUrl`、`stateUrl`、`targetUrl` 和合成令牌。
SSH 只能调用该测试包固定的 `restart`，不接受调用方提供的 shell 命令。

用锁定的 cryptography50.0.1 环境执行 `prepare_tls.py --output /new/private/tls`，
只生成新的合成证书；CA 签名私钥不会保存。使用 Linux certutil3.98 创建空 SQL NSS 库，
并用 `-t C,,` 导入 `ca.pem`。已审阅的 Ubuntu 构建包为
`libnss3-tools_3.98-1build1_arm64.deb`，SHA256 为
`273a3da5dc5d11dbc4efceb787cbe65e1775a3489c84bb393a672f7df17060b8`，版权声明保留在私有测试包。
仅把测试 `cert9.db`、`key4.db` 和 `ca.pem` 放入 `nssdb/`。
不得复制个人信任库、向宿主安装 CA、忽略证书错误或复用过期证书。
`browser-entry.mjs` 仅向容器的空 HOME 写入测试信任库。

这份证据限定于无外部路由的合成 HTTPS 产品组合；公网浏览、配置异常丢失、跨机器迁移、
已安装 Desktop 和最终源码退役仍需分别验收。
