# Runtime dependency notices

[English](README.md) · [简体中文](README.zh-CN.md)

This directory retains unmodified upstream license notices for newly bundled document parsing,
OCR and MCP Apps dependencies. `sources.json` records the exact package version/source path and
SHA-256 of every retained file. Desktop staging copies this complete directory to
`native-server/runtime-notices`; the browser bundle's MCP Apps code also requires its notice even
though the Server does not import it.

- officeparser 7.8.0: MIT.
- PDF.js / pdfjs-dist 6.3.289: Apache-2.0 plus independently licensed fonts, CMaps, ICC profiles and
  image/WASM decoders. All packaged license files are retained, not just the root license.
- Tesseract.js 7.0.0 and tesseract.js-core 7.0.0: Apache-2.0 package notices.
- English and Simplified Chinese trained data 1.0.0: the npm tarballs omit a license and label
  their package metadata MIT; the source repository identifies its trained data as Apache-2.0.
  Its upstream license is retained with the exact source revision, separate from package metadata.
- MCP Apps 1.7.5: actual LICENSE records Apache-2.0/MIT transition, documentation CC-BY-4.0.
  npm's short MIT field does not replace this full notice.

No upstream implementation has been copied into this directory. Notices do not prove native
binary provenance or establish a complete audit of every transitive library. Existing Electron,
Node and PostgreSQL notices remain in their established locations. Windows PostgreSQL's wrapper
license does not cover all bundled DLLs; the separate native inventory records that release gate.
