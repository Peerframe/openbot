# Desktop setup

[简体中文](DESKTOP_ONBOARDING.zh-CN.md)

The macOS arm64 and Windows x64 desktop distributions include a local Server and PostgreSQL.
Choose how this computer should connect:

- **Service computer:** Desktop initializes an app-owned PostgreSQL 17 database, starts the
  bundled Server, creates its private Owner bootstrap identity, connects and opens model setup.
  No Docker, Homebrew, administrator account or first-launch download is required.
- **Remote client:** Desktop saves and verifies an existing HTTPS Server origin, then asks for
  its Owner login. It does not initialize or start a local database or Server.

The macOS window retains native traffic lights and the left sidebar toggle. The sidebar keeps
**OpenBot** as a wordmark without a separate brand icon. Its single creation **+** opens channel
and Bot creation; there is no separate New conversation row or extra plus beside section headings.
Search filters authorized channels and Bots. **Plugins** and **Owner** are the bottom entries;
Owner opens Settings, About, Help, Feedback and logout. The office scene remains deferred.

## Workspace navigation and conversations

The left and right panels can be collapsed independently. The channel title and horizontally
stacked Bot avatars form one borderless disclosure for channel details and membership; there is
no separate more menu. Share, Work computers and the right-panel toggle remain separate controls
at the top right. The compact task-progress strip and contextual information panel are retained.

Click a Bot in the sidebar to open its persistent direct conversation. Right-click it to open the
Bot profile. A direct conversation has exactly one Server-owned Bot identity; repeated opens reuse
the same conversation, and adding other members or routing its task to another Bot is rejected.
Direct conversations do not appear as ordinary channels. See
[direct-conversation research](research/desktop-direct-conversations.md).

Back and forward revisit workspace destinations. Creating a channel opens it immediately.
Returning from Settings preserves the selected view, draft and reading position. Navigation is
local presentation state, not Server routing or authorization. See
[navigation research](research/desktop-navigation-continuity.md).

The conversation keeps readable messages, quoted replies and associated task status. In a channel,
type **@** and choose a current member to address that Bot; the selection uses its Server-provided
ID. A direct conversation needs no mention. The composer no longer has a Bot dropdown below the
text. It grows from two to eight lines and retains the send button; Enter sends by default and
Shift+Enter inserts a newline. Reading older messages stays in place until **Return to latest**.

The composer's **+**, drag-and-drop and file paste add attachments. A message accepts up to
**8 files / 20 MiB total**: text/code up to 256 KiB each, PNG/JPEG up to 5 MiB each, and
supported PDF, Office/OpenDocument and audio/video files up to 10 MiB each. Originals are stored
on the Server and remain downloadable. Extraction, OCR and transcription are separate actions;
media transcription sends the selected media to the configured service after an explicit action.
You can cancel an upload or retry only failed files while retaining successful attachments.
Cancellation ignores a late response; an original already received by the Server may remain in
attachment management. Recording and adding a voice draft are separate from sending a message.
Skill chips request existing reviewed skills and never grant capabilities.

**Share** provides task-output downloads and sharing the Bot itself. Bot sharing previews its
profile and verified skills; selected reviewed single-file instructions use the v2 package.
Private memory, history, keys and computer permissions remain on the source Server. The recipient
creates a new Bot and reviews imported instructions before model use. See [Employee sharing](EMPLOYEE.md).

After initial setup, reopening resumes the existing local service and database with a compact
connection state instead of repeating the installation checklist. Saved credentials are reused.
Credential access is asynchronous so system authorization does not freeze the startup window;
an unlock failure preserves the existing encrypted identity and data. macOS can still request
Keychain approval after an unsigned build changes; see the distribution limitations below.

Each channel retains its draft text, selected Bot, quoted reply, attachment and skill chips in
workspace-session memory.
Switching channels while a send is pending does not move its result into another channel, and a
successful send clears only the unchanged submitted draft. Newer edits are kept. Only one message
submission per channel is pending at a time; failures retain the draft and are not retried
automatically. After an uncertain network result, check the channel history before resubmitting.

Drafts are not saved to disk or localStorage and do not survive logout, changing Owner/Server,
reload or closing the window. The bounded cache retains up to 32 visited channels with drafts of
at most 8,000 characters. Unsent drafts, quoted replies, attachment/skill selections and pending sends are not evicted; if all
slots are in use, the next channel displays a limit notice until an older draft is sent or cleared.
This is not offline sending or Server-side idempotency. See
[conversation research](research/desktop-conversation-continuity.md).

