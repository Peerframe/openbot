# Provider conformance

OpenBot publishes executable checks before it describes a platform or Provider as supported. The
design adapts stable check ids and explicit expected-failure baselines from
[MCP Conformance `74edef34`](https://github.com/modelcontextprotocol/conformance/tree/74edef34d674f563537be8c6587cebaa58e830ca),
target metadata and reproducible evidence from
[Kubernetes Conformance `6fc6e660`](https://github.com/cncf/k8s-conformance/tree/6fc6e66092075b7443c9259629b607c15b7876b9),
and explicit OS/architecture
scoping from the [OCI runtime specification `6999a89a`](https://github.com/opencontainers/runtime-spec/tree/6999a89a76a0329f440d5740497bedb9dd431297).
The checks and JSON schema are OpenBot-specific; no upstream implementation code is copied.

## What is checked today

Protocol `0.9.0` carries both temporary legacy capability aliases and an authoritative versioned
manifest. Every Run offer contains exact capability-major requirements. Server routing and the
Worker Host independently verify the same requirements.

- A matching legacy alias cannot replace a missing versioned capability.
- `browser.observe@2` cannot silently satisfy a Run requiring `browser.observe@1`.
- A platform-specific profile cannot run on a different operating system.
- A full-capacity Worker Host cannot receive another Run.
- Declaration-only Providers are never advertised as executable.
- Provider declarations fail startup validation when ids, platforms, or capability ownership are
  internally inconsistent.
- `buildProviderConformanceReport` emits a strict, bounded JSON artifact tied to the Provider,
  protocol, suite, platform, architecture, OS version, and evidence level.
- `@openbot/provider-conformance-runner` executes stable scenarios in deterministic order with
  setup/run deadlines, abort signals, bounded cleanup, allowlisted outcomes, and baseline-derived
  process status.
- A required prerequisite must fail; it cannot be hidden as skipped. A tracked expected failure
  stays failed and never grants a support label.

The current scenario matrix covers Linux x64 browser execution, Linux arm64 coding, Windows x64
browser execution, macOS arm64 browser execution, macOS arm64 Cua declarations, platform mismatch,
missing manifests, incompatible capability majors, and capacity exhaustion. These are simulated
contract fixtures; they are not a claim that every native Provider is implemented.

## Conformance stages

| Stage | Meaning | Required evidence |
| --- | --- | --- |
| Declaration | Static metadata is well formed | `inspectProviderDeclaration` passes |
| Routed | Server and Node accept only the declared platform and exact capability majors | Shared protocol and routing scenarios pass |
| Integrated | The Provider completes bounded hermetic tasks and emits valid progress, frames, approvals, and artifacts | Provider integration suite passes |
| Real device | The same scenarios run on a named OS version and architecture | `real-device` report with reproducible external evidence |
| Supported | Maintainers approve a pinned Provider release and publish known limitations | Reviewed real-device matrix and security evidence |
| Certified | A pinned release passes the full matrix with signed packages, upgrade/rollback checks, and no unapproved failures | Independent release review and attached reports |

`experimental`, `supported`, and `certified` are release support labels. Passing declaration or
routing tests alone never grants one of those labels.

## Current honest status

| Provider | Declaration | Routed | Integrated | Support claim |
| --- | --- | --- | --- | --- |
| Docker/browser adapter | Passes | Simulated Windows/macOS/Linux routes pass | Navigate + PNG and opt-in reviewed single-button click on trusted test origins | Pre-alpha development slice |
| Cua | Passes | macOS declaration scenario passes | Not implemented in this repository | None |
| Lume | Passes | Requirements are defined | Not implemented in this repository | None |
| Coder | Passes | Simulated Linux arm64 route passes | Not implemented in this repository | None |

## Machine-readable report

`@openbot/protocol` owns `openbot.provider-conformance/v1`, `@openbot/provider-sdk` owns the builder
and deterministic serializer, and `@openbot/provider-conformance-runner` owns scenario
orchestration and exclusive evidence-file creation. The report deliberately contains no
`supported` or `certified` field: evidence is machine-readable, while release labels remain a
maintainer review.

```ts
const report = buildProviderConformanceReport({
  provider,
  providerVersion: "0.1.0",
  stage: "integration",
  suiteVersion: "1.0.0",
  target: {
    platform: "linux",
    architecture: "x64",
    osVersion: "6.8.0",
    evidenceLevel: "hermetic",
  },
  checks: scenarioChecks,
});
```

Each check has a stable id, severity, status, timestamp, bounded references, and bounded evidence.
Raw logs are excluded because they can contain credentials or private content. Summary counts,
baseline findings, and conformance are recomputed by the strict schema so editing JSON cannot turn
a failed check into a passing report.

A `real-device` target must additionally name `workerHostVersion`, `hardwareModel`, and an opaque
`hardwareEvidenceId`. The id references controlled inventory or evidence; it must not be a serial
number, UDID, credential, or other raw device identifier.

Expected failures require a tracking issue and expiry. A matching unexpired entry makes the CI
baseline current, but the check remains failed and `summary.conformant` remains `false`. An
unexpected failure, expired entry, missing check, or now-passing check makes the baseline stale.

## Run a scenario module

A scenario module exports one typed `suite`. Scenario outcomes contain only an allowlisted status
and stable code; arbitrary Provider output and thrown values are never copied into the public
report.

```ts
export const suite = {
  name: "openbot-provider",
  version: "1.0.0",
  stage: "integration",
  provider,
  providerVersion: "0.1.0",
  target: {
    platform: "linux",
    architecture: "x64",
    osVersion: "6.8.0",
    evidenceLevel: "hermetic",
  },
  scenarios: [navigateAndCapture],
} satisfies ProviderConformanceSuite;
```

Build the runner, then write a new report path. The command refuses to replace existing evidence.

```bash
npm run build --workspace @openbot/provider-conformance-runner
node packages/provider-conformance-runner/dist/cli.js \
  --module ./path/to/provider-suite.mjs \
  --output ./provider-conformance-report.json
```

Exit `0` means the expected-failure baseline is current, not that every required check passed. Exit
`1` means an unexpected or stale failure; exit `2` means the harness or evidence write failed.
Inspect `summary.conformant` separately.

Provider and scenario modules are executable, untrusted code. Run the command in a dedicated,
disposable process and OS account with no Owner browser profile or unrelated credentials. Deadlines
send abort signals and bound runner progress, but this package is not a native-code sandbox.

## Run the repository tests

```bash
npm run test --workspace @openbot/protocol
npm run test --workspace @openbot/provider-sdk
npm run test --workspace @openbot/provider-conformance-runner
npm run test --workspace @openbot/node
npm run test --workspace @openbot/server
```

The full repository gate remains:

```bash
npm run check
```

## Adding a Provider

1. Research an existing maintained implementation and record its pinned version and license in
   [Open-source reuse](OPEN_SOURCE_REUSE.md).
2. Implement a narrow `ComputerProvider`; do not import identity, policy, or routing from the
   upstream project.
3. Declare only platforms that the adapter can actually execute on. Keep unfinished packages
   declaration-only by omitting `execute`.
4. Add positive and negative fixtures for platform, architecture where relevant, exact capability
   majors, capacity, reconnect, and fail-closed behavior.
5. Add hermetic integration tests, then real-device evidence before requesting a support label.
6. Export a typed `ProviderConformanceSuite`, run it outside the Server process, validate the output
   with `providerConformanceReportSchema`, and publish the deterministic JSON as CI evidence.
7. Document optional licenses, privileged dependencies, and expected failures. An expected failure
   is visible debt, never silent success.

The schema, builder, and standalone runner exist today and have hermetic negative fixtures. The next
gap is to author Provider-specific scenario modules and execute them on controlled real Windows,
macOS, and Linux devices. No real-device support claim exists until those reports are observed and
reviewed.

## Reviewed browser-click evidence

The [controlled browser flow](CONTROLLED_BROWSER.md) was exercised on macOS arm64 with actual
Server/PostgreSQL, enrolled Worker, pinned upstream agent-computer and its Chromium, using a local
fixture. Rejection preserved the page; approval clicked the named button once and returned a PNG.
Repeated navigation covers frame-qualified references. Web UI passed at 1280x900 and 390x844.
The QA upstream bind-address patch is disclosed in [research](research/controlled-browser-click.md).
This is experimental integration evidence, not native desktop input or Windows/Linux browser
certification. Browser-side egress and general untrusted-site operation remain unimplemented.
