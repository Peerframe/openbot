# Historical Windows PostgreSQL source-build notices

The retired Windows Desktop runtime built **unmodified PostgreSQL 17.11 source** with the official Meson/MSVC build system. The source archive is verified against both the pinned SHA-256 and PostgreSQL's published checksum before extraction. The binary is not taken from the npm/EDB repack.

Current Windows Desktop is a remote client and does not build or ship PostgreSQL; see
[the accepted retirement decision](../../docs/research/final-server-retirement.md). The unused
builder, staging adapter and minor-upgrade probe were removed on 2026-09-29. These notices and
rejected-candidate evidence remain for historical recipients. Existing profiles and clusters are
not removed or converted by this source cleanup.

The historical script is available with `git show e3208b8:scripts/build-windows-postgresql.ps1`.
It required a licensed Windows x64 MSVC environment with Python 3, Perl and PowerShell 7, used
hash-pinned Meson/Ninja/WinFlexBison, changed no upstream source, and ran upstream regression
before generating a manifest. The former Desktop CI harness checked migrations, SCRAM and restart.
The following inventory describes that historical build, not a current installation command.

The runtime includes PostgreSQL's own SQL, JSON, PL/pgSQL, built-in SCRAM and UTF-8 support. NLS/gettext/iconv, ICU collation, OpenSSL/TLS, XML/XSLT, readline, external procedural languages, compression libraries and JIT are disabled. This database is used on loopback and does not claim remote TLS service or arbitrary third-party binary-extension compatibility. The Microsoft C runtime is statically linked by MSVC (`b_vscrt=mt`), under the licensed Microsoft toolchain's distributable-code terms. Windows system APIs are provided by Windows. No EDB, GNU runtime, or separately downloaded Microsoft runtime DLL is copied into this database package.

## What recipients receive

Every built runtime contains a `licenses` directory with this notice, the exact official PostgreSQL source archive and checksum, build script, build options, upstream regression log, and embedded-source copyright notices. `openbot-postgresql-build.json` records source/tool versions, compiler hash, runner image, actual build time, all binary imports and the SHA-256/size of every installed file. The historical installer included these materials; its CI retained a separate source/provenance artifact. Toolchain versions are recorded for reproduction, but the build is not claimed to be bit-for-bit deterministic.

- `PostgreSQL-COPYRIGHT`: exact upstream PostgreSQL license.
- `Regex-COPYRIGHT`: Henry Spencer's regex notices shipped in the source.
- `Embedded-source-notices.txt`: verbatim license/copyright comments from the source; `embedded-notice-sources.json` maps each block to its original file and hash. Includes optional/build-only source conservatively.
- `Snowball-COPYING`: exact BSD notice from commit `48a67a2831005f49c48ec29a5837640e23e54e6b`, the version explicitly identified by PostgreSQL's Snowball README.
- `IANA-timezone.txt`: public-domain data statement and upstream source context.
- `Bison-GPL-3.0.txt`, `Bison-output-exception.txt`, and `Flex-COPYING`: parser-generator output notices. The actual generated parser's notice is also extracted into the installed artifact. Bison's output exception allows the larger PostgreSQL work to retain its own license; generator tools are not redistributed with OpenBot.
- `sources.json`: reviewed source URLs, hashes and notice inventory.

Users may inspect or replace this separately installed PostgreSQL runtime with a compatible build; application startup still enforces its executable/path/security policy. OpenBot does not restrict reverse engineering of these open-source components or inspection/debugging of changes to them. There is no LGPL corresponding-source offer for the selected runtime because the unresolved LGPL DLLs are not used or distributed.

`rejected-edb/` is repository audit evidence for a rejected candidate. Those files are expressly excluded by the historical source-build packaging script. Their presence does not authorize redistributing the old binary repack or imply that its corresponding-source gap was resolved.

Read [the research decision](../../docs/research/windows-postgresql-redistribution.md) for the exact candidate comparison and validation status. A successful source-build manifest proves the upstream suite completed for that artifact; it does not replace the Desktop Windows installation test.
