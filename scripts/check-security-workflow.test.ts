import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stringify } from "yaml";
import {
  validatePythonProductWorkflow,
  validateSecurityWorkflow,
} from "./check-security-workflow.ts";
import { SETUP_NODE, workflowDocument } from "./workflow-policy.ts";
import {
  type CommandStep,
  commandStep,
  environmentOf,
  type FixtureWorkflow,
  fixtureJob,
  fixtureSteps,
  matrixRows,
  settingsOf,
  stepAt,
  workflowFixture,
} from "./workflow-test-fixture.ts";

type Mutation = (value: FixtureWorkflow) => void;

const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../.github/workflows/s7-migration.yml", import.meta.url),
  "utf8",
);
function changed(change: Mutation): string {
  const value = workflowFixture(source);
  change(value);
  return stringify(value, { lineWidth: 0 });
}
function command(value: FixtureWorkflow, id: string, fragment: string): CommandStep {
  return commandStep(fixtureJob(value, id), fragment);
}
const check = (text: string): void => {
  validateSecurityWorkflow(text);
  validatePythonProductWorkflow(text, migration);
};

test("real CI preserves security and independent installed product qualifications", () =>
  check(source));
test("peer order, display names, indentation and extra pinned setup are not security contracts", () => {
  const value = workflowFixture(source);
  value.jobs = Object.fromEntries(Object.entries(value.jobs).reverse());
  for (const job of Object.values(value.jobs)) {
    job.name = "Descriptive name can change";
    for (const step of job.steps ?? []) {
      if (step.name) step.name = "Another description";
    }
  }
  fixtureSteps(fixtureJob(value, "validate")).splice(2, 0, {
    uses: SETUP_NODE,
    with: { "node-version": "22.22.2" },
  });
  check(stringify(value, { indent: 4, lineWidth: 100 }));
});
test("YAML duplicate keys, aliases and comments cannot satisfy executable policy", () => {
  assert.throws(() => workflowDocument("jobs:\n  security: {}\n  security: {}\n"));
  assert.throws(() => workflowDocument("jobs:\n  security: &job {}\n  validate: *job\n"));
  assert.throws(() =>
    check(
      changed((v) => {
        const step = command(v, "security", "npm audit ");
        step.run = `# ${step.run}\necho omitted`;
      }),
    ),
  );
});
test("the shared parser rejects job, step and command shapes no policy can inspect", () => {
  for (const text of [
    "jobs: []\n",
    "jobs:\n  security: run\n",
    "jobs:\n  security:\n    steps: run\n",
    "jobs:\n  security:\n    steps:\n      - npm audit\n",
    "jobs:\n  security:\n    steps:\n      - run: [npm, audit]\n",
    "jobs:\n  security:\n    steps:\n      - uses: 7\n",
    "jobs:\n  security:\n    steps:\n      - with: fetch-depth\n",
    "jobs:\n  check:\n    needs: {scope: true}\n",
  ])
    assert.throws(() => workflowDocument(text));
});
test("read-only authority, exact source pins and disabled credential persistence are required", () => {
  const mutations: readonly Mutation[] = [
    (v) => {
      v.permissions.contents = "write";
    },
    (v) => {
      v.on.pull_request_target = null;
    },
    (v) => {
      fixtureJob(v, "validate").permissions = { "id-token": "write" };
    },
    (v) => {
      fixtureJob(v, "validate").secrets = "inherit";
    },
    (v) => {
      settingsOf(stepAt(fixtureJob(v, "security"), 0))["persist-credentials"] = true;
    },
    (v) => {
      settingsOf(stepAt(fixtureJob(v, "security"), 0))["fetch-depth"] = 1;
    },
    (v) => {
      stepAt(fixtureJob(v, "validate"), 1).uses = "actions/setup-node@v7";
    },
    (v) => {
      const job = fixtureJob(v, "validate");
      job.steps = fixtureSteps(job).filter((s) => s.uses !== SETUP_NODE);
    },
    (v) => {
      settingsOf(stepAt(fixtureJob(v, "validate"), 1))["node-version"] = "latest";
    },
  ];
  for (const mutate of mutations) assert.throws(() => check(changed(mutate)));
});
test("production audits retain exact CLI, coverage and fail-closed execution", () => {
  const mutations: readonly Mutation[] = [
    (v) => {
      command(v, "security", "npm@10.9.9").run = "npm install -g npm@latest";
    },
    (v) => {
      command(v, "security", "npm ci ").run = "npm install";
    },
    (v) => {
      command(v, "security", "npm audit ").run = "npm audit fix --force";
    },
    (v) => {
      command(v, "security", "npm audit ").run += " || true";
    },
    (v) => {
      command(v, "security", "npm audit ")["continue-on-error"] = true;
    },
    (v) => {
      command(v, "security", "npm audit ").if = false;
    },
    (v) => {
      command(v, "security", "audit-python.sh").run = "echo omitted";
    },
    (v) => {
      const steps = fixtureSteps(fixtureJob(v, "security"));
      const a = steps.indexOf(command(v, "security", "npm audit "));
      const b = steps.indexOf(command(v, "security", "npm ci "));
      const audit = steps[a];
      const install = steps[b];
      assert(audit && install);
      [steps[a], steps[b]] = [install, audit];
    },
  ];
  for (const mutate of mutations) assert.throws(() => check(changed(mutate)));
});
test("credential scanning retains full history and content-free exact finding review", () => {
  for (const suffix of [" --branch HEAD", " --exclude-paths tests", " --since-commit HEAD~1"])
    assert.throws(() =>
      check(
        changed((v) => {
          const s = command(v, "security", "git file:///repo");
          s.run = s.run.replace("git file:///repo", `git file:///repo${suffix}`);
        }),
      ),
    );
  for (const substitute of [
    "echo ignored",
    "cat trufflehog-results.jsonl",
    "node scripts/check-credential-findings.ts ignored 0 || true",
  ])
    assert.throws(() =>
      check(
        changed((v) => {
          const s = command(v, "security", "check-credential-findings");
          s.run = s.run.replace(/node scripts\/check-credential-findings[^\n]+/, substitute);
        }),
      ),
    );
});
test("native portable capabilities survive without unrelated repeated suites", () => {
  const mutations: readonly Mutation[] = [
    (v) => {
      matrixRows(fixtureJob(v, "portable")).pop();
    },
    (v) => {
      const [row] = matrixRows(fixtureJob(v, "portable"));
      assert(row);
      row.runner = "ubuntu-latest";
    },
    (v) => {
      fixtureJob(v, "portable")["continue-on-error"] = true;
    },
    (v) => {
      command(v, "portable", "/usr/bin/plutil").if = "runner.os != 'Windows'";
    },
    (v) => {
      command(v, "portable", "build-macos-worker-host-candidate").run = "echo omitted";
    },
    (v) => {
      command(v, "portable", "prepare-native-server.ts").run = "echo omitted";
    },
    (v) => {
      command(v, "portable", "turbo run test").if = false;
    },
  ];
  for (const mutate of mutations) assert.throws(() => check(changed(mutate)));
});
test("selection cannot bypass required qualifications or lose the authoritative PR input", () => {
  const mutations: readonly Mutation[] = [
    (v) => {
      fixtureJob(v, "python-runtime").if = "false";
    },
    (v) => {
      fixtureJob(v, "browser-product").if = "github.actor == 'maintainer'";
    },
    (v) => {
      delete fixtureJob(v, "harness").needs;
    },
    (v) => {
      command(v, "scope", "ci-scope.ts").run = "node scripts/ci-scope.ts --local";
    },
    (v) => {
      const outputs = fixtureJob(v, "scope").outputs;
      assert(outputs);
      outputs.plan = "{}";
    },
    (v) => {
      const needs = fixtureJob(v, "check").needs;
      assert(Array.isArray(needs));
      delete needs[0];
    },
    (v) => {
      fixtureJob(v, "check").if = "success()";
    },
    (v) => {
      environmentOf(stepAt(fixtureJob(v, "check"), -1)).OPENBOT_CI_NEEDS = "{}";
    },
    (v) => {
      const step = stepAt(fixtureJob(v, "check"), -1);
      assert(typeof step.run === "string");
      step.run += " || true";
    },
    (v) => {
      stepAt(fixtureJob(v, "check"), -1).if = "false";
    },
    (v) => {
      v.jobs.additional = { "runs-on": "ubuntu-24.04" };
    },
  ];
  for (const mutate of mutations) assert.throws(() => check(changed(mutate)));
});
test("all C2 gates and real product recovery stay required when selected", () => {
  for (const [job, fragment] of [
    ["harness", "npm run harness:wheel"],
    ["harness", "npm run contracts:test"],
    ["harness", "node apps/web/src/test/work-http-probe.mjs"],
    [
      "harness",
      "node --test experiments/work-journey/desktop-temporal/observe-pollers.test.ts experiments/work-journey/desktop-temporal/probe-support.test.ts",
    ],
    ["harness", "npm run contracts:http:python"],
    ["harness", "npm run contracts:http:python -- --suite publisher"],
    ["harness", "npm run contracts:http:python -- --suite models"],
    ["harness", "npm run contracts:http:ts"],
    ["harness", "npm run contracts:http:ts -- --suite publisher"],
    ["harness", "npm run contracts:http:ts -- --suite models"],
    ["harness", "npm run contracts:http:tls"],
    ["harness", "npm run contracts:http:tls -- --suite publisher"],
    ["harness", "npm run contracts:http:tls -- --suite models"],
    ["temporal-qualification", "--engine postgres-mtls --upgrade-archive"],
    ["temporal-qualification", "npm run test:temporal:upgrade"],
    ["harness", "npm run contracts:legacy"],
    ["browser-product", "control node replacement response-loss browser-restart"],
    ["server-container", "deploy/server/smoke-product.ts"],
    ["server-container", "scripts/product-entry.integration.test.ts"],
    ["desktop-product", "--filter=@openbot/desktop --filter=@openbot/server --filter=@openbot/web"],
    ["desktop-product", "node apps/desktop/scripts/prepare-native-server.ts"],
    ["desktop-product", "node apps/desktop/scripts/smoke-product.ts apps/desktop/native-runtime"],
    ["desktop-product", "node apps/desktop/scripts/package.ts --preview"],
    ["desktop-product", "node apps/desktop/scripts/verify-product.ts"],
    ["desktop-product", "OpenBot Preview.app/Contents/Resources/native-runtime"],
    [
      "desktop-product",
      "apps/desktop/native-runtime/node/bin/node apps/desktop/scripts/measure-ts-product.ts apps/desktop/native-runtime",
    ],
  ] as const)
    assert.throws(() =>
      check(
        changed((v) => {
          const step = command(v, job, fragment);
          step.run = step.run.replace(fragment, "omitted");
        }),
      ),
    );
  assert.throws(() =>
    check(
      changed((v) => {
        command(v, "harness", "npm run harness:wheel").if = "runner.os == 'Windows'";
      }),
    ),
  );
  assert.throws(() =>
    check(
      changed((v) => {
        fixtureJob(v, "synthetic-migration").uses =
          "someone/other/.github/workflows/migration.yml@main";
      }),
    ),
  );
  assert.throws(() =>
    validatePythonProductWorkflow(source, migration.replace("workflow_call:", "push:")),
  );
});
test("obsolete PR cancellation cannot cancel main qualification", () => {
  assert.throws(() =>
    check(
      changed((v) => {
        v.concurrency["cancel-in-progress"] = true;
      }),
    ),
  );
  assert.throws(() =>
    check(
      changed((v) => {
        v.concurrency.group = "all-ci";
      }),
    ),
  );
});

test("Linux kernel and protected Host gates cannot be omitted or conditionally bypassed", () => {
  for (const [job, fragment] of [
    ["server-container", "--test /workspace/qualification/kernel-facts.test.ts"],
    ["server-container", "OPENBOT_READONLY_KERNEL_TEST=1"],
    ["server-container", "--network none --read-only"],
    ["harness", "npm run test:linux:contracts"],
    ["browser-product", "experiments/linux-execution/qualify-native.ts"],
  ] as const) {
    assert.throws(() =>
      check(
        changed((v) => {
          const step = command(v, job, fragment);
          step.run = step.run.replace(fragment, "omitted");
        }),
      ),
    );
    assert.throws(() =>
      check(
        changed((v) => {
          command(v, job, fragment).if = "false";
        }),
      ),
    );
  }
});
