/** Live protected Host causal exchanges. Wire timestamps gain authority only after pinned verification. */
import { isDeepStrictEqual } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { commandPreparationBindingSchema } from "../../packages/protocol/dist/index.js";
import {
  CommandSigner,
  CommandVerifier,
  unverifiedCommandPayload,
} from "../../apps/server/dist/work-command-crypto.js";
import {
  commandExecutionBinding,
  commandPreparationBinding,
  commandTimeLower,
  commandTimeUpper,
  parseCommandClaims,
  timingPolicySchema,
  validateCommandTime,
  type CommandBindingV2,
  type CommandClaims,
  type TimingPolicy,
} from "../../apps/server/dist/work-command-contract.js";
import { commandTokenDigest } from "../../apps/server/dist/work-command-values.js";
import { requireFact } from "./protected-io.ts";
import { nativeClock } from "./kernel-facts.ts";
type Preparation = ReturnType<typeof commandPreparationBinding>;
type Sample = readonly [number, number, string];
type Verified<
  P extends "work_command_dispatch" | "work_command_permit" | "work_command_control_request",
> = { value: CommandClaims<P>; digest: string };
const seal = Symbol("protected exchange"),
  same = isDeepStrictEqual;
export class HostExchangeBook {
  readonly instanceId = randomUUID();
  readonly policy: TimingPolicy;
  readonly clock: () => Sample;
  readonly pending = new Map<string, PendingExchange>();
  readonly finished = new Set<string>();
  closed = false;
  constructor(policy: TimingPolicy, clock: () => Sample = nativeClock) {
    this.policy = timingPolicySchema.parse(policy);
    this.clock = clock;
  }
  sample() {
    const v = this.clock();
    requireFact(
      Array.isArray(v) &&
        v.length === 3 &&
        v.slice(0, 2).every((n) => Number.isSafeInteger(n) && Number(n) > 0) &&
        v[1] >= v[0],
      "invalid_host_clock",
    );
    commandPreparationBindingSchema.shape.preparationId.parse(v[2]);
    return v;
  }
  beginPrepare(binding: Preparation) {
    requireFact(!this.closed && this.pending.size < 64, "host_capacity");
    const b = commandPreparationBindingSchema.parse(binding);
    requireFact(!this.pending.has(b.actionId), "original_already_reserved");
    const p = new PendingExchange(this, "prepare", b, this.sample(), seal);
    this.pending.set(b.actionId, p);
    return p;
  }
  beginControl(binding: Preparation, requestId: string, operation: "lookup" | "stop") {
    commandPreparationBindingSchema.shape.preparationId.parse(requestId);
    requireFact(
      !this.closed &&
        this.pending.size < 64 &&
        this.finished.size + this.pending.size < 4096 &&
        ["lookup", "stop"].includes(operation) &&
        !this.pending.has(requestId) &&
        !this.finished.has(requestId),
      "control_replayed_or_capacity",
    );
    const p = new PendingExchange(
      this,
      operation,
      commandPreparationBindingSchema.parse(binding),
      this.sample(),
      seal,
    );
    p.requestId = requestId;
    this.pending.set(requestId, p);
    return p;
  }
  finishControl(p: PendingExchange) {
    requireFact(
      !this.closed &&
        p.book === this &&
        ["lookup", "stop"].includes(p.kind) &&
        p.control &&
        this.pending.get(p.requestId) === p &&
        this.finished.size < 4096,
      "invalid_control",
    );
    p.checkControl();
    this.finished.add(p.requestId);
    this.pending.delete(p.requestId);
    p.closed = true;
  }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) p.closed = true;
  }
}
export class PendingExchange {
  readonly book: HostExchangeBook;
  readonly kind: "prepare" | "consume" | "lookup" | "stop";
  readonly binding: Preparation | CommandBindingV2;
  readonly start: Sample;
  requestId: string;
  readonly nonce = randomBytes(32).toString("base64url");
  closed = false;
  challengeDigest?: string;
  authorization?: CommandClaims<"work_command_prepare_authorize">;
  authorizationDigest?: string;
  readinessDigest?: string;
  private anchor?: readonly [number, Sample, Sample];
  requestDigest?: string;
  dispatch?: Verified<"work_command_dispatch">;
  control?: Verified<"work_command_control_request">;
  constructor(
    book: HostExchangeBook,
    kind: PendingExchange["kind"],
    binding: Preparation | CommandBindingV2,
    start: Sample,
    key: symbol,
  ) {
    requireFact(key === seal, "invalid_exchange");
    this.book = book;
    this.kind = kind;
    this.binding = binding;
    this.start = start;
    this.requestId = kind === "prepare" ? binding.preparationId : randomUUID();
  }
  live() {
    requireFact(!this.closed && !this.book.closed, "exchange_closed");
    const now = this.book.sample();
    requireFact(
      now[2] === this.start[2] && now[0] >= this.start[0] && now[1] >= this.start[1],
      "host_clock_changed",
    );
    requireFact(
      Math.abs(now[1] - now[0] - (this.start[1] - this.start[0])) <=
        this.book.policy.clockQuantizationMs * 1000,
      "host_clock_suspended",
    );
    return now;
  }
  base(signer: CommandSigner, audience: string) {
    return {
      ...this.binding,
      version: 2,
      iss: signer.issuer,
      aud: audience,
      jti: randomUUID(),
      requestId: this.requestId,
      nonce: this.nonce,
    };
  }
  async challenge(signer: CommandSigner, audience: string) {
    requireFact(
      ["prepare", "lookup", "stop"].includes(this.kind) && !this.challengeDigest,
      "challenge_replayed",
    );
    this.live();
    const purpose =
      this.kind === "prepare" ? "work_command_prepare_challenge" : "work_command_control_challenge";
    const token = await signer.sign(purpose, {
      ...this.base(signer, audience),
      purpose,
      bootId: this.start[2],
      enforcerInstanceId: this.book.instanceId,
      createdBoottimeUs: this.start[1],
      expiresBoottimeUs: this.start[1] + this.book.policy.challengeBudgetMs * 1000,
      ...(this.kind === "prepare" ? {} : { operation: this.kind }),
    });
    this.challengeDigest = commandTokenDigest(token);
    return token;
  }
  async acceptAuthorization(
    token: string,
    verifier: CommandVerifier,
    issuer: string,
    audience: string,
  ) {
    requireFact(
      this.kind === "prepare" && !this.authorization && this.challengeDigest,
      "authorization_replayed",
    );
    const record = await verifier.verifyRecord(token, {
        purpose: "work_command_prepare_authorize",
        issuer,
        audience,
        binding: this.binding,
        request: { requestId: this.requestId, nonce: this.nonce },
      }),
      now = this.live(),
      v = record.value;
    requireFact(
      now[1] - this.start[1] < this.book.policy.challengeBudgetMs * 1000 &&
        v.challengeDigest === this.challengeDigest &&
        same(v.timing, this.book.policy),
      "authorization_changed_or_expired",
    );
    this.authorization = v;
    this.authorizationDigest = record.digest;
    this.anchor = [v.issuedAtMs, this.start, now];
    return record;
  }
  async ready(proof: unknown, signer: CommandSigner, audience: string) {
    requireFact(this.authorization && !this.readinessDigest, "readiness_replayed");
    const now = this.live(),
      v = await parseCommandClaims("work_command_ready", {
        ...this.base(signer, audience),
        purpose: "work_command_ready",
        authorizationDigest: this.authorizationDigest,
        inputDigest: this.authorization.staging.inputDigest,
        proof,
      });
    const p = v.proof;
    requireFact(
      p.bootId === this.start[2] &&
        p.enforcerInstanceId === this.book.instanceId &&
        p.runtimeMaxUs === this.book.policy.runtimeMaxMs * 1000 &&
        p.timingPolicyDigest === this.book.policy.policyDigest &&
        p.observedMonotonicUs <= now[0] &&
        p.observedBoottimeUs <= now[1],
      "native_proof_changed",
    );
    const active = p.activeMonotonicUs + p.observedBoottimeUs - p.observedMonotonicUs;
    requireFact(
      this.start[1] <= active && active < this.start[1] + this.book.policy.challengeBudgetMs * 1000,
      "native_started_outside_challenge",
    );
    const token = await signer.sign("work_command_ready", v);
    this.readinessDigest = commandTokenDigest(token);
    return token;
  }
  interval() {
    requireFact(this.anchor, "no_causal_anchor");
    const now = this.live(),
      [wall, origin, received] = this.anchor;
    return {
      lower: wall + commandTimeLower(this.book.policy, Math.floor((now[1] - received[1]) / 1000)),
      upper: wall + commandTimeUpper(this.book.policy, Math.ceil((now[1] - origin[1]) / 1000)),
    };
  }
  check(value: CommandClaims) {
    const interval = this.interval();
    requireFact(interval.lower <= interval.upper, "invalid_interval");
    validateCommandTime(value, interval.lower);
    validateCommandTime(value, interval.upper);
    return interval;
  }
  /** The candidate timestamp only selects JWT prevalidation time. No anchor is adopted until
   * the actual signature, pinned role, exact binding and request nonce have all been verified. */
  async acceptDispatch(
    token: string,
    verifier: CommandVerifier,
    issuer: string,
    audience: string,
    binding: CommandBindingV2,
  ) {
    requireFact(
      this.kind === "prepare" && this.authorization && this.readinessDigest && !this.dispatch,
      "dispatch_replayed",
    );
    const candidate = unverifiedCommandPayload(token),
      anchors = candidate.anchors as { admittedAtMs?: number } | undefined;
    const record = await verifier.verifyRecord(token, {
        purpose: "work_command_dispatch",
        issuer,
        audience,
        binding,
        nowMs: anchors?.admittedAtMs as number,
      }),
      v = record.value,
      now = this.live();
    requireFact(
      same(commandPreparationBinding(v), this.binding) &&
        v.readinessDigest === this.readinessDigest &&
        v.anchors.rootDeadlineMs === this.authorization.rootDeadlineMs,
      "dispatch_binding_changed",
    );
    this.anchor = [v.anchors.admittedAtMs, this.start, now];
    this.check(v);
    this.dispatch = record;
    return record;
  }
  beginConsume() {
    requireFact(this.kind === "prepare" && this.dispatch, "no_dispatch");
    this.check(this.dispatch.value);
    const p = new PendingExchange(
      this.book,
      "consume",
      commandExecutionBinding(this.dispatch.value),
      this.live(),
      seal,
    );
    requireFact(this.anchor, "no_causal_anchor");
    p.anchor = this.anchor;
    p.dispatch = this.dispatch;
    this.closed = true;
    return p;
  }
  async consumeChallenge(signer: CommandSigner, audience: string) {
    requireFact(
      this.kind === "consume" && !this.requestDigest && this.dispatch,
      "consume_replayed",
    );
    const interval = this.interval(),
      iat = Math.floor(interval.lower / 1000),
      binding = commandExecutionBinding(this.dispatch.value);
    const value = await parseCommandClaims("work_command_consume", {
      ...this.base(signer, audience),
      purpose: "work_command_consume",
      iat,
      nbf: iat,
      exp: Math.min(iat + 30, Math.floor(binding.hardDeadlineMs / 1000)),
      ticketDigest: this.dispatch.digest,
    });
    this.check(value);
    const token = await signer.sign("work_command_consume", value, this.interval().lower);
    this.requestDigest = commandTokenDigest(token);
    return token;
  }
  async acceptPermit(token: string, verifier: CommandVerifier, issuer: string, audience: string) {
    requireFact(this.kind === "consume" && this.requestDigest, "no_consume_request");
    const candidate = unverifiedCommandPayload(token);
    const record = await verifier.verifyRecord(token, {
        purpose: "work_command_permit",
        issuer,
        audience,
        binding: this.binding,
        request: { requestId: this.requestId, nonce: this.nonce },
        nowMs: candidate.consumedAtMs as number,
      }),
      v = record.value;
    requireFact(
      v.requestDigest === this.requestDigest && same(commandExecutionBinding(v), this.binding),
      "permit_binding_changed",
    );
    this.anchor = [v.consumedAtMs, this.start, this.live()];
    this.check(v);
    return record;
  }
  async acceptControl(token: string, verifier: CommandVerifier, issuer: string, audience: string) {
    requireFact(
      ["lookup", "stop"].includes(this.kind) && !this.control && this.challengeDigest,
      "control_replayed",
    );
    const record = await verifier.verifyRecord(token, {
        purpose: "work_command_control_request",
        issuer,
        audience,
        binding: this.binding,
        request: { requestId: this.requestId, nonce: this.nonce },
      }),
      v = record.value,
      now = this.live();
    requireFact(
      now[1] - this.start[1] < this.book.policy.challengeBudgetMs * 1000 &&
        v.operation === this.kind &&
        v.challengeDigest === this.challengeDigest,
      "control_changed_or_expired",
    );
    this.anchor = [v.issuedAtMs, this.start, now];
    this.control = record;
    this.checkControl();
    return record;
  }
  checkControl(output = false) {
    requireFact(this.control && ["lookup", "stop"].includes(this.kind), "no_control_request");
    const v = this.control.value,
      interval = this.interval();
    requireFact(
      interval.lower >= v.issuedAtMs &&
        interval.upper < v.expiresAtMs &&
        (!output || (v.operation === "lookup" && v.includeOutput)),
      "control_scope_or_expiry",
    );
    return v;
  }
  async receipt(
    observation: CommandClaims<"work_command_receipt">["observation"],
    permitDigest: string | null,
    signer: CommandSigner,
    audience: string,
  ) {
    const control = this.checkControl();
    requireFact(control.operation === "lookup" && control.dispatch, "no_lookup_dispatch");
    const interval = this.interval(),
      iat = Math.floor(interval.lower / 1000);
    const v = await parseCommandClaims("work_command_receipt", {
      ...control.dispatch,
      iss: signer.issuer,
      aud: audience,
      jti: randomUUID(),
      purpose: "work_command_receipt",
      requestId: this.requestId,
      nonce: this.nonce,
      iat,
      nbf: iat,
      exp: Math.min(iat + 30, Math.floor(control.expiresAtMs / 1000)),
      permitDigest,
      observation,
    });
    this.check(v);
    return signer.sign("work_command_receipt", v, interval.lower);
  }
}
