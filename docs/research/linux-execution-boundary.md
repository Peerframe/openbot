# Research: first Linux execution boundary

- Status: proposed deployment and acceptance design; **not deployed or qualified**.
- Date: 2026-09-23.
- Owner: OpenBot maintainers.
- Related work: [work execution contract](../WORK_EXECUTION_CONTRACT.md),
  [capability lease design](capability-lease-protocol.md), and the existing architecture migration.
- Acceptance journeys: first qualify command-only processing of synthetic input files with bounded
  isolated output and recovery without another launch. Separately qualify a dedicated browser's
  test login, exact approved operation and destination readback across replacement. Each capability
  must prove that cancellation, a real network partition and an old worker cannot admit another action.
- Security boundary: Python control owns identity, policy, authorization, budgets and publication;
  Temporal owns continuation. Workers, commands, pages, imported skills and executor reports remain
  untrusted. The host's narrowly privileged Provider enforcement process is part of the trusted
  computing base, not a permission granted to model code.

## Decision and evidence level

Use a **dedicated Linux x86-64 VM**, Docker Engine's existing OCI lifecycle API and the released
**gVisor `runsc` runtime**, through the existing Node/Provider seam with lease enforcement still to
be designed and implemented. Qualify a separate sandbox for each command Action first, with no
network. The browser capability is a separate qualification: one persistent sandbox per credential
partition, an explicit egress proxy and host-enforced network rules. This selects maintained execution
components and a thin OpenBot policy adapter, not another sandbox platform, Agent loop or recovery
scheduler.

This proposed host profile must keep the command process from accessing the browser's cookies,
the Node's identity or Docker's host privilege. It is not the current `docker-linux`
Provider's implemented behavior. Neither this host profile nor the browser/gVisor combination was
run during this research. Current macOS/Docker Desktop execution and the separate Temporal
PostgreSQL work do not establish native Linux isolation. The first target is one Owner's dedicated
Ubuntu 24.04 LTS x86-64 VM with cgroup v2; record its exact kernel/package versions in acceptance.
No multi-tenant, ARM64, rootless Docker or arbitrary authenticated-web claim follows from this choice.

## Search evidence and fixed candidates

Searched official sources on 2026-09-23 using `gvisor Docker runsc networking filesystem security`,
`repo:google/gvisor rootless chromium sandbox`, `OpenSandbox gvisor networkPolicy execd command`,
`Firecracker jailer production host`, `Docker DOCKER-USER`, and `Squid dstdomain dst CONNECT`.
Read release metadata, immutable source trees, licenses, relevant tests and issue status through the
public GitHub API. GitHub's API identified OpenSandbox's new umbrella release where the indexed
`/releases/latest` page still showed its older component release; pins below follow the API/tag object.

