# Generic bounded JSON transport — 2026-09-25

Reuse decision: retain Node22.23.2 released `net.Socket`, `stream.Duplex`, Buffer and fatal
TextDecoder APIs. Existing WebSocket framing cannot frame the protected Unix byte stream; no
additional transport framework, reconnect client or authority layer is needed. The local gap is
only the frozen four-byte length header and finite serial input/output accounting. The existing
Node release/platform/license review in OPEN_SOURCE_REUSE is retained. Primary APIs reviewed:
[net](https://nodejs.org/download/release/v22.23.2/docs/api/net.html),
[stream](https://nodejs.org/download/release/v22.23.2/docs/api/stream.html),
[TextDecoder](https://nodejs.org/download/release/v22.23.2/docs/api/util.html#class-utiltextdecoder).

The Owner requested dsh for development. It implemented this generic module and tests in an
isolated workspace using only public documentation and a synthetic interface specification;
no repository or user data was provided. Root ran its first40 checks, identified concrete
write-error/property/queue boundaries, and dsh implemented the second pass. Root then ran52
checks. Dsh could not execute its own tests because its nested command sandbox was unavailable;
those failed starts are not credited as tests. No third-party source was copied or substantially
adapted; the new adapter uses Node built-ins and carries the repository MIT license.

Root integration preserves ESM in one explicit `.mjs` source, compiled/copied by the existing
TypeScript build with a narrow include. It introduces no dependency or packaging copy script.
Root additionally retains the active write until both its callback and required drain complete,
and adds real disposable Unix-socket tests. Delivery is never permission or business completion.
The consumer supplies one connected owned socket and controls path/authentication separately.
The raw Host independently uses strict JSON and signed operation checks; this generic parser
intentionally does not reject duplicate JSON members and cannot replace authority verification.

Both directions are bounded to four retained frames and65536 bytes; outbound counts headers and
active writes. Payloads are1..32768 bytes, input decoding is fatal UTF8/BOM/object checked, and
outbound trees are bounded at4096 values/depth12 without accessors/toJSON/coercion. Partial input,
blocked callback/write, asynchronous destruction and Abort all retain finite failure semantics.
No path discovery, network connection, reconnect/retry, execution or proof verification is added.

Integrated evidence:53 Node tests passed, including the actual disposable Unix-socket roundtrip;
Node typecheck/build and the focused Biome check passed. Negative tests intentionally construct
thenables and sparse arrays; their narrow lint suppressions preserve the boundary checks.

The installation adapter uses the same reviewed Node net.Socket API to connect once to a fixed
absolute Unix path supplied by trusted installation composition, then attaches this transport.
It adds a five-second connect deadline and Abort cleanup, no discovery, environment lookup,
TCP alternative or reconnection. The path is not supplied by Worker/model frames. This adapter
is unprivileged and does not prove root ownership or peer identity: the protected Host separately
checks Linux SO_PEERCRED, and Control/Host retain all pinned signature/identity checks. It remains
an optional constructor injection, not a default installer or new public command.

## Hosted Windows test endpoint — 2026-09-25

PR96 run36155987717 passed the52 synthetic transport cases but failed the real IPC fixture at
`server.listen`: a temporary filesystem pathname is a Unix-domain endpoint, not a Windows pipe
name. The transport itself receives a connected Duplex and selects no endpoint. Reviewed Node's
[exact CI release IPC documentation](https://raw.githubusercontent.com/nodejs/node/v22.22.2/doc/api/net.md):
Windows requires its local named-pipe namespace; Unix uses a filesystem path. Reuse that built-in
API, not another transport library or a test skip. No dependency or upstream source copy is added.

Change only the fixture endpoint: keep the same owned random-directory suffix, Unix path on
Unix, and local named pipe on Windows. Preserve real byte framing, backpressure, Unicode, cleanup
and the five-second test bound on every platform. Existing53 cases still execute. This neither
adds a product Windows command installation nor changes the Linux Host's peer-credential gate.
Local Unix execution and hosted Windows execution remain distinct evidence.

All53 transport cases passed locally after the fixture correction, including real Unix IPC.
The Windows named-pipe branch still requires the next native Windows CI run.
