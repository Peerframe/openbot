import { readFile, stat } from "node:fs/promises";
import { runControlContracts } from "./control.ts";
import { runResourceContracts } from "./resources.ts";
import { runLifecycleContracts } from "./lifecycle.ts";
import { runEmployeeContracts } from "./employee.ts";
import { runAutomationContracts } from "./automations.ts";
import { runNodeContracts } from "./nodes.ts";
import { runPluginContracts } from "./plugins.ts";
import { runArtifactContracts } from "./artifacts.ts";
import { runBrowserContracts } from "./browser.ts";
import { runPortabilityContracts } from "./portability.ts";
import { runPublisherContracts } from "./publisher.ts";
import { runModelContracts } from "./models.ts";
import {
  contractTargetSchema,
  controlContractFixtureSchema,
  lifecycleContractFixtureSchema,
  employeeContractFixtureSchema,
  productContractFixtureSchema,
  nodeContractFixtureSchema,
  artifactContractFixtureSchema,
  pluginContractFixtureSchema,
  lifecycleScenarioSchema,
  employeeScenarioSchema,
  nodeScenarioSchema,
  artifactScenarioSchema,
  pluginScenarioSchema,
  browserContractFixtureSchema,
  browserScenarioSchema,
  publisherContractFixtureSchema,
  publisherScenarioSchema,
  workContractFixtureSchema,
  workScenarioSchema,
} from "./target.ts";
import { runWorkContracts } from "./work.ts";

const [flag, fixture, suiteFlag, selected, ...extra] = process.argv.slice(2);
const suite = selected ?? "work";
if (
  flag !== "--fixture" ||
  !fixture ||
  extra.length ||
  (suiteFlag !== undefined && suiteFlag !== "--suite") ||
  (suiteFlag !== undefined && selected === undefined) ||
  ![
    "work",
    "resources",
    "lifecycle",
    "employee",
    "automations",
    "nodes",
    "artifacts",
    "plugins",
    "browser",
    "portability",
    "publisher",
    "models",
    "control",
    "all",
  ].includes(suite)
) {
  throw new Error(
    "Use --fixture PRIVATE_JSON [--suite work|resources|lifecycle|employee|automations|nodes|artifacts|plugins|browser|portability|publisher|models|control|all] for an explicitly disposable target.",
  );
}
if ((await stat(fixture)).mode & 0o077)
  throw new Error("Contract fixture must be private (mode 0600).");
const input: unknown = JSON.parse(await readFile(fixture, "utf8"));
const schema =
  suite === "all"
    ? productContractFixtureSchema
    : suite === "lifecycle"
      ? lifecycleContractFixtureSchema
      : suite === "work"
        ? workContractFixtureSchema
        : suite === "employee"
          ? employeeContractFixtureSchema
          : suite === "nodes"
            ? nodeContractFixtureSchema
            : suite === "artifacts"
              ? artifactContractFixtureSchema
              : suite === "browser"
                ? browserContractFixtureSchema
                : suite === "publisher"
                  ? publisherContractFixtureSchema
                  : suite === "plugins"
                    ? pluginContractFixtureSchema
                    : suite === "control"
                      ? controlContractFixtureSchema
                      : contractTargetSchema;
const parsed = schema.parse(input);
const prepared = {
  target: contractTargetSchema.parse({
    baseUrl: parsed.baseUrl,
    origin: parsed.origin,
    cookie: parsed.cookie,
    botId: parsed.botId,
  }),
  password:
    "password" in parsed
      ? controlContractFixtureSchema.shape.password.parse(parsed.password)
      : null,
  lifecycle: "lifecycle" in parsed ? lifecycleScenarioSchema.parse(parsed.lifecycle) : null,
  employee: "employee" in parsed ? employeeScenarioSchema.parse(parsed.employee) : null,
  nodes: "nodes" in parsed ? nodeScenarioSchema.parse(parsed.nodes) : null,
  artifacts: "artifacts" in parsed ? artifactScenarioSchema.parse(parsed.artifacts) : null,
  plugins: "plugins" in parsed ? pluginScenarioSchema.parse(parsed.plugins) : null,
  browser: "browser" in parsed ? browserScenarioSchema.parse(parsed.browser) : null,
  publisher: "publisher" in parsed ? publisherScenarioSchema.parse(parsed.publisher) : null,
  work:
    "work" in parsed && parsed.work !== undefined ? workScenarioSchema.parse(parsed.work) : null,
};
if (suite === "work" || suite === "all") {
  const result = await runWorkContracts(prepared.target, prepared.work ?? undefined);
  console.log(`Work HTTP contract: ${result.count} checks passed on the supplied target.`);
}
if (suite === "resources" || suite === "all") {
  const result = await runResourceContracts(prepared.target);
  console.log(
    `Resource HTTP/bytes contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (prepared.lifecycle !== null) {
  const result = await runLifecycleContracts(prepared.target, prepared.lifecycle);
  console.log(
    `Lifecycle HTTP/audit contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (prepared.employee !== null) {
  const result = await runEmployeeContracts(prepared.target, prepared.employee);
  console.log(
    `Employee HTTP/knowledge contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (suite === "automations" || suite === "all") {
  const result = await runAutomationContracts(prepared.target);
  console.log(`Automation HTTP contract: ${result.count} checks passed on the supplied target.`);
}
if (prepared.browser !== null) {
  const result = await runBrowserContracts(prepared.target, prepared.browser);
  console.log(
    `Browser HTTP/socket contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (suite === "portability" || suite === "all") {
  const result = await runPortabilityContracts(prepared.target);
  console.log(
    `Employee portability HTTP/bytes contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (prepared.publisher !== null) {
  const result = await runPublisherContracts(prepared.target, prepared.publisher);
  console.log(
    `Signed Employee HTTP/bytes contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (suite === "models") {
  const result = await runModelContracts(prepared.target);
  console.log(
    `Model Owner HTTP/synthetic SDK contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (prepared.nodes !== null) {
  const result = await runNodeContracts(prepared.target, prepared.nodes);
  console.log(
    `Node identity HTTP/WebSocket contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (prepared.artifacts !== null) {
  const result = await runArtifactContracts(prepared.target, prepared.artifacts);
  console.log(
    `Run artifact HTTP/bytes contract: ${result.count} checks passed on the supplied target.`,
  );
}
if (prepared.plugins !== null) {
  const result = await runPluginContracts(prepared.target, prepared.plugins);
  console.log(`Plugin HTTP/MCP contract: ${result.count} checks passed on the supplied target.`);
}
if (prepared.password !== null) {
  const result = await runControlContracts(prepared.target, prepared.password);
  console.log(`Control HTTP/SSE contract: ${result.count} checks passed on the supplied target.`);
}
