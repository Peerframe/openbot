import {
  type Artifact,
  type ChannelRealtimeEvent,
  type Message,
  type MessageReaction,
  type Run,
  type RunOutput,
  reactionEmojis,
} from "@openbot/domain";
import {
  demoArtifact,
  demoBots,
  demoChannel,
  demoMessage,
  demoPrompt,
  demoReport,
  demoRun,
  demoTime,
} from "./fixtures";

export interface DemoSnapshot {
  revision: number;
  playing: boolean;
  stage: number;
  tick: number;
  messages: Message[];
  runs: Run[];
  artifacts: Artifact[];
}
const replyText =
  "这是一条示例回复：正式工作区会把消息和引用关系交给所选 Bot。这里仅演示消息交互，内容不会发送到模型。";
const researchText =
  "功能梳理完成：\n\n- **频道协作**：Bot 按身份接收任务，可以邀请另一位 Bot。\n- **持续沟通**：查看逐段回复，并在执行中补充要求。\n- **文件交付**：把整理后的结果保存为 Markdown。";
const reviewText =
  "表达已检查。建议用「**一个频道，完成协作**」作为开头；把能力、过程和交付分开写，读者更容易理解。";
const finalText =
  "已合并 Nova 的功能梳理和 Otto 的表达建议。\n\n发布介绍整理好了，点击下面的文件即可下载。";

