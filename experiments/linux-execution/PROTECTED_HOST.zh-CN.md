# 受保护的离线命令 Host — 未启用的 Linux 候选

本包提供实际可运行的 Unix Host 与固定 native helper，尚未注册产品工具或授予 Work 权限。
Node 仍是不可信转发方；批准、admission、在线单次 consume 和 lookup 均须使用 Control 的既有
v2 证明。本包不包含 browser，实际 Linux/systemd/runsc 验收尚未完成。

## 文件与运行入口

`protected_host.py --config <root 所有的配置路径>` 是唯一 Unix 服务，持有 enforcement 私钥和
Control 公钥 pins，位于每个 Action unit 之外。`protected_native.py` 只有固定 daemon、execute、
lookup、lookup-output 模式，复用原 sandbox、output_capacity 和 deadline_probe 的窄读回函数，
不调用旧 qualification 工作负载。`protected_io.py` 仅处理有界原始帧与独占 no-follow/fsync 记录。
`LinuxNative.cleanup(original_record)` 是停传输及原 unit 后的显式运维操作，不在 Node 协议中；
它只清理已证实终态、原 invocation/cgroup/loop/backing/inode 相符的资源，并保留原保留记录和 ledger。

使用已有 Python3.12 与已锁定的纯 command 依赖，把 apps/server-python/src 加入 PYTHONPATH；
无需数据库、Temporal、模型服务或付费账户。v2 模块必须为已整合 readiness 版本。固定 native
源码目录包含三个新源码和已有 sandbox、output_capacity、deadline_probe，不动态生成 helper，
不安装另一套执行框架。

## 受保护配置与前提

配置为 root 所有、0600，置于 root 所有的0700目录。所有祖先须为真实目录、root 所有且不可由
group/world 写入；拒绝 symlink 路径。私钥仅一个 link、0600，位于 native.secretsDirectory。
state 与 secrets 目录必须分开。socket 位于 root 所有、0750、group 为专用 Node group 的目录，
socket 本身0660。Node 必须使用显式非零 nodeUid，不持 root/sudo/Docker/key/ledger/输入祖先权限。
Linux SO_PEERCRED 必须匹配该 uid，目录 group 权限不等于业务授权。

顶层配置字段固定为：

```
state, socket, nodeUid, nodeGid, route, policy, controlIssuer, enforcementIssuer,
native, privateKey, controlPins
```

route 是 Server 选定的 nodeId/providerId/enforcementKeyId/ledgerId；policy 是经资格验证的完整
v2 TimingPolicy，本候选要求 runtimeMaxMs<=50000、stopAllowanceMs=5000，不默认认定时钟已合格。
controlPins 为1..8个 `{kid,path}` 公钥 PEM。所有签名消息须匹配固定 route 与原 binding，producer
环境没有私钥或 token。native 字段固定为：

```
base, binaries, archive, archiveSha256, image, imageTag, sources, sourceHashes,
binaryHashes, python, pythonPath, secretsDirectory
```

base 采用 `/opt/obh` 等短的真实私有目录；完整 UUID 映射到受保护12位hex子目录，协议 unit 名仍
保留完整 UUID。提交前检查所有已知 Unix socket 路径，包括 Docker ExecRoot/libnetwork 和
containerd shim；长路径直接拒绝，不退回共享路径。binaries/sources/secretsDirectory 为 root
所有的0700目录；python 是已有固定环境中的可信解释器，pythonPath 是可信源码目录。
sourceHashes 恰含 protected_native.py、protected_io.py、sandbox.py、output_capacity.py、
deadline_probe.py 的部署 SHA256；binaryHashes 必须等于 REAL_HOST_DEADLINE 已公开的10个固定哈希。

离线镜像及 archive 必须为此前已审 Python image/digest；不 pull、不导入任意镜像。imageTag 只给
同一 repository 的精确已载入 digest 命名，preflight 独立检查 RepoDigest。当前输出 filesystem 固定
为独立64MiB ext4，请求其他 outputMiB 会拒绝。输出披露最多1MiB，限一个 UTF-8 text/plain 或
text/csv 文件；拒绝 NUL、symlink、稀疏超大文件和额外输出。

要求已审 Linux x86-64、cgroup v2、systemd255，以及精确 Docker29.8.1/containerd2.3.5/runsc
release-20260914.0 systrap binaries。每个 Action 新 unit 使用 private network/mount namespace、
delegated supervisor subgroup、2500MiB内存/零swap、150%CPU、1536 host tasks，无 restart、
control-group SIGKILL、无 stop hooks，原 RuntimeMax 最大50秒且不可延长。guest 资源、只读rootfs、
非root、network/mount/PID 校验复用 precursor。local logging 显式 compress=false，start 前必须
由容器 typed readback 确认，日志容量不扩大。

