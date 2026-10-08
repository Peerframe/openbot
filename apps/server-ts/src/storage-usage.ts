import { closeSync, constants, fstatSync } from "node:fs";
import { relative, resolve } from "node:path";
import type postgres from "postgres";
import { storageUsageSchema } from "@openbot/protocol";
import type { ReferencedAttachment } from "./attachment-references.js";
import type { Attachment, OwnerFiles } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { directoryNames } from "./posix-directory.js";
import { openAt, openDirectory } from "./posix-files.js";
export function treeBytes(path: string): Map<string, number> {
  const result = new Map<string, number>();
  let count = 0;
  const walk = (fd: number, prefix: string[]) => {
    if (prefix.length > 8) return refuse(503, "storage_depth_limit");
    for (const name of directoryNames(fd, 10000)) {
      if (++count > 10000) return refuse(503, "storage_entry_limit");
      const child = openAt(fd, name, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = fstatSync(child);
        if (info.uid !== process.geteuid?.()) return refuse(503, "storage_path_refused");
        if (info.isDirectory()) walk(child, [...prefix, name]);
        else if (info.isFile() && info.nlink === 1)
          result.set([...prefix, name].join("/"), info.size);
        else return refuse(503, "storage_path_refused");
      } finally {
        closeSync(child);
      }
    }
  };
  const root = openDirectory(path, false);
  try {
    const info = fstatSync(root);
    if (info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0)
      return refuse(503, "private_storage_root_required");
    walk(root, []);
    return result;
  } finally {
    closeSync(root);
  }
}
export async function measuredUsage(
  db: postgres.TransactionSql,
  files: OwnerFiles,
  objectRoot: string,
  artifactRoot: string | undefined,
  channel: Attachment[],
  owner: Attachment[],
  trash: ReferencedAttachment[],
) {
  objectRoot = resolve(objectRoot);
  artifactRoot = artifactRoot === undefined ? undefined : resolve(artifactRoot);
  const objects = treeBytes(objectRoot),
    prefix = relative(objectRoot, resolve(files.root)),
    claimed = new Set<string>();
  if (prefix.startsWith("../") || prefix === "..") return refuse(503, "storage_root_overlap");
  const referencedIds = new Set(
    trash
      .filter((item) => item.referenceCount.messages || item.referenceCount.tasks)
      .map((item) => item.id),
  );
  let active = 0,
    trashed = 0,
    ownerBytes = 0,
    referencedBytes = 0,
    taskBytes = 0,
    taskCount = 0,
    extraTotal = 0,
    extraOther = 0,
    extraCount = 0;
  const channels = new Map<string, { sizeBytes: number; fileCount: number }>();
  for (const item of [...channel, ...owner]) {
    let total = 0;
    for (const suffix of [".bin", ".json", ".text.json"]) {
      const key = prefix + "/" + item.id + suffix,
        size = objects.get(key);
      if (size === undefined) {
        if (suffix !== ".text.json") return refuse(503, "storage_attachment_unavailable");
        continue;
      }
      claimed.add(key);
      total += size;
    }
    if (item.scopeKind === "owner") ownerBytes += total;
    else {
      const entry = channels.get(item.channelId!) ?? { sizeBytes: 0, fileCount: 0 };
      entry.sizeBytes += total;
      entry.fileCount++;
      channels.set(item.channelId!, entry);
      if (item.deletedAt) trashed += total;
      else active += total;
      if (referencedIds.has(item.id)) referencedBytes += total;
    }
  }
  for (const [key, size] of objects)
    if (key.split("/")[0] === "runs") {
      if (claimed.has(key)) return refuse(503, "storage_root_overlap");
      claimed.add(key);
      taskBytes += size;
      taskCount++;
    }
  if (artifactRoot !== undefined) {
    if (artifactRoot === objectRoot || objectRoot.startsWith(artifactRoot + "/"))
      return refuse(503, "storage_root_overlap");
    if (artifactRoot.startsWith(objectRoot + "/")) {
      const prefix = relative(objectRoot, artifactRoot) + "/";
      for (const [key, size] of objects)
        if (key.startsWith(prefix)) {
          if (claimed.has(key)) return refuse(503, "storage_root_overlap");
          if (/^[a-f0-9]{64}$/.test(key.slice(prefix.length))) {
            claimed.add(key);
            taskBytes += size;
            taskCount++;
          }
        }
    } else {
      for (const [key, size] of treeBytes(artifactRoot)) {
        extraTotal += size;
        if (/^[a-f0-9]{64}$/.test(key)) {
          taskBytes += size;
          taskCount++;
        } else {
          extraOther += size;
          extraCount++;
        }
      }
    }
  }
  const [observed] =
    await db`SELECT pg_database_size(current_database()) AS bytes,clock_timestamp() AS now`;
  if (!observed) return refuse(503, "storage_measurement_unavailable");
  const database = Number(observed.bytes),
    total = [...objects.values()].reduce((sum, value) => sum + value, extraTotal + database);
  if (!Number.isSafeInteger(total) || total < 0) return refuse(503, "storage_size_limit");
  const other = [...objects].filter(([key]) => !claimed.has(key));
  const rows = channels.size
    ? await db`SELECT id,name,deleted_at FROM channels WHERE id IN (SELECT jsonb_array_elements_text(${db.json([...channels.keys()])}))`
    : [];
  const names = new Map(rows.map((row) => [row.id, row]));
  if (names.size !== channels.size) return refuse(503, "storage_channel_unavailable");
  const top = [...channels.keys()]
    .sort(
      (a, b) =>
        channels.get(b)!.sizeBytes - channels.get(a)!.sizeBytes || (a < b ? -1 : a > b ? 1 : 0),
    )
    .slice(0, 20);
  return storageUsageSchema.parse({
    totalBytes: total,
    measuredAt: observed.now.toISOString(),
    categories: {
      channelFiles: { sizeBytes: active, fileCount: channel.length - trash.length },
      taskOutputs:
        artifactRoot !== undefined ? { sizeBytes: taskBytes, fileCount: taskCount } : null,
      retainedRunOutputs:
        artifactRoot === undefined ? { sizeBytes: taskBytes, fileCount: taskCount } : null,
      trash: { sizeBytes: trashed, fileCount: trash.length },
      ownerTaskFiles: { sizeBytes: ownerBytes, fileCount: owner.length },
      other: {
        sizeBytes: other.reduce((sum, [, size]) => sum + size, extraOther),
        fileCount: other.length + extraCount,
      },
      database: { sizeBytes: database },
      workingComputerBrowserData: null,
    },
    trash: {
      fileCount: trash.length,
      sizeBytes: trashed,
      referencedFileCount: referencedIds.size,
      referencedSizeBytes: referencedBytes,
    },
    topChannels: top.map((id) => ({
      id,
      name: names.get(id)!.name,
      deleted: names.get(id)!.deleted_at !== null,
      ...channels.get(id)!,
    })),
    topChannelsLimit: 20,
  });
}
