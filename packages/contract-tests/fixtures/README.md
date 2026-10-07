# Synthetic document fixture

`document.docx` is a locally authored, deterministic ZIP containing only
`[Content_Types].xml` and `word/document.xml`. Its single paragraph is
`OpenBot synthetic document evidence`; ZIP timestamps are fixed to 2026-01-01.
It follows the minimal DOCX fixture used by the existing Python parser tests.
No upstream document, user content, credentials or executable payload is included.

The public HTTP suite uploads these bytes to both attachment namespaces and invokes the
released document parser. It checks bounded public processing metadata and downloads the
unchanged original bytes. No Python fixture generator is needed to run the TS suite.
