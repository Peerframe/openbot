"""Catalog, limit and deadline validation.

Synchronous unit tests: these refusals must happen before any run work starts, so
they assert the failure reason directly instead of driving a run.
"""

from __future__ import annotations

import math

import pytest

from openbot_agent_runtime import (
    FailureReason,
    RuntimeLimits,
    ToolDescriptor,
    validate_deadline,
)
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.errors import RuntimeFailure

from support import descriptor


def _reason(excinfo: pytest.ExceptionInfo[RuntimeFailure]) -> FailureReason:
    return excinfo.value.reason


def _catalog(*descriptors: ToolDescriptor) -> ToolCatalog:
    return ToolCatalog(list(descriptors), max_tools=8, max_bytes=8192)


# -- catalog admission ---------------------------------------------------------


def test_catalog_accepts_well_formed_descriptors() -> None:
    catalog = _catalog(descriptor("search"), descriptor("fetch"))

    assert catalog.names == {"search", "fetch"}
    assert catalog.bytes > 0
    assert catalog.descriptor("search").name == "search"
    assert catalog.sdk_definitions()["search"].parameters_json_schema["type"] == "object"


def test_catalog_refuses_duplicate_names() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        _catalog(descriptor("search"), descriptor("search"))

    assert _reason(caught) is FailureReason.CATALOG_INVALID


@pytest.mark.parametrize("name", ["", "has space", "1" * 65, "emoji🙂", "-leading"])
def test_catalog_refuses_unusable_names(name: str) -> None:
    with pytest.raises(RuntimeFailure) as caught:
        _catalog(descriptor(name))

    assert _reason(caught) is FailureReason.CATALOG_INVALID


def test_catalog_refuses_a_non_object_input_schema() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        _catalog(descriptor("search", schema={"type": "array", "items": {"type": "string"}}))

    assert _reason(caught) is FailureReason.CATALOG_INVALID


def test_catalog_refuses_an_invalid_json_schema() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        _catalog(descriptor("search", schema={"type": "object", "properties": "not-a-mapping"}))

    assert _reason(caught) is FailureReason.CATALOG_INVALID


def test_catalog_refuses_a_missing_description() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        _catalog(descriptor("search", description=""))

    assert _reason(caught) is FailureReason.CATALOG_INVALID


def test_catalog_refuses_too_many_tools() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        ToolCatalog(
            [descriptor(f"tool_{index}") for index in range(9)], max_tools=8, max_bytes=1 << 20
        )

    assert _reason(caught) is FailureReason.CATALOG_LIMIT


def test_catalog_refuses_an_oversize_catalog() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        ToolCatalog([descriptor("search")], max_tools=8, max_bytes=32)

    assert _reason(caught) is FailureReason.CATALOG_LIMIT


# -- argument admission --------------------------------------------------------


def test_valid_arguments_are_returned_as_a_mapping() -> None:
    catalog = _catalog(descriptor("search"))

    assert catalog.validate_arguments("search", {"query": "a", "limit": 3}) == {
        "query": "a",
        "limit": 3,
    }


def test_arguments_may_arrive_as_a_json_string() -> None:
    """The SDK can hand through a raw JSON string, so it is parsed and checked."""
    catalog = _catalog(descriptor("search"))

    assert catalog.validate_arguments("search", '{"query": "a"}') == {"query": "a"}


def test_missing_required_argument_is_refused() -> None:
    catalog = _catalog(descriptor("search"))

    with pytest.raises(RuntimeFailure) as caught:
        catalog.validate_arguments("search", {"limit": 1})

    assert _reason(caught) is FailureReason.INVALID_ARGUMENTS
    assert "query" in caught.value.detail


def test_wrong_argument_type_is_refused() -> None:
    catalog = _catalog(descriptor("search"))

    with pytest.raises(RuntimeFailure) as caught:
        catalog.validate_arguments("search", {"query": "a", "limit": "many"})

    assert _reason(caught) is FailureReason.INVALID_ARGUMENTS


def test_undeclared_argument_is_refused() -> None:
    catalog = _catalog(descriptor("search"))

    with pytest.raises(RuntimeFailure) as caught:
        catalog.validate_arguments("search", {"query": "a", "extra": True})

    assert _reason(caught) is FailureReason.INVALID_ARGUMENTS