The information panel prioritizes the selected channel's pending approvals, active tasks, recent
results and artifacts. Existing approval and task-inspection actions retain Server authorization.
The Token panel displays measurements supplied by the Server when available. Missing measurements
remain unavailable; recent bounded task/usage data is not an all-time or billed total. See
[inspector research](research/desktop-contextual-inspector.md).

macOS sidebar translucency uses Electron's native sidebar material behind the left navigation;
chat and detail surfaces remain opaque. It can be disabled in Settings. macOS Reduce Transparency
or High Contrast overrides the requested effect, and unsupported or unavailable environments use
an opaque fallback. The current workspace has a light appearance; no complete dark appearance or
Liquid Glass implementation is claimed. See [material research](research/desktop-sidebar-material.md).

## Native menus and shortcuts

The macOS application, File, Edit, View and Window menus use Chinese labels. Standard text editing,
zoom, fullscreen and window actions use Electron's native roles. Navigation commands are enabled
only when their corresponding view action is available.

| Action | macOS shortcut |
| --- | --- |
| Create a channel | Command+N |
| Open Settings | Command+, |
| Back / Forward | Command+[ / Command+] |
| Show or hide the left sidebar | Command+B |
| Show or hide the information panel | Command+Shift+B |

The same view actions remain available in the interface. No global keyboard shortcut, arbitrary
command bridge, Reload menu or Developer Tools menu is added. See
[native menu research](research/desktop-native-navigation-menu.md).

## Settings and local preferences

Open **Owner → Settings**. Settings replaces the workspace across the whole application window;
its own vertical category navigation, search and **Back to app** control replace the channel/Bot
sidebar. Categories are grouped under Application and Workspace:

| Category | Available controls and information |
| --- | --- |
| General | Sidebar translucency, independent panel visibility, comfortable/compact spacing, 14/16 px chat text, reduced motion, send shortcut and 12/24-hour timestamps |
| About OpenBot | Version/platform/runtime information, model-interface choices and Hermes Agent attribution |
| Privacy & Data | Data/credential storage, Server authorization, available usage and reset local interface preferences |
| Model services | Validate and save the Server's **one default model configuration**, replace its key and explicitly enable or disable the native Agent |
| Work computers | Current role and Server address, change role/remote connection, manage devices and inspect local Worker status |
| Automatic tasks | Create and manage persistent schedules through the existing Server API |

Provider presets are choices for the single default configuration, not independently saved
connections or per-Bot model assignments.

Interface preferences are non-secret values saved in this renderer's local profile, not workspace
policy on the Server. They apply immediately and survive reopening when storage is available.
If saving fails, the current choice remains in memory and Settings explains that it was not saved.
Resetting interface defaults does not delete conversations, Bots, schedules or model credentials.
Changing the Server connection clears Desktop session storage and can reset these preferences.
Shift+Enter always inserts a newline, and IME composition does not send a message. System reduced
motion remains effective even when the local reduced-motion switch is off. See
[preference research](research/desktop-workspace-preferences.md).

## Plugins and automatic tasks

Open **Plugins** at the sidebar bottom. It occupies the full application window with **Back to
app**, without the workspace sidebar. The Skills tab lists actual workspace skills with search
and state filters. **Add skill** imports a single `SKILL.md` for a selected Bot into the existing
review process; imported content is not immediately trusted or activated. Open a skill's Bot
profile to review its source, version, full content, declared capabilities and content digest.
The Bots tab provides Bot creation and the existing reviewed Bot-template import flow. Failed
profile reads are shown as unavailable, not empty. This is a workspace extension interface, not
a public marketplace or an installer for arbitrary executable plugin bundles. See
[destination research](research/workspace-destinations.md) and
[UI refresh research](research/desktop-ui-refresh.md).

Above the Skills/Bots tabs, expand the **Plugins** panel and choose **Add tool plugin** to
preview and install an MCP Server connection. Review its declarations, grant selected tools or
content to a Bot, and enable the plugin. Installation alone grants no access; calls remain subject
to Server authorization and the selected approval mode. See [MCP plugins](PLUGINS.md).

Automatic tasks are available from **Owner → Settings → Automatic tasks**.

An authenticated Owner can create an automatic task for a Bot already in a channel, then pause,
resume or delete its schedule. The UI offers elapsed intervals of one hour, 24 hours and seven
days, with a future first-run time entered in the displayed local timezone and stored as a UTC
instant. These are elapsed intervals, not calendar-time promises across daylight-saving changes.
The Server accepts intervals from 15 to 10,080 minutes and a first run within 366 days; there are
at most 50 schedules per Server workspace.

