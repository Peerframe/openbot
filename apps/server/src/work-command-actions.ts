/** Prepares command action intents without granting model input execution authority. */
import { commandDispatchOperationSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import { type CommandOperation, commandIntentSchema } from "./work-command-contract.js";
import { commandValue } from "./work-command-values.js";
import type { WorkAction } from "./work-ledger.js";
import { workCanonical } from "./work-values.js";
/** The durable deferred wrapper is Control-owned; only its exact command effect reaches the wire. */
export async function actionCommand(value: WorkAction["intent"]) {
  commandValue(value);
  if (value.kind === "work_command") return commandIntentSchema.parseAsync(value);
  if (
    Object.keys(value).sort().join(",") !== "arguments,effect,kind,tool" ||
    value.kind !== "deferred_tool" ||
    value.tool !== "run_command"
  )
    throw new WorkConflict("command_intent_changed");
  const effect = await commandIntentSchema.parseAsync(value.effect);
  if (
    workCanonical(value.arguments).wire !==
    workCanonical({ argv: effect.command.argv, output: effect.command.output }).wire
  )
    throw new WorkConflict("command_arguments_changed");
  return effect;
}
export async function actionCommandOperation(
  action: WorkAction,
  epoch: number,
  route: CommandOperation["route"],
): Promise<CommandOperation> {
  const intent = await actionCommand(action.intent);
  if (workCanonical(action.intent).digest !== action.intent_digest)
    throw new WorkConflict("command_intent_changed");
  return commandDispatchOperationSchema.parseAsync({
    format: "openbot.work-command.operation/v1",
    taskId: action.task_id,
    runId: action.run_id,
    actionId: action.id,
    authorityGeneration: Number(action.authority_generation),
    originalEpoch: epoch,
    profileDigest: intent.profileDigest,
    route,
    intentDigest: action.intent_digest,
    command: intent.command,
  });
}
