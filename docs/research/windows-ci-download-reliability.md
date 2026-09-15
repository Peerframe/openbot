# Research: Electron packaging download reliability

- Status: Accepted for implementation
- Date: 2026-09-15
- Owner: @yxflc11
- Related issue: PR #72; PR #71 CI run 34857235769
- Acceptance journey: a transient Electron release download failure recovers before packaging starts; permanent failures remain visible.
- Security boundary: build-time HTTPS downloads only. Upstream checksum validation, cache handling, TLS verification, packaging and signing remain authoritative.

## Search evidence

Searched GitHub for `repo:electron/get retry`, `FetchDownloader retries` and Packager `downloader downloadOptions`. Reviewed the existing Desktop foundation and installable-delivery entries in `docs/OPEN_SOURCE_REUSE.md`.

Reviewed [Packager 20.3.0](https://github.com/electron/packager/tree/8c5cc941018b1d890c7152734972c44b9b98f268), including `src/download.ts` and its public download option; reviewed [get 5.1.0](https://github.com/electron/get/tree/da84467eacf58f36a8d43de64a09dd2cfe491d3f), including `src/FetchDownloader.ts`, `src/types.ts`, `src/index.ts`, `test/FetchDownloader.spec.ts`, `test/checksums.spec.ts`, release notes and MIT license. These exact releases are already in the lockfile. The public `FetchDownloader` and `HTTPError` exports support the adapter without internal imports. `FetchDownloader` makes one Fetch attempt; its `RequestInit` options support abort signals but no built-in retry option.

Reviewed closed [get issue #205](https://github.com/electron/get/issues/205): Windows parallel cache mutation can fail independently of HTTP. This repair must not retry filesystem/cache errors or run concurrent downloads as a workaround. The PR #71 log instead reports HTTP 504 from the release asset endpoint.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing Packager and get public Downloader API | Packager 20.3.0 / `8c5cc941018b1d890c7152734972c44b9b98f268`; get 5.1.0 / `da84467eacf58f36a8d43de64a09dd2cfe491d3f` | BSD-2-Clause; MIT | Released packages; Fetch and checksum tests inspected | Supports all packaging hosts, signals and custom downloader; checksum validation follows successful download | Select released fetch implementation with thin bounded retry adapter |
| Existing get built-in download options alone | get 5.1.0 | MIT | Same reviewed source | Supports timeout signals but does not retry a 504 | Insufficient alone |
| Retry the complete packaging command | Existing Packager 20.3.0 | BSD-2-Clause | Existing packaging tests | Repeats filesystem, hooks and potentially signing operations | Reject; retry only download |

## Reuse decision

Use `FetchDownloader` for all network and file streaming and the documented Packager `download.downloader` extension. Declare existing locked get 5.1.0 as a direct development dependency because OpenBot now imports its public API. There is no new dependency tree or copied downloader.

The local gap is a maximum of three attempts, one five-minute timeout per attempt, short backoff and a maximum 30-second accepted Retry-After. Retry only specific transient HTTP statuses and transport codes. Do not retry permanent HTTP, certificate, filesystem or checksum failures, or caller cancellation. Abort and dispose failed HTTP response bodies before retrying. Preserve preview checksums/cache configuration. Upstream still verifies each artifact before accepting it. If get gains equivalent bounded retry, remove this adapter after the same regression suite passes.

## Source incorporation

No source copied or substantially adapted. Calls use public released APIs. Existing package license notices remain applicable; no runtime dependency or distributable content added.

## Verification plan

Exercise the real released FetchDownloader and downloadArtifact with synthetic Fetch responses and temporary files: 504 then success with valid checksum; permanent 404; repeated 504 cap; transient connection error; invalid checksum; caller abort; bounded timeout; partial transfer replacement; Retry-After cap. Run Desktop focused tests and repository checks. Native Windows packaging remains a CI acceptance gate; local tests do not claim Windows installer success.

## Unresolved questions

GitHub release service availability cannot be guaranteed. The adapter bounds recovery and fails visibly after exhaustion.