Schedules persist in PostgreSQL and submit a normal channel task through the existing Server
routing, approval and audit path. The Server must keep running; a remote client can be closed.
After downtime, at most one due occurrence is submitted before advancing past the missed
intervals, so there is no backlog replay. An unfinished previous Run skips the next occurrence.
Resuming an expired schedule advances it into the future. At a due check, missing Bot channel membership
pauses its schedule instead of choosing another Bot. Pausing or deleting a schedule stops future
submissions and preserves already-created Runs and history.

A schedule grants no extra permissions. Native inference requires separate [Agent opt-in](NATIVE_AGENT.md);
Worker tasks retain their existing capability/approval requirements. Submission time is not a
guarantee of execution or completion. Older Servers without the automation
API show an unavailable state. This is single-Server operation, not multi-replica dispatch support.
See [recurring-task research](research/server-automations.md).

## Current boundaries

The current public preview is **0.1.0-alpha.9**, with a macOS arm64 DMG and Windows x64 EXE.
Both platforms support a bundled local Server/PostgreSQL or an existing Server connection.
Linux x64 remains a remote-client build target; alpha.9 publishes no Linux installers. These are
unsigned development builds; production signing and macOS notarization remain outstanding.
Windows installation and retained-runtime checks ran on a hosted runner; manual Windows desktop
and SmartScreen acceptance remain outstanding. macOS Intel is outside the installer matrix. See
[installation](DESKTOP_INSTALLATION.md) and [Windows verification](WINDOWS_DESKTOP.md) for
versioned artifacts and distribution boundaries.

The [native Agent](NATIVE_AGENT.md) adds model-generated replies after Owner opt-in. The composer
supports the bounded text/code, image, PDF, Office/OpenDocument and audio/video attachments
described above through authenticated channel attachment routes. Uploading an original does not
automatically extract, OCR or transcribe it. Task submissions are not automatically retried.
Existing native-task stop and explicit resubmission controls retain their Server-owned lifecycle;
resubmission creates a new task and does not promise safe replay of prior side effects.

On macOS and Windows, the bundled Server listens **only on this computer**. Sharing this native
installation with another computer requires a future authenticated HTTPS provisioning flow. Do
not enter its loopback address on another computer. For remote use today, connect to an existing
HTTPS deployment using the advanced instructions below. Closing the macOS window keeps Desktop
running; closing the Windows window quits Desktop. Quitting stops its own Server and database.
Reopening restarts the same data. This is not a login service, backup, database-upgrade or
unattended-recovery implementation.

In builds with the macOS database supervisor, an abrupt Desktop main-process exit closes a private
control pipe. The supervisor shuts down only its own PostgreSQL child; reopening allows up to
15 seconds for that shutdown and reuses the retained data. It does not adopt old unsupervised
databases or stop processes identified by a PID file. Force-killing the supervisor itself is not
covered. This lifecycle change does not establish Windows crash recovery.


Data lives under Desktop's user-data directory in `openbot/local-server`. Bootstrap secrets are
sealed with Electron safeStorage using macOS Keychain or Windows DPAPI; database access uses
private random credentials and SCRAM. Model keys are encrypted by the Server with AES-256-GCM.
No secret is returned by the model summary API. Missing resources, unavailable system credential
storage, unsafe data paths or incompatible existing database state fail visibly; retry does not
delete an existing cluster. Switching to remote-client mode stops local services and retains
their data. Switching back reuses that data.

## Model access

After native installation, select a supported provider preset, its allowed endpoint/region, an
accessible model ID and API key. Presets include OpenAI, Anthropic, Gemini, DeepSeek and Kimi/Moonshot
among the choices shown by the current app. Validation/discovery requests model metadata, not
generation or transcripts. The Server stores one default provider/model configuration, shared by
native Agent tasks; switching the selection replaces that default. Keys can be replaced in
**Owner → Settings → Model services**. Concurrent or stale saves reject instead of overwriting a
newer revision. Skipping postpones setup. Presets do not imply that every listed model is available
to the supplied account, and arbitrary custom proxy URLs are not accepted.

Saving credentials leaves inference disabled unless the Owner checks **Enable native Agent**.
The [native Agent](NATIVE_AGENT.md) then executes new `none`-profile tasks through a bounded
model/tool/observation loop. It sends task/context data to the selected provider and may incur API
charges. Unsupported Worker capabilities remain unavailable.
Remote clients cannot configure older Servers that do not implement the endpoint.

## Build and advanced self-deployment

From the repository root, install locked dependencies, run `npm run check`, then run
`npm run package --workspace @openbot/desktop` on the target OS. macOS and Windows packaging stage the compiled Server,
production dependency closure, PostgreSQL binaries and notices in `native-runtime` before
assembling the application. The generated runtime is ignored by Git. A local development launch
also needs `npm run prepare:native --workspace @openbot/desktop` before `npm start --workspace
@openbot/desktop`. First launch does not download executable code.

