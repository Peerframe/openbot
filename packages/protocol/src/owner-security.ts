import { z } from "zod";

export const ownerPasswordChangeInputSchema = z.strictObject({
  currentPassword: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= 1024),
  newPassword: z.string().refine((value) => {
    const length = Array.from(value).length;
    return length >= 15 && length <= 1024 && value !== "replace-with-a-long-random-owner-password";
  }),
});
export const ownerSessionDeviceSchema = z.strictObject({
  id: z.string().min(1).max(128),
  /** Untrusted, bounded User-Agent hint; never authenticated device identity. */
  userAgent: z.string().refine((value) => Array.from(value).length <= 256),
  current: z.boolean(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export const ownerSessionsResponseSchema = z.strictObject({
  sessions: z.array(ownerSessionDeviceSchema).max(100),
});
export const ownerPasswordChangeResponseSchema = z.strictObject({
  changed: z.literal(true),
  reauthenticationRequired: z.literal(true),
});
export const ownerSessionRevocationResponseSchema = z.strictObject({
  revoked: z.number().int().min(0),
});
export type OwnerPasswordChangeInput = z.infer<typeof ownerPasswordChangeInputSchema>;
export type OwnerSessionDevice = z.infer<typeof ownerSessionDeviceSchema>;
export type OwnerPasswordChangeResponse = z.infer<typeof ownerPasswordChangeResponseSchema>;
