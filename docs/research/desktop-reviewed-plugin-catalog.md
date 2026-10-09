# Research: reviewed plugin catalog source (C8)

- Date: 2026-10-01
- Decision: explicit source-review records in a bundled catalog; optionally a private operator catalog.

Reuse the existing bounded Python plugin DTOs, Owner transactions and MCP install/manifest/grant
flow recorded in the Python plugin decision and
the starter review. Compared the public MCP Registry, a dynamic
remote feed, and explicit locally reviewed records. The Registry proves publication metadata, not
OpenBot security review; a remote feed adds a new mutable authority. Choose a bounded versioned
catalog shipped with source, or an explicitly configured owner-private operator file. Only records
marked reviewed with exact source/review metadata enter the response. Corrupt/unreviewed sources
fail closed; requests cannot select a path/feed or trigger remote discovery. No new dependency.

GitHub/official searches: `MCP registry security review metadata`, `OpenAI documentation MCP`.
[OpenAI's official docs](https://developers.openai.com/learn/docs-mcp) identify a public documentation
server. An initialize/list-only review through the actual retained DNS-pinned client failed because
this environment resolves the endpoint to non-public addresses. Preserve that refusal. The remote
server is excluded; neither its live declaration nor a successful OpenBot install is claimed.

## Included reviewed entry: OpenBot notebook developer template

Review source at OpenBot main `57341154b19d45686b2f71bce96fca38e1f07310`,
`packages/mcp-example/src/plugin-example.ts`, `plugin-example-view.ts`, `package.json`, LICENSE
and SOURCE.json. The original extraction provenance is retained in SOURCE.json; this catalog pins
the actual current source tree, not the old dirty snapshot. The sample is MIT, MCP SDK1.30.0 and
Zod4.6.2. Actual server identity is `openbot-example@1.0.0`; the package's `0.0.0` is not a deployed
service version. Tools: bounded sum_numbers (read) and append_note (in-memory mutation, up to100
notes, requires per-call Owner approval); resources: notes and isolated offline HTML; prompt:
review_note. Content remains untrusted. The renderer App has no network/device or host-tool access.

Source review covers bounded loopback HTTP, exact Origin, JSON byte cap, schemas, process lifecycle,
in-memory retention, annotations versus Server authority, and existing real MCP integration/grant/
approval tests. Existing starter tests copy only the reviewed template and license, pin dependencies,
and refuse overwrite. This is a development template requiring separate deployment/endpoint setup;
it is not a hosted third-party service or a one-click install. Catalog metadata never installs, grants
or bypasses live manifest review. The included record carries file SHA-256s and the exact source commit.
No upstream code is copied or substantially adapted in this change.

### Re-review 2026-10-07: MCP SDK 1.32.1

Catalog revision 2 binds OpenBot commit `fa34622926600c42433058aa1129f888c41871f9`. The only reviewed
file that changed is `packages/mcp-example/package.json`: its exact `@modelcontextprotocol/sdk` pin
moved from 1.30.0 to 1.32.1 for GHSA-6qxp-vccf-f47h (the OAuth client did not bind stored credentials
to their issuer). The template does not use the SDK's OAuth client. The other four files and their
SHA-256s are unchanged; tools, resources, prompts, bounds and grants are as reviewed above. The 1.x
changes from 1.30.0 to 1.32.1 are fixes and opt-in options (see the MCP entry in
`docs/OPEN_SOURCE_REUSE.md`).
