// Whole-interface acceptance (docs/research/ui-acceptance-automation.md). Starts a disposable
// stack — owned PostgreSQL, the Python product serving the built Web, and the TS entry with
// `--entry ts` — then drives the real interface in an installed Chrome. It writes a receipt and
// screenshots, and removes every process, container and file it created.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { DevProcessOwner } from "./dev-processes.ts";
import {
  allowlistedEnvironment,
  cleanupOnTerminationSignals,
  OwnedDockerFixture,
  runFixtureCommand,
  startControlPostgres,
} from "./python-acceptance-fixture.ts";
import {
  type AcceptanceOptions,
  classifyResponses,
  type ObservedResponse,
  parseAcceptanceArgs,
  redact,
} from "./ui-acceptance-report.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = parseAcceptanceArgs(process.argv.slice(2));
const python = join(root, "apps/server-python/.worker-venv/bin/python");
const webRoot = join(root, "apps/web/dist");
const tsEntry = join(root, "apps/server-ts/dist/serve.js");
const STEP_TIMEOUT = 20_000;

function preflight(value: AcceptanceOptions): void {
  assert(
    existsSync(python),
    "Prepare Python first: apps/server-python/scripts/bootstrap-worker.sh",
  );
  assert(
    existsSync(join(webRoot, "index.html")),
    "Build the Web first: npm run build -w @openbot/web",
  );
  if (value.entry === "ts")
    assert(existsSync(tsEntry), "Build the TS entry first: npm run build -w @openbot/server-ts");
  if (value.browser) assert(existsSync(value.browser), `No browser at ${value.browser}.`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000}s.`);
}

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
}

try {
  preflight(options);
} catch (error) {
  // Nothing has started yet; say what to prepare and stop.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const work = join(options.out ?? tmpdir(), `openbot-ui-acceptance-${Date.now()}`);
mkdirSync(work, { recursive: true, mode: 0o700 });
const data = join(work, "data");
for (const dir of ["objects", "artifacts", "model"])
  mkdirSync(join(data, dir), { recursive: true, mode: 0o700 });
const shots = join(work, "screenshots");
mkdirSync(shots, { recursive: true });

const ownerPassword = randomBytes(18).toString("hex");
const databasePassword = randomBytes(24).toString("hex");
const environment = allowlistedEnvironment([
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
]);
const docker = new OwnedDockerFixture(root, environment);
const owner = new DevProcessOwner({
  cwd: root,
  graceMs: 8_000,
  createChild: (command, args, spawnOptions) => {
    const log = openSync(join(work, `${args.at(-1)?.split("/").at(-1) ?? "process"}.log`), "a");
    return spawn(command, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ["ignore", log, log],
    });
  },
});
let browser: Browser | undefined;
let databaseUrl = "";
const secrets = () => [ownerPassword, databasePassword, databaseUrl];
function cleanup(): void {
  docker.cleanup();
  rmSync(data, { recursive: true, force: true });
}
cleanupOnTerminationSignals(cleanup);

const steps: Step[] = [];
const responses: ObservedResponse[] = [];
const pageErrors: string[] = [];
let page: Page;
let restarting = false;
let currentStep = "启动";

async function step(name: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  currentStep = name;
  try {
    await body();
    steps.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    const message = redact(
      error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
      secrets(),
    );
    steps.push({ name, ok: false, ms: Date.now() - started, error: message });
    console.log(`  ✗ ${name}: ${message}`);
    await page
      ?.screenshot({ path: join(shots, `failed-${steps.length}.png`) })
      .catch(() => undefined);
  }
}

let exitCode = 1;
try {
  console.log(`OpenBot whole-interface acceptance (entry: ${options.entry})`);
  databaseUrl = await startControlPostgres(
    docker,
    `openbot-ui-acceptance-${randomUUID().slice(0, 8)}`,
    databasePassword,
  );
  runFixtureCommand(process.execPath, ["deploy/server/product-migrate.ts"], {
    cwd: root,
    env: { ...environment, OPENBOT_DATABASE_URL: databaseUrl },
  });

  const publicPort = await freePort();
  const pythonPort = options.entry === "ts" ? await freePort() : publicPort;
  const origin = `http://127.0.0.1:${publicPort}`;
  const pythonEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OPENBOT_CONTROL_DATABASE_URL: databaseUrl,
    OPENBOT_CONTROL_OWNER_PASSWORD: ownerPassword,
    OPENBOT_CONTROL_AUTHORITY: "product",
    OPENBOT_CONTROL_HOST: "127.0.0.1",
    OPENBOT_CONTROL_PORT: String(pythonPort),
    OPENBOT_CONTROL_ALLOWED_ORIGINS: origin,
    OPENBOT_CONTROL_COOKIE_MODE: "loopback",
    OPENBOT_CONTROL_NODE_EXECUTABLE: process.execPath,
    OPENBOT_CONTROL_NODE_MODULE_ROOT: join(root, "node_modules"),
    OPENBOT_CONTROL_OBJECT_ROOT: join(data, "objects"),
    OPENBOT_CONTROL_ARTIFACT_ROOT: join(data, "artifacts"),
    OPENBOT_CONTROL_MODEL_DIRECTORY: join(data, "model"),
    OPENBOT_CONTROL_WEB_ROOT: webRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    ...(options.entry === "ts"
      ? {
          OPENBOT_CONTROL_PROXY_ADDRESS: "127.0.0.1",
          OPENBOT_CONTROL_PUBLIC_ORIGIN: origin,
          OPENBOT_CONTROL_TS_READ_GROUP: "transcription",
        }
      : {}),
  };
  const tsEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OPENBOT_TS_HOST: "127.0.0.1",
    OPENBOT_TS_PORT: String(publicPort),
    OPENBOT_TS_PYTHON_ORIGIN: `http://127.0.0.1:${pythonPort}`,
    OPENBOT_TS_PUBLIC_ORIGIN: origin,
    OPENBOT_TS_READ_GROUP: "transcription",
    OPENBOT_TS_READ_ALLOWED_ORIGINS: origin,
    OPENBOT_TS_DATABASE_URL: databaseUrl,
  };
  const startPython = () =>
    owner.start(python, ["-I", "-B", "apps/server-python/scripts/serve.py"], pythonEnv);
  const startEntry = () => owner.start(process.execPath, [tsEntry], tsEnv);
  let publicProcess: ChildProcess = startPython();
  if (options.entry === "ts") {
    await waitForHttp(`http://127.0.0.1:${pythonPort}/`);
    publicProcess = startEntry();
  }
  await waitForHttp(`${origin}/`);
  console.log(`Stack ready at ${origin}`);

  browser = await chromium.launch({
    headless: !options.headed,
    ...(options.browser ? { executablePath: options.browser } : { channel: "chrome" }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT);
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith("/api/") && !restarting)
      responses.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
        step: currentStep,
      });
  });
  page.on("pageerror", (error) => pageErrors.push(redact(error.message, secrets())));

  const sidebarRow = (text: string) => page.locator(".sb-row", { hasText: text }).first();
  const composer = () => page.locator('textarea[aria-label="消息内容"]');

  await step("登录", async () => {
    await page.goto(origin);
    await page.locator('input[type="password"]').fill(ownerPassword);
    await page.keyboard.press("Enter");
    await page.getByText("你的工作，从这里开始").waitFor();
  });
  await step("新建 Bot 并回答分工卡", async () => {
    await page
      .getByRole("button", { name: /新建 Bot/ })
      .first()
      .click();
    await page.getByText("你最想让我先帮你做什么？").first().waitFor();
    await page.getByRole("button", { name: /写作与发布/ }).click();
    await page.locator(".new-bot-setup-answered", { hasText: "写作与发布" }).waitFor();
    await page.locator(".bot-info .bi-tag", { hasText: "写作与发布" }).waitFor();
  });
  await step("右栏四个分页", async () => {
    for (const name of ["工作", "资料库", "电脑", "详情"]) {
      await page.getByRole("tab", { name }).click();
      await page.locator('.bot-info [role="tabpanel"]').waitFor();
    }
  });
  await step("改名", async () => {
    const field = page.locator('input[aria-label="Bot 名称"]');
    await field.fill("验收助理");
    await field.press("Enter");
    await sidebarRow("验收助理").waitFor();
  });
  await step("编辑头像（C9）", async () => {
    await page.getByRole("button", { name: "编辑头像" }).click();
    const current = await page.locator(".bot-info .robot-avatar").first().getAttribute("data-head");
    const target = current === "cat" ? "圆顶" : "猫耳";
    await page.locator(".bi-avatar-heads button", { hasText: target }).click();
    await page.keyboard.press("Escape");
    const expected = target === "猫耳" ? "cat" : "round";
    await page.locator(`.sb-row .robot-avatar[data-head="${expected}"]`).first().waitFor();
  });
  await step("第二个 Bot（跳过分工卡）", async () => {
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByText("创建新 Bot", { exact: true }).click();
    await page.getByRole("button", { name: "跳过" }).click();
    await page.locator(".new-bot-setup-answered", { hasText: "已忽略" }).waitFor();
  });
  await step("建频道并发第一条消息", async () => {
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByText("创建频道", { exact: true }).click();
    for (const name of ["新建 Bot", "验收助理"])
      await page
        .getByRole("option", { name: new RegExp(name) })
        .first()
        .click();
    await composer().fill("验收：频道第一条消息");
    await composer().press("Enter");
    await page.locator(".message-row", { hasText: "验收：频道第一条消息" }).first().waitFor();
    await page.getByRole("tab", { name: "成员" }).click();
    await page.locator(".ci-member").nth(1).waitFor();
    await page.locator(".realtime-state.live").waitFor();
  });
  await step("附件上传并发送", async () => {
    await page
      .locator("form.message-composer input[type=file]")
      .first()
      .setInputFiles({
        name: "acceptance.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("OpenBot whole-interface acceptance\n"),
      });
    await page.getByRole("button", { name: "移除附件 acceptance.txt" }).waitFor();
    await composer().fill("附件验收");
    await composer().press("Enter");
    await page.locator(".message-row", { hasText: "acceptance.txt" }).first().waitFor();
  });
  await step("取消排队的任务", async () => {
    await page.locator(".task-card").getByRole("button", { name: "取消" }).last().click();
    await page.locator(".task-card", { hasText: "已停止" }).first().waitFor();
  });
  await step("插件窗口", async () => {
    await page.locator("button.sb-plugins").click();
    await page.getByRole("heading", { name: "插件" }).first().waitFor();
    await page.keyboard.press("Escape");
  });
  await step("设置的每个分区", async () => {
    await page.locator("summary[aria-label$='账户与设置']").click();
    await page.getByRole("menuitem", { name: "设置" }).click();
    const nav = page.locator("nav.settings-dialog-nav button");
    const count = await nav.count();
    assert(count >= 14, `Only ${count} settings sections.`);
    const failed: string[] = [];
    for (let index = 0; index < count; index += 1) {
      await nav.nth(index).click();
      const dialog = page.locator("dialog[open]");
      const heading =
        (await dialog.locator("h1").first().textContent({ timeout: 5_000 }))?.trim() ?? "";
      await page.waitForTimeout(400);
      if (!heading || (await dialog.locator('[role="alert"], .form-error').count()) > 0)
        failed.push(heading || `#${index + 1}`);
    }
    assert.equal(failed.length, 0, `Sections with errors: ${failed.join(", ")}`);
    await page.screenshot({ path: join(shots, "settings.png") });
    await page.keyboard.press("Escape");
  });
  await step("重启公开入口后自动重连且不用重新登录", async () => {
    restarting = true;
    const stopped = new Promise((resolve) => publicProcess.once("exit", resolve));
    publicProcess.kill("SIGTERM");
    await stopped;
    await page.locator(".realtime-state.retrying").waitFor();
    publicProcess = options.entry === "ts" ? startEntry() : startPython();
    await waitForHttp(`${origin}/`);
    await page.locator(".realtime-state.live").waitFor({ timeout: 45_000 });
    restarting = false;
    const session = await page.evaluate(
      async () =>
        (
          (await (await fetch("/api/v1/auth/session")).json()) as {
            authenticated?: unknown;
          }
        ).authenticated,
    );
    assert.equal(session, true, "The Owner was logged out by the restart.");
  });
  await page.screenshot({ path: join(shots, "final.png") });

  const tally = classifyResponses(responses);
  const failedSteps = steps.filter((item) => !item.ok);
  const passed =
    failedSteps.length === 0 && tally.unexpected.length === 0 && pageErrors.length === 0;
  const receipt = {
    entry: options.entry,
    passed,
    steps,
    responses: {
      total: responses.length,
      byStatus: tally.byStatus,
      allowed: tally.allowed,
      unexpected: tally.unexpected,
    },
    pageErrors,
    screenshots: shots,
  };
  writeFileSync(join(work, "receipt.json"), redact(JSON.stringify(receipt, null, 2), secrets()));
  console.log(
    `\n${passed ? "PASS" : "FAIL"}: ${steps.length - failedSteps.length}/${steps.length} steps, ` +
      `${responses.length} API responses ${JSON.stringify(tally.byStatus)}, ` +
      `${tally.allowed.length} allowed known gap(s), ${tally.unexpected.length} unexpected, ` +
      `${pageErrors.length} page error(s).`,
  );
  for (const item of tally.unexpected)
    console.log(`  unexpected ${item.status} ${item.method} ${item.path}`);
  for (const message of pageErrors) console.log(`  page error: ${message}`);
  console.log(`Receipt and screenshots: ${work}`);
  exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error), secrets()));
} finally {
  await browser?.close().catch(() => undefined);
  await owner.stop().catch(() => undefined);
  cleanup();
}
process.exit(exitCode);
