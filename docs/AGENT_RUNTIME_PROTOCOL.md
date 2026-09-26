# Agent runtime process profile v1

[English](AGENT_RUNTIME_PROTOCOL.md) · [简体中文](AGENT_RUNTIME_PROTOCOL.zh-CN.md)

Status: frozen for internal adapter implementation, not a production-enabled runtime or public API.
Research and scope: [transport review](research/python-runtime-transport.md).

## Authority and transport

One trusted installed Python process handles one invocation. The Server owns its executable,
arguments, environment, working directory and pipes; task data cannot choose any of them. JSON-RPC
2.0 objects use UTF-8 newline framing on stdin/stdout. Use only the exact object keys below;
reject batches, notifications, unknown fields, duplicate/replayed IDs and invalid JSON/UTF-8.
These restrictions form a private profile, not full MCP or general JSON-RPC interoperability.

The profile is `openbot-agent-runtime/1`. Limits: 524,288 bytes per frame excluding LF; 8 MiB per
direction per invocation; 64 KiB total stderr; 1,024 frames per direction; at most one outstanding
child request. Count bytes before decoding/dispatch and bound unterminated buffers. Stdout carries
only protocol, never banners or diagnostics. Discard stderr contents; exceeding its bound fails.
Each side flushes each frame. JSON values must be finite and have nesting depth at most 64.

Parent request ID is `run`; child IDs are `w1`, `w2`, ... monotonically increasing, up to `w512`.
Responses reuse the request's ID. Each response contains exactly one of `result` or `error`.
No authorization, account, Run ID, provider credentials or completion capability is transported.

## Parent invocation

The parent sends exactly one request:

```json
{"jsonrpc":"2.0","id":"run","method":"runtime.execute","params":{"protocol":"openbot-agent-runtime/1","tools":[],"deadlineMs":90000}}
```

`tools` contains up to 64 objects, collectively at most 64 KiB when JSON encoded:
`{name: string, description: string, inputSchema: object}`. Reuse the Python unit's tool validation.
`deadlineMs` is an integer from 1 to 300000, measured once on receipt. The parent independently
applies its own deadline/abort signal and shared Run budgets. Child bounds never expand those rules.

The Python adapter calls the existing real SDK executor with no instructions or corrections port,
the exact task `Continue the Server-bound task.`, the supplied tool descriptors and deadline.
Set catalog_tools=64, history_messages=128 and output_bytes=32000; other reviewed limits remain.
Never install dependencies, select a provider or implement a replacement handwritten Agent loop.

## Child requests

| Method | Exact params | Success result |
| --- | --- | --- |
| `authority.check` | `{}` | `{}` |
| `model.generate` | `{messages: WireMessage[]}` | `{text: string, tools: ToolIntent[], usage: {inputTokens: integer or null, outputTokens: integer or null}}` |
| `tool.execute` | `ToolIntent` | `{value: JSON}` |

`ToolIntent` is `{id: string, name: string, arguments: object}`. The model provider supplied the ID;
it is untrusted correlation, not permission or proof of exactly-once execution. The Server checks
exact current intent membership and consumes it before dispatch. IDs must be distinct within one
model response; a later model step may reuse a consumed ID only as a newly proposed intent. Pending
intents block the next model step. Wire request IDs still cannot be reused. The child must preserve
IDs and values.

Wire messages admit only these shapes:

- `{role: "user", content: string}`
- `{role: "assistant", content: [{type: "text", text: string} | {type: "tool-call", toolCallId: string, toolName: string, input: object}, ...]}`
- `{role: "tool", content: [{type: "tool-result", toolCallId: string, toolName: string, output: {type: "json", value: JSON}}, ...]}`

The first message is exactly `{role:"user",content:"Continue the Server-bound task."}`. It occurs
once; later user messages, system roles, media, provider options, retry prompts and unknown parts
are refused. Python maps SDK UserPromptPart, TextPart, ToolCallPart and ToolReturnPart to these
shapes in order; multiple consecutive return parts form one tool message. The message array has at
most 128 entries and occupies at most 256 KiB serialized. Tool arguments must be objects, including
when a model adapter supplied them as a JSON string. Reject unsupported SDK parts; do not stringify
or discard them silently.

The Server replaces the first control message with its original admitted messages, retains its
instructions/media and rereads corrections on every step. It persists provider-reported usage
before returning the response. Python translates response text/tools to a real SDK ModelResponse;
null usage may map to the SDK's unreported/default counter but must never be reported as observed
zero usage to Server. The Server's own durable record retains unknown counts.

There is no worker audit, usage-write, correction-write, approval or result-submit method.
`authority.check` never authorizes the next operation by itself; each Server operation rechecks.

## Results, errors and lifecycle

On SDK completion the child responds to `run` with `result:{text:string}` only, flushes and exits
zero. The Server requires valid bounded nonblank text matching its last model answer, no outstanding
operation, clean EOF and exit zero before accepting a provisional result. Only NativeAgentRunner
later publishes the reply/artifacts and commits Run state. Any extra frame after final is failure.

Application errors use `{code:-32000,message:"Runtime operation refused",data:{reason:string}}`.
The reason is a bounded fixed identifier (at most 64 ASCII lowercase letters/digits/underscores),
not raw exception text. Python may return its reviewed FailureReason value; Server owns the final
mapping. A Server port failure remains authoritative even if Python claims success afterward.
Protocol failures fail closed and close the channel; a valid request may receive the standard
-32600/-32601/-32602 error with a fixed message before closure. Never retry or resume an invocation.

Python watches parent EOF even while waiting on an SDK/port operation, cancels its main task and
exits nonzero without final success. No cancel RPC exists: Server cancellation closes the pipes
and terminates the invocation-owned POSIX process group, escalating SIGTERM to SIGKILL after a
bounded grace period. Success also requires clean child termination within the cleanup deadline.
Child EOF/crash, a deadline, malformed output, overlapping operations or a late result cannot
publish success. An ordinary child process is not a sandbox. This profile currently targets POSIX
integration tests; Linux application support requires separate evidence, and Windows is unclaimed.
