# Synthetic attachment fixtures

`encrypted.pdf` contains only the locally authored sentence “OpenBot encrypted PDF evidence”.
It was generated with ReportLab and pypdf 6.10.0; AES-256 test password: `openbot-test-password`.
It contains no user document or upstream copyrighted fixture. The parsers are exercised through
the bounded Worker; plain Office containers and the OCR raster are generated in tests.

`script-action.pdf` is a locally authored PDF with an OpenAction JavaScript that throws if executed. Its purpose is to verify extraction never executes PDF actions. It contains no imported exploit or external URL.

`image-only.pdf` is a locally authored one-page PDF that paints one black RGB raster pixel across
its page. It has no text objects or external resources. It exercises the same absent text layer as
a scanned page without including any private scan or upstream fixture.
