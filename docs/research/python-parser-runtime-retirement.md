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
