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
