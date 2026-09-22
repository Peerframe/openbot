"""Catalog construction and argument admission.

Argument validation belongs here for a verified reason: the SDK's own
``Tool.from_schema`` builds its argument validator as
``SchemaValidator(schema=core_schema.any_schema())`` and documents that "schema
validation of the arguments is skipped", because a JSON Schema cannot be compiled
into a pydantic-core schema without an extra translation layer. The Server hands
the unit JSON input schemas, so the unit validates against them itself and never
forwards unchecked arguments to the tool authority. See RESEARCH.md §3.5 and §4.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, Final

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic_ai.tools import ToolDefinition
from referencing import Registry
from referencing.exceptions import NoSuchResource

from .bounds import json_utf8_size, utf8_size
from .contracts import (
    MAX_TOOL_DESCRIPTION_BYTES,
    MAX_TOOL_NAME_CHARS,
    ToolDescriptor,
)
from .errors import FailureReason, RuntimeFailure

_TOOL_NAME_PATTERN: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_MAX_REPORTED_VIOLATIONS: Final = 3
_MAX_VIOLATION_CHARS: Final = 160


def _refuse_external_schema(uri: str) -> Any:
    """Refuse every URI retrieval an argument schema could otherwise trigger.

    Tool input schemas are Server-declared data and must be self-contained. A
    ``$ref``/``$dynamicRef`` that does not resolve inside the schema itself is a
    request to fetch a URI, and resolving it is what would let an untrusted
    description reach the network or the filesystem during argument admission. This
    function is installed as the registry's *only* retrieval path, so no default
    retriever remains to fall back on: an external reference is unresolvable by
    construction rather than by luck.
    """
    raise NoSuchResource(ref=uri)


SCHEMA_REGISTRY: Final = Registry(retrieve=_refuse_external_schema)
"""Referencing registry with no retrieval path.