/** An entry-local transport. It has no reference to the original fetch and cannot fall through. */
export class DemoAdapter {
  private listeners = new Set<() => void>();
  protected sources = new Set<EventTarget>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private replies: Array<{ runId: string; text: string; part: number; replyTo: string }> = [];
  private reactions: MessageReaction[] = [];
  protected outputs = new Map<string, RunOutput>();
  private nextId = 0;
  protected snapshot: DemoSnapshot = {
    revision: 0,
    playing: false,
    stage: 0,
    tick: 0,
    messages: [demoMessage("demo-request", demoPrompt)],
    runs: [],
    artifacts: [],
  };
  constructor(protected readonly origin: string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(update: Partial<DemoSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...update, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  protected event(event: ChannelRealtimeEvent) {
    for (const source of this.sources)
      source.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
  }
  connect(source: EventTarget, url: string) {
    const target = new URL(url, this.origin);
    if (
      target.origin !== this.origin ||
      target.pathname !== `/api/v1/channels/${demoChannel.id}/events` ||
      target.search
    )
      throw new TypeError("演示不连接外部事件服务。");
    this.sources.add(source);
    this.ensureTimer();
    queueMicrotask(() => {
      if (this.sources.has(source))
        source.dispatchEvent(
          new MessageEvent("channel.ready", {
            data: JSON.stringify({
              type: "channel.ready",
              channelId: demoChannel.id,
              occurredAt: demoTime,
            }),
          }),
        );
    });
    return () => {
      this.sources.delete(source);
    };
  }
  play = () => {
    if (this.snapshot.tick >= 32 && !this.replies.length) return;
    this.publish({ playing: true });
    this.ensureTimer();
  };
  pause = () => {
    this.publish({ playing: false });
  };
  restart = () => {
    this.replies = [];
    this.reactions = [];
    this.outputs.clear();
    this.publish({
      playing: false,
      stage: 0,
      tick: 0,
      messages: [demoMessage("demo-request", demoPrompt)],
      runs: [],
      artifacts: [],
    });
  };
  finish = () => {
    while (this.snapshot.tick < 32) this.advance();
    this.pause();
  };
  dispose = () => {
    clearInterval(this.timer);
    this.sources.clear();
    this.listeners.clear();
  };
  private ensureTimer() {
    this.timer ??= setInterval(() => {
      for (const source of this.sources) source.dispatchEvent(new Event("heartbeat"));
      if (this.snapshot.playing) this.advance();
    }, 650);
  }
  private addMessage(message: Message) {
    this.publish({ messages: [...this.snapshot.messages, message].slice(-100) });
    this.event({ type: "message.created", channelId: demoChannel.id, message });
  }
  private addRun(run: Run) {
    this.publish({ runs: [...this.snapshot.runs, run].slice(-100) });
    this.event({ type: "run.created", channelId: demoChannel.id, run });
  }
  private endRun(id: string, status: Run["status"] = "completed", artifacts: Artifact[] = []) {
    const current = this.snapshot.runs.find((run) => run.id === id);
    if (current?.status !== "running") return;
    const run = {
      ...current,
      status,
      updatedAt: new Date(Date.parse(demoTime) + this.snapshot.tick * 1000).toISOString(),
    };
    this.outputs.delete(id);
    this.publish({
      runs: this.snapshot.runs.map((item) => (item.id === id ? run : item)),
      artifacts: [...this.snapshot.artifacts, ...artifacts],
    });
    this.event({ type: "run.updated", channelId: demoChannel.id, run, artifacts });
  }
  protected output(id: string, text: string) {
    const run = this.snapshot.runs.find((item) => item.id === id);
    if (run?.status !== "running") return;
    const output = {
      runId: id,
      channelId: demoChannel.id,
      botId: run.botId,
      text,
      reset: false,
      sequence: (this.outputs.get(id)?.sequence ?? 0) + 1,
    };
    this.outputs.set(id, output);
    this.event({ type: "run.output", ...output });
  }
  private finishReply(
    runId: string,
    content: string,
    id: string,
    offset: number,
    artifacts: Artifact[] = [],
  ) {
    const run = this.snapshot.runs.find((item) => item.id === runId);
    if (run?.status !== "running") return;
    this.addMessage(demoMessage(id, content, run.botId, runId, offset));
    this.endRun(runId, "completed", artifacts);
  }
  advance = () => {
    const tick = Math.min(32, this.snapshot.tick + 1);
    this.publish({ tick, stage: tick < 3 ? 0 : tick < 26 ? 1 : 2 });
    if (tick === 1 && !this.snapshot.runs.some((run) => run.id === "demo-root"))
      this.addRun(demoRun("demo-root", "demo-editor", "整理 OpenBot 发布介绍", "demo-request"));
    if (
      tick === 3 &&
      this.snapshot.runs.find((run) => run.id === "demo-root")?.status === "running"
    ) {
      this.addMessage(
        demoMessage(
          "demo-delegate-research",
          "Nova，请把频道协作、沟通和文件交付梳理成简洁的功能清单。",
          "demo-editor",
          "demo-root",
          3,
        ),
      );
      this.addRun(
        demoRun(
          "demo-research-task",
          "demo-research",
          "梳理功能清单",
          "demo-delegate-research",
          "demo-root",
        ),
      );
    }
    if (
      tick === 5 &&
      this.snapshot.runs.find((run) => run.id === "demo-root")?.status === "running"
    ) {
      this.addMessage(
        demoMessage(
          "demo-delegate-review",
          "Otto，请从新用户的角度检查介绍结构。我会同步整理交付文档。",
          "demo-editor",
          "demo-root",
          5,
        ),
      );
      this.addRun(
        demoRun(
          "demo-review-task",
          "demo-review",
          "检查介绍结构",
          "demo-delegate-review",
          "demo-root",
        ),
      );
    }
    if (tick >= 7 && tick <= 16)
      this.output(
        "demo-research-task",
        researchText.slice(0, Math.ceil((researchText.length * (tick - 6)) / 10)),
      );
    if (tick === 17)
      this.finishReply("demo-research-task", researchText, "demo-research-result", 17);
    if (tick >= 12 && tick <= 21)
      this.output(
        "demo-review-task",
        reviewText.slice(0, Math.ceil((reviewText.length * (tick - 11)) / 10)),
      );
    if (tick === 22) this.finishReply("demo-review-task", reviewText, "demo-review-result", 22);
    if (tick >= 25 && tick <= 31)
      this.output("demo-root", finalText.slice(0, Math.ceil((finalText.length * (tick - 24)) / 7)));
    if (tick === 32) this.finishReply("demo-root", finalText, "demo-final", 32, [demoArtifact]);
    for (const reply of this.replies) {
      reply.part += 1;
      this.output(
        reply.runId,
        reply.text.slice(0, Math.ceil((reply.text.length * reply.part) / 6)),
      );
      if (reply.part === 7) {
        const run = this.snapshot.runs.find((item) => item.id === reply.runId);
        if (run?.status === "running")
          this.addMessage({
            ...demoMessage(
              `${reply.runId}-answer`,
              reply.text,
              run.botId,
              run.id,
              100 + this.nextId * 2,
            ),
            replyToMessageId: reply.replyTo,
          });
        this.endRun(reply.runId);
      }
    }
    this.replies = this.replies.filter((reply) => reply.part < 7);
    if (tick === 32 && !this.replies.length) this.pause();
  };
  /** Opt-in fixture subclasses receive only already bounded, same-origin parsed requests. */
  protected handleFixtureRequest(
    _method: string,
    _path: string,
    _body: Record<string, unknown>,
  ): Response | undefined {
    return undefined;
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), this.origin);
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    if (url.origin !== this.origin || url.search || url.hash || url.username || url.password)
      throw new TypeError("交互演示不连接外部服务。");
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const prefix = `/api/v1/channels/${demoChannel.id}`;
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const raw = typeof init?.body === "string" ? init.body : request ? await request.text() : "";
    if (raw.length > 10000) return json({ error: "演示消息过长。" }, 413);
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
        if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
      } catch {
        return json({ error: "无效的演示请求。" }, 400);
      }
    }
    const fixtureResponse = this.handleFixtureRequest(method, path, body);
    if (fixtureResponse) return fixtureResponse;
    if (method === "GET") {
      if (path === `${prefix}/messages`) return json({ messages: this.snapshot.messages });
      if (path === `${prefix}/runs`) return json({ runs: this.snapshot.runs });
      if (path === `${prefix}/reactions`) return json({ reactions: this.reactions });
      if (path === `${prefix}/attachments`) return json({ attachments: [] });
      if (path === "/api/v1/plugins") return json({ plugins: [], pendingCalls: [] });
      for (const bot of demoBots)
        if (path === `/api/v1/bots/${bot.id}/profile`)
          return json({ profile: { employee: bot, skills: [] } });
      for (const run of this.snapshot.runs) {
        // Demo/fixture Runs have no durable Server call ledger; only this read is allowlisted.
        if (path === `/api/v1/runs/${run.id}/plugin-calls`) return json({ calls: [] });
        if (path === `/api/v1/runs/${run.id}/output`)
          return json({ output: this.outputs.get(run.id) ?? null });
      }
    }
    if (method === "PUT" && path.startsWith(`${prefix}/messages/`) && path.endsWith("/reactions")) {
      const id = path.slice(`${prefix}/messages/`.length, -"/reactions".length);
      if (
        !this.snapshot.messages.some((message) => message.id === id) ||
        !reactionEmojis.includes(body.emoji as never) ||
        typeof body.active !== "boolean"
      )
        return json({ error: "无效的表情操作。" }, 400);
      this.reactions = this.reactions.filter(
        (item) => item.messageId !== id || item.emoji !== body.emoji,
      );
      if (body.active)
        this.reactions.push({
          messageId: id,
          emoji: body.emoji as MessageReaction["emoji"],
          actor: "owner",
        });
      const reactions = this.reactions.filter((item) => item.messageId === id);
      this.event({
        type: "message.reactions",
        channelId: demoChannel.id,
        messageId: id,
        reactions,
      });
      return json({ reactions });
    }
    if (method === "POST" && path === `${prefix}/messages`) {
      if (
        typeof body.content !== "string" ||
        !body.content.trim() ||
        body.content.length > 8000 ||
        this.replies.length >= 4 ||
        this.snapshot.messages.length >= 90
      )
        return json({ error: "请缩短消息或重播演示后继续。" }, 400);
      const recipients = body.botIds ?? [body.botId ?? "demo-editor"];
      if (
        !Array.isArray(recipients) ||
        recipients.length < 1 ||
        recipients.length > 3 ||
        new Set(recipients).size !== recipients.length ||
        recipients.some((id) => typeof id !== "string" || !demoBots.some((bot) => bot.id === id)) ||
        this.replies.length + recipients.length > 4 ||
        (body.replyToMessageId !== undefined &&
          !this.snapshot.messages.some((item) => item.id === body.replyToMessageId))
      )
        return json({ error: "演示对象无效。" }, 400);
      const id = `demo-interaction-${++this.nextId}`;
      const message = {
        ...demoMessage(id, body.content, undefined, undefined, 99 + this.nextId * 2),
        ...(typeof body.replyToMessageId === "string"
          ? { replyToMessageId: body.replyToMessageId }
          : {}),
      };
      const runs = (recipients as string[]).map((botId, index) =>
        demoRun(`${id}-run${index ? `-${index}` : ""}`, botId, "回应体验消息（示例）", id),
      );
      this.addMessage(message);
      for (const run of runs) {
        this.addRun(run);
        this.replies.push({ runId: run.id, text: replyText, part: 0, replyTo: id });
      }
      this.play();
      return json({ message, run: runs[0], runs: runs.slice(1) });
    }
    for (const run of this.snapshot.runs)
      if (method === "POST" && path === `/api/v1/runs/${run.id}/cancel`) {
        this.endRun(run.id, "cancelled");
        if (run.id === "demo-root") {
          for (const child of this.snapshot.runs.filter((item) => item.parentRunId === run.id))
            this.endRun(child.id, "cancelled");
          this.pause();
        }
        return json({ run: this.snapshot.runs.find((item) => item.id === run.id) });
      }
    return json({ error: "此入口只演示频道协作；请在自己的 OpenBot 工作区使用完整功能。" }, 403);
  };
  download(path: string): { name: string; content: string } | undefined {
    return path === `/api/v1/artifacts/${demoArtifact.id}/content` && this.snapshot.artifacts.length
      ? { name: demoArtifact.name, content: demoReport }
      : undefined;
  }
}
