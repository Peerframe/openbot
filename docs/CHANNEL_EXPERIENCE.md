# Desktop alpha.5 channel experience

The channel conversation has been rebuilt after inspecting the installed Grok Bot 0.47.0 application. The pre-implementation change list covered message geometry, the composer, reply controls, collaboration activity, attachments, and conversation continuity. OpenBot keeps its own avatars, navigation and authorization model.

## What changes

| Part | Observable behavior |
| --- | --- |
| Transcript | Compact gray Bot bubbles and black human bubbles; sender labels at group starts; avatars at the last bubble's lower edge; time separators after a five-minute gap. The channel toolbar is 44 px high. |
| Composer | A 44 px minimum-height composer grows with text. Attachment and send controls sit at opposite ends. Multiple recipient chips coexist; a channel message can omit a recipient. |
| Recipients | One message can explicitly address up to six distinct current channel Bots. The Server validates the complete recipient set in one transaction and creates one source message with a Run for each recipient. Everyone expands to exact current member IDs and refuses a group over six rather than silently truncating it. |
| Reply | Replying to a current Bot selects it as recipient. A quoted message can be brought into view. The model receives a bounded explicit referenced-message context, including references outside the usual recent-message window. |
| Message actions | Reply, copy and task details are hidden by default at every width. Hovering or focusing a message reveals its controls; touch users can tap the message to focus it. |
| Work | Actual running, queued, failed and cancelled states appear inside the conversation. Queued follow-ups show that they are waiting to continue. After a newer request completes, older failures and cancellations remain in message details instead of current activity. Delegation retains sender/recipient identity and inspectable task relationships. |
| Attachments | Picker, file drop and pasted files/screenshots share the same bounded authenticated upload path. Drafts and sent messages show file cards; PNG/JPEG can be enlarged and closed with Escape. Internal attachment markers are hidden from normal message presentation. |
| Continuity | A queued task can read earlier tasks' replies completed before it begins; later independent human requests do not leak into its input. The Server supplies context before the first model call. |

## Execution boundaries

- New messages submitted during work remain independent queued tasks. This release does **not** implement in-flight steering, token streaming or unrestricted asynchronous Bot-to-Bot messaging. The existing delegation limits and cancellation tree remain in force.
- Default channel routing reuses the Server's coordinator/first-member policy; it is not a simulated consensus among all Bots.
- No new voice-input, reaction, member-removal or scheduled-routine capability is claimed by the channel visual work. Existing product tools and approvals remain available through their actual controls.
- Attachments retain the current format and size limits (eight files / 20 MiB per task). Sent-file cards do not claim a new native original-file download feature; generated artifacts retain their existing download path.
- OpenBot artwork and its existing surrounding navigation intentionally differ from the reference. Visual verification must report viewport-specific measurements and remaining differences, rather than claiming unmeasured pixel identity across the whole application.

## Evidence and implementation

- [Native reference and reuse research](research/channel-native-reference.md)
- [Routing and context research](research/channel-context-routing.md)
- [Attachment presentation research](research/channel-attachment-presentation.md)
- Meaningful component tests cover multiple recipients, default routing, keyboard selection, reply targeting/navigation, grouping, activity states, drag/drop/paste and preview lifecycle.
- A disposable PostgreSQL integration suite covers atomic multi-recipient creation, independent identity, queued context, explicit old references, cancellation and authority boundaries.
- Reference observation used existing conversations and reversible unsent drafts; no reference-service message, file upload or publication was sent. Exportable preview data is synthetic.

Bot delegation, persistent files and MCP tools from the earlier core upgrade remain in place. See the [plugin author guide](PLUGINS.md) for extension contracts.

## Rendered acceptance, 2026-09-10

- Production channel components with synthetic data: 1040 x 760 desktop and 390 px narrow layouts. Measured header and empty composer heights: 44 px; no horizontal overflow. Default visible message-action groups: zero at both widths.
- Browser interactions: selected two recipients and submitted one message yielding two tasks; replied to Nova and checked its exact recipient chip; clicked a quote and verified focus on the original message; opened a PNG preview, closed with Escape and verified focus restoration; cancelled a queued task and observed its cancelled state. Browser error/warning log was empty.
- Picker/drop/paste upload failures and permissions are covered by component and Server tests. The rendered attachment preview used a seeded synthetic record; no claim of a manual file-upload acceptance through the native file chooser is made.
- Native app acceptance uses the installed app and retained local data. The renderer, its real toolbar and channel navigation are checked separately from the synthetic browser fixture. Reference paid model execution and live asynchronous delegation remain untested.

## Run progress and computer preview

The run progress panel in task details shows only Server-owned Run, progress, and collaboration records. Computer preview renders only when a real execution frame exists; otherwise it shows a short empty state.
