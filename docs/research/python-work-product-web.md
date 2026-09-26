# Public web tools through durable Work Actions

Reviewed before implementation, 2026-09-25. The parent owns integration; this packet only adds
new modules/tests and changes no root files, schema, defaults, core or serve composition.

Reuse the accepted desktop-public-web-tools.md and agent-research-artifacts.md reviews and the
OPEN_SOURCE_REUSE.md public-source entry. Exact original local contracts are agent-sources.ts,
native-web-tools.ts and native-agent.ts at root HEAD 482bdc5 plus current uncommitted integration.
The same repository MIT implementation is substantially adapted; no third-party source copied.
The existing LICENSE and dependency notices remain required in distribution.

The original formatter is html-to-text 10.0.1 / 1c39d9885075836a7e45d0236c7a5541dede8e52
(MIT). Its input/output/security contract is retained as the compatibility reference. Selected
runtime implementations are Beautiful Soup 4.15.0 / Soup Sieve 2.8.3 below, CPython 3.12 stdlib
URL/IP/async process APIs (PSF), HTTPX 0.28.1 / HTTPCore 1.0.9 (BSD), existing plugin transport's
PinnedBackend/public_address, Temporal Python 1.33.0, PostgreSQL 17.11 and existing Work
DeferredActivities/ToolResults. No new execution engine is necessary. Additional Python dependency review follows below.

Primary documentation rechecked:
- https://docs.python.org/3.12/library/urllib.parse.html#url-parsing-security confirms urlsplit is
  not a validator. Reject ambiguity explicitly, use HTTPX's URL canonicalization, and validate
  every DNS answer; no standards-equivalence claim for rejected WHATWG legacy syntax.
- https://docs.tavily.com/documentation/api-reference/endpoint/search retains the official fixed
  endpoint, Bearer auth and basic/5/no-answer/no-raw-content search request contract.
- Kimi official Formula contract and hosted mutable moonshot/web-search:latest pin are retained
  from desktop-public-web-tools.md. No new provider/capability or billing test is introduced.
- https://github.com/html-to-text/node-html-to-text/tree/1c39d9885075836a7e45d0236c7a5541dede8e52
  and the installed source/package retain the exact prior conversion API. The runtime Node bridge is not selected: the parent requires a native Python control path.

The Python converter selection and deliberate formatting differences are recorded below. Network authority remains entirely Python-controlled:
HTTPS 443, no auth/cookies/custom headers for pages, no redirects/proxy/compression, all-address
public-IP validation once then numeric pin with original Host/TLS identity, bounded total/body.
Search auth is separate and only goes to the exact official Tavily or selected Kimi endpoint.

A trusted async search_configuration(db, context) callback must read current Owner configuration
under caller-owned source/Task locks; no environment read and no model-supplied settings/key.
Tavily has priority in the selection helper. Kimi additionally binds the selected model's complete
non-secret configuration provenance; recheck before send and before returning a persisted opaque
result. Existing Python has no Tavily credential settings route: host composition must provide
this trusted source, otherwise search is absent. No fallback after failure.

Each invocation is a read-only durable Action requiring no separate Owner approval. A content-free
attempt event under the existing Task UPDATE lock consumes one of four web calls for the entire
Task, including failed DNS/HTTP attempts. Dispatch has a second once-only marker and repeats real
SDK accepted Activity, current source/membership/correction, original Action, generation/expiry,
and current live claim/fence after DNS and immediately before send. No SQL lock spans the remote
response. These transaction commits are linearization points; revocation cannot unsend a request
already committed for dispatch. Unknown results recover by ToolResults lookup only. Persisted
response observation is untrusted evidence, never proof the public source is authentic or current.

Tests use only synthetic local transport injection and the dedicated owned work_plugins.json PG
fixture, each test owning separate Bot/channel/Task IDs. Real SDK ActivityEnvironment supplies
Activity context; immutable history is synthetic. No real Temporal cluster, public provider key,
paid call or live Internet success is claimed by these tests.

