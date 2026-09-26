# Desktop downloads and installation

Current source scope: only macOS arm64 bundles the local Python service. Windows, Intel Mac and Linux are remote clients. Earlier local-Server installation/qualification records below are historical, not claims for new builds. Existing installations, encrypted settings and databases are retained.

[English](DESKTOP_INSTALLATION.md) · [简体中文](DESKTOP_INSTALLATION.zh-CN.md)

**Current preview: [Desktop 0.1.0-alpha.9](https://github.com/Peerframe/openbot/releases/tag/desktop-v0.1.0-alpha.9)** provides a macOS Apple Silicon DMG and Windows x64 EXE, with a combined manifest and SHA256SUMS. Both come from the same source commit that passed full CI. The table also lists Linux build targets; alpha.9 does not publish Linux installers.

alpha.9 restores channel member names, avatars and controls, keeps plugin permission editing tied to the selected Bot, and distinguishes task-state or resource changes from actual channel permission loss. Empty-PDF extraction failures and the original-attachment save dialog now use Chinese copy in the Chinese interface. Existing workspace data and model settings are retained by the upgrade path.

The [versioned release page](https://github.com/Peerframe/openbot/releases/tag/desktop-v0.1.0-alpha.9) records the source commit and successful main CI. Its [desktop-manifest.json](https://github.com/Peerframe/openbot/releases/download/desktop-v0.1.0-alpha.9/desktop-manifest.json) records the exact source, included targets and installer digests; verify downloads against [SHA256SUMS](https://github.com/Peerframe/openbot/releases/download/desktop-v0.1.0-alpha.9/SHA256SUMS). Windows installation and retained-data evidence comes from a hosted runner; see the [release-source cold-start evidence](WINDOWS_DESKTOP.md#release-source-cold-start-evidence). Production signing, notarization and manual Windows desktop acceptance remain outstanding.

| Platform | File in the release | Installation | Available composition |
| --- | --- | --- | --- |
| macOS Apple Silicon | `openbot-desktop-<version>-darwin-arm64.dmg` | Open the disk image and drag OpenBot to Applications | Client, bundled local Server/PostgreSQL, optional bundled Worker companion |
| Windows x64 | `openbot-desktop-<version>-win32-x64.exe` | Open the installer; it installs for the current user and adds Start menu access | Client with bundled local Server/PostgreSQL, or connection to an existing Server |
| Linux x64 | `openbot-desktop-<version>-linux-x64.deb` | Install using the distribution package manager | Client connected to an existing Server |
| Linux x64 portable | `openbot-desktop-<version>-linux-x64.AppImage` | Make executable and run; system AppImage dependencies still apply | Client connected to an existing Server |

These initial installers are **unsigned development builds**. They do not bypass Gatekeeper,
SmartScreen, Linux sandbox requirements, or an organization's installation policy. Signing,
notarization and real-device installation evidence are not implied by a successful build. No
automatic updater is installed. Installers preserve application data during ordinary uninstall;
back up your data before manually upgrading. macOS Intel and ARM Windows/Linux are not covered.

## One-command bootstrap

After the selected Desktop release is published, the repository scripts download its exact native
asset and check `SHA256SUMS` before installing. Checksums establish consistency with that release;
they are not a substitute for a publisher signature. Read the script first if required by your
environment. Both scripts use the fixed OpenBot GitHub repository and retain operating-system
trust checks. They never enable inference or enroll a Worker.

The macOS/Linux command bootstrap requires curl 8.4.0 or newer so unknown-length downloads are also bounded. Older or unrecognized versions stop before network access; use the native installer download table instead.

macOS arm64 (for Linux, choose a published version that includes an AppImage):

```bash
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Peerframe/openbot/main/scripts/install-desktop.sh \
  -o /tmp/openbot-install-desktop.sh
bash /tmp/openbot-install-desktop.sh 0.1.0-alpha.9
```

The macOS bootstrap installs to `~/Applications/OpenBot.app`; it refuses to replace an existing
app. Use the DMG for a reviewed upgrade. Linux installs to
`~/.local/opt/openbot/<version>/openbot.AppImage`; it keeps existing versions. Delete the downloaded
script when finished. Neither path requests root privileges or starts Server/Worker services.

Windows x64, from PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Peerframe/openbot/main/scripts/install-desktop.ps1 -OutFile "$env:TEMP\openbot-install-desktop.ps1"
& "$env:TEMP\openbot-install-desktop.ps1" -Version 0.1.0-alpha.9
```

The PowerShell script opens the per-user installer and waits for its result. If your execution
policy disallows scripts, download and open the EXE instead; changing execution policy is not
part of this procedure.

## First useful session

1. On macOS or Windows x64 choose **Service computer** to initialize local services, or connect to an existing
   Server. Linux uses the existing-Server path.
2. Sign in as Owner. In **Owner → Settings → Model services**, configure the Server's single
   default provider, model and key; explicitly opt into the native Agent when ready.
3. Use the **+** beside the OpenBot wordmark to create a Bot or channel. Click a Bot for a direct
   conversation, or address it with **@** in a channel, then submit a `none`-profile task. A provider metadata check does not
   prove inference: the first completed real task is the live model acceptance step.
4. Quit and reopen Desktop. Verify the workspace and model summary remain available. Local macOS/Windows
   services stop when Desktop quits; unattended schedules require a continuously running Server.

Desktop supports bounded channel collaboration, richer files, reviewed MCP content/apps, voice drafts and retained startup. Sharing exports reusable Bot profiles/verified skills and downloads deliverables; it does not publish private memory or transcripts. Windows local-runtime evidence is recorded in [Windows Desktop](WINDOWS_DESKTOP.md). macOS bundles PostgreSQL 17.10; Windows bundles 17.11.

See [Desktop onboarding](DESKTOP_ONBOARDING.md), [native Agent](NATIVE_AGENT.md) and
[Server container](SERVER_CONTAINER.md) for the exact supported boundaries.

## Build and prepare a release

```bash
npm ci
npm run check
npm run package:installers --workspace @openbot/desktop
```

Build on the target OS. Existing Packager/ASAR/fuse checks run before the installer stage, which
uses pinned `electron-builder` 26.16.1 with `prepackaged` and `publish: never`. Native CI adds the
macOS Worker companion and builds every target. The output directory includes `manifest.json` and
`SHA256SUMS`; locally built manifests have `sourceCommit: null` and cannot enter the CI release gate.

The **Prepare Desktop release** workflow takes a successful main push CI run and the matching
Desktop version. It validates repository/run identity, the selected targets and every checksum,
then creates a draft prerelease with those installers, a combined manifest and checksum list.
The workflow defaults to macOS arm64 and Windows x64; its target selection also supports
Windows alone or all three platforms.
It does not publish the draft or overwrite an existing release. Complete the retained native
dependency notice/source review and signing/distribution review before publishing. Draft status is
visible only to repository maintainers and is not a public download channel.

The Windows command installer streams at most 16 KiB of checksums and 2 GiB of installer bytes, allowing at most five HTTPS redirects on approved GitHub release hosts. Cancellation, limits or failures remove partial downloads. Linux copies into a private sibling stage before publishing the version directory; failed copies are retryable and concurrent destinations are retained without overwrite or nesting.

The Desktop main window owns one workspace and one channel event stream. Reload, channel replacement, Server switching and window closure abort obsolete streams so repeated navigation does not exhaust Server connection slots.
