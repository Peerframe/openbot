# Python base / Worker collection gate repair

2026-09-25. Scope: test selection only. No production, dependency, schema, authority or oracle changes.

## Evidence and selected reuse (before implementation)

The CI failure occurs in `apps/server-python/scripts/check.sh -q`, before the optional Worker environment bootstrap, because `pytest` recursively collects every module. Seventeen modules now import Temporal, Pydantic AI or `openbot_agent_runtime` directly or transitively. The base lock deliberately excludes these dependencies; adding them would violate the reviewed profile separation. Sixteen failing files already belong to the existing Worker PostgreSQL invocation; `test_work_collaboration_deadline_replay.py` is absent. `test_temporal_engine.py` also relies on `importorskip` in base and is absent from that Worker list.

Reuse `docs/research/python-control-read-slice.md` (separate base environment, pytest8.4.2, MIT) and `docs/research/work-product-worker.md` (opt-in Worker profile, Temporal1.33.0 and Pydantic AI2.47.0). The reuse ledger records both profiles. Read the official [pytest collection options](https://docs.pytest.org/en/8.4.x/example/pythoncollection.html#ignore-paths-during-test-collection) and [8.4.2 implementation](https://github.com/pytest-dev/pytest/blob/8.4.2/src/_pytest/main.py). Released `--ignore` excludes named paths before module import, while explicit file arguments select the Worker suite. These documented APIs already close this gate gap; no plugin, new dependency, modified test skip or copied upstream source is needed. The existing local pytest package matches8.4.2 and retains its MIT notice.

Use one checked-in plain-text Worker file list, relative to `apps/server-python`, shared by base `check.sh` exclusions and the existing owned PostgreSQL Worker invocation. Preserve every original Worker file and order, including root's just-added `deploy/server/test_product_container.py`; add the two omitted Temporal files. Both readers reject missing entries; Node rejects duplicate entries. Base prints the delegated file count and required separate gate. CI already bootstraps the Worker closure and sets `OPENBOT_TEMPORAL_TEST_PYTHON` on `test:control:python`; preserve that workflow and fixture isolation. Without that variable, the existing optional local gate will explicitly report Worker execution was not performed, rather than silently implying full acceptance.

Validate with exact-lock base and Worker interpreters, no fixture variables, collection-only for the complete respective selections, explicit file/node-id accounting, and focused non-database tests. PostgreSQL acceptance remains the existing CI gate and is not claimed from collection. The replay module's pre-existing history-input skip remains visible and is not newly bypassed.

## Full base execution: three stale contract assertions

The actual base entry subsequently executed1289 cases successfully and exposed three assertions
left behind by commit `778236bdb01014f62aa590e22389263a4c5ec4ee`. Current domain/protocol includes
the `model` computer profile and optional `{connectionId,modelId}` Bot selection. Original fields
retain legacy projection behavior; the frozen old `toBot` does not project this new selection and
is not modified or presented as its oracle. Reuse the Python model-services/task-profile reviews.
Tests now pin the current public selection, omission when absent and refusal of malformed/private
fields without allowing configuration, keys or system prompts into the public DTO.

The persisted context loader intentionally accepts32768 UTF-8 bytes, matching the trusted source
admission path for existing8000-codepoint Run instructions. Public native Task admission retains
16384 bytes and has no caller-selectable `source` flag. The old16385-byte rejection expectation
was stale. Reuse the task-authority/source review and `work_store.create_in_transaction` contract;
test exact32768 acceptance and32769 refusal for ASCII, Chinese and emoji, plus legitimate16385
readback. No production, authority, dependency, schema or frozen oracle is changed. All175 tests
in these two files passed in the exact base environment. Root repeated the real base entry successfully:1304 passed,453 fixture-dependent skips.
The independent owned PostgreSQL base profile also passed826 cases with2 optional skips.

Final integrated owned PostgreSQL execution passed826 base cases (+2 optional skips) and1489
Worker cases (+1 missing-history fixture skip), with real HTTP, session issuance/revocation and
read parity. The full `npm run check` also passed. These are actual local executions; the next
hosted run separately validates the clean Linux CI bootstrap and native container matrix.
