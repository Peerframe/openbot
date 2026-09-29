# Research: Installable Desktop delivery and persistent model configuration

- Status: Implementation in progress; release and real-device evidence pending
- Date: 2026-09-08
- Owner: OpenBot maintainers
- Related issue: Desktop delivery and usable Agent milestone
- Acceptance journey: Download a versioned Desktop installer from a durable release, install the
  client, connect or initialize a Server, configure a model, and retain configuration after restart.
- Security boundary: Existing Packager/ASAR/fuse gates remain authoritative. An installer does not
  enroll a Worker, enable inference, start privileged services, or confer computer-control support.
  Model credentials remain Server-owned and encrypted; missing/corrupt key material fails closed.

## Search evidence

- Search date: 2026-09-07/08 (Asia/Shanghai).
- GitHub queries: Electron Forge releases and fuse compatibility; electron-builder releases,
  `prepackaged`, NSIS `oneClick`, `perMachine`, `runAfterFinish`, and open issues. Reviewed the
  builder's `platformPackager.ts`, `NsisTarget.ts`, `nsisOptions.ts`, package manifest, MIT license,
  and maintained `test/src/{mac,windows,linux}` suites. Open issues #10179 (PKG TCC prompt) and
  #10181 (macOS entitlements) are reasons not to add PKG or silently replace signing policy.
