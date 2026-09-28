# Parser runtime dependency separation

2026-09-25, before implementation. Root repository is read-only.

Reuse the accepted dependency reviews in docs/OPEN_SOURCE_REUSE.md,
attachment-processing-completion.md, pdfjs-6.3-lock-coherence.md and
desktop-python-product.md. Existing pins: pdfjs-dist6.3.289 /
1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56 (Apache-2.0 plus bundled notices),
officeparser7.8.0 / 09b27018450ed4df88fe01494343b43556813b71 (MIT),
tesseract.js/core7.0.0 (Apache-2.0), eng/chi_sim1.0.0 (metadata MIT; trained
data Apache-2.0, retained source notice806cd9adc8c6e8abc11c782db1818c990576bebc).
Drizzle ORM0.45.2 (Apache-2.0) and postgres3.4.9 (Unlicense) stay in @openbot/db.
No parser implementation, dependency release or resolver algorithm changes.

Primary sources actually read: npm10 workspace and package-lock documentation,
https://docs.npmjs.com/cli/v10/using-npm/workspaces/ and
https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json/.
GitHub search queried npm/cli v10.9.9 workspaces package-lock; known workspace
lock issues #9659 and #9105 support retaining the current officeparser root
resolution anchor/global override and changing no install strategy. Existing
source/releases/tests/security/license reviews above remain the selected exact
pins; no upgrade or new parser research is needed.

First viable option: native npm workspace metadata records the existing six
production roots independently of apps/server. Add one private metadata-only
packages/python-node-runtime package; reuse the existing exact lock graph
traversal by adding this single allowed entry. Filter the metadata root from
staging because it has no executable/dist. The only compiled retained workspace
remains packages/db, with its unchanged migrations and CLI.

A second package lock, synthetic apps/server projection, copied parser, replacement
parser framework or moved database history would each add unnecessary coupling or
divergent behavior. parser_worker.mjs stays in Python source and retains its fixed
byte-only protocol, no-network preload, released Workers, parser pins and bounds.
Default legacy mode remains unchanged. No upstream source is copied.

Verification: compare exact old/new closure; remove apps/server lock/link and
recompute; malformed/missing graph tests; synchronize new manifest/lock; run the
existing release-graph and Desktop tests. Independently stage the same exact
closure in temporary storage and run original Python parser tests with synthetic
Office/PDF/OCR bytes, no database or external request. Retain notices and identify
all remaining test-oracle dependencies before any later old-Server deletion.

## Result

11 Desktop, 12 unchanged release resolver and 11 real staged parser tests passed.
The exact closure is unchanged:43 locked third-party entries,33 applicable on this
macOS arm64 host, sole compiled workspace packages/db. No third-party version or
integrity changed. Default backend, parser worker, database history and CLI remain
unchanged. Actual staged DB import/SQL-byte comparison and containment passed.
Offline npm10.9.8 validated the two added entries; its unrelated platform metadata
rewrites were not adopted. Project-pinned npm10.9.9 clean installation and final
Desktop packaging remain root integration checks. No dependency was downloaded.
The removed Server-lock regression preserves the complete dependency closure; existing
TS interop tests remain in place and must be relocated before deleting legacy source.

## Typed parser consolidation — 2026-09-29

The fixed worker is now `apps/server-python/src/openbot_server/parser_worker.ts`.
Its bounded header, dependency verification and PDF/Office/OCR adapters have explicit types;
the released parser declarations supply upstream API types. The Python child command and its
network preload both select this single source. The old handwritten MJS exits after independent
Node22.22.2 and24.21.0 parser checks. No additional loader, build step, dependency, wire format,
permission or released version is introduced. Direct native TS reuses the cleanup record's
reviewed Node/TypeScript contract; root and affected CI include `typecheck:parsers`.

Real consumption was verified from the existing Desktop staging entry with Python3.12.13,
Node24.21.0 and the production dependency projection, and from a newly built local Linux arm64
product container. Source hashes match staging; old MJS is absent. Synthetic Office/PDF/OCR,
Owner HTTP, restart and bounded shutdown checks pass. This does not qualify signed releases,
Keychain, Windows/Intel Mac execution, configured Temporal or real model calls.

中文：固定解析器已整理为一个 TS 实现，Python 子进程与网络预加载同时切换，旧 MJS 已退出。
复用原 Node、TS 和解析库版本，没有新增加载器、编译阶段或权限。最低 Node22.22.2 与产品
Node24.21.0 的真实解析检查、Desktop 暂存安装物和 Linux arm64 产品容器消费链已通过；
签名发布、Keychain、Windows/Intel Mac、配置后的 Temporal 和真实模型调用不在这些证据内。
