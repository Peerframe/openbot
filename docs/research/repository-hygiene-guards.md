# Research: repository hygiene guards

- Status: Accepted (Owner, 2026-10-10)
- Problem: by October 2026 the repository held 601 Markdown files (about 64,000 lines). Of these:
  - 124 research records had nothing but an index pointing at them;
  - dated plans and status logs sat at the top of `docs/`;
  - 127 translations were drifting from their English sources;
  - the root rules said the control plane was Python after TypeScript had taken over;
  - most source files did not say what they were for.

  The cleanup (#213, #214, #215, #217, #218) removed about 33,000 lines. This record decides how to
  stop the same drift from coming back.

## Evidence

- **OpenAI, "Harness engineering"** (February 2026). An agent-written codebase stays coherent when:
  - `AGENTS.md` is a map rather than an encyclopedia;
  - architecture and taste rules are enforced mechanically by custom linters and structural tests;
  - recurring garbage-collection passes remove drift instead of relying on people to notice.
- **Anthropic, Claude Code best practices.** Keep `CLAUDE.md` short, and cut any line whose
  removal would not cause mistakes. Bloated instruction files make agents ignore the rules that
  matter. Situational knowledge belongs in skills, which load on demand.
- **Tools considered.**

  | Tool | What it does | Decision |
  | --- | --- | --- |
  | knip | Unused files, exports and dependencies in TS monorepos (MIT) | Adopt after P5. Today the Python/TS coexistence would produce mostly false findings. |
  | dependency-cruiser | Enforces layering rules between modules | Adopt with the P5 Server layering refactor. There are no layers to protect yet. |
  | jscpd | Duplicate-code detection | Deferred. Ratchets on the specific duplications (pools, session checks) are more precise. |
  | lychee / markdown-link-check | Link checking | Not needed. `check-docs.ts` already validates every local link. |

  None of these detects research records that nothing uses, dated plans, translations outside the
  kept set, or source files without an opening comment.

## Decision

Add `scripts/check-hygiene.ts` to `npm run docs:check`, which CI runs on every pull request. It
uses no new dependency, and every failure message says how to fix it. It enforces:

1. Chinese translations only for the set named in `AGENTS.md`.
2. No plan, roadmap, status, worklog, handoff or cleanup documents at the top of `docs/`.
3. Every research record is named by something other than an index.
4. Paths written in backticks in living docs exist (ADRs and research records are dated evidence
   and are exempt; so are the Python directories that P5 deletes).
5. Nested `AGENTS.md` files stay within 60 lines. The root map keeps its 90-line budget in
   `check-developer-entrypoints.ts`.
6. Every `experiments/*` directory is still run by code, scripts, `package.json` or CI.
7. Source files open with a comment saying what they are for.

Rules 5 and 7 start from a recorded baseline in `scripts/hygiene-baseline.json` that may only go
down; the check asks for the baseline to be lowered as soon as files improve.

Code-structure ratchets for the TS Server (a single connection pool, one session check, no
swallowed errors, logging on) belong with the P5 refactor in `apps/server-ts`, as structural tests
next to the code they protect.

## Source incorporation

Source copied or substantially adapted: no.