## Python HTML conversion selection

The parent explicitly requires Python runtime conversion, permitting a small reviewed dependency.
Inspected maintained Beautiful Soup 4.15.0 (June 7 2026) and Inscriptis 2.7.1 (Feb 27 2026).
Search terms: Python inscriptis 2.7.1 license release html text; beautifulsoup4 release get_text.
Primary official sources: https://www.crummy.com/software/BeautifulSoup/bs4/doc/,
https://code.launchpad.net/beautifulsoup, PyPI version metadata/source releases,
https://github.com/facelessuser/soupsieve/releases/tag/2.8.3,
https://github.com/weblyzard/inscriptis/issues. Launchpad live bug listing was unavailable; the
release changelog documents reviewed fixes 2134393 (numeric entities on current Python),
2154141 (mixed void-tag forms), 2121335 (parser exception conversion). No claim of an empty
bug backlog. Inspected downloaded release source, tests, license and dependency metadata.

Select beautifulsoup4==4.15.0 (MIT), soupsieve==2.8.3 (MIT, 5aedc41, inefficient attribute
pattern fix); typing-extensions is already pinned. BSD/PSF CPython html.parser is selected
explicitly, never optional XML/lxml/network loaders. get_text/decompose are maintained APIs;
a small pinned BeautifulSoup tree-builder hook caps depth/child count before allocation.
Source distributions SHA256:
- beautifulsoup4: 288e3ca7d54b06f2ac191970bc275c1939cb46d450b255bf6718b04aa37ab4f7
- soupsieve: 3267f1eeea4251fb42728b6dfb746edc9acaffc4a45b27e19450b676586e8349
Inspected HTMLParserTreeBuilder, BeautifulSoup.handle_starttag, Tag.get_text/decompose,
upstream HTML parser/tag/element tests. No third-party implementation is copied or forked.
Full MIT notices (including Beautiful Soup's html5lib attribution) are supplied separately.
Inscriptis source sha256 16517bab88ac2c8f01d58748bf070256e8af7a3fac96d1e317b01371d04a3c6e,
Apache-2.0, requires lxml>=5.4,<6.1 and requests>=2.32.3; its richer CSS/table-layout machinery
and compiled parser/network dependencies exceed this task. Its open table annotation offset
issue #92 does not affect the selected simple text extraction.

Python converter runs a fixed isolated Python subprocess with cleared environment and no
untrusted code evaluation, 3-second timeout/kill/reap, input <=512 KiB, output <=4 MiB and
hard tree depth 40, children 1000, total nodes 50000. Tree limits reject rather
than silently truncate. Remove script/style/iframe/noscript/img/template; retain anchor text
without href, headings in original case and table cell text separated by newlines. Unlike
html-to-text, visual table alignment/heading capitalization/inline whitespace are not preserved.
The final text remains strict UTF-8 <=6000 bytes, controls removed, with truncation flag.
No page-supplied image/link/CSS is fetched, and no script runs. UTF-8 decode is strict before
parsing. Defaults use only installed pinned dependencies; tests may inject reviewed package
source directories into the child in lieu of changing the root environment.

## Product host configuration

Restore the retained Server `TAVILY_API_KEY` option only at the trusted startup composition;
`ProductWorkRuntime` receives it explicitly and tools still cannot read environment settings.
The existing Desktop launcher already maps its explicit `OPENBOT_DESKTOP_TAVILY_API_KEY` to that
Server key without forwarding unrelated ambient keys. The Python bootstrap preserves that mapped
value. A bounded validated opaque credential has a domain-separated SHA-256 configuration revision,
so a restart with a different credential cannot consume an earlier selection as unchanged. Raw
credentials remain private; only the revision participates in the durable intent. Tavily keeps
priority over selected Kimi and has no runtime fallback after failure. Existing pinned official
Tavily/Kimi review and transport tests apply; no new provider, endpoint or dependency is added.
