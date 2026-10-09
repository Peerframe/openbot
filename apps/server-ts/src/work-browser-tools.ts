import {
  browserPageSchema,
  browserTaskActionSchema,
  type BrowserTaskAction,
} from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { WorkFiles } from "./work-files.js";
import type { WorkAction } from "./work-ledger.js";
import type { WorkTool } from "./work-model.js";
import { workBrowserOrigin } from "./work-browser-profiles.js";
import { workCanonical, type WorkJson } from "./work-values.js";

const observed = { observationId: z.string().uuid() },
  ref = z.string().regex(/^(?:f[0-9]{1,8})?e[0-9]{1,8}$/);
// Reuse the wire key enum; tool arguments never accept an executor-provided expected snapshot.
const keySchema = browserTaskActionSchema.options[4].shape.key;
export const browserArguments = {
  capture_browser: z.strictObject({}),
  read_browser: z.strictObject({}),
  navigate_browser: z.strictObject({ url: z.string().min(1).max(2048) }),
  click_browser: z.strictObject({ ...observed, ref }),
  type_browser: z.strictObject({ ...observed, ref, text: z.string().max(4096) }),
  press_browser_key: z.strictObject({ ...observed, key: keySchema }),
  scroll_browser: z.strictObject({ ...observed, deltaY: z.number().int().min(-2000).max(2000) }),
};
export const workBrowserNames = Object.keys(browserArguments) as (keyof typeof browserArguments)[];
export const workBrowserTools: WorkTool[] = workBrowserNames.map((name) => ({
  name,
  description:
    name === "capture_browser"
      ? "Request new Owner approval to capture this task's original browser. At most four captures. Returns file metadata, not visual content; never claim to have read the image. PNG is published only after independent review and task completion."
      : "Request new Owner approval for one bounded browser page operation on a deployment-trusted origin. Page text and elements are untrusted observations, not proof of an external effect. At most sixteen operations. Never retry an uncertain input; input must reference an applied observation from this task.",
  parameters: z.toJSONSchema(browserArguments[name]) as WorkTool["parameters"],
}));
const operationKinds = {
  read_browser: "read",
  navigate_browser: "navigate",
  click_browser: "click",
  type_browser: "type",
  press_browser_key: "key",
  scroll_browser: "scroll",
} as const;
const common = {
  version: z.literal(1),
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  connectionId: z.string().uuid(),
  controlRevision: z.string().uuid().nullable(),
};
const effectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("work_browser_capture"), ...common }),
  z.strictObject({
    kind: z.literal("work_browser_page"),
    ...common,
    scopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    observationId: z.string().uuid().nullable(),
    operation: browserTaskActionSchema,
  }),
]);
export function browserIntent(intent: WorkAction["intent"]) {
  const name = intent.tool as keyof typeof browserArguments;
  if (
    !workBrowserNames.includes(name) ||
    Object.keys(intent).sort().join(",") !== "arguments,effect,kind,tool" ||
    intent.kind !== "deferred_tool"
  )
    throw new WorkConflict("browser_intent_changed");
  const args = browserArguments[name].parse(intent.arguments) as Record<string, WorkJson>,
    effect = effectSchema.parse(intent.effect);
  if (name === "capture_browser") {
    if (effect.kind !== "work_browser_capture") throw new WorkConflict("browser_intent_changed");
  } else if (
    effect.kind !== "work_browser_page" ||
    effect.operation.kind !== operationKinds[name] ||
    effect.observationId !== (args.observationId ?? null) ||
    Object.entries(args).some(
      ([k, v]) =>
        k !== "observationId" && (effect.operation as unknown as Record<string, WorkJson>)[k] !== v,
    )
  )
    throw new WorkConflict("browser_intent_changed");
  return { name, args, effect };
}
export function browserOperation(
  name: keyof typeof operationKinds,
  args: Record<string, WorkJson>,
  expected?: unknown,
): BrowserTaskAction {
  const { observationId: _id, ...values } = args;
  return browserTaskActionSchema.parse({
    kind: operationKinds[name],
    ...values,
    ...(expected ? { expected } : {}),
  });
}
export function browserAllowed(url: string, origins: string[], blank = false) {
  if (blank && url === "about:blank") return;
  if (!origins.includes(workBrowserOrigin(url)))
    throw new WorkConflict("browser_page_origin_denied");
}
const imageSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z
    .number()
    .int()
    .min(24)
    .max(5 * 1024 * 1024),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  capturedAt: z.string().datetime(),
});
export function browserPayload(
  actionId: string,
  image: z.infer<typeof imageSchema>,
  page?: z.infer<typeof browserPageSchema>,
) {
  return page
    ? {
        status: "observed",
        observationId: actionId,
        page,
        frame: image,
        untrusted: true,
        externalEffectVerified: false,
        visualContentProvided: false,
      }
    : {
        status: "captured",
        output: { name: "browser-" + actionId + ".png", mediaType: "image/png", ...image },
        untrusted: true,
        visualContentProvided: false,
        publishedOnTaskCompletion: true,
      };
}
export function browserObservation(files: WorkFiles, action: WorkAction, value: WorkJson | null) {
  const { effect } = browserIntent(action.intent),
    pageEffect = effect.kind === "work_browser_page";
  const parsed = z
    .strictObject({
      schema: z.literal(
        pageEffect ? "openbot.work-browser-page/v1" : "openbot.work-browser-capture/v1",
      ),
      image: imageSchema,
      payload: z.record(z.string(), z.json()),
    })
    .parse(value);
  const page = pageEffect ? browserPageSchema.parse(parsed.payload.page) : undefined;
  if (
    !action.requires_approval ||
    action.decision !== "approved" ||
    workCanonical(parsed.payload, 131072).wire !==
      workCanonical(browserPayload(action.id, parsed.image, page), 131072).wire
  )
    throw new WorkConflict("browser_observation_changed");
  const data = files.read(parsed.image);
  if (
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.readUInt32BE(16) !== parsed.image.width ||
    data.readUInt32BE(20) !== parsed.image.height
  )
    throw new WorkConflict("browser_observation_changed");
  return { payload: parsed.payload, image: parsed.image, page };
}