| Component/candidate | Exact reviewed release and commit | Maintenance, tests and fit | Decision |
| --- | --- | --- | --- |
| [OCI runtime spec](https://github.com/opencontainers/runtime-spec/tree/92249139eea7161e13745abd4cb6d0ea02a3227a) | v1.3.0 / `92249139eea7161e13745abd4cb6d0ea02a3227a`; Apache-2.0 | Standard process, mount, namespace and Linux resource configuration; no OpenBot authority or effect receipt semantics | Adopt via released runtimes; do not implement a runtime |
| [Docker Engine/Moby](https://github.com/moby/moby/releases/tag/docker-v29.8.1) | 29.8.1 / `464cd50c3d9e92877d56940ea160de6fca7bea23`; Apache-2.0 | Released 2026-09-15; inspect/exec/kill/stop/restart integration tests in `integration/container`; release fixes namespace detection and updates the static containerd bundle to 2.3.5 | Select create/start/inspect/wait/kill and fixed mounts/resources; Docker alone is not the hostile-code boundary |
| [gVisor](https://github.com/google/gvisor/tree/95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29) | release-20260914.0 / `95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29`; Apache-2.0 | Active release line; `test/e2e`, `test/root/cgroup_test.go`, `test/root/sandboxposture_test.go`, syscall and fuzz coverage. OCI-compatible application kernel; syscall compatibility and overhead require workload tests | Select `runsc`, default userspace network stack, no unsafe flags or automatic `runc` fallback |
| [Squid](https://github.com/squid-cache/squid/releases/tag/SQUID_7_7) | 7.7 / `173863d3ec547d7fc5227ddbb5d8093c88b4842f`; GPL-2.0, separate process | Released 2026-08-24; reviewed destination-domain/IP ACL source, existing test tree and official ACL/HTTP-access configuration. Release includes buffer and FTP input fixes | Select as an explicit proxy, with host packet enforcement; do not implement a new HTTP proxy |
| [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.1.0) | 1.1.0 / `b1a29cf93a823a95913f7943010febb3f29de05c`; Apache-2.0 | New unified stable release 2026-09-21; `server/tests/test_docker_service.py`, execd command/process-group tests, lifecycle and SDK suites. Provides command/filesystem APIs but not OpenBot action admission | Do not add its server/SDK/platform for this first profile; retain as a replacement candidate if its larger API becomes necessary |
| [Firecracker](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.17.0) | 1.17.0 / `95f868c8e345b1cc8faccd1a3c910b4989dc3f58`; Apache-2.0 | Released 2026-09-10; jailer, seccomp and snapshot integration/security tests; requires KVM, guest kernel/rootfs and supported host configuration | Viable stronger deployment alternative, but direct integration adds guest image, networking and lifecycle work beyond the existing OCI Provider seam; not selected for the first host |
| [Existing agent-computer](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer) | `257c1280d684089be9adb0b35cce262efc7064bf`; MIT; Playwright 1.62.1, Apache-2.0 | Existing reviewed browser adapter; authorization, control, viewer, workspace and shell tests. Persistent contexts and a browser proxy setting exist | Reuse browser mechanics only, with restricted reachability and explicit hardening; do not expose its shell through the browser credential boundary |

Important qualifications from the actual sources:

- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/) limits kernel attack
  exposure; mapped files and permitted network connections remain accessible, and cgroups/network
  policy remain host responsibilities. It does not remove hardware side channels or compromised-host
  risk. [Docker socket access](https://docs.docker.com/engine/security/protect-access/) is a privileged
  control path; it never enters a sandbox or the ordinary Node process.
- gVisor [#12575](https://github.com/google/gvisor/issues/12575) remained open on the research date:
  reported rootless Docker startup requires an unsafe test flag. This design does not use that flag,
  disable cgroups, or switch to host networking to make startup succeed.
  [#14071](https://github.com/google/gvisor/issues/14071) remained open: joining a never-started
  container's PID namespace can panic and leave problematic shims. Use one container per sandbox,
  no cross-container PID sharing, and test daemon recovery/cleanup; this is not a claim the bug is fixed.
- OpenSandbox's pinned `server/configuration.md` defaults Docker networking to `host`. Its pinned
  `docs/guides/secure-container.md` documents gVisor/egress-sidecar incompatibility because the
  sidecar needs the NAT table. `networkPolicy` must not be removed to make an isolated deployment
  start. [#1315](https://github.com/opensandbox-group/OpenSandbox/issues/1315) was closed after pooled
  sandboxes could ignore network policy; the release rejects that combination.
  Command SSE/proxy failure [#1277](https://github.com/opensandbox-group/OpenSandbox/issues/1277)
  remained open. These are configuration and transport obligations, not reasons to invent an executor.
- Read Firecracker's [production host requirements](https://github.com/firecracker-microvm/firecracker/blob/95f868c8e345b1cc8faccd1a3c910b4989dc3f58/docs/prod-host-setup.md)
  and matching-version jailer instructions. A microVM also requires maintained kernels, privilege
  separation, network policy and resource controls; it is not an automatic substitute for them.

## Existing OpenBot boundary: reuse and mandatory gaps

Repository baseline inspected: `81de22b565ea195d4acc747085ab6246471e89af`. Checked the reuse ledger's
Browser computer, Browser egress hardening, Provider SDK, capability lease and Python work-domain
entries; [controlled click](controlled-browser-click.md), [short-term hardening](dev-001-short-term-hardening.md),
[Linux service/credentials](linux-worker-host-service-and-secret-service.md),
[runtime ports](runtime-execution-ports.md) and [Provider conformance](../PROVIDER_CONFORMANCE.md).

| Existing evidence | Reuse | Required change before Linux qualification |
| --- | --- | --- |
| `providers/docker/src/index.ts` navigates, captures PNG and optionally performs one reviewed click; `assertNavigationAllowed` is a prior DNS lookup | Bounded browser observation and exact click intent | This adapter does not launch Docker or run shell commands. Enforce egress where connections occur; the earlier DNS lookup cannot constrain browser redirects, subresources, DNS changes or raw sockets |
| `providers/docker/src/computer-request.ts` rejects HTTP redirects and bounds HTTP time/body | Transport limits and fixed public errors | Cancelling this HTTP request does not prove the browser stopped or the effect failed; add explicit action outcome/lookup mapping |
| `apps/node/src/client.ts` aborts local executions on WS close/cancel and resumes a matching `approval.resolved` waiter | Enrollment, routing, bounded progress/frame reporting and cooperative abort | A bare approval result is not a signed/consumed capability. Connection loss is not a fencing proof. H2 is a lease design draft, not an implemented consume path; keep new real effects disabled until its mapping to Python work authority and the trusted helper is designed, implemented and tested |
| `packages/provider-sdk/src/provider.ts` has `PreparedAction`, optional prepare/commit, `AbortSignal` and PNG result metadata | Extend this seam for bounded command/browser actions and receipts | Carry Task/Run/Action, immutable digest, current attempt epoch, provider/session scope and receipt references. Do not pretend the legacy Run result already implements the work contract |
| Python `work_store.py`, `work_claims.py`, `work_completion.py`, `work_files.py`, `work_handoff.py` | Admission/budget transactions, monotonic claims, unknown states, immutable artifact registration and engine handoff | Connect an authenticated executor port to these facts; do not give a Worker its database DSN, signing key or direct `complete()` privilege |
| Temporal work-journey adapter | Durable activities/waits and reconciliation scheduling | Replace the fake effect port with the qualified Provider port. Temporal history must contain references, not browser cookies, bearer tokens, command environments or secret file bytes |

The proposed local work comprises that Provider port, a restricted host-launch component, a lease
consume path still to be designed and implemented, and capability-specific conformance cases. The
launch component must accept only Server-approved immutable actions and expose no generic Docker
socket, arbitrary mounts, runtime choice or raw container API. Separate OS identity/IPC permissions
must keep an untrusted Node from invoking Docker directly. This enforces the Provider boundary;
it must not decide user policy, retry commands, resume a Task or publish results.

## Proposed target deployment and scope

Keep the Python control service, its PostgreSQL database, model-provider keys and Temporal services
off the execution VM. The VM hosts the enrolled Node, the restricted Provider enforcement process,
the root-owned Docker daemon/runsc installation, with an egress proxy added only for the browser
capability. Provider control connections use
authenticated TLS to the control service and an explicit endpoint allowlist. No workload route may
reach control, Temporal, databases, the host management plane, metadata services or another sandbox.
The Node uses its already-reviewed dedicated-account credential storage; no GUI keyring is assumed
on a headless VM. Existing bearer enrollment is not proof of possession or host attestation.

Before serving actions, verify exact runtime versions, image digests, resource limits and network
enforcement for the selected capability. Browser qualification additionally requires the expected
proxy/firewall policy and policy-generation health. Missing enforcement makes that capability unavailable.
Daemon/host reboot must restore deny rules before a browser or command can run; no restart policy
may start workloads first. Record the actual VM kernel, Docker package/containerd bundle, runsc
binary SHA-256 in acceptance evidence; browser evidence also records the proxy binary/image digest
and browser image/browser revision.
Reviewed source pins are not substitute binary checksums. No floating tags, downloads/installers
inside runtime startup, privileged containers, host PID/IPC/network, device passthrough, Docker
socket, host home directory, SSH agent, package-manager secrets or control credentials are allowed.

| Surface | Initial bound |
| --- | --- |
| Command | One container per immutable Action; reviewed image digest; non-root UID/GID; all capabilities dropped; `no-new-privileges`; read-only root; private bounded `/tmp`; no network; no automatic restart |
| Command files | Immutable per-Action input copy mounted read-only; fresh per-Action output storage with an enforced write-time capacity bound. No shared writable workspace with another Action or browser profile. Server verifies size/digest/allowed relative names before promotion |
| Command limits | Initial policy ceilings: 1 CPU, 512 MiB memory, 512 host PIDs plus an explicitly tested guest process limit, 256 file descriptors, 60 s wall time, 1 MiB combined captured output, 64 MiB output files. These are proposed limits, not measured capacity; commands that require more need a new admitted resource envelope |
| Browser | One isolated container/profile per `(Owner, Bot, credential scope)`; one active writer; pinned browser service and Playwright/Chromium pair; separate downloads/output staging; no shell/file API exposed to the Node |
| Browser limits | Initial ceiling: 2 CPUs, 2 GiB memory, 512 PIDs, bounded private shared memory, 15 s operation transport deadline and an explicitly admitted session lifetime. Approvals wait in Temporal with no open execution grant; idle browser egress is blocked |
| Privileged enforcement | Host-owned Provider helper only; fixed Docker/OCI operations and mount roots. No user-supplied runtime flags or host paths. Resource cleanup and the admitted action's watchdog are lifecycle enforcement, not segment retry |
| Host isolation claim | Defense in depth for the declared VM/workload profile after acceptance, not resistance to a malicious VM administrator, hypervisor or hardware side channels |

Write-time bounded output storage is a prerequisite for command qualification. A normal host bind
directory does not enforce the proposed 64 MiB ceiling, and checking file sizes during collection
cannot prevent a command from filling the host disk. The concrete filesystem/quota mechanism still
needs selection, source review and exhaustion tests; this document does not select or implement it.
The manual precursor below writes only a small synthetic output and does not establish this bound.

Use Docker's immutable container ID and Action labels for lifecycle lookup. Persist that association
before starting a command, and keep exited containers/receipt metadata until control acknowledges
collection; `--rm` is inappropriate for admitted work. Create/start/transport failures can leave an
unknown outcome. Inspect the same object, do not issue another start after it exited: Docker can
restart an exited container, which would repeat the command. Never create another object for an
unknown Action. If the daemon's records are absent or ambiguous, absence is not non-execution proof.

## Network enforcement

Commands have `--network=none`, including no DNS. Dependencies are in the reviewed image or imported
as approved input; a command cannot silently install packages. Any later networked command requires
a new explicit capability/profile rather than widening this one.

Browsers reach only a task-scoped proxy on a private bridge; the host firewall blocks direct IPv4
and IPv6, UDP/QUIC, alternate DNS, the Docker bridge gateway and sibling sandboxes. The proxy alone
can resolve and connect outward. Configure Squid with exact permitted destination names/ports,
explicit destination-IP exclusions for loopback/private/link-local/multicast/metadata/control ranges,
and a final deny rule. Reject numeric-host bypass and unknown policy generation. The host also
denies forbidden destination ranges from the proxy's namespace so DNS timing cannot reopen them.
Use synthetic fixture endpoints in a dedicated test network, never a general private-network opt-in.

Use [Docker's documented `DOCKER-USER` ordering](https://docs.docker.com/engine/network/firewall-iptables/)
for the selected iptables backend and protect host-bound traffic in the host INPUT path as well.
Do not rely on UFW defaults or mix nftables-backend instructions with `DOCKER-USER`; Docker
[documents these differences](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
Pre-established tunnels also need a bounded lifetime and active teardown on revoke: a new ACL does
not retroactively terminate CONNECT tunnels. Kill/block the revoked browser namespace before
handing its scope to a replacement; inability to prove isolation leaves the scope unavailable.

The proxy is a destination policy, not approval for an individual website operation. Without TLS
interception it does not verify encrypted paths, methods or request bodies, or establish that an
approved click has only one application-level effect. A permitted site can still receive data;
prompt injection remains an application-policy problem. Initial acceptance uses synthetic accounts
and destinations. Real accounts require explicit approved account/site scope and a separately
verified application effect/readback path; arbitrary authenticated browsing is not qualified here.

## Browser compatibility and persistence gates

The existing source provides useful mechanics, with concrete limits:

| Concern | Source evidence | Required Linux/gVisor check or missing implementation |
| --- | --- | --- |
| Login persistence | Pinned `profiles.ts` uses `launchPersistentContext` on `/profiles`; upstream comments distinguish persistent expiry cookies/local storage from session-only cookies that may disappear on restart | Restart and SIGKILL the actual pinned browser under runsc. Check expiry cookies, session cookies, IndexedDB, service-worker state and reauthentication with a synthetic site. Do not promise all sites remain logged in |
| Secret storage | The same file uses `--password-store=basic` and explicitly describes it as obfuscation, not protection | Dedicated volume permissions plus VM/disk encryption/backup policy; no profile in artifacts/logs/Temporal. Browser compromise or a host administrator can read its own session. The command sandbox cannot mount or read it |
| Browser sandbox | `COMPUTER_SANDBOX` defaults off and Playwright receives `chromiumSandbox: false`; the Dockerfile has no non-root `USER` and installs Bun with an unpinned installer | Build a minimal reproducible derivative or request upstream packaging changes: pinned Bun/base digest, non-root runtime, `COMPUTER_SANDBOX=on`, compatible reviewed seccomp and private IPC. Verify actual process arguments and operation under runsc. No `SYS_ADMIN`, `seccomp=unconfined`, host IPC or silent `--no-sandbox` workaround |
| Profile ownership | Upstream sweeps Chromium singleton lock files before launch and groups profiles by Bot within one process | Acquire control-owned exclusive session/epoch before mounting; prove prior container stopped before replacement. Never mount one writable profile on two hosts or trust the lock sweep to fence the previous browser |
| Shell and files | Pinned `index.ts` exposes `/exec` and `/files/*` under the same computer token; upstream profiles are not an OS isolation boundary | Keep the broad token inside Provider enforcement; exact-route allowlist refuses these endpoints on the browser channel. Commands use the separate OCI sandbox. Reachability controls must apply to the raw upstream port, not only the advertised tools |
| Human takeover | `control.ts`, viewer code and tests implement Bot-vs-human control; previous OpenBot real-browser evidence is macOS against a local fixture | Exercise Server-authorized human takeover, credential entry with no model/log exposure, disconnect, container restart and return to automation on Linux. Upstream in-memory control cannot replace a durable Server control lease; restart defaults to no automation until current ownership is checked |
| Downloads | Playwright emits download events and requires saving bytes before context cleanup; the current OpenBot Provider has no qualified download capability | Save to a dedicated quota-bound staging directory, distrust suggested filenames/MIME, reject traversal/symlinks, digest/read back before artifact registration. Kill during download must not publish a partial artifact |
| Uploads | Playwright supports `setInputFiles`; the current OpenBot reviewed-click adapter does not expose a qualified upload operation | Bind exact input digest, destination origin/form and approval; import only that file through read-only staging. No arbitrary host path, profile file, automatic archive extraction or directory upload. Destination-side confirmation is required after an uncertain submission |

Primary APIs: [Playwright Docker constraints](https://playwright.dev/docs/docker),
[downloads](https://playwright.dev/docs/downloads), [file input](https://playwright.dev/docs/input#upload-files).
The official Docker image is described for testing/development; its existence does not qualify
untrusted sites. The source tree inspection found no gVisor-specific browser compatibility test in
the inspected agent-computer or gVisor paths. All Linux rows above remain pending; a failed browser
sandbox gate blocks that browser profile. It does not authorize weakening the chosen boundary.

## Admission, fencing, uncertainty and recovery ownership

H2 is a design draft for a TypeScript Server and Node WebSocket lease, including JWS encoding,
a JCS action fingerprint and a connection-bound consume result. There is no implemented lease
consume path to reuse. Its mapping to Python work Actions and a separately trusted enforcement
helper remains undesigned and unimplemented: the consuming identity/connection, authority checks,
fingerprint inputs and encoding must be reconciled explicitly. The existing Python `intentDigest`
must not be treated as the H2 JCS fingerprint merely because both use SHA-256. This document states
integration requirements; it does not define a replacement token or wire protocol.

The proposed immutable operation must bind Task/Run/Action, provider and node identity, authority generation,
execution epoch, input/script/image digests, file/network/resource envelope and browser session
scope where applicable. Under the proposed boundary, a signed lease is necessary but insufficient:
the enforcement component must verify the exact operation and consume it online against Python
control immediately before dispatch. The consume transaction must serialize with Task/Action
revoke/cancel and admission; these are required behaviors, not an existing remote executor API.
No control connection, stale epoch, changed digest, expired lease or already-consumed operation
can grant another launch. Readback of a past receipt is allowed without reopening execution.

A Worker never holds the host Docker socket or the browser's broad token. A compromised Worker
can propose or replay requests but cannot bypass the trusted Provider enforcement boundary.
The helper maintains only action-to-runtime observation/receipt facts and bounded stop/watchdog
state; these facts cannot authorize another Action. It has no Task scheduler, model loop or
independent retry policy. Temporal schedules activities and reconciliation; the existing
`work_handoff` adapter bridges committed pending work to the engine.

On cancel/revoke, control denies new admissions first and requests bounded kill/connection teardown.
Already-admitted work may have effects, including after the user presses stop. Killing a process,
closing a page, an expired lease or a missing callback does not undo or disprove them. Current
authority and epoch checks guard new admission/budget reservation and final Task/Artifact publication.
Historical outcome settlement is different: `work_store.resolve()` intentionally permits a trusted
resolver to record independently verified receipts after cancellation or attempt replacement without
requiring a current fence. A stale Worker report cannot directly settle usage, but an old Action's
verified receipt must not be rejected solely because its execution epoch is no longer current.
Recording that fact grants no new execution or publication authority. External stale writes are
prevented only where the execution gate/destination enforces the epoch. An already-running command
can still modify its isolated output until stopped, so
staging is never a shared live workspace and cannot become a final artifact without current control.

For lost acknowledgements, query the same container/action receipt and independently verify intended
output or destination state. An exit code/screenshot alone is not confirmation of a remote write.
A destination-enforced idempotency key is useful only with its actual documented scope and lifetime.
The present browser backend has no general durable receipt lookup: an unprovable browser submission
stays unknown and requires bounded human reconciliation, not another click. Unknown billed usage
stays reserved. Engine completion/failure is never automatically business success, refund or retry
permission. Container snapshots, browser profiles and Temporal histories have different lifetimes;
none is a substitute for PostgreSQL authority or verified Artifact content.

## Runnable precursor and required acceptance

Only the following **manual precursor** is immediately runnable after an operator installs the
reviewed host components and supplies an already-loaded, reviewed Python image digest. It is not
an implemented OpenBot isolation suite and was not executed in this research. Run on the dedicated
Linux VM, not the current Mac. It creates and removes only its own test container/temp directory.

```sh
set -eu
: "${OPENBOT_TEST_IMAGE:?Set an already-loaded Python OCI image@sha256:digest}"
case "$OPENBOT_TEST_IMAGE" in *@sha256:*) ;; *) exit 2 ;; esac
test "$(uname -s)" = Linux
docker version --format '{{.Server.Version}}'
runsc --version
# Compare the preceding values with the reviewed pins; do not accept an runc fallback.
probe_root=$(mktemp -d)
probe_name="openbot-linux-boundary-$$"
cleanup() { docker rm -f "$probe_name" >/dev/null 2>&1 || true; rm -rf "$probe_root"; }
trap cleanup EXIT INT TERM
mkdir "$probe_root/input" "$probe_root/output"
printf 'row,value\n7,old\n' > "$probe_root/input/source.csv"
chmod 755 "$probe_root" "$probe_root/input"
chmod 644 "$probe_root/input/source.csv"
# This directory contains synthetic outputs only; production sets its dedicated mapped UID.
chmod 777 "$probe_root/output"
docker create --pull=never --name "$probe_name" --runtime runsc --restart no --network none \
  --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --memory-swap 512m --cpus 1 --pids-limit 512 --ulimit nofile=256:256 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
  --mount "type=bind,src=$probe_root/input,dst=/input,readonly" \
  --mount "type=bind,src=$probe_root/output,dst=/output" \
  "$OPENBOT_TEST_IMAGE" python -c '
import os, pathlib, socket
assert os.getuid() == 10001
assert not pathlib.Path("/var/run/docker.sock").exists()
assert not any(k.startswith(("OPENBOT_", "AWS_", "OPENAI_", "ANTHROPIC_")) for k in os.environ)
assert pathlib.Path("/input/source.csv").read_bytes() == b"row,value\n7,old\n"
for path in ("/input/new", "/etc/openbot-probe"):
    try: pathlib.Path(path).write_text("forbidden")
    except OSError: pass
    else: raise AssertionError("unexpected writable path")
s = socket.socket(); s.settimeout(1)
assert s.connect_ex(("198.51.100.1", 443)) != 0
s.close()
pathlib.Path("/output/result.csv").write_bytes(b"row,value\n7,fixed\n")
'
test "$(docker inspect --format '{{.HostConfig.Runtime}}' "$probe_name")" = runsc
timeout 90s docker start -a "$probe_name"
test "$(docker inspect --format '{{.State.ExitCode}}' "$probe_name")" = 0
printf 'row,value\n7,fixed\n' | cmp - "$probe_root/output/result.csv"
```

This precursor demonstrates only the inspected configuration and simple file/process behavior.
The unreachable documentation address is not proof of a firewall; the real suite must place live
canaries on forbidden routes and prove they are reachable from an authorized fixture first.
Qualify command-only and browser capabilities separately in the existing conformance runner and
public work journey, with exact binaries/configuration and independently counted effects. The
command gate requires the rows marked Command or Both, applied to its own execution path; it does
not require browser packaging, login persistence, a proxy, uploads/downloads or human takeover.
The browser gate additionally requires its Browser rows and the shared cases for browser actions.
A command precursor passing in isolation does not enable product execution: authenticated admission
and the shared authority/recovery cases remain prerequisites for advertising that capability.

| Case | Scope | Executable procedure and required observation |
| --- | --- | --- |
| Secrets/files | Both | Inject synthetic canary secrets in control/host/other-Bot locations; attempt reads through the selected capability's environment, filesystem and process surfaces, including traversal and symlink races. None is returned. Inputs stay immutable; unregistered output never appears in public Artifact routes |
| Runtime/resources | Both | Inspect runtime/UID/capabilities/mounts/cgroups; exhaust the capability's memory/PID/storage/output limits and exceed its admitted lifetime. Command output must hit its write-time capacity bound without filling host storage. The owned workload stops within the configured bound, host stays responsive, and no other sandbox is killed. No success from truncated/partial output |
| No-network command | Command | Place live canaries on host, private IPv4/IPv6 and sibling routes; prove fixture reachability from an authorized process first. Command direct sockets and DNS cannot reach them or external destinations. Repeat after daemon/host restart |
| Browser egress | Browser | Serve live canaries for loopback, host gateway, private IPv4/IPv6, metadata and other sandbox; try direct sockets, DNS rebinding, redirects, subresources, WebSocket, QUIC and proxy bypass. All forbidden paths stay blocked; the exact fixture destination works. Repeat after daemon/host restart and proxy failure |
| Browser lifecycle | Browser | Execute every browser-table case above under runsc, including persistent vs session cookies, IndexedDB, pending download, exact-file upload and human takeover during approval. Verify zero Bot actions while human-owned, including after browser restart |
| Exact approval | Both | Change the relevant command bytes, image, input digest, upload file, target, epoch or network scope after approval; replay the same consumed grant from another Node. No new container/browser input and no budget reservation |
| Real partition/stale worker | Both | Drop packets in both directions between the old execution VM and the control endpoint while leaving the old workload running. Revoke/advance epoch from a separate client, then ask the old Node to launch and attempt final publication. Restore packets and retry. Independent launch/effect counters and control revisions must show no new admission or stale commit |
| Command receipt recovery | Command | Suppress acknowledgement after the command writes its isolated output, then kill the activity/Node. Replacement inspects the same Action/container and independently verifies its output. Count launches and writes; no second start or replacement container for an unknown Action. Missing/conflicting evidence remains unknown with its reservation |
| Browser receipt recovery | Browser | Destination fixture commits, suppresses its response, then kill the activity/Node. Replacement uses the same Action lookup and destination readback; exactly one effect and all POST attempts counted. Missing/conflicting evidence remains unknown with its reservation |
| Host loss | Both | Kill the executor or reboot the VM during execution. Preserve the same Action's observation/receipt identity and deny stale admission/publication. Missing runtime records do not prove non-execution |
| Profile fencing | Browser | Do not attach a browser profile elsewhere until the old writer is proved stopped or the old VM is fenced. A disconnected host still writing is not safe to replace merely because its lease expired |
| Cleanup | Both | Fail startup before/after container creation and interrupt each test. Owned objects have bounded teardown, no background process/port remains, and cleanup never deletes another Task's state. Retain browser profiles intentionally where applicable; keep receipts until acknowledged reconciliation |

For the partition case, packet loss must be a real network fault: install fixture-scoped DROP rules
on the dedicated VM (OUTPUT to the control IP/port and INPUT from it, or both bridge directions in
`DOCKER-USER` for a containerized Node), with a cleanup trap removing the exact rules. Prove the
control connection fails while a separate local workload canary continues to run. `SIGSTOP`, killing
a process, disconnecting a browser UI or merely mocking heartbeat expiry does not satisfy this case.

## Source incorporation, handoff and remaining decision

No upstream source was copied or substantially adapted; no dependency was installed, no host was
provisioned and no product default changed. Existing MIT browser attribution remains; distributed
runtime/proxy images must carry their own notices/SBOM and the applicable Squid source/license
obligations. A later derivative browser image needs a separate fixed build manifest and notices.

This file is an internal design/evidence record, not a support announcement. Before user-facing
availability changes, update the affected English/Chinese Provider and security documents together
and run the repository checks plus the real Linux cases. Version upgrades rerun the affected
runtime/browser/network and receipt tests; any incompatible or missing backend makes that
capability unavailable rather than selecting an unreviewed fallback.

Command qualification remains conditional on its isolation/resource tests, write-time storage bound
and authenticated admission/recovery integration. Browser qualification separately depends on the
browser sandbox, persistence and egress tests. Binary/image checksums, the lease mapping and live
enforcement, browser derivative packaging and the automated acceptance commands beyond the precursor
remain unimplemented. If runsc cannot satisfy Chromium's required
sandbox/syscalls without weakening policy, qualify the already-compared VM runtime through the
same Provider contract; do not claim success from a less isolated container. No new roadmap or
second continuation owner is introduced here.
