# 仅命令执行的 Linux 前置验证

2026-09-25状态：**真实Linux／runsc命令边界及独立原生生命周期已测试，产品执行能力仍未启用**。
本标准库实验不掌握Task身份、权限、预算、审批或Artifact发布。追加账本防止已消耗Action／epoch
再次create／start，但它不是认证入场服务或另一套恢复引擎。

## 固定实现与真实证据

复用Docker29.8.1／Moby `464cd50c3d9e92877d56940ea160de6fca7bea23`、gVisor
release-20260914.0／`95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29`和OCI1.3.0／
`92249139eea7161e13745abd4cb6d0ea02a3227a`。未复制上游源码，未增加Python依赖。
宿主配置使用已发布Docker／containerd／runsc／systemd。决策与一手来源见
[原始边界研究](../../docs/research/linux-execution-boundary.md)及
[VPS验收记录](../../docs/research/linux-vps-qualification.md)。

[REAL_HOST_BOUNDARY.json](REAL_HOST_BOUNDARY.json)记录实际源码哈希及Linux x86-64／cgroupv2下五项真实测试：

- UID10001、根和输入只读、仅loopback、无法连接监督进程金丝雀及外部路由；内核CPU／内存／零swap／宿主PID上限读回。
- 64MiB专用ext4输出设备写满返回ENOSPC，没有超过设备容量。
- 100GiB逻辑稀疏文件在读取空洞前拒收。
- 真实启动成功后丢弃回执，重建控制器只能读回原结果；再次启动被拒绝，副作用文件只产生一次。
- guest RLIMIT_NPROC为512／512，负载不能提高硬上限；自行缩小到32后，31个子进程成功，下一个返回EAGAIN。guest真实用户计数与宿主cgroup任务计数不同。

每项结束均清理精确独占容器、挂载和loop关联。另见[REAL_HOST_DEADLINE.json](REAL_HOST_DEADLINE.json)：
四个全新每Action systemd unit分别验证正常超时、控制器死亡、私有Docker暂停和启动请求排队。
原始Docker／containerd／runsc进程树均由原生timeout停止，判定前不靠控制器清理，也未重发启动。
实际停止观测在名义60秒期限之后0.12–0.31秒，处于预先定义的5秒观测上限内；这是普通systemd／内核调度，
不是硬实时保证。业务结果仍为unknown。自有进程树、挂载和loop均已清理；10个生产容器的身份／启动时间／状态，
以及IPv4／IPv6防火墙语义规则保持不变。产品认证入场、任意镜像隔离、浏览器网络和接管仍需独立验收。

## 文件与运行

受保护命令Host的首个完整原生场景也已通过，见
[REAL_PROTECTED_COMMAND.json](REAL_PROTECTED_COMMAND.json)：真实低权限Node转发、私有namespace、
签名就绪／回执、原动作仅一次启动及准确18字节CSV。原50秒unit在五秒观测余量内停止（观测延迟155毫秒），
本次资源和临时密钥已清理，既有服务／防火墙未变。该场景的Control签名方仍为合成夹具；
真实Work／Temporal权限经产品入口的整合仍是独立必需门槛。

| 文件 | 用途 |
| --- | --- |
| `sandbox.py` | 显式daemon绑定、不可变命令、单次启动、有界观察／收集及精确ID清理 |
| `output_capacity.py` | 只读检查真实Linux挂载、设备和容量 |
| `qualify_running_host.py` | 在已隔离且明确选定的测试daemon中跑真实有界场景 |
| `deadline_probe.py` | 全新每Action原生unit、原始cgroup身份及四种生命周期故障场景 |
| `compare_production.py` | 比较输入身份／状态及预先规范化的防火墙语义哈希 |
| `test_*.py` | 脚本／内核观测回归，不启动daemon或容器 |
| `probe_output_capacity.py` | 早期LinuxKit反例，证明普通目录／tmpfs不等于持久容量上限 |

