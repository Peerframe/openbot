# Third-Party Notices

[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

OpenBot's Server, Worker Hosts and Desktop build reference the following components. Exact resolved
versions are recorded in checked-in lockfiles; release artifacts must also carry generated SBOMs
and notices.

- Microsoft .NET runtime and `Microsoft.Extensions.*` / `System.*` libraries — Copyright .NET
  Foundation and contributors; MIT License.
- `Meziantou.Framework.Win32.Jobs` 4.0.0 — Copyright Gérald Barré; MIT License.
- Electron 44.3.0 — Copyright Electron contributors and GitHub Inc.; MIT License. Electron
  development packages retain the upstream `LICENSE`, and packaged artifacts retain Electron's
  generated `LICENSE` and `LICENSES.chromium.html` files.
- `@electron/fuses` 2.1.3 — Copyright 2020 Electron Maintainers; MIT License. This build tool is not
  included in the Desktop application ASAR.
- `@electron/packager` 20.3.0 — Copyright 2015 Max Ogden and other contributors; BSD 2-Clause
  License. This build tool is not included in the Desktop application ASAR.
- `@electron/asar` 4.3.0 — Copyright 2014 GitHub Inc.; MIT License. This build tool validates the
  final Desktop archive inventory and is not included in the application ASAR.
- `write-file-atomic` 8.0.0 — Copyright 2015 Rebecca Turner; ISC License. This is included in the
  Desktop application ASAR for atomic public-origin configuration writes.
- `signal-exit` 4.1.0 — Copyright 2015–2023 Benjamin Coe, Isaac Z. Schlueter, and Contributors; ISC
  License. This is the sole runtime dependency of `write-file-atomic` in the Desktop application
  ASAR.
- `@modelcontextprotocol/sdk` 1.30.0 — Copyright (c) 2024 Anthropic, PBC; MIT License.
  Official MCP client/server and validation APIs are used without copied implementation code.
  Its LICENSE remains in production dependencies; the MIT terms are reproduced below.
  See [plugin research](docs/research/third-party-mcp-plugins.md).

- Vercel AI SDK `ai` 7.0.93, `@ai-sdk/openai` 4.0.66, `@ai-sdk/anthropic` 4.0.53, `@ai-sdk/moonshotai` 3.0.49,
  `@ai-sdk/provider` 4.0.10 / 4.0.14, `@ai-sdk/provider-utils` 5.0.36 / 5.0.40 and the SDK's transitive
  `@ai-sdk/gateway` 4.0.75 — Copyright 2023 Vercel, Inc.; Apache License 2.0.
  The Server uses explicit OpenAI/Anthropic/OpenRouter/Moonshot adapters, not the AI SDK gateway. Package LICENSE files
  remain in the packaged production dependency tree. No upstream implementation was copied.
  See [Agent research](docs/research/native-agent-loop.md) and the
  [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

- `@openrouter/ai-sdk-provider` 3.0.0 — OpenRouter contributors; Apache License 2.0.
  Selected release c1ce69ab9dfe9ca87a57e1db5faf35ee78f6fa1a; use the public chat adapter without
  copied or modified upstream code. Its LICENSE remains in packaged production dependencies.
  See [OpenRouter research](docs/research/openrouter-model-entry.md).

No upstream source is copied into OpenBot. The following MIT license text is reproduced for the
MIT-licensed dependencies listed above:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The following BSD 2-Clause license text is reproduced for `@electron/packager`:

> Copyright (c) 2015 Max Ogden and other contributors
> All rights reserved.
>
> Redistribution and use in source and binary forms, with or without modification, are permitted
> provided that the following conditions are met:
>
> - Redistributions of source code must retain the above copyright notice, this list of
>   conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice, this list of
>   conditions and the following disclaimer in the documentation and/or other materials provided
>   with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
> IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
> FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
> CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
> DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
> DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
> IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
> OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The following ISC license text is reproduced for `write-file-atomic`:

> Copyright (c) 2015, Rebecca Turner
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without
> fee is hereby granted, provided that the above copyright notice and this permission notice appear
> in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
> AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
> NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
> OF THIS SOFTWARE.

The following ISC license text is reproduced for `signal-exit`:

> Copyright (c) 2015-2023 Benjamin Coe, Isaac Z. Schlueter, and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without
> fee is hereby granted, provided that the above copyright notice and this permission notice appear
> in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
> AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
> NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
> OF THIS SOFTWARE.

## Native Desktop Server preview

Desktop installer creation additionally uses build-only `electron-builder` 26.16.0, reviewed at
`f4610970f78b6ce223b1f4cee2b5e8f5caa14a48`, MIT, copyright 2015 Loopline Systems. No upstream
source was copied or substantially adapted. Its package license and downloaded installer-tool
notices remain under their upstream licenses; the application does not load electron-builder at
runtime. See `docs/research/desktop-installable-delivery.md` for the installer-only reuse boundary.

- PostgreSQL 17.10 — PostgreSQL Global Development Group and the Regents of the University
  of California; PostgreSQL License. Native packaging uses
  `@embedded-postgres/darwin-arm64` / `darwin-x64` `17.10.0-beta.17`, MIT packager,
  commit `c23ad8a026c711c8666c3c2596d0fde643cf378a`. The wrapper code is not used.
- Postgres.js 3.4.9 — Rasmus Porsager; Unlicense. Its package notice is retained alongside code.
- The PostgreSQL binary bundle includes OpenSSL, ICU, LZ4, Zstandard, zlib, libxml2, Kerberos,
  libedit, libiconv, gettext and libuuid. These are not relicensed under OpenBot's MIT license.
  Upstream notices and their source/hash inventory are retained in
  `apps/desktop/resources/native-notices` and copied into the native runtime. The packager's MIT
  notice is also retained. No upstream executable implementation is copied into OpenBot source.
- This is an internal unsigned development bundle. Exact per-library binary/source correspondence
  and LGPL distribution obligations remain public-release gates, documented in that inventory.
  Do not represent the preview as an attested or distribution-cleared release.

## Native Agent public sources

- ipaddr.js 2.5.0 (dc55282780d8702bac31ef012ca52e4a77fbca1f), MIT.
- html-to-text 10.0.1 (1c39d9885075836a7e45d0236c7a5541dede8e52), MIT.
- @types/html-to-text 9.0.4, MIT, build-time types only.

Packages retain their upstream notices in the production dependency closure. No upstream source
was copied or substantially adapted. See [research](docs/research/agent-research-artifacts.md).

## YAML parser

`yaml` 2.9.0 (commit `ddb21b04cb889722cec8f89dc1b67f19d62d7f7d`) is used unchanged
for bounded Agent Skills frontmatter parsing. Its packaged LICENSE is retained.

Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

## Document extraction, OCR and MCP Apps

- officeparser 7.8.0 — Copyright (c) 2019 Harsh Ankur; MIT. Used unchanged for bounded Office
  document extraction in a separate process.
- pdfjs-dist 6.3.289 — Mozilla/PDF.js contributors; Apache-2.0. The distribution also includes
  Foxit fonts (BSD-style notice), Liberation fonts (SIL OFL 1.1), Adobe CMaps, ICC profiles
  (CC0), and separately licensed OpenJPEG, QCMS and PDFium/JBIG2 decoders. Their complete
  packaged license files are retained alongside the main license.
- tesseract.js 7.0.0 and tesseract.js-core 7.0.0 — Apache-2.0 package licenses; unchanged OCR
  engine/runtime. The WebAssembly runtime retains upstream third-party implementation terms.
- `@tesseract.js-data/eng` / `@tesseract.js-data/chi_sim` 1.0.0 — OCR trained data from
  naptha/tessdata / tesseract-ocr. The npm archives omit LICENSE and their metadata says MIT;
  the canonical data repository identifies its data as Apache-2.0. Its full upstream license is
  retained at source revision `806cd9adc8c6e8abc11c782db1818c990576bebc` rather than treating
  package metadata as the license for trained data.
- `@modelcontextprotocol/ext-apps` 1.7.5, commit `92f46a574568a3ddac7600343b7d3c4c4ed7b588` —
  unchanged official AppBridge and PostMessageTransport. Its LICENSE records an Apache-2.0/MIT
  transition, documentation CC-BY-4.0; the npm package's short MIT field is incomplete. The full
  notice is retained. No upstream host implementation was copied into OpenBot source.

All of these retained texts and their file hashes are in [licenses/runtime](licenses/runtime/README.md),
which Desktop packaging includes as `native-server/runtime-notices`. This supplement does not
replace the original packages' notices or relicense their contents under OpenBot's MIT license.

## Windows PostgreSQL source-build scope

Windows Desktop builds the unmodified official PostgreSQL 17.11 source with Meson/MSVC.
NLS/gettext/iconv, ICU, OpenSSL, XML/XSLT, external procedural languages and compression
libraries are disabled through upstream public build options. No EDB/npm Windows binary repack
is included. The Microsoft C runtime is statically linked under the licensed MSVC toolchain's
distributable-code terms; Windows APIs remain operating-system components.

[licenses/windows-postgresql](licenses/windows-postgresql/README.md) retains the PostgreSQL,
regex, Snowball, IANA, embedded-source and parser-output notices plus exact source/tool hashes.
Each Windows build includes the official source archive, build script/options, regression log,
DLL-import inventory and per-file hashes. The GNU parser tools are build-only; Bison's generated
output exception is preserved. The old EDB archive's byte provenance and unresolved LGPL source
gap are retained only as rejected-candidate evidence and excluded from runtime packaging.

The build manifest is written only after upstream regression and dependency checks pass.
Windows installation and restart conformance are established separately by the CI harness.
See the [source-build decision](docs/research/windows-postgresql-redistribution.md).
