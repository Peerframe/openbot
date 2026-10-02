# C15: route callers after standalone page retirement

[简体中文](C15-route-caller-inventory.zh-CN.md)

Baseline `cbf1700bf596f8f06f202005123e6d92cf7d59a1`, inspected 2026-10-03. Read-only inventory;
**no route, service, DTO or Web code is removed**. The Owner confirms removal before implementation.

The standalone navigation entry disappeared; the underlying settings flows still call the APIs.
`AutomationsScreen` is still mounted inside Settings → routines. `SkillLibraryScreen` is absent,
but Settings → skills mounts the import/review flows. No automation endpoint became unused.

| Service-computer endpoint | Actual current caller chain | Disposition |
| --- | --- | --- |
| GET `/api/v1/automations` | `DesktopSettingsScreen` routines → `SettingsAutomations` → `AutomationsScreen` → `destination-api.listAutomations` | Keep |
| POST `/api/v1/automations` | Same settings flow → `createAutomation` | Keep |
| PATCH `/api/v1/automations/:id` | Same settings flow → `setAutomationEnabled` | Keep |
| DELETE `/api/v1/automations/:id` | Same settings flow → `deleteAutomation` | Keep |
| GET `/api/v1/bots/:id/profile` | `SettingsSkills` → `useEmployeeProfiles` / `getEmployeeProfile`; Bot profile and composer also read it | Keep |
| POST `/api/v1/bots/:id/skills/import` | `SettingsSkills` install → `EmployeeSkillImport` → `api.importEmployeeSkill`; profile import also uses it | Keep |
| POST `/api/v1/bots/:id/skills/:skillId/state` | `SettingsSkills` review → `EmployeeSkillReview` → `api.updateEmployeeSkillState`; profile review also uses it | Keep |
| POST `/api/v1/bots/:id/skills` | No current product HTTP client found; direct candidate-metadata creation remains documented and tested | **Only removal candidate for confirmation** |

The last endpoint is a currently unused *public route*, not an unused service implementation.
`EmployeeKnowledgeService.import_skill` internally calls `create_skill`; removing the method would
break the still-used import route. Retain that method and its creation/review logic if the Owner
later approves deleting the HTTP route. This absence is not established as a consequence of page
retirement: the current UI already installs by `/skills/import`, not manual metadata registration.
No independent global GET `/skills` or special standalone-page route exists to remove.

## Evidence and bounded search

- Route owners: `product_control.py` lines registering automations, bot profile and skill writes;
  `employee_knowledge.py` `create_skill` / `import_skill`.
- Consumers inspected: `DesktopSettingsScreen.tsx` (routines/skills), `SettingsSections.tsx`
  (`SettingsAutomations`), `AutomationsScreen.tsx`, `destination-api.ts`, `SettingsSkills.tsx`,
  `EmployeeSkillImport.tsx`, `EmployeeSkillReview.tsx`, `api.ts`, `use-employee-profiles.ts`.
- Repository search: product source in `apps`, `packages`, `providers`, `plugins`, `scripts`,
  excluding generated output, test files and environments, for `createEmployeeSkill`, `createSkill`,
  `/skills`, `/automations`, and all corresponding client function names. Protocol schemas and
  frozen-oracle verification are not active product HTTP callers. No production access log claim.
- Existing tests: `AutomationsScreen.test.tsx`, `SettingsDataSections.test.tsx`,
  `EmployeeSkillReview.test.tsx`, `test_automation_store.py`, `test_employee_knowledge.py`,
  `test_product_control.py` document retained flows. Inspected, not newly executed for this inventory.
- Contract: `docs/API.md` documents candidate metadata creation and import/review. No contract
  change occurs in this PR; if removal is approved, update both API documents in that implementation.

## Current handoff

Worktree `/private/tmp/openbot-c15-inventory`, branch `codex/c15-route-caller-inventory`.
Confirmation requested: delete only **POST `/api/v1/bots/:botId/skills`**, or keep its public
manual-candidate creation capability. All other listed routes have live consumers and stay.
No deletion without the Owner's answer; no auto-merge. `npm run docs:check`: 12 tests passed, 564 Markdown files. `npm run research:check`: 27 local
tests passed; hosted PR body gate pending. `git diff --check` passed. PR: [#160](https://github.com/Peerframe/openbot/pull/160).
Hosted [validate passed](https://github.com/Peerframe/openbot/actions/runs/37040623556/job/110949649742)
on `cb507da`; this handoff-only update reuses the same inventory evidence.