Internal ``#/...`` references still resolve against the schema itself; external
ones raise ``Unresolvable`` (surfaced through jsonschema as a wrapped referencing
error) instead of being fetched. Verified against the pinned ``referencing`` and
``jsonschema`` builds in RESEARCH.md §3.6.
"""


class ToolCatalog:
    """An immutable, validated view of the tool descriptors offered for one run."""

    def __init__(
        self, descriptors: Sequence[ToolDescriptor], *, max_tools: int, max_bytes: int
    ) -> None:
        if isinstance(descriptors, (str, bytes)) or not isinstance(descriptors, Sequence):
            raise RuntimeFailure(
                FailureReason.CATALOG_INVALID, "tool descriptors must be a sequence"
            )
        if len(descriptors) > max_tools:
            raise RuntimeFailure(
                FailureReason.CATALOG_LIMIT,
                f"catalog declares {len(descriptors)} tools, above the limit of {max_tools}",
            )

        validated: list[ToolDescriptor] = []
        validators: dict[str, Draft202012Validator] = {}
        for descriptor in descriptors:
            if not isinstance(descriptor, ToolDescriptor):
                raise RuntimeFailure(
                    FailureReason.CATALOG_INVALID,
                    f"catalog entries must be ToolDescriptor, got {type(descriptor).__name__}",
                )
            name = _validate_name(descriptor)
            if name in validators:
                raise RuntimeFailure(
                    FailureReason.CATALOG_INVALID, f"duplicate tool name {name!r} in catalog"
                )
            schema = _validate_schema(name, descriptor)
            validators[name] = Draft202012Validator(schema, registry=SCHEMA_REGISTRY)
            validated.append(
                ToolDescriptor(
                    name=name, description=descriptor.description, input_schema=schema
                )
            )

        payload = [
            {"name": item.name, "description": item.description, "input_schema": item.input_schema}
            for item in validated
        ]
        total_bytes = json_utf8_size(payload)
        if total_bytes > max_bytes:
            raise RuntimeFailure(
                FailureReason.CATALOG_LIMIT,
                f"catalog occupies {total_bytes} bytes, above the limit of {max_bytes}",
            )

        self._descriptors: tuple[ToolDescriptor, ...] = tuple(validated)
        self._validators = validators
        self._bytes = total_bytes

    @property
    def descriptors(self) -> tuple[ToolDescriptor, ...]:
        return self._descriptors

    @property
    def names(self) -> frozenset[str]:
        return frozenset(self._validators)

    @property
    def bytes(self) -> int:
        """Serialized catalog size, as measured against the catalog byte limit."""
        return self._bytes

    def descriptor(self, name: str) -> ToolDescriptor:
        """Return the descriptor for ``name`` or refuse an unknown tool."""
        for descriptor in self._descriptors:
            if descriptor.name == name:
                return descriptor
        raise RuntimeFailure(FailureReason.UNKNOWN_TOOL, f"unknown tool {name!r}")

    def sdk_definitions(self) -> dict[str, ToolDefinition]:
        """Tool definitions for the SDK toolset, preserving declared schemas."""
        return {
            descriptor.name: ToolDefinition(
                name=descriptor.name,
                description=descriptor.description,
                parameters_json_schema=dict(descriptor.input_schema),
            )
            for descriptor in self._descriptors
        }

    def validate_arguments(self, name: str, raw: Any) -> dict[str, Any]:
        """Admit a tool call's arguments or refuse the whole call.

        A refusal is terminal for the run: it is never converted into a retry
        prompt or a failed observation the model could route around.
        """
        validator = self._validators.get(name)
        if validator is None:
            raise RuntimeFailure(FailureReason.UNKNOWN_TOOL, f"unknown tool {name!r}")

        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except ValueError as exc:
                raise RuntimeFailure(
                    FailureReason.INVALID_ARGUMENTS,
                    f"arguments for {name!r} are not valid JSON: {type(exc).__name__}",
                ) from exc
        elif isinstance(raw, Mapping):
            parsed = dict(raw)
        else:
            parsed = raw

        if not isinstance(parsed, dict):
            raise RuntimeFailure(
                FailureReason.INVALID_ARGUMENTS,
                f"arguments for {name!r} must be a JSON object, got {type(parsed).__name__}",
            )

        try:
            violations = [
                f"{'/'.join(str(part) for part in error.absolute_path) or '<root>'}: {error.message}"
                for error in validator.iter_errors(parsed)
            ]
        except Exception as exc:
            # ``iter_errors`` is lazy, so an unresolvable reference only surfaces while
            # the violations are collected. That is a refusal (the arguments cannot be
            # checked against the declaration), not a crash, and it is never a reason to
            # fetch the URI.
            raise RuntimeFailure(
                FailureReason.INVALID_ARGUMENTS,
                f"arguments for {name!r} cannot be checked against its input schema: "
                f"{type(exc).__name__}",
            ) from exc
        if violations:
            reported = "; ".join(violations[:_MAX_REPORTED_VIOLATIONS])[:_MAX_VIOLATION_CHARS]
            raise RuntimeFailure(
                FailureReason.INVALID_ARGUMENTS,
                f"arguments for {name!r} violate its input schema ({len(violations)} violation(s)): "
                f"{reported}",
            )
        return parsed


def _validate_name(descriptor: ToolDescriptor) -> str:
    name = descriptor.name
    if not isinstance(name, str) or not name or len(name) > MAX_TOOL_NAME_CHARS:
        raise RuntimeFailure(
            FailureReason.CATALOG_INVALID,
            f"tool name must be a string of 1..{MAX_TOOL_NAME_CHARS} characters",
        )
    if not _TOOL_NAME_PATTERN.match(name):
        raise RuntimeFailure(
            FailureReason.CATALOG_INVALID,
            f"tool name {name!r} contains unsupported characters",
        )
    return name


def _validate_schema(name: str, descriptor: ToolDescriptor) -> dict[str, Any]:
    description = descriptor.description
    if not isinstance(description, str) or not description:
        raise RuntimeFailure(
            FailureReason.CATALOG_INVALID, f"tool {name!r} must declare a non-empty description"
        )
    if utf8_size(description) > MAX_TOOL_DESCRIPTION_BYTES:
        raise RuntimeFailure(
            FailureReason.CATALOG_LIMIT,
            f"tool {name!r} description exceeds {MAX_TOOL_DESCRIPTION_BYTES} bytes",
        )

    schema = descriptor.input_schema
    if not isinstance(schema, Mapping):
        raise RuntimeFailure(
            FailureReason.CATALOG_INVALID, f"tool {name!r} input schema must be a mapping"
        )
    if not schema:
        raise RuntimeFailure(
            FailureReason.CATALOG_INVALID, f"tool {name!r} input schema must not be empty"
        )
    declared_type = schema.get("type", "object")
    if declared_type != "object":
        raise RuntimeFailure(
            FailureReason.CATALOG_INVALID,
            f"tool {name!r} input schema must describe an object, got {declared_type!r}",
        )
    schema = dict(schema)
    schema.setdefault("type", "object")
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise RuntimeFailure(
            FailureReason.CATALOG_INVALID,
            f"tool {name!r} declares an invalid JSON Schema: {exc.message[:120]}",
        ) from exc
    return schema


__all__ = ["SCHEMA_REGISTRY", "ToolCatalog"]
