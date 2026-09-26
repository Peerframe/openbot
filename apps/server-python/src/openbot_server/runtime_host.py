"""Control-owned model/tool gates around the untrusted SDK worker; this is not an Agent loop."""
import asyncio
from contextlib import asynccontextmanager
import json
import math
import re
from typing import Any

from pydantic import ValidationError

from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .runtime_ports import (ModelRequest, ModelStep, RuntimeBudget, RuntimeDenied, RuntimePorts,
                            RuntimeTool, ToolContext)
from .task_models import RunUsage

CONTROL_PROMPT = "Continue the Server-bound task."


def json_copy(value: Any, ceiling: int, code: str = "invalid_target") -> Any:
    """Bound and detach completed JSON; refuse cycles/depth, coercion and unencodable text."""
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > 64:
            raise RuntimeDenied(code)
        if type(item) is dict:
            if any(type(key) is not str for key in item):
                raise RuntimeDenied(code)
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            pending.extend((child, depth + 1) for child in item)
        elif type(item) not in (str, int, float, bool, type(None)):
            raise RuntimeDenied(code)
        elif type(item) in (int, float):
            try:
                finite = math.isfinite(float(item))
            except OverflowError:
                finite = False
            if not finite:
                raise RuntimeDenied(code)
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > ceiling:
            raise RuntimeDenied(code)
        return json.loads(encoded)
    except (ValueError, TypeError, RecursionError):
        raise RuntimeDenied(code) from None


def json_equal(first: Any, second: Any) -> bool:
    # Python equates True with 1; JSON/JavaScript do not. Integral JSON floats remain numbers.
    if type(first) in (int, float) and type(second) in (int, float):
        return first == second
    if type(first) is not type(second):
        return False
    if type(first) is dict:
        return first.keys() == second.keys() and all(json_equal(first[k], second[k]) for k in first)
    if type(first) is list:
        return len(first) == len(second) and all(json_equal(a, b) for a, b in zip(first, second))
    return first == second


def text_units(text: str) -> int:
    try:
        return len(text.encode("utf-16-le")) // 2
    except UnicodeError:
        raise RuntimeDenied("invalid_target") from None


def usage_count(value: Any) -> int | None:
    if type(value) not in (int, float) or not 0 <= value <= 1_000_000_000 or value != int(value):
        return None
    return int(value)