仓库根目录运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s experiments/linux-execution -p 'test_*.py'
```

CLI要求明确私有Unix socket、预期daemon ID／数据目录和已加载镜像digest，绝不隐式使用默认Docker context：

```sh
python3 experiments/linux-execution/sandbox.py check \
  --docker-host unix:///owned-test/docker.sock \
  --docker-binary /reviewed/bin/docker \
  --daemon-id '<observed-reviewed-id>' --daemon-root /owned-test/docker-data \
  --work-root /owned-test/work \
  --image 'repository@sha256:<reviewed-digest>' \
  --admitted-image 'repository@sha256:<reviewed-digest>'
```

真实场景由可信操作方先配置已复核独占service及离线镜像，进入daemon实际网络／挂载命名空间，再运行
`qualify_running_host.py --root /owned-test --unit openbot-qualification-<name>.service
--prefix <fresh-case-prefix>`。要求自有0700根目录、固定binary／image、私有daemon身份记录和containerd。
仅创建新的合成Action子目录及有界ext4文件；不得指向生产或共享daemon。此配置接口是验收夹具，不是产品API。

原生生命周期验收在已复核Linux宿主查看`deadline_probe.py --help`。此冻结宿主夹具使用
`/opt/openbot-qualification-20260925-c8b2`，须已有已复核离线镜像／binary和root自有units目录，不是通用安装器。
运行`python3 deadline_probe.py run --name deadline-<fresh-id> --case baseline`，或替换为列出的其他case。
每次使用全新unit名，不能复用已消耗Action；内部`--root`模式不是公开运行入口。新宿主／路径须明确配置、复核并重取证。准备和离线加载消耗同一原始期限。helper通过systemd D-Bus类型化
属性确认停止钩子为空（文本CLI省略空数组），并核对不重启、整组SIGKILL、原始invocation及cgroup。
判定记录后才清理精确临时资源。

## 权限、持久化与剩余门槛

create／start核对专用私有ext4根、nodev／nosuid／noexec、固定设备总容量及无嵌套／重复挂载。
可信操作方控制源路径祖先；负载仅接收input／output，没有daemon socket或凭据。输入摘要和daemon实际
挂载／资源形态均在启动前检查。历史XFS备选见[容量研究](OUTPUT_CAPACITY_REVIEW.md)，早期反例见
[LinuxKit证据](evidence/output-capacity-linuxkit-20260924.json)。

外部启动前持久化并fsync启动名额及目录。已消耗启动名额但Docker仍为created必须保持unknown，
因为原请求可能排队中；缺失记录不能证明未执行。只按持久关联的精确ID清理，同名替代对象被拒绝，清理失败明确保留。

调用方在create／start前固定一次monotonic截止，启动回执延迟消耗同一预算。Python后续kill／观察仅为尽力收尾，
无法在控制器死亡或daemon不可达时独立停止负载；已独立验收的每Action原生unit包住所有可能晚启动的进程。
`deadline_probe.py`验证该外层机制，单独调用`sandbox.py`不会自动获得该保证。
恢复只能观察，不能重置期限、替换容器或重发命令。

收集采用no-follow、单链接普通文件、增量哈希、有限目录项，并在读取稀疏空洞前检查逻辑大小，拒绝并发身份／大小变化。
返回的enforced:false只描述收集本身：摘要／大小检查不是存储强制或授权发布。文件完整性与设备／镜像证据分开。

Python控制层仍须消费精确Task／Run／Action epoch、审批和资源授权，串行处理取消／撤权并发布核验产物。
Temporal继续负责恢复，宿主helper只负责执行和回执。浏览器会话、监督写入、接管、下载及文档／代码交付均有独立验收，
不能因这些命令测试通过而直接启用能力。

浏览器b2的独立失败记录见 [REAL_BROWSER_CHROOT_ATTEMPT.json](REAL_BROWSER_CHROOT_ATTEMPT.json)。此前chroot fatal已消失，但首个Chrome进程达到探针25秒期限，渲染未通过。15个采样Chrome进程保留NoNewPrivs和seccomp；原180秒unit到期、资源清理及现有服务／防火墙不变均通过。这些结果不代表浏览器或接管验收通过。
