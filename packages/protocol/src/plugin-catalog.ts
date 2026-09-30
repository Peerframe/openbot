import { z } from "zod";

const sourceFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
      .refine((v) => !v.split("/").some((p) => p === "." || p === "..")),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const reviewSchema = z
  .object({
    status: z.literal("reviewed"),
    reviewedAt: z.string().datetime(),
    reviewedBy: z.string().min(1).max(80),
    record: z
      .string()
      .regex(/^docs\/research\/[a-z0-9-]+\.md$/)
      .max(256),
    scope: z.string().min(1).max(500),
  })
  .strict();
export const reviewedPluginEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    distribution: z.enum(["self-hosted-template", "self-hosted"]),
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    license: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9.-]+$/),
    sourceUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !!url.hostname &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !url.port &&
            !Array.from(value).some(
              (char) => /\s/u.test(char) || char === "\\" || char.charCodeAt(0) < 32,
            )
          );
        } catch {
          return false;
        }
      }),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    files: z.array(sourceFileSchema).min(1).max(16),
    review: reviewSchema,
  })
  .strict()
  .refine(
    (item) =>
      item.sourceUrl.includes(item.sourceCommit) &&
      new Set(item.files.map((f) => f.path)).size === item.files.length,
  );
export const reviewedPluginCatalogSchema = z
  .object({
    format: z.literal("openbot.reviewed-plugin-catalog/v1"),
    revision: z.number().int().min(1).max(2147483647),
    entries: z.array(reviewedPluginEntrySchema).max(32),
  })
  .strict()
  .refine((value) => new Set(value.entries.map((e) => e.id)).size === value.entries.length);
export type ReviewedPluginEntry = z.infer<typeof reviewedPluginEntrySchema>;
export type ReviewedPluginCatalog = z.infer<typeof reviewedPluginCatalogSchema>;
