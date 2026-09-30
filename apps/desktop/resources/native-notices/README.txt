OpenBot native PostgreSQL preview notices

The locked @embedded-postgres/darwin-arm64 package is
17.10.0-beta.17, git c23ad8a026c711c8666c3c2596d0fde643cf378a.
Its MIT packager license is copied separately into postgres/PACKAGER-LICENSE.md.
Intel Mac now ships the remote client; its unused darwin-x64 binary dependency
has exited. These upstream notices also remain for historical native recipients.
PostgreSQL is 17.10, distributed under the PostgreSQL License.

License texts in this directory are unmodified upstream notices (Libedit.txt is
its source-file license header only). sources.json records exact source URLs and
SHA-256 hashes. No executable library source has been copied into OpenBot.
The source-linked notices do not constitute a reproducible binary provenance
attestation. The extracted binary inventory confirms PostgreSQL 17.10, OpenSSL
3.0.20, ICU 68.2, LZ4 1.10.0, Zstandard 1.5.7 and zlib 1.3.2. Libxml2, Kerberos,
libedit, libiconv, gettext and libuuid notices are retained from the pinned source
revisions listed in sources.json; exact correspondence to the repacked binaries
still needs distributor confirmation before public redistribution.

The native binary lineage repacks EnterpriseDB's PostgreSQL distribution:
https://get.enterprisedb.com/postgresql/postgresql-17.10-1-osx-binaries.zip
The upstream repack script excludes most documentation. Its archive includes
PostgreSQL's legal notice but not a complete per-library provenance manifest.

Do not publish this development bundle as a licensed, attested release until the
complete native dependency/source inventory and LGPL source/relinking obligations
are verified. libiconv and gettext are dynamically linked LGPL libraries; their
license texts and source references must travel with any reviewed distribution.
OpenBot's MIT license does not replace these licenses or prohibit modification,
replacement or reverse engineering permitted by them. No library is statically
incorporated into OpenBot application code.

Historical Windows source-build review (2026-09-10)

Windows Desktop now ships the remote client and no PostgreSQL runtime. The retired
source-build tooling is preserved in Git history, not in current packaging.
The previous Windows npm candidate remains rejected because its modified LGPL DLL
source/provenance was incomplete; it is not a permitted packaging fallback.
Historical Windows notices and audit evidence remain in licenses/windows-postgresql.
The Darwin source/version inventory above must not be used as Windows provenance.
See docs/research/final-server-retirement.md for the current platform boundary.
