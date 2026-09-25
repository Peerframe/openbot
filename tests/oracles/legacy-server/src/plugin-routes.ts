import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError, z } from "zod";
import type { PluginService } from "./plugin-service.js";
import { decidePluginCallSchema, PluginError, removePluginSchema } from "./plugin-types.js";

/** Mount at /api/v1 after the parent Server's Owner/session/Origin middleware. */
export function createPluginRoutes(service: PluginService) {
  const routes = new Hono();
  for (const path of [
    "/plugins",
    "/plugins/*",
    "/plugin-calls/*",
    "/channels/:channelId/bots/:botId/plugin-content",
  ])
    routes.use(
      path,
      bodyLimit({
        maxSize: 24 * 1024,
        onError: (context) => context.json({ error: "插件请求过大。" }, 413),
      }),
    );
  routes.onError((error, context) => {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return context.json({ error: "插件请求无效。", code: "invalid" }, 400);
    if (error instanceof PluginError) {
      const status = {
        invalid: 400,
        unavailable: 503,
        conflict: 409,
        forbidden: 403,
        not_found: 404,
        rejected: 409,
        expired: 409,
      } as const;
      return context.json({ error: error.message, code: error.code }, status[error.code]);
    }
    return context.json({ error: "插件操作未完成，请检查服务后重试。", code: "unavailable" }, 503);
  });
  const contentScope = z
    .object({ channelId: z.string().uuid(), botId: z.string().uuid() })
    .strict();
  routes.get("/channels/:channelId/bots/:botId/plugin-content", async (context) => {
    const scope = contentScope.parse({
      channelId: context.req.param("channelId"),
      botId: context.req.param("botId"),
    });
    return context.json(await service.ownerContentCatalog(scope));
  });
  routes.post("/channels/:channelId/bots/:botId/plugin-content", async (context) => {
    const scope = contentScope.parse({
      channelId: context.req.param("channelId"),
      botId: context.req.param("botId"),
    });
    return context.json(
      await service.ownerReadContent(
        scope,
        await context.req.json(),
        AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(30_000)]),
      ),
    );
  });
  routes.get("/plugins", async (context) => context.json(await service.snapshot()));
  routes.post("/plugins/preview", async (context) =>
    context.json(
      await service.preview(
        await context.req.json(),
        AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(30_000)]),
      ),
    ),
  );
  routes.post("/plugins", async (context) =>
    context.json(
      {
        plugin: await service.install(
          await context.req.json(),
          AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(30_000)]),
        ),
      },
      201,
    ),
  );
  routes.post("/plugins/:id/update/preview", async (context) => {
    const { revision } = removePluginSchema.parse(await context.req.json());
    return context.json(
      await service.previewUpdate(context.req.param("id"), revision, context.req.raw.signal),
    );
  });
  routes.post("/plugins/:id/update", async (context) =>
    context.json({
      plugin: await service.applyUpdate(
        context.req.param("id"),
        await context.req.json(),
        context.req.raw.signal,
      ),
    }),
  );
  routes.patch("/plugins/:id", async (context) =>
    context.json({
      plugin: await service.setEnabled(context.req.param("id"), await context.req.json()),
    }),
  );
  routes.put("/plugins/:id/grants/:botId", async (context) =>
    context.json({
      plugin: await service.grant(
        context.req.param("id"),
        context.req.param("botId"),
        await context.req.json(),
      ),
    }),
  );
  routes.delete("/plugins/:id", async (context) => {
    const { revision } = removePluginSchema.parse(await context.req.json());
    await service.remove(context.req.param("id"), revision);
    return context.json({ deleted: true });
  });
  routes.post("/plugin-calls/:id/decision", async (context) => {
    const { decision } = decidePluginCallSchema.parse(await context.req.json());
    await service.decide(context.req.param("id"), decision);
    return context.json({ decided: true });
  });
  return routes;
}
