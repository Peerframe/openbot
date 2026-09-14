# Channel files and processing

Upload files using the composer picker, drag and drop, or image paste. A message supports eight files totalling 20 MiB; text/code files are limited to 256 KiB each, PNG/JPEG to 5 MiB, and documents/media to 10 MiB. Filenames and signatures are validated on the Server. Original bytes are immutable, channel-scoped and SHA-256 checked.

## Supported operations

| Input | Operation | Execution boundary |
| --- | --- | --- |
| UTF-8 text/code | Bot reads bounded pages | Current task's explicit attachment IDs only |
| DOCX, XLSX, PPTX, ODT, ODS, ODP | Extract document text from attachment actions | Local officeparser 7.8.0; no macro execution, embedded attachment extraction or OCR |
| PDF | Extract document text, optionally with its password | Local PDF.js 6.2.108; password is transient and never retained in attachment metadata or derived text |
| PNG, JPEG | Recognize image text | Local Tesseract.js 7.0.0; bundled English and simplified Chinese language data; no CDN or image upload |
| MP3, WAV, M4A, MP4, WebM | Explicitly send to OpenAI for transcription | Requires an enabled OpenAI connection; only selected media is sent; keys stay on Server |

The attachment card's actions include processing and original download. Process a document or media attachment before sending it to a Bot. A processed attachment is available through `read_attachment`, including for providers that cannot consume binary documents. Unprocessed PNG/JPEG/PDF retain the existing compatible OpenAI/Anthropic binary-input path. Processing status shows extracted character count and truncation. A failed or cancelled parse does not replace a previously valid result or delete the original.

PDF extraction reads existing text. Scanned PDFs without a text layer need their pages supplied as PNG/JPEG for this OCR path; the current extractor does not rasterize PDF pages. Speech transcripts and OCR can be inaccurate; the source stays available for checking. Legacy binary DOC/XLS/PPT and Office password encryption are not supported.

## Bounds and storage

The Server runs at most two processing jobs simultaneously. Each parser executes in a separate Node Worker with a 256 MiB old-generation heap, a 32 MiB young generation and a 4 MiB stack. Heap limits are not a complete operating-system memory sandbox: native libraries/Wasm can allocate separately. Input, image dimensions (16 million pixels), ZIP inflation (32 MiB), ZIP entry count (2,000), expanded spreadsheet cells (100,000), output (262,144 UTF-16 characters), pages (200) and elapsed time (30 seconds for extraction, 60 for OCR) are separately bounded. Worker termination is awaited before temporary language files are removed. No parsed document HTML executes in the application.

A derived sidecar records the original SHA-256, operation, timestamp, text and truncation. Bot output labels the content as untrusted data; reading an attachment never creates authority or new tool permissions. Passwords are not stored. External transcription is an explicit action with a 90-second request bound, disabled redirects and bounded responses; it is not performed automatically on upload, view or task creation.

## Files and recovery

The channel file manager lists available files and a recycle bin. Moving an attachment into the recycle bin retains bytes for existing task references; restore makes it visible in the available list again. Explicit cleanup only removes files deleted more than seven days ago and not referenced by messages/tasks. Without a Server reference checker, cleanup fails closed. No background purge is enabled.

Desktop original downloads pass only exact channel/attachment IDs through trusted IPC. The main process fetches and hashes the original, presents a native Save dialog, rechecks the authenticated connection and writes with exclusive creation. Existing files are never overwritten. The web client also checks the digest and downloads as opaque bytes; neither path executes or previews document HTML.

## Validation

Real parser tests use locally authored DOCX/XLSX/PPTX/ODT containers, an AES-256 encrypted PDF, and a generated OCR image with offline language data. Tests cover malformed containers, cancellation, password failures, digest mismatch, provider gating, scoped lifecycle routes, reference-safe retention and native original saving. The media transport test substitutes the HTTP response and is not a real model transcription. Windows execution depends on the native CI result; portable tests on macOS do not prove Windows conformance.

## Documents without readable text

Text extraction fails with an explanation when the parser returns only whitespace. The original
file remains available and is not marked as successfully extracted. A PDF may be scanned or blank;
PDF text extraction does not perform OCR. Upload PNG/JPEG pages and explicitly choose image OCR,
or provide a PDF with a readable text layer. A partially searchable PDF may still yield only part
of its content; successful extraction is not a guarantee of complete page coverage.

If an older version saved an empty extraction, task preparation asks you to re-upload the original
and extract readable text or explicitly attach supported image/PDF content. It does not silently
send the original binary to a model in place of that empty text.

Processed documents, OCR and transcripts register the same audited `read_attachment` tool as plain text, including when supplied alone. Attachment descriptors, media/extension limits and operations live in the shared protocol package. Automatic tasks follow the [same reference lifecycle](AUTOMATIONS.md#attachment-references).