额外前提：systemd 仅在 unit 私有 mount namespace 中把 /run/containerd 换成独立16MiB tmpfs，
root0700、nodev/nosuid/noexec；固定 helper 在启动 containerd 前核对实际 descriptor/mount 身份、
类型、路径、传播、owner/mode 及 statvfs 总容量。不在宿主手动挂载或清理共享 /run。旧 native
期限证据未覆盖此新属性，必须重新在 Linux 验收。

## 唯一执行事实与传输

Unix 原始流为4字节无符号大端长度，再跟1..32768字节严格 UTF-8 JSON；重复key、非法UTF-8/
surrogate、非有限数、错字段/版本/方向、超限及关联不匹配都会拒绝。协议0.10.0。每个 Host 进程
只接受一个 relay 连接，timeout/断线关闭 live nonce/output scope，不重连、不重放。持久记录保留；
之后的新 Host instance 只能用新的已签名 control challenge 查询原 Action，不恢复 prepare/consume
slot、不重新启动。

prepare_open 后 Host 先发最长5秒的本地 BOOTTIME/boot/instance 挑战；只有准确对应的 Owner 已批准
Server authorization 才能保留目录/unit。O_EXCL、文件及父目录 fsync 先于外部 unit/create/start；
失败或丢ACK仍占用原槽位。固定 daemon helper 在 containerd 之前和 dockerd 之前读取真实时钟/
boot/保护 instance。准备不含模型 argv；所有 producer 属于原 unit，Host 超时不是 native kill 证明。

prepare_authorize 后即可发送 input_chunk，不要等待 ready；每块须为连续offset，最多8个平面文件、
总20MiB、单块16KiB。原长度/hash 全部通过且完成真实 unit/cgroup/namespace/runtime 读回后才发 ready；
空 manifest 不需要 chunk。dispatch 必须绑定 ready digest 与原 operation。新的在线 consume 挑战
先于唯一 permit；Host 从因果时间区间推导保守的固定本地 BOOTTIME launch 截止并先持久化，execute
helper 加入原 namespace/cgroup 后，在 create 与 start 前各查原 guard，precursor 另独立 fsync 两个
保留事实。unknown 不重复任何效果，也不代表成功。

lookup/stop 共用 control_open/control_challenge，并要求当前 Server 签署准确 nonce/request/digest。
stop 不授予输出。lookup 用持久递增 sequence 及原 dispatch/epoch/permit 签署有界观察，每个输出块
重新检查同一 live includeOutput 权限及原截止。过期、断线、范围变化阻止继续披露。live book 最多
64槽，无 eviction；持久 Action root 也限64，每 Action 最多4096条观察记录；满后拒绝，cleanup 不
重新开放原 Action/ledger。

## 验证与待验门槛

受影响检查无需 native 效果：

```sh
PYTHONPATH=apps/server-python/src:experiments/linux-execution \
  apps/server-python/.worker-venv/bin/python -m pytest -q \
  experiments/linux-execution/protected_host_test.py \
  experiments/linux-execution/protected_native_test.py
```

58项测试已通过，包含完整签名准备→ready→dispatch→consume→receipt/output 经真实本机 Unix socket 往返、
本机 native peer credential 和断线；native 时钟、subprocess/readback 及效果是明确的 fake。
负例覆盖输入offset/hash/links、重放/重启、route/epoch、迟到lookup/输出过期、fsync失败、上限、
错误invocation、create后最终guard、UTF-8/原始长度、私有shim挂载读回及key权限。
本轮未运行 Linux unit、daemon、mount、工作负载、VPS、provider、真实用户profile、数据库或模型。

启用前须使用低权限 Node 和受保护 Unix 入口走真实 Linux adapter，检查新 mount/resource/native
启动 guard、丢ACK和重启下一次unit/create/start、期限停止、精确字节及签名receipt/artifact review、
expired/cancel/revoke拒绝和精确所有权 cleanup。Host 仍须符合不休眠及已接受的时钟/停止裕量；
不能声称任意 kernel/VM 停顿下的硬实时。原 daemon/native 消失后，lookup 返回unknown，不离线解析
Docker状态或重挂旧output来伪造成功。保留的 backing/output 与未知loop ACK需显式运维核对；产品
当前权限签发、Work结算、artifact/result review仍为独立整合门槛。
