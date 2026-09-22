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

from jsonschema_rs import Draft202012Validator, FancyRegexOptions
from pydantic_ai.tools import ToolDefinition

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


# Unicode character classes need the released engine's normal compiled-size allowance.
# Offline mode disables all external reference retrieval, including file URIs.
_PATTERN_OPTIONS: Final = FancyRegexOptions(
    backtrack_limit=10_000, size_limit=10 * 1024 * 1024, dfa_size_limit=2 * 1024 * 1024
)


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
            try:
                validators[name] = Draft202012Validator(
                    schema, offline=True, validate_formats=False, pattern_options=_PATTERN_OPTIONS
                )
            except ValueError as exc:
                raise RuntimeFailure(
                    FailureReason.CATALOG_INVALID,
                    f"tool {name!r} declares an unsupported or invalid JSON Schema",
                ) from exc
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
                f"{'/'.join(str(part) for part in error.instance_path) or '<root>'}: {error.message}"
                for error in validator.iter_errors(parsed)
            ]
        except Exception as exc:
            # A validator failure (including a regex limit) seals the run; no fallback
            # or retrieval path can broaden the admitted arguments.
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
    return schema


__all__ = ["ToolCatalog"]
