import { expect, it } from "vitest";
import {
  authSessionSchema,
  controlHttpErrorSchema,
  channelMessageCreatedSchema,
  loginRequestSchema,
  ownerPasswordChangeRequestSchema,
} from "./control-http.js";

it("requires real boolean authentication and never admits owner fields to anonymous sessions", () => {
  for (const value of [
    { authenticated: 1 },
    { authenticated: "false" },
    { authenticated: false, owner: { id: "owner", name: "Owner" } },
  ]) {
    expect(authSessionSchema.safeParse(value).success).toBe(false);
  }
});
it("preserves password whitespace and code-point bounds while rejecting invalid UTF-8", () => {
  expect(loginRequestSchema.parse({ password: " padded 🧪 ", extra: true })).toEqual({
    password: " padded 🧪 ",
  });
  expect(loginRequestSchema.safeParse({ password: "🧪".repeat(1024) }).success).toBe(true);
  for (const password of ["", "🧪".repeat(1025), "\ud800", "\udfff"]) {
    expect(loginRequestSchema.safeParse({ password }).success).toBe(false);
  }
  for (const newPassword of ["\ud800".repeat(15), "replace-with-a-long-random-owner-password"]) {
    expect(
      ownerPasswordChangeRequestSchema.safeParse({ currentPassword: "current", newPassword })
        .success,
    ).toBe(false);
  }
});
it("retains the real attachment error extensions without exposing arbitrary diagnostics", () => {
  expect(
    controlHttpErrorSchema.parse({
      error: "attachment_referenced",
      referenceCount: { messages: 1, tasks: 2 },
    }),
  ).toMatchObject({ referenceCount: { messages: 1, tasks: 2 } });
  expect(controlHttpErrorSchema.safeParse({ error: "diagnostic", stack: "private" }).success).toBe(
    false,
  );
});

it("keeps message events scoped to their committed channel and preserves greeting origin", () => {
  const event = {
    type: "message.created",
    channelId: "channel",
    message: {
      id: "message",
      channelId: "channel",
      authorType: "bot",
      authorId: "bot",
      origin: "greeting",
      content: "Synthetic greeting",
      createdAt: "2026-10-06T00:00:00.000Z",
    },
  };
  expect(channelMessageCreatedSchema.parse(event)).toEqual(event);
  for (const invalid of [
    { ...event, channelId: "other" },
    { ...event, extra: true },
    { ...event, message: { ...event.message, origin: null } },
    { ...event, message: { ...event.message, origin: "unknown" } },
  ])
    expect(channelMessageCreatedSchema.safeParse(invalid).success).toBe(false);
});
