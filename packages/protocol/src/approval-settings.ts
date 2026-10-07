import { z } from "zod";

const exactId = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const page = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        /^[a-z0-9.-]+$/.test(u.hostname) &&
        u.hostname.includes(".") &&
        !/(^|\.)(0x[0-9a-f]+|[0-9]+|local|internal|test|invalid|onion)$/.test(u.hostname) &&
        !value.includes("?") &&
        !value.includes("#") &&
        u.hostname
          .split(".")
          .every((p) => p.length > 0 && p.length <= 63 && !p.startsWith("-") && !p.endsWith("-")) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        !u.port &&
        !z
          .ipv4()
          .or(z.ipv6())
          .safeParse(u.hostname.replace(/^\[|\]$/g, "")).success &&
        u.hostname !== "localhost" &&
        u.hostname !== "localhost.localdomain" &&
        !u.hostname.endsWith(".localhost") &&
        !value.includes("*") &&
        !value.includes("\\") &&
        !Array.from(value).some(
          (c) => /\s/u.test(c) || c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126,
        ) &&
        u.href === value
      );
    } catch {
      return false;
    }
  });
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), value: exactId }).strict(),
  z.object({ kind: z.literal("attachment"), value: exactId }).strict(),
  z.object({ kind: z.literal("page"), value: page }).strict(),
]);
export const approvalExceptionSchema = z
  .object({
    botId: exactId,
    category: z.enum(["product_read", "public_web"]),
    target,
  })
  .strict()
  .refine((v) => (v.category === "public_web") === (v.target.kind === "page"));
const config = {
  productRead: z.enum(["inherit", "required"]),
  publicWeb: z.enum(["inherit", "required"]),
  exceptions: z
    .array(approvalExceptionSchema)
    .max(64)
    .refine((v) => new Set(v.map((e) => JSON.stringify(e))).size === v.length),
};
export const approvalSettingsInputSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .max(2147483647)
      .meta({ "x-openbot-json-integer-token": true }),
    ...config,
  })
  .strict();
export const approvalSettingsSchema = z
  .object({
    revision: z.number().int().min(1).max(2147483647),
    ...config,
    protectedExceptionCategories: z.tuple([
      z.literal("delete"),
      z.literal("install"),
      z.literal("permission_change"),
      z.literal("command"),
      z.literal("browser"),
      z.literal("plugin"),
      z.literal("unknown"),
    ]),
  })
  .strict();
export type ApprovalSettingsInput = z.infer<typeof approvalSettingsInputSchema>;
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;
export type ApprovalException = z.infer<typeof approvalExceptionSchema>;