- Primary documentation: [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/distribution-overview),
  [builder CLI](https://www.electron.build/cli/),
  [GitHub release creation](https://cli.github.com/manual/gh_release_create),
  [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), and
  [Node 24 filesystem APIs](https://nodejs.org/docs/latest-v24.x/api/fs.html).
- Existing entries: Desktop foundation, integrated onboarding, cross-platform handoff and native
  Agent in `docs/OPEN_SOURCE_REUSE.md`; ADR-0041; current container contract and model settings.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Electron Forge | 7.11.2 / f2a3ec8aa9c836aff95fcd83ce9c99842f0cda8a | MIT | Latest stable, maintained maker suites; prior review found Fuses 2 incompatibility and dependency advisories | Replacing the existing pipeline would reopen resolved Electron 44 packaging boundaries | Retain prior rejection |
| electron-builder | 26.16.0 / f4610970f78b6ce223b1f4cee2b5e8f5caa14a48 | MIT; bundled tool licenses retained upstream | Released 2026-09-02; native target, archive, CLI, configuration and publishing tests | `prepackaged` skips repackaging; supports DMG, NSIS and Linux distribution targets. Installer-only use preserves current ASAR/fuses. Dependency audit and actual target builds still required | Select build-only adapter, subject to validation |
| Existing Packager/Fuses | 20.3.0 / 8c5cc941018b1d890c7152734972c44b9b98f268; Fuses 2.1.3 | BSD-2-Clause; MIT | Existing package and fuse tests, three native CI targets | Already produces vetted app directories, but no installers or durable publication | Retain, wrap output only |
| Compose named volumes + Node filesystem/crypto | Existing Node 24.20.0; Compose specification as documented 2026-09-07 | Node.js license; specification terms | Existing container startup/restart smoke and Node standard-library tests | Private persistent model directory with an exclusive, bounded key initialization path; explicit environment key remains supported | Select standards and thin lifecycle adapter |

## Reuse decision

- Selected option: released packaging dependency and standard deployment primitives, with narrow
  OpenBot adapters for artifact identity, checksums, publication gates and model-key ownership.
- Why first viable: no single open standard creates all three installers. Existing Packager stays
  in place; a prepackaged builder adapter supplies the missing installer stage without a second
  runtime or renderer. No custom installer engine, elevation or privileged installer actions.
- Gap: versioned release assets and clear download links, installer metadata, one-command download
  entry, and a default writable/private model configuration location for container deployments.
- Exit plan: replace only the installer adapter when a maintained equivalent passes the same
  source identity, package inventory, fuse, checksum and platform gates.
- Failure behavior: no publication after partial builds; do not overwrite release assets or claim
  signing/notarization without evidence. A missing/corrupt model key must not silently replace an
  existing key or decryptable configuration. Model execution remains explicit Owner opt-in.

## Source incorporation

- Source copied or substantially adapted: no. Use published APIs and configuration contracts.
- Required notices: builder remains build-only; preserve its dependency license files and upstream
  installer-tool notices. Existing Electron and PostgreSQL notices remain in Desktop bundles.

## Verification plan

- Finish the distribution/configuration project before running its grouped checks.
- Assert supported target/version names, no automatic publication/start/elevation, retained user
  data, complete manifest/checksum sets, and failure on altered/missing artifacts.
- Exercise model-key persistence, file ownership/modes, symlink and corruption rejection, and
  conflicting legacy configuration; container restart retains model data.
- Build the local macOS installer; native CI validates Windows and Linux packages. Real-device
  installation, Developer ID/notarization and Authenticode remain separate evidence.
- Update README download sections, installation documentation and maintained translations with
  actual availability, including pending publication rather than speculative download URLs.

## Installer recovery and Windows transfer review (2026-09-08)

Final source review found two concrete gaps: the Linux bootstrap created its final version directory
before copying, so a failed copy could make retry look installed; Windows Invoke-WebRequest bounded
time but did not bound downloaded bytes while reading. On .NET Framework, automatic redirects may
also downgrade HTTPS to HTTP. These are part of the original installer acceptance boundary.

Reviewed Microsoft HttpClient/HttpClientHandler APIs for .NET Framework 4.8 and the current native
PowerShell CI lane, plus GNU coreutils mv no-clobber/no-target-directory semantics. The first viable
options are existing platform APIs, not another downloader or installer dependency. Sources:
[AllowAutoRedirect](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclienthandler.allowautoredirect),
[ResponseHeadersRead](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption),
[mv](https://www.gnu.org/software/coreutils/manual/html_node/mv-invocation.html).

Use streamed Windows reads with an overall cancellation deadline, byte caps, HTTPS-only bounded
redirects to GitHub release hosts, exclusive output creation and deterministic disposal. Preserve
Internet-zone marking and nonzero installer exit handling. For Linux, copy into a private sibling
stage and publish without replacing a concurrent target; failures clean only this invocation's stage.
Test failure/retry, concurrent target retention, HTTP downgrade, redirect count and streamed oversize
with local fixtures. Windows HTTP tests run in native PowerShell CI, not as a source-string proxy.
No upstream source is copied or substantially adapted; no new dependency is added.

Validation: the full repository check passed. Real Linux Bash fixtures passed copy-failure cleanup,
retry, existing-checksum verification and concurrent destination retention. All nine HTTP/file
fixtures passed in Microsoft PowerShell 7.5.0, using an isolated network-disabled container pinned
to `mcr.microsoft.com/powershell@sha256:042240d57ec9e47e511033b92625a8d95875ee5860af3015992c248b58a8be81`.
The portable matrix explicitly runs `scripts/install-desktop.test.ts`, including both Windows
PowerShell and pwsh on Windows. Ubuntu CI exposed a newer coreutils `mv -nT` nonzero no-clobber
exit where the older Debian fixture returned zero. Both paths now preserve the concurrent target,
clean only the private stage and report the same retained-installation outcome. They include
cancellation before headers and during a stalled response body; no public asset is downloaded.

## Unresolved questions

- Dependency admission review: the complete installed graph reports zero high/critical advisories;
  four existing moderate Drizzle/esbuild development advisories remain. Installer-tool downloads
  and real native builds are still part of project validation.

- Public release publication and signing credentials are not assumed. Build reviewable artifacts
  first and record exactly which stage has passed.

## curl unknown-length transfer boundary

Final installer-document review confirmed from the official
[curl max-filesize documentation](https://curl.se/docs/manpage.html#--max-filesize) and
[8.4.0 changelog](https://curl.se/ch/8.4.0.html) that releases before 8.4.0 do not enforce this limit
when response length is unknown. Select the existing released tool's fixed behavior: require curl
8.4.0 (tag object `817204c6e41f66dafbaa704d67f828a4288b3577`, curl license) or newer before network/staging, rather than add a custom shell stream limiter or claim older
versions are bounded. Older systems can use the documented native-asset download path. No source
copied, new dependency or operating-system change. Test rejected/malformed versions before any
network call and retain minimum-version fixtures in both Bash native lanes.

## Explicit Windows-only release scope (2026-09-10)

The user requests Windows-only alpha.6 delivery. Re-reviewed the existing `prepare-desktop-release.mjs` authority/manifest tests, hash-pinned checkout v7.0.1 and setup-node v7.0.0 workflow actions, [GitHub workflow_dispatch boolean inputs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs), and [gh release create](https://cli.github.com/manual/gh_release_create). Reuse existing released GitHub Actions/CLI and OpenBot installer manifest verification; no new dependency, protocol or copied source.

Add an explicit `windowsOnly` boolean and final `--windows-only` CLI flag, selected by workflow `windows_only`. Default assembly continues to require all three native targets. Windows scope requires the Windows installer and records exactly one target; it does not treat missing Windows bytes as success or claim other platforms were included. Preserve successful same-repository main-push CI authority, exact source commit/version, manifest and file hash checks, refusal to replace an existing release, and reviewable draft prerelease creation. Correct release notes to describe Windows local Server/PostgreSQL and the selected scope. This change prepares a draft; publication remains a separate authorized release action.
