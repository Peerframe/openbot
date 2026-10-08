import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSkillDocument } from "@openbot/employee-publisher/agent-skills";
import {
  memoryCreateInput,
  memoryPolicy,
  parseEmployee,
  skillDocument,
  skillCreateInput,
  proposalInput,
} from "./employee-input.js";
import { WriteFailure } from "./primary-bot-write.js";
const memory = {
  kind: "semantic",
  title: "Fact",
  content: "Safe content",
  sensitivity: "internal",
  portability: "never",
};
const failure = (action: () => unknown, status: number, code: string) => {
  try {
    action();
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(WriteFailure);
    expect((error as WriteFailure).status).toBe(status);
    expect((error as WriteFailure).body.error).toBe(code);
  }
};
describe("Employee migration input boundaries", () => {
  it("keeps code-point DTO and UTF-16 memory storage limits and the retained surrogate error", () => {
    const safe = parseEmployee(memoryCreateInput, { ...memory, title: "😀".repeat(80) });
    expect(() => memoryPolicy(safe)).not.toThrow();
    const bounded = parseEmployee(memoryCreateInput, { ...memory, title: "😀".repeat(81) });
    failure(() => memoryPolicy(bounded), 422, "invalid_employee_memory");
    failure(
      () => memoryPolicy({ ...memory, content: "\ud800" }),
      503,
      "employee_knowledge_storage_unavailable",
    );
    failure(
      () => parseEmployee(memoryCreateInput, { ...memory, modelUseEnabled: null }),
      422,
      "Invalid request input.",
    );
  });
  it("merged policy cannot retain model use after sensitivity changes; local paths remain local-only data", () => {
    failure(
      () => memoryPolicy({ ...memory, sensitivity: "restricted", modelUseEnabled: true }),
      422,
      "memory_model_use_forbidden",
    );
    failure(
      () => memoryPolicy({ ...memory, kind: "secret-reference" }),
      422,
      "memory_secret_reference_policy",
    );
    expect(() =>
      memoryPolicy({ ...memory, content: "Use /home/synthetic/work.txt" }),
    ).not.toThrow();
    failure(
      () => memoryPolicy({ ...memory, content: "api_key = synthetic-private-text" }),
      422,
      "memory_sensitive_content",
    );
    failure(
      () =>
        proposalInput({
          kind: "semantic",
          title: "Fact",
          content: "api_key = synthetic-private-text",
        }),
      422,
      "knowledge_sensitive_content",
    );
  });
  it("reuses bounded YAML parsing while preserving Python metadata code-point lengths", () => {
    const document = `---\nname: reviewed-text\ndescription: ${"😀".repeat(700)}\n---\nRead evidence.\n`;
    const parsed = skillDocument(document);
    expect(parsed.description).toBe("😀".repeat(700));
    expect(parsed.sha256).toBe(createHash("sha256").update(document).digest("hex"));
    expect(parseSkillDocument(document)).toEqual(parsed);
    for (const invalid of [
      document.replace("name: reviewed-text", "name: &ref reviewed-text"),
      document.replace("name: reviewed-text", "name: reviewed-text\nname: duplicate"),
      document.replace("Read evidence.", "password = synthetic-private-text"),
      document.replace("Read evidence.", "x".repeat(12289)),
    ])
      failure(() => skillDocument(invalid), 422, "invalid_skill_document");
  });
  it("skill code-point fields remain bounded and input cannot add capabilities outside the current product", () => {
    const value = {
      slug: "reviewed-text",
      name: "😀".repeat(160),
      description: "😀".repeat(1024),
      version: "1.0.0",
      source: "manual",
      reason: "Reviewed",
    };
    expect(parseEmployee(skillCreateInput, value).name).toBe(value.name);
    failure(
      () => parseEmployee(skillCreateInput, { ...value, name: "😀".repeat(161) }),
      422,
      "Invalid request input.",
    );
    failure(
      () =>
        parseEmployee(skillCreateInput, { ...value, requiredCapabilities: ["browser.session"] }),
      422,
      "Invalid request input.",
    );
  });
});