For an isolated test app, use `npm run package:preview --workspace @openbot/desktop`, then open
`apps/desktop/out/preview/OpenBot Preview-darwin-arm64/OpenBot Preview.app` on Apple Silicon
(substitute `x64` for an Intel build). Finder, Dock, helpers and the app menu use the Preview
identity and the same OpenBot icon. This command packages without launching or copying to
`/Applications`; `npm start` is the Electron development launcher and is not this packaged app.
Preview uses bundle ID `dev.openbot.desktop.preview`, executable `OpenBot Preview`, and its own
`~/Library/Application Support/OpenBot Preview` profile, including cookies and local Server data.
It does not migrate the installed app's data. Rebuilding retains the Preview profile. Preview
cannot include the production macOS Worker companion because its background identity is shared;
the bundled local Server is included. The normal package target keeps its existing identity.

Advanced users can install Server, PostgreSQL, Web and Worker components separately using the
[root source setup](../README.md#development). These options belong in repository documentation,
not in the initial Desktop role selector. Configure a trusted HTTPS reverse proxy for remote use;
keep database credentials and Owner authentication server-side.

To enable model settings on a separately deployed Server, set both
`OPENBOT_MODEL_SETTINGS_PATH` (an absolute path in a private persistent directory) and
`OPENBOT_MODEL_ENCRYPTION_KEY` (64 lowercase hexadecimal characters representing 32 random bytes).
Keep the encryption key in a secret manager outside the settings file; losing it makes saved keys
unreadable. Omit both to disable the endpoint. Run one Server writer per settings file. The API is
Owner-only `GET`/`POST /api/v1/settings/model`, with the existing mutation-origin checks; POST
requires `provider`, `model`, `apiKey`, and the last `revision` (null for initial configuration).
`agentEnabled` defaults to false. Only Owner opt-in enables inference for newly created tasks.

CI packages Linux x64, Windows x64 and macOS arm64 and retains each successful platform's unsigned
bundle for seven days. Download the commit-named `.tar.gz` from the successful
[CI run](https://github.com/yxflc11/openbot/actions/workflows/ci.yml) while signed in to GitHub.
Extract with `tar -xzf <archive>` to preserve executable modes and internal links. These bundles
are temporary development artifacts, not signed installers, automatic updates or desktop-control
certification. See [handoff research](research/desktop-cross-platform-handoff.md).

macOS uses PostgreSQL 17.10 from the pinned `17.10.0-beta.17` native package. Windows uses the
pinned official PostgreSQL 17.11 source build; the former Windows npm binary package is not
accepted. See [Windows build provenance](research/windows-desktop-completion.md). Production
distribution still requires review of native dependency provenance, redistribution terms,
signing and notarization. Local functionality tests do not substitute for release-support evidence.

Visual checks use isolated fixtures, never seeded data in a real profile. The office scene remains
deferred; this workspace uses channel conversations.


## Local session recovery

The app-owned macOS Server creates and protects its own Owner identity. Desktop now restores that
Server session after expiry, a 401 response, or returning to the app. The password remains in the
main process; no credential is shown to the renderer. Reloading a live local Server also recovers the
session without restarting the database. A failed operation is not automatically replayed.

Explicit logout keeps this window logged out and shows **Re-enter** for local use. This is not an OS
lock: launching the app again can authenticate its own Server. Remote clients and browser login keep
the existing password and session-expiry rules. Recovery cannot target a remote or stopped Server.
See [research and validation](research/desktop-local-session-recovery.md).

The installed application is named **OpenBot**. An existing macOS Preview profile can be reused
without changing its encryption namespace; its internal data-directory name remains unchanged.
An already configured canonical OpenBot profile takes precedence. Only obsolete app bundles and
installer files may be removed during the local update, not the active profile.

macOS may ask for the login Keychain password when the updated application first reads the previous
profile's encryption key. This is a system authorization, separate from the OpenBot Owner login.
The local development build has no stable Developer ID signature, so repeated prompts across
rebuilds are possible. The existing Keychain entry is retained to keep encrypted data readable.

### Advanced search account configuration

The Desktop launcher may explicitly supply `OPENBOT_DESKTOP_TAVILY_API_KEY` to select an optional
Tavily search account for its built-in Server. A generic `TAVILY_API_KEY` from another project or
shell is ignored. Desktop does not read a repository `.env` automatically. This advanced setting
does not change saved model connections or Kimi's supported built-in search. A separately deployed
Server continues to accept its own `TAVILY_API_KEY` configuration.
