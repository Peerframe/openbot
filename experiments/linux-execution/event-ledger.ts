/** Durable create/start reservations across processes. Missing runtime state never releases a slot. */
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  writeSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { exclusiveLock } from "../../apps/server/dist/posix-files.js";
import { commandValue, strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import { fsyncDirectory, readBytes, requireFact } from "./protected-io.ts";
export const createEvents = [
  "container_create_reserved",
  "container_created",
  "container_create_unverified",
  "container_create_failed",
];
export type EventRecord = {
  at: string;
  action_id: string;
  action_epoch: number;
  event: string;
  detail: Record<string, unknown>;
};
export type Association = {
  action_id: string;
  action_epoch: number;
  container_name: string;
  container_id: string;
  intent_digest: string;
};
export class EventLedger {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  read(): EventRecord[] {
    if (!existsSync(this.path)) return [];
    const text = new TextDecoder("utf8", { fatal: true }).decode(
      readBytes(this.path, 2 * 1024 * 1024, { uid: process.geteuid!() }),
    );
    const lines = text.split("\n");
    requireFact(lines.pop() === "", "partial_ledger_record");
    requireFact(lines.length <= 8192, "ledger_capacity");
    return lines.filter(Boolean).map((line) => {
      const value = strictCommandJson(Buffer.from(line), 32768) as EventRecord;
      requireFact(
        value &&
          typeof value === "object" &&
          typeof value.action_id === "string" &&
          Number.isSafeInteger(value.action_epoch) &&
          typeof value.event === "string" &&
          value.detail &&
          typeof value.detail === "object" &&
          !Array.isArray(value.detail),
        "invalid_ledger_record",
      );
      return value;
    });
  }
  forAction(action: string, epoch: number) {
    return this.read().filter((r) => r.action_id === action && r.action_epoch === epoch);
  }
  private async locked<T>(callback: () => T) {
    const fd = openSync(
      this.path + ".lock",
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const st = fstatSync(fd);
      requireFact(
        st.isFile() &&
          st.nlink === 1 &&
          st.uid === process.geteuid!() &&
          (st.mode & 0o777) === 0o600,
        "unsafe_ledger_lock",
      );
      await exclusiveLock(fd, 3000);
      return callback();
    } finally {
      closeSync(fd);
    }
  }
  private appendLocked(
    action: string,
    epoch: number,
    event: string,
    detail: Record<string, unknown> = {},
  ) {
    const record = {
      at: new Date().toISOString(),
      action_id: action,
      action_epoch: epoch,
      event,
      detail,
    };
    const bytes = Buffer.concat([commandValue(record, 32768), Buffer.from("\n")]);
    const fd = openSync(
      this.path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      const st = fstatSync(fd);
      requireFact(
        st.isFile() &&
          st.nlink === 1 &&
          st.uid === process.geteuid!() &&
          (st.mode & 0o777) === 0o600 &&
          st.size + bytes.length <= 2 * 1024 * 1024,
        "unsafe_or_full_ledger",
      );
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        requireFact(count > 0, "ledger_write_unknown");
        offset += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(this.path));
    return record;
  }
  append(action: string, epoch: number, event: string, detail: Record<string, unknown> = {}) {
    return this.locked(() => this.appendLocked(action, epoch, event, detail));
  }
  reserveCreate(action: string, epoch: number, name: string, intent: string) {
    return this.locked(() => {
      requireFact(
        !this.forAction(action, epoch).some((r) => createEvents.includes(r.event)),
        "create_already_reserved",
      );
      return this.appendLocked(action, epoch, "container_create_reserved", {
        container_name: name,
        intent_digest: intent,
      });
    });
  }
  association(record: Association) {
    const created = this.forAction(record.action_id, record.action_epoch).filter(
      (e) => e.event === "container_created",
    );
    requireFact(created.length === 1, "ambiguous_created_association");
    const detail = created[0]!.detail;
    requireFact(
      detail.container_id === record.container_id &&
        detail.container_name === record.container_name &&
        detail.intent_digest === record.intent_digest &&
        record.intent_digest.length > 0,
      "original_association_changed",
    );
    return detail;
  }
  reserveStart(record: Association) {
    return this.locked(() => {
      this.association(record);
      requireFact(
        this.counters(record.action_id, record.action_epoch).startAttempts === 0,
        "start_already_reserved",
      );
      return this.appendLocked(record.action_id, record.action_epoch, "start_attempt", {
        container_id: record.container_id,
        container_name: record.container_name,
      });
    });
  }
  counters(action: string, epoch: number) {
    const events = this.forAction(action, epoch).map((r) => r.event),
      count = (kind: string) => events.filter((v) => v === kind).length;
    return {
      startAttempts: count("start_attempt"),
      launches: count("start_succeeded"),
      exitsObserved: count("exit_observed"),
      outputsCollected: count("output_collected"),
      kills: count("kill_issued"),
    };
  }
}
