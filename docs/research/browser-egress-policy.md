# Browser egress policy compiler and runtime qualification

Design checkpoint2026-09-26; follows the selected components and network boundary in
[Linux execution research](linux-execution-boundary.md). The proxy component is now qualified
within the actual fixture below; the product browser remains restricted to trusted fixture origins.

## Reuse and evidence

Use the already selected Squid7.7 release at
[`173863d3ec547d7fc5227ddbb5d8093c88b4842f`](https://github.com/squid-cache/squid/tree/173863d3ec547d7fc5227ddbb5d8093c88b4842f),
GPL-2.0-or-later, as a separate executable. Its official release source archive is2,437,896 bytes,
SHA256 `e3bd613b91b1c498ec2992276063342a85cd6edddd5521294e04f44bc055da9b`. The archive and
release metadata were fetched and checked. Reviewed the pinned INSTALL, COPYING, CONTRIBUTORS,
configure options, `src/acl/Ip.cc`, `src/acl/DomainData.cc` and `src/ip/Address.cc`, plus the official
[ACL](https://www.squid-cache.org/Doc/config/acl/) and
[access ordering](https://www.squid-cache.org/Doc/config/http_access/) documentation. The earlier
release/source/test/security review remains in the Linux record. No Squid source is incorporated
into OpenBot. Preserve the source archive and notices with any distributed binary.

The first viable implementation is a strict configuration adapter for this released proxy; no
HTTP proxy, IP formatter or firewall engine is reimplemented. Use Python3.12's standard ipaddress
module. DSH received only the anonymously hash-verified public Linux design and a bounded compiler
task; it implemented an initial candidate in a private packet. Root owns integration and actual
runtime tests. DSH assistance is development, not independent review.

## Integration contract and source-derived corrections

Only an exact private listener/client pair, bounded canonical DNS scheme/host/port triples and
additional blocked CIDRs enter the compiler. No filenames, arbitrary directives, environment,
I/O, authority or subprocess API enters it. Each origin keeps its own port and protocol checks;
an HTTP origin cannot inherit another origin's port or enable FTP. CONNECT is a destination tunnel,
not proof that its bytes are TLS or that a particular website operation was approved.

Squid stores IPv4 addresses in an IPv4-mapped IPv6 representation. A blanket
`dst ::ffff:0:0/96` therefore risks blocking ordinary public IPv4, which a Python-only ACL model
misses. Numeric URL hosts are instead refused by exact `dstdomain -n` policy, and IPv4 destination
ranges cover mapped private/metadata/control addresses after normalization. Do not claim a
separate mapped-address prohibition that the selected proxy cannot distinguish. Reject mapped
caller CIDRs in favor of explicit IPv4. Use the standard library's canonical network formatting.
Actual parse logs also showed Squid silently replaces IPv4 `/0` with `all` while exiting zero.
Remove that redundant positive ACL; explicit denials cover nonpublic ranges. The probe rejects
ERROR/WARNING/FATAL/SECURITY NOTICE parse output instead of trusting exit status alone.

Reject empty/broad/malformed policy before writing any configuration. Access and store logs and
disk caching remain disabled. Exact host, port and source gates plus a final deny are necessary
proxy policy; host packet enforcement is still required at the actual connection, across IPv4/IPv6,
DNS rebinding, direct sockets, host gateway, sibling sandbox and preexisting tunnel teardown.
No compiler test or proxy-only result qualifies that host boundary or a live Linux product browser.

## Verification route

The initial amd64 source build under emulation hit its1500-second bound and was removed; it
produced no accepted binary. Use the released Debian7.7-1 executable instead. The official
[package](https://packages.debian.org/testing/web/squid) and
[packaging source](https://deb.debian.org/debian/pool/main/s/squid/squid_7.7-1.debian.tar.xz)
were inspected, including all four patches, configure flags and upstream/functional autopkgtests.
Patches change default config/log/file locations, systemd runtime directories, and recognition of
localhost as an internal hostname; the emitted explicit config does not include Debian snippets,
and localhost remains outside its permitted destinations. This is the Debian GnuTLS build, not
the unpublished minimal source build. Preserve package notices and corresponding source if shipped.

The fixture uses the official Debian forky-slim amd64 manifest
`sha256:61c8340200f7d4e440dd0c52ac81628060da77410108afaebb23d38e43f39fa1`
(2026-09-18, image-source revision8f962b15d7884a90e17876a9303cbac909d119aa).
Exact Squid7.7-1 packages are installed only inside the disposable image through signed Debian
APT metadata; capture actual package versions, final image and binary digests. No host/VPS package
is installed. Run `squid -k parse` against the generated configuration,
then use owned isolated network fixtures with real positive HTTP/CONNECT and forbidden destinations,
cross-origin/port, numeric-host and protocol counterexamples. Keep exact source/license artifacts.
The later native Linux packet must independently qualify privileged lifecycle and network rules
before any real browser capability is enabled.

Address policy also reviewed the IANA
[IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/)
and [global unicast assignments](https://www.iana.org/assignments/ipv6-unicast-address-assignments/)
on2026-09-26. It conservatively excludes non-global and selected special ranges, rather than
asserting every address inside2000::/3 is currently allocated or safe. Explicit management ranges
and connection-time host enforcement remain mandatory.

## Actual result

Debian7.7-1 amd64 executable SHA256
`4e343ba74e3ae6f83dd319ad6f320150e76a0fcf5e90a81dff7a815bfefb9d4b` passed20 actual cases:
three positive HTTP/CONNECT paths,17 refusal paths with zero canary requests, clean proxy exit and
owned-container removal. The final image/source hashes and per-case outcomes are in
[REAL_EGRESS_RESULT.json](../../experiments/browser-execution/REAL_EGRESS_RESULT.json).
The first attempt stopped before proxy execution because dormant Linux tunnel devices were
mistaken for active interfaces; the final fixture instead requires every non-loopback device to
be DOWN and unaddressed, alongside Docker's inspected network-none mode. All attempts were removed.
No host packet, DNS rebinding, Linux product Host or preexisting-tunnel revocation claim follows.
The required CI job uses the same real executable fixture; five compiler-only tests remain cheap
offline regressions. `npm run check` verification is recorded in the current handoff.

## Actual native packet check

The supplied Ubuntu24.04 VPS has nftables1.0.9-1ubuntu0.1, iproute2 6.1.0-1ubuntu6.4,
iptables1.8.10-3ubuntu2 and systemd255.4-1ubuntu8.17. CI installs these exact networking packages
only on its disposable runner.
Read-only version checks changed no service, package or rule. Reviewed the official
[nftables hook/verdict semantics](https://netfilter.org/projects/nftables/manpage.html),
[netfilter hooks](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks), and
[Docker packet filtering constraints](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
Use the installed Linux packet filter, not another proxy or a Python model of its decisions.

Qualify a fixed routed topology inside one native150-second `PrivateNetwork=yes` systemd
unit. Its four owned child namespaces contain synthetic client, proxy-port canary, public and private
targets, joined by owned veth pairs. Require the parent and all child namespace inodes to differ
from PID1 before touching links or rules. Prove TCP/UDP/IPv6/private/metadata/host canaries reachable
before installing the exact fixture table. An inet forward chain then admits only client→proxy and
proxy→public fixture ports, while input refuses client/target access to the namespace's own host.
Flush the dedicated admission chain to revoke an already-open connection; no established-state
exception outside that chain may keep it usable. All rules live in the private unit namespace;
never flush a host ruleset or change the production Docker daemon/backend.

This is kernel-routing qualification only: the proxy-port canary is an echo service, explicitly
not a Squid substitute. Real Squid is covered above. Their later composition with actual gVisor,
Chromium, product authority and profile lifecycle still requires its own evidence. The fixture is
not a general privileged installer or production network configuration. All child services and
namespace anchors belong to the original unit cgroup; the native deadline and explicit cleanup
bound lifetime even if the SSH caller disappears. No external route or real account is involved.

The corrected fixture passed23 actual forwarding cases on the supplied VPS. Before filtering,
all IPv4/IPv6, private, metadata, host, DNS TCP/UDP and QUIC-port UDP echo canaries were reachable.
After filtering, only the declared proxy-to-public TCP paths passed. Client-to-proxy TCP passed;
flushing the admission chain then blocked the same established socket with no additional target
receipt. All owned children were reaped, the unit closed, and9 existing production containers,
both iptables variants, nft rules (ignoring counters) and host forwarding sysctls were unchanged.
See [safe native evidence](../../experiments/browser-execution/REAL_KERNEL_NETWORK_RESULT.json).

The first native attempt stopped before rule installation because the IPv6 canary was not ready.
Global addresses used nodad but their link-local neighbors still required DAD completion. The
corrected fixture waits for actual non-tentative/non-failed addresses instead of extending request
timeouts or weakening rules. The consumed first identity was not reused; its children and original
unit were closed, with production unchanged. Final source is retained under `native-network/`.
The launcher now additionally permits the CI runner's snapshot-only `/usr/bin/docker` and records
its source hashes; the kernel probe and nft bytes match the accepted native run. Required CI runs
this same private-unit fixture on a disposable Ubuntu24.04 runner. No Squid/browser composition,
DNS rebinding application path or product authority acceptance is inferred.

## Pinned Linux composition candidate

Before implementation, reuse the accepted private Docker29.8.1/containerd2.3.5/runsc
release-20260914.0 supervisor and Playwright1.62.1 amd64 archive, rather than rebuilding or
uploading Chromium. Keep its inner sandbox and reviewed OCI seccomp derivative unchanged.
The existing agent-computer source at257c1280d684089be9adb0b35cce262efc7064bf remains the MIT
service; preserve its notice and fixture dependency lock. Its sole listener patch binds the
explicit private container address instead of the prior local loopback. No upstream browser
engine or proxy source is copied into OpenBot.

The already used Bun1.3.14 runtime comes from the official amd64 slim manifest
`sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0`, source
`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`, executable SHA256
`a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791`.
Reviewed its pinned [official image recipe](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/dockerhub/debian-slim/Dockerfile),
which selects the baseline x64 release and verifies signed checksums. Preserve full Bun LICENSE.md:
Bun is MIT, but the distributed binary also includes LGPL WebKit/JSC and other notices and
corresponding source/relink obligations. This private qualification packet is not a public
production distribution. No user credentials, existing profiles or private transcripts enter it.

Reviewed Docker's [bridge driver](https://docs.docker.com/engine/network/drivers/bridge/)
and gVisor's [networking](https://gvisor.dev/docs/user_guide/networking/) documentation. Docker
creates the browser and proxy's separate bridges inside the original private native namespace;
no host networking mode, published port, outside default route, NAT, production Docker or
host firewall mutation is admitted. Explicit namespace-local nft forwarding/input policy controls
client-to-proxy and proxy-to-owned-canary paths. The proxy is the separately packaged Squid7.7-1
already qualified above. A root-private Unix relay exposes only the test service to the local
controller through SSH loopback, keeping Control/PostgreSQL/Temporal and Node credentials local.

Use a new single-use identity and a declared native600-second hard limit for image loading,
service readiness, the product journey and original lifetime closure. The original180-second
component identity is consumed and is never extended or reused. Profiles use a256MiB private
noexec/nodev/nosuid tmpfs; a graceful replacement must prove old container exit before reusing it.
The admission chain must also revoke existing proxy connections, not merely reject a later URL.
Retain input hashes, actual runtime argv and original Invocation/cgroup cleanup. A failed or
unknown start is not retried; diagnose its retained evidence before preparing a distinct candidate.
Composition is not accepted until the actual evidence is collected. General public egress, an
installed app/default switch and final retirement are not inferred from this prepared candidate.

For the actual product journey, the retained Node resolves the reserved `example.com` domain
through its ordinary DNS entry; no injected resolver bypasses that policy. Only Squid's fixed
fixture hosts entry maps it to93.184.216.34 in the disconnected canary namespace. The browser
cannot reach the Internet. The real socket probe separately covers public-shaped IPv4/IPv6,
private/metadata/management destinations and proxy host refusals. All denial canaries must first
answer before the packet rules are installed; a missing listener is not denial evidence.

The first actual composition reached the pinned Bun service in runsc, passed the routed socket
checks and navigated Chromium through Squid in2.093 seconds. The local product Node correctly
rejected a public HTTP origin before any product browser action. Keep that HTTPS requirement.
The follow-up uses a synthetic HTTPS canary with a dedicated two-day CA, leaf SAN example.com,
and the browser's normal per-user NSS trust database. No --ignore-certificate-errors or
ignoreHTTPSErrors switch is added. The CA signing key stays local; only the synthetic leaf key is
read by the owned canary. No OS/browser trust store belonging to the user or VPS is modified.

Reviewed the exact Chromium151.0.7922.34
[Linux certificate instructions](https://github.com/chromium/chromium/blob/151.0.7922.34/docs/linux/cert_management.md):
M146+ defaults to HOME/.local/share/pki/nssdb, while an existing HOME/.pki/nssdb takes precedence.
Create an otherwise empty SQL NSS database using the installed NSS3.124 certutil (SHA256
`4f5257303b873864b947e01be4de7f62a388bdccdfe94b5e4ab678bb3f520184`) and the documented C,,
SSL-CA trust flag. The existing cryptography50.0.1 dependency generates the dedicated test keys.
Copy that test-only database into the owned browser tmpfs, never mount a personal certificate
store. Squid permits CONNECT only to the explicit HTTPS origin and the native packet filter
admits that owned canary's18443 port. Keep a wrong-hostname/unknown-CA refusal in the real TLS check.
The fixture's controller HTTP read timeout may be20 seconds over SSH; product request deadlines
and the original native600-second hard limit remain unchanged.

Local reproduction found the macOS NSS3.124 SQL database loads in the official image's NSS3.98,
but CERT_GetCertTrust returns zero flags for the fixture CA. Both headless shell and full Chromium
reject it, so changing browser channels is not justified. Generate the disposable database with
Ubuntu's released libnss3-tools3.98-1build1 inside the same pinned Linux image instead. The official
[Ubuntu package pool](https://ports.ubuntu.com/ubuntu-ports/pool/main/n/nss/) supplies the arm64
builder package; preserve its bundled copyright and record its SHA256. Its database is the only
new VPS input, not a host package installation or a relaxed certificate policy.

The matching Linux certutil package SHA256 is
`273a3da5dc5d11dbc4efceb787cbe65e1775a3489c84bb393a672f7df17060b8`. A local disconnected
Playwright1.62.1 container then passed HTTPS200, wrong-host ERR_CERT_COMMON_NAME_INVALID and
unknown-CA ERR_CERT_AUTHORITY_INVALID for both default headless shell and full Chromium. The
M146+ default NSS directory alone also passed. The actual native candidate keeps the original
headless-shell selection and all certificate validation. The observed trust-flag mismatch is
evidence; its internal NSS compatibility mechanism was not independently established.

The repository now includes a certificate generator using the existing cryptography dependency
and a bounded real TLS tunnel check. No upstream implementation was copied. The generator was
checked with OpenSSL verification; it creates only a new private directory and never serializes
the CA signing key. The reviewed Linux certutil, not the macOS-generated database, is required.

The comp5 native product composition passed on2026-09-26. All three real TLS cases and13
container socket cases passed; actual Work approvals, one click, report download and replay passed.
A new container reused only the private profile after the old container exited0, retaining the
expected persistent state and human pause. The same verified TLS proxy tunnel stopped delivering
after admission removal, with no new target hit. The original600-second unit expired with no
restart and an empty cgroup; owned runtime data was removed and9 production containers, firewall
semantics and forwarding settings were unchanged. See the
[paired safe evidence](../../experiments/work-journey/evidence/product-browser-linux.json).
Core native sources match the executed packet hashes. The published local Node helper parameterizes
the authorized SSH target instead of embedding a personal host; four preflight checks passed and
the selected command is unchanged. The fixed executed helper hash is retained in the evidence.
No production Internet policy or cross-machine profile recovery is inferred.
