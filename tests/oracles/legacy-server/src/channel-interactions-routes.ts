import type { Channel, Run } from "@openbot/domain";
import { setMessageReactionSchema } from "@openbot/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { ChannelInteractionStore } from "./channel-interactions-store.js";
import type { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import { StoreConflictError, StoreNotFoundError } from "./control-plane-store.js";

/** Mount at /api/v1 only after Owner authentication and Origin middleware. */
export function createChannelInteractionRoutes(dependencies: {
  store: ChannelInteractionStore;
  realtime: ChannelRealtimeHub;
  onRemoved?(result: { channel: Channel; cancelledRuns: Run[] }): void;
}) {
  const routes = new Hono();
  routes.use(
    "/channels/:channelId/messages/:messageId/reactions",
    bodyLimit({
      maxSize: 1024,
      onError: (context) => context.json({ error: "Request too large." }, 413),
    }),
  );
  routes.onError((error, context) => {
    if (error instanceof StoreNotFoundError) return context.json({ error: error.message }, 404);
    if (error instanceof StoreConflictError) return context.json({ error: error.message }, 409);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return context.json({ error: "Invalid channel interaction." }, 400);
    return context.json({ error: "Channel interaction could not be completed." }, 503);
  });
  routes.get("/channels/:channelId/reactions", async (context) =>
    context.json({
      reactions: await dependencies.store.listReactions(context.req.param("channelId")),
    }),
  );
  routes.put("/channels/:channelId/messages/:messageId/reactions", async (context) => {
    const channelId = context.req.param("channelId"),
      messageId = context.req.param("messageId");
    const input = setMessageReactionSchema.parse(await context.req.json());
    const reactions = await dependencies.store.setReaction(channelId, messageId, input);
    dependencies.realtime.publish({ type: "message.reactions", channelId, messageId, reactions });
    return context.json({ reactions });
  });
  routes.delete("/channels/:channelId/bots/:botId", async (context) => {
    const result = await dependencies.store.removeMember(
      context.req.param("channelId"),
      context.req.param("botId"),
    );
    dependencies.onRemoved?.(result);
    dependencies.realtime.publish({
      type: "channel.updated",
      channelId: result.channel.id,
      channel: result.channel,
    });
    return context.json(result);
  });
  return routes;
}