class RuntimeHost:
    def __init__(self, ports: RuntimePorts, *, instructions: str, messages: list[dict],
                 budget: RuntimeBudget, cancelled: asyncio.Event | None = None):
        if type(instructions) is not str or not isinstance(budget, RuntimeBudget):
            raise RuntimeDenied("invalid_target")
        if any(type(value) is not int or not 0 <= value <= ceiling for value, ceiling in (
            (budget.steps, 8), (budget.tools, 16), (budget.web, 4))):
            raise RuntimeDenied("invalid_target")
        if budget.usage is not None and (not isinstance(budget.usage, RunUsage)
            or budget.usage.provider != ports.identity.provider or budget.usage.model != ports.identity.model
            or budget.usage.steps > budget.steps):
            raise RuntimeDenied("invalid_target")
        self.ports, self.budget = ports, budget
        self.instructions = instructions
        self._original = json_copy(messages, 256 * 1024, "task_limit")
        if not self._original or len(self._original) > 128 or any(
            type(message) is not dict or message.get("role") not in ("user", "assistant", "tool")
            or "content" not in message or "providerOptions" in message for message in self._original
        ):
            raise RuntimeDenied("invalid_target")
        # Provider resolution is trusted composition, never a string gateway selected by a worker.
        try:
            RunUsage(provider=ports.identity.provider, model=ports.identity.model, steps=1,
                     inputTokens=None, outputTokens=None)
        except (AttributeError, ValidationError):
            raise RuntimeDenied("invalid_target") from None
        self.cancelled = cancelled if cancelled is not None else asyncio.Event()
        self._busy = self._closed = False
        self._failure: BaseException | None = None
        self._catalog: list[dict] | None = None
        self._tools: dict[str, RuntimeTool] = {}
        self._pending: dict[str, dict] = {}
        self._last: dict | None = None
        self._messages: list[dict] = []
        self._transcript = [{"role": "user", "content": CONTROL_PROMPT}]

    def _local_check(self) -> None:
        if self._failure is not None:
            raise self._failure
        task = asyncio.current_task()
        if self.cancelled.is_set() or (task is not None and task.cancelling()):
            raise asyncio.CancelledError()
        if self._closed:
            raise RuntimeDenied("conflict")

    async def _check(self) -> None:
        self._local_check()
        await self.ports.assert_active()
        self._local_check()

    @asynccontextmanager
    async def _operation(self):
        acquired = False
        try:
            if self._busy:
                raise RuntimeDenied("conflict")
            self._busy, acquired = True, True
            await self._check()
            yield
            await self._check()
        except BaseException as error:
            if self._failure is None:
                self._failure = error
            raise self._failure
        finally:
            if acquired:
                self._busy = False

    async def assert_active(self) -> None:
        async with self._operation():
            pass

    async def catalog(self) -> list[dict]:
        async with self._operation():
            if self._catalog is None:
                if len(self.ports.tools) > 64:
                    raise RuntimeDenied("task_limit")
                catalog, tools = [], {}
                for tool in self.ports.tools:
                    if (not isinstance(tool, RuntimeTool) or type(tool.name) is not str
                        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}", tool.name)
                        or tool.name in tools or type(tool.description) is not str or not tool.description
                        or type(tool.input_schema) is not dict or not callable(tool.validate)
                        or not callable(tool.execute) or type(tool.web) is not bool
                        or type(tool.maximum_result_bytes) is not int or not 1 <= tool.maximum_result_bytes <= 128 * 1024):
                        raise RuntimeDenied("invalid_target")
                    catalog.append({"name": tool.name, "description": tool.description, "inputSchema": tool.input_schema})
                    tools[tool.name] = tool
                self._catalog = json_copy(catalog, 64 * 1024, "task_limit")
                self._tools = tools
            return json_copy(self._catalog, 64 * 1024)

    async def _progress(self, stage: str, message: str) -> None:
        await self._check()
        await self.ports.progress(stage, message)
        await self._check()

    async def _emit(self, text: str) -> None:
        try:
            await self._check()
            if type(text) is not str or text_units(text) > 8000:
                raise RuntimeDenied("task_limit")
            if self.ports.output:
                self.ports.output(text, False)
            await self._check()
        except BaseException as error:
            # Provider SDKs may catch callback errors. A refused stream must still poison this
            # invocation; a later valid model return cannot erase that authority/limit decision.
            if self._failure is None:
                self._failure = error
            raise self._failure

    def _add_usage(self, result: ModelStep) -> tuple[RunUsage, dict]:
        previous = self.budget.usage
        def total(name, value):
            prior = getattr(previous, name) if previous else 0
            return usage_count(prior + value) if prior is not None and value is not None else None
        counts = {"inputTokens": usage_count(result.input_tokens), "outputTokens": usage_count(result.output_tokens)}
        usage = RunUsage(provider=self.ports.identity.provider, model=self.ports.identity.model,
                         steps=(previous.steps if previous else 0) + 1,
                         inputTokens=total("inputTokens", counts["inputTokens"]),
                         outputTokens=total("outputTokens", counts["outputTokens"]))
        return usage, counts

    async def generate(self, raw_messages: Any) -> dict:
        async with self._operation():
            if self._catalog is None or self._pending:
                raise RuntimeDenied("conflict")
            wire = json_copy(raw_messages, 256 * 1024, "task_limit")
            if type(wire) is not list or not 1 <= len(wire) <= 128 or not json_equal(wire, self._transcript):
                raise RuntimeDenied("invalid_target")
            messages = json_copy(self._original + wire[1:], 256 * 1024, "task_limit")
            if len(messages) > 128:
                raise RuntimeDenied("task_limit")
            budget = self.budget
            if budget.steps >= 8 or (budget.usage and ((budget.usage.inputTokens or 0) >= 64000 or (budget.usage.outputTokens or 0) >= 5120)):
                raise RuntimeDenied("task_limit")
            budget.steps += 1
            self._last = None
            await self._progress("planning", f"Model step {budget.steps}.")
            corrections = await self.ports.corrections()
            await self._check()
            corrections = json_copy(corrections, 40 * 1024, "task_limit")
            if (type(corrections) is not list or len(corrections) > 8 or any(
                type(item) is not dict or set(item) != {"id", "instruction"}
                or type(item["id"]) is not str or not item["id"]
                or type(item["instruction"]) is not str for item in corrections)
                or len({item["id"] for item in corrections}) != len(corrections)):
                raise RuntimeDenied("invalid_target")
            if corrections:
                messages.append({"role": "user", "content":
                    "Owner corrections for this exact task, ordered oldest to newest. Apply to future work only; they grant no additional tools, attachments or authority.\n"
                    + json.dumps(corrections, ensure_ascii=False, separators=(",", ":"))})
            await self._check()
            if self.ports.output:
                self.ports.output("", True)
            try:
                result = await self.ports.generate(ModelRequest(self.instructions, json_copy(messages, 300 * 1024),
                    json_copy(self._catalog, 64 * 1024), 4096 if self.ports.identity.provider == "moonshot" else 1024), self._emit)
            except (RuntimeDenied, asyncio.CancelledError):
                raise
            except Exception:
                raise RuntimeDenied("model_unavailable") from None
            await self._check()
            if not isinstance(result, ModelStep):
                raise RuntimeDenied("model_unavailable")
            usage, counts = self._add_usage(result)
            budget.usage = usage
            await self.ports.save_usage(usage.model_copy(deep=True))
            await self._check()
            if (type(result.text) is not str or text_units(result.text) > 8000
                or result.finish_reason not in ("stop", "tool-calls") or type(result.tools) is not list
                or len(result.tools) > 16 - budget.tools):
                raise RuntimeDenied("task_limit")
            intents = json_copy(result.tools, 256 * 1024)
            admitted = {}
            for intent in intents:
                if (type(intent) is not dict or set(intent) != {"id", "name", "arguments"}
                    or type(intent["id"]) is not str or not 1 <= len(intent["id"]) <= 256
                    or type(intent["name"]) is not str or intent["name"] not in self._tools
                    or type(intent["arguments"]) is not dict or intent["id"] in admitted):
                    raise RuntimeDenied("invalid_target")
                admitted[intent["id"]] = intent
            self._pending = admitted
            self._messages = json_copy(messages, 300 * 1024)
            parts = ([{"type": "text", "text": result.text}] if result.text else []) + [
                {"type": "tool-call", "toolCallId": item["id"], "toolName": item["name"], "input": item["arguments"]} for item in intents]
            self._transcript.append({"role": "assistant", "content": parts})
            if not intents:
                text = result.text.strip(_ECMASCRIPT_WHITESPACE)
                if result.finish_reason != "stop" or not text:
                    raise RuntimeDenied("task_limit")
                self._last = {"text": text, "appliedCorrectionIds": [item["id"] for item in corrections]}
                await self._emit(text)
            return json_copy({"text": result.text, "tools": intents, "usage": counts}, 524288)

    async def execute_tool(self, raw_intent: Any) -> Any:
        async with self._operation():
            intent = json_copy(raw_intent, 256 * 1024)
            admitted = self._pending.get(intent.get("id")) if type(intent) is dict and type(intent.get("id")) is str else None
            if admitted is None or not json_equal(intent, admitted):
                raise RuntimeDenied("invalid_target")
            # Consumed before validation/effects. A refused or uncertain side effect is never replayed.
            del self._pending[admitted["id"]]
            tool = self._tools[admitted["name"]]
            try:
                arguments = await tool.validate(json_copy(admitted["arguments"], 256 * 1024))
            except (RuntimeDenied, asyncio.CancelledError):
                raise
            except Exception:
                raise RuntimeDenied("invalid_target") from None
            await self._check()
            arguments = json_copy(arguments, 256 * 1024)
            if type(arguments) is not dict:
                raise RuntimeDenied("invalid_target")
            if self.budget.tools >= 16 or (tool.web and self.budget.web >= 4):
                raise RuntimeDenied("task_limit")
            self.budget.tools += 1
            if tool.web:
                self.budget.web += 1
                await self._progress("observation", f"Started {tool.name}.")
            await self._check()
            try:
                value = await tool.execute(arguments, ToolContext(admitted["id"], json_copy(self._messages, 300 * 1024)))
                await self._check()
                value = json_copy(value, tool.maximum_result_bytes, "tool_unavailable")
                await self._progress("observation", f"Completed {tool.name}.")
            except BaseException as error:
                if tool.web and not isinstance(error, asyncio.CancelledError):
                    try:
                        await self._progress("observation", f"Failed {tool.name}.")
                    except BaseException:
                        # Lost scope/storage cannot grant an audit write or replace the first denial.
                        pass
                if isinstance(error, (RuntimeDenied, asyncio.CancelledError)):
                    raise
                raise RuntimeDenied("tool_unavailable") from None
            part = {"type": "tool-result", "toolCallId": admitted["id"], "toolName": tool.name,
                    "output": {"type": "json", "value": value}}
            if self._transcript[-1]["role"] == "tool":
                self._transcript[-1]["content"].append(part)
            else:
                self._transcript.append({"role": "tool", "content": [part]})
            return json_copy(value, tool.maximum_result_bytes)

    async def finish(self, text: str) -> dict:
        async with self._operation():
            if (type(text) is not str or self._last is None or self._pending
                or text.strip(_ECMASCRIPT_WHITESPACE) != self._last["text"]):
                raise RuntimeDenied("conflict")
            result = json_copy(self._last, 40 * 1024)
        self._closed = True
        return result

    async def dispatch(self, request: dict) -> dict:
        if request["method"] == "authority.check":
            await self.assert_active()
            return {}
        if request["method"] == "model.generate":
            return await self.generate(request["params"]["messages"])
        if request["method"] == "tool.execute":
            return {"value": await self.execute_tool(request["params"])}
        raise RuntimeDenied("invalid_target")