def test_malformed_json_arguments_are_refused() -> None:
    catalog = _catalog(descriptor("search"))

    with pytest.raises(RuntimeFailure) as caught:
        catalog.validate_arguments("search", "{not json")

    assert _reason(caught) is FailureReason.INVALID_ARGUMENTS


def test_non_object_arguments_are_refused() -> None:
    catalog = _catalog(descriptor("search"))

    with pytest.raises(RuntimeFailure) as caught:
        catalog.validate_arguments("search", [1, 2, 3])

    assert _reason(caught) is FailureReason.INVALID_ARGUMENTS


def test_unknown_tool_is_refused() -> None:
    catalog = _catalog(descriptor("search"))

    with pytest.raises(RuntimeFailure) as caught:
        catalog.validate_arguments("missing", {})

    assert _reason(caught) is FailureReason.UNKNOWN_TOOL


# -- limits and deadline -------------------------------------------------------


def test_default_limits_sit_at_or_below_their_ceilings() -> None:
    RuntimeLimits().validated()


@pytest.mark.parametrize(
    "overrides",
    [
        {"steps": 9},
        {"steps": 0},
        {"tool_calls": 17},
        {"catalog_tools": 65},
        {"catalog_bytes": (64 * 1024) + 1},
        {"message_bytes": (256 * 1024) + 1},
        {"history_messages": 257},
        {"output_bytes": (64 * 1024) + 1},
        {"tool_result_bytes": (128 * 1024) + 1},
        {"progress_events": 65},
        {"corrections": 9},
        {"correction_bytes": (16 * 1024) + 1},
    ],
)
def test_a_limit_outside_its_range_is_refused(overrides: dict[str, int]) -> None:
    with pytest.raises(RuntimeFailure) as caught:
        RuntimeLimits(**overrides).validated()

    assert _reason(caught) is FailureReason.INVALID_REQUEST


def test_a_non_integer_limit_is_refused() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        RuntimeLimits(steps=True).validated()  # type: ignore[arg-type]

    assert _reason(caught) is FailureReason.INVALID_REQUEST


@pytest.mark.parametrize("deadline", [0.0, -1.0, 3600.1, math.inf, math.nan])
def test_unusable_deadlines_are_refused(deadline: float) -> None:
    with pytest.raises(RuntimeFailure) as caught:
        validate_deadline(deadline)

    assert _reason(caught) is FailureReason.INVALID_REQUEST


def test_a_usable_deadline_is_returned_as_a_float() -> None:
    assert validate_deadline(30) == 30.0
    assert validate_deadline(None) is None


@pytest.mark.parametrize("filename,valid", [
    ("报告.md", True), ("Résumé.md", True), ("report.md", True),
    ("../report.md", False), ("report.exe", False), ("😀.md", False),
])
def test_server_unicode_report_pattern(filename, valid) -> None:
    catalog = _catalog(descriptor("write_report", schema={
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {"name": {"type": "string", "pattern": r"^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,100}\.md$"}},
        "required": ["name"], "additionalProperties": False,
    }))
    if valid:
        assert catalog.validate_arguments("write_report", {"name": filename}) == {"name": filename}
    else:
        with pytest.raises(RuntimeFailure) as caught:
            catalog.validate_arguments("write_report", {"name": filename})
        assert caught.value.reason is FailureReason.INVALID_ARGUMENTS


@pytest.mark.parametrize("keyword", ["additionalProperties", "unevaluatedProperties"])
def test_unicode_pattern_properties_preserve_other_property_constraints(keyword) -> None:
    catalog = _catalog(descriptor("read", schema={
        "type": "object", "patternProperties": {r"^\p{L}+$": {"type": "integer"}}, keyword: False,
    }))
    assert catalog.validate_arguments("read", {"中文": 1}) == {"中文": 1}
    for invalid in [{"中文": "wrong type"}, {"!": 1}]:
        with pytest.raises(RuntimeFailure) as caught:
            catalog.validate_arguments("read", invalid)
        assert caught.value.reason is FailureReason.INVALID_ARGUMENTS


def test_invalid_regex_is_rejected_during_catalog_admission() -> None:
    with pytest.raises(RuntimeFailure) as caught:
        _catalog(descriptor("read", schema={"type": "object", "properties": {"x": {"pattern": "["}}}))
    assert caught.value.reason is FailureReason.CATALOG_INVALID
