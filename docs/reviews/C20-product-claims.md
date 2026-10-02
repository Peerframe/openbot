# C20: user-visible browser and attachment claims

[简体中文](C20-product-claims.zh-CN.md)

Audit baseline: `cbf1700bf596f8f06f202005123e6d92cf7d59a1` (2026-10-03). No Web or runtime
changes. The Owner will revise UI copy; suggested Chinese copy below is ready to use.

| Current claim | Verdict and scope | Correct copy |
| --- | --- | --- |
| 画面只在内存里保留 | Valid for this window's live frames in OpenBot's viewer path. Not a blanket claim about all browser screenshots: explicit task screenshots may be persisted as artifacts. | 这个窗口的实时画面不保存为文件；任务产生的截图可能保存为产出。 |
| 登录状态留在工作电脑 | Valid for the supported per-Bot persistent browser profile on the original working host. Clearing browser data removes it; replacement/re-enrollment does not migrate it. | 登录状态保存在运行浏览器的工作电脑；清除浏览数据会移除登录状态。 |
| 关闭窗口会暂停控制 | Valid where currently shown, after this viewer has taken control (`mine`). Closing an observation-only view does not pause a running Bot; closing someone else's view cannot release their control. Explicit release is required to resume; disconnect/expiry must not auto-release. | 接管后关闭窗口，Bot 会保持暂停；重新打开并点「交还 Bot」后才会继续。 |
| 移到回收站的文件不再发给 Bot | New reference admission and later attachment/media reads refuse deleted files. It does not revoke already sent model input or retained text from an earlier attempt. Owner history download remains available. | 移到回收站后，Bot 不能再读取或新引用这个文件；已发送的内容无法撤回。 |
| 清理只删除进回收站满 7 天、且没有消息或任务还在引用的文件 | **Not implemented.** The UI calls an unregistered POST `/api/v1/channels/:id/attachments/cleanup`. There is no seven-day recycle-bin collector or reference-aware permanent-file cleanup. Deleting an entire channel/Bot is a different authorized lifecycle and purges the channel's files without this age rule. | 移入回收站后可恢复；永久清理暂未提供。 |
| 会把这段音频发给已配置的 OpenAI；原文件留在服务电脑 | Valid only on explicit transcribe using the currently enabled OpenAI setting, a nonempty key and the official endpoint. A merely saved model connection is insufficient. No generic custom-compatible endpoint or implicit fallback. Original bytes persist; derived transcript is also stored locally. | 转写会使用当前启用的 OpenAI 配置，将这段音频发送到 OpenAI 官方服务；原文件保留在服务电脑。 |

## Code and existing test evidence

- Live viewer: `browser_sessions.py` `command` validates and returns frames; `_event` writes only
  command identity/kind/outcome, no frame/text. `providers/docker/src/browser.ts` `command` buffers
  a validated screenshot without file output; `EmployeeBrowser.tsx` stores only component state.
  `providers/docker/src/index.ts` `screenshotArtifact` is the distinct task screenshot path.
  Existing `test_browser_sessions.py`: `test_release_commit_failure_keeps_durable_pause_and_withholds_frame`,
  `test_serialization_disconnect_and_bad_frame_remain_uncertain`,
  `test_live_response_authority_identity_and_disconnect`. These are synthetic HTTP/WS tests,
  not a disk-forensics or actual native browser test.
- Login persistence: pinned agent-computer `profiles.ts` `createProfiles` calls
  `chromium.launchPersistentContext(directoryFor(botId), ...)`. Reviewed
  [source at 257c128](https://github.com/CopilotKit/openbot/blob/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer/src/profiles.ts).
  OpenBot original-host enforcement: `browser_sessions.py` `_host_identity` and
  `test_durable_profile_binding_survives_restart_and_refuses_reenrollment`;
  `test_maintenance_requires_original_identity_capability_and_exact_clear_confirmation`.
  Hosted actual browser/profile recovery:
  [job 110915830971](https://github.com/Peerframe/openbot/actions/runs/37030141750/job/110915830971),
  including `browser-restart` recovery; the synthetic cookie/profile fixture is not a real login.
- Closing: `browser_sessions.py` `close` updates `paused=True` only for the matching control
  session; `BrowserCoordinator.run` refuses an expired latch until explicit take/release.
  `EmployeeBrowser.tsx` shows the promise only when `mine` and cleanup invokes close, never release.
  Existing UI test `clears typed input before dispatch, never retries uncertainty, and only closes the view` and Server `test_real_enrollment_view_exclusive_control_input_release_and_restart_pause` cover
  the distinction. Provider `browser.test.ts` covers expired lease and explicit release.
- Recycle bin: `owner_files.py` `_validate_references`, `work_product_attachment_reads.py`
  `read_attachment`, `work_product_media.py` `_manifest`, `attachment_processing.py` `_snapshot`
  refuse deleted objects. Existing `test_product_control.py` checks retained deleted-channel
  attachment downloads, and `test_work_product_media.py` has deletion-before-hydration/provider
  cases. This audit inspected those cases; the optional media Worker suite is not rerun here.
- Cleanup: `product_attachment_routes.py` registers list/upload/metadata/content/delete/restore/
  process only. `AttachmentsManager.tsx` `cleanup` calls the missing route. `OwnerFiles.purge_channel`
  and `OwnerProduct.purge_deleted_channel_files` require the entire channel tombstone, not seven days.
  `test_identity_lifecycle.py` covers the different deletion path.
- Transcription: `AttachmentProcessingService.process`, `_audio_settings`, `_transcribe`, `_save`;
  `ModelSettingsService.active`. Test
  `test_transcription_official_sdk_only_on_explicit_enabled_action_and_bounded_result` asserts one
  MockTransport request to `https://api.openai.com/v1/audio/transcriptions`, `whisper-1`, and no
  transfer on disabled/non-OpenAI/custom-endpoint settings. Revoked-Owner and cancellation tests
  refuse transfer; original bytes and scoped derived output are preserved.

## Current handoff and validation

Worktree `/private/tmp/openbot-c20-claims`, branch `codex/c20-product-claims`. Two existing modules,
`test_browser_sessions.py` and `test_attachment_processing.py`, passed **51 tests, zero skips**
against a new owned PostgreSQL17.11 Docker fixture, actual loopback HTTP/WS and fake transcription
transport. Initial audit harness lacked the unrelated-channel field and Node module resolution;
2 fixture failures were corrected and the full 51 reran. No production data, paid model or real
credentials. Previous hosted browser links are reused evidence, not a new hosted execution.
No API behavior changes; bilingual API notes explain the actual limits. PR: [#159](https://github.com/Peerframe/openbot/pull/159); hosted [validate passed](https://github.com/Peerframe/openbot/actions/runs/37040157029/job/110948189456)
on `29eb5c1`. This evidence-only update reuses the unchanged executed test evidence.
No auto-merge; C9/C11 and the missing cleanup implementation remain outside this task.
