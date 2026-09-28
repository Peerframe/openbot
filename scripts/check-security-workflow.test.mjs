import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, stringify } from "yaml";
import {
  validatePythonProductWorkflow,
  validateSecurityWorkflow,
} from "./check-security-workflow.mjs";
import { SETUP_NODE, workflowDocument } from "./workflow-policy.mjs";

const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../.github/workflows/s7-migration.yml", import.meta.url),
  "utf8",
);
function changed(change) {
  const value = parse(source);
  change(value);
  return stringify(value, { lineWidth: 0 });
}
function command(value, id, fragment) {
  return value.jobs[id].steps.find((step) => step.run?.includes(fragment));
}
const check = (text) => {
  validateSecurityWorkflow(text);
  validatePythonProductWorkflow(text, migration);
};

test("real CI preserves security and independent installed product qualifications", () =>
  check(source));
test("peer order, display names, indentation and extra pinned setup are not security contracts", () => {
  const value = parse(source);
  value.jobs = Object.fromEntries(Object.entries(value.jobs).reverse());
  for (const job of Object.values(value.jobs)) {
    job.name = "Descriptive name can change";
    for (const step of job.steps ?? []) {
      if (step.name) step.name = "Another description";
    }
  }
  value.jobs.validate.steps.splice(2, 0, { uses: SETUP_NODE, with: { "node-version": "22.22.2" } });
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
test("read-only authority, exact source pins and disabled credential persistence are required", () => {
  for (const mutate of [
    (v) => {
      v.permissions.contents = "write";
    },
    (v) => {
      v.on.pull_request_target = null;
    },
    (v) => {
      v.jobs.validate.permissions = { "id-token": "write" };
    },
    (v) => {
      v.jobs.validate.secrets = "inherit";
    },
    (v) => {
      v.jobs.security.steps[0].with["persist-credentials"] = true;
    },
    (v) => {
      v.jobs.security.steps[0].with["fetch-depth"] = 1;
    },
    (v) => {
      v.jobs.validate.steps[1].uses = "actions/setup-node@v7";
    },
    (v) => {
      v.jobs.validate.steps = v.jobs.validate.steps.filter((s) => s.uses !== SETUP_NODE);
    },
    (v) => {
      v.jobs.validate.steps[1].with["node-version"] = "latest";
    },
  ])
    assert.throws(() => check(changed(mutate)));
});
test("production audits retain exact CLI, coverage and fail-closed execution", () => {
  for (const mutate of [
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
      const steps = v.jobs.security.steps;
      const a = steps.indexOf(command(v, "security", "npm audit "));
      const b = steps.indexOf(command(v, "security", "npm ci "));
      [steps[a], steps[b]] = [steps[b], steps[a]];
    },
  ])
    assert.throws(() => check(changed(mutate)));
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
    "node scripts/check-credential-findings.mjs ignored 0 || true",
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
  for (const mutate of [
    (v) => {
      v.jobs.portable.strategy.matrix.include.pop();
    },
    (v) => {
      v.jobs.portable.strategy.matrix.include[0].runner = "ubuntu-latest";
    },
    (v) => {
      v.jobs.portable["continue-on-error"] = true;
    },
    (v) => {
      command(v, "portable", "/usr/bin/plutil").if = "runner.os != 'Windows'";
    },
    (v) => {
      command(v, "portable", "build-macos-worker-host-candidate").run = "echo omitted";
    },
    (v) => {
      command(v, "portable", "prepare-native-server.mjs").run = "echo omitted";
    },
    (v) => {
      command(v, "portable", "turbo run test").if = false;
    },
  ])
    assert.throws(() => check(changed(mutate)));
});
test("selection cannot bypass required qualifications or lose the authoritative PR input", () => {
  for (const mutate of [
    (v) => {
      v.jobs["python-runtime"].if = "false";
    },
    (v) => {
      v.jobs["browser-product"].if = "github.actor == 'maintainer'";
    },
    (v) => {
      delete v.jobs["harness"].needs;
    },
    (v) => {
      command(v, "scope", "ci-scope.ts").run = "node scripts/ci-scope.ts --local";
    },
    (v) => {
      v.jobs.scope.outputs.plan = "{}";
    },
    (v) => {
      delete v.jobs.check.needs[0];
    },
    (v) => {
      v.jobs.check.if = "success()";
    },
    (v) => {
      v.jobs.check.steps.at(-1).env.OPENBOT_CI_NEEDS = "{}";
    },
    (v) => {
      v.jobs.check.steps.at(-1).run += " || true";
    },
    (v) => {
      v.jobs.check.steps.at(-1).if = "false";
    },
    (v) => {
      v.jobs.additional = { "runs-on": "ubuntu-24.04" };
    },
  ])
    assert.throws(() => check(changed(mutate)));
});
test("all C2 gates and real product recovery stay required when selected", () => {
  for (const [job, fragment] of [
    ["harness", "npm run harness:wheel"],
    ["harness", "npm run contracts:test"],
    ["temporal-qualification", "--engine postgres-mtls --upgrade-archive"],
    ["browser-product", "control node replacement response-loss browser-restart"],
    ["python-product-container", "deploy/server/smoke-product.py"],
    ["python-desktop-preview", "node apps/desktop/scripts/package.mjs --preview --python-product"],
  ])
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
        v.jobs["synthetic-migration"].uses = "someone/other/.github/workflows/migration.yml@main";
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
