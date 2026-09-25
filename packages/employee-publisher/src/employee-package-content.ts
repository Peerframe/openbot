import type { EmployeeExportFinding, EmployeeSkill } from "@openbot/domain";
import type { EmployeeTemplatePayload } from "@openbot/protocol";
import { parseSkillDocument } from "./agent-skills.js";

// Single-file redistribution only. Referenced license files and bundles require separate review.
const licenses = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
]);
type PortableSkill = EmployeeTemplatePayload["skills"][number];

export function portableSkillContent(skill: EmployeeSkill, findings: EmployeeExportFinding[]) {
  if (!skill.skillMarkdown) return undefined;
  try {
    const parsed = parseSkillDocument(skill.skillMarkdown);
    const content = {
      markdown: parsed.markdown,
      sha256: parsed.sha256,
      license: parsed.license ?? "",
    };
    const problem = skillContentProblem({
      ...skill,
      dependencySlugs: skill.dependencyIds,
      content,
    });
    if (problem || !skill.modelUseEnabled || skill.contentSha256 !== parsed.sha256)
      throw new Error(problem ?? "The instruction digest has not been reviewed for this Bot.");
    return content;
  } catch (error) {
    findings.push({
      code: "invalid-skill-content",
      location: `skills.${skill.slug}.content`,
      message: error instanceof Error ? error.message : "Skill instructions cannot be shared.",
    });
    return undefined;
  }
}

/** Revalidate even a checksummed/signed package: integrity does not imply executable eligibility. */
export function skillContentProblem(skill: PortableSkill): string | undefined {
  if (!skill.content) return undefined;
  try {
    const parsed = parseSkillDocument(skill.content.markdown);
    if (
      parsed.markdown !== skill.content.markdown ||
      parsed.sha256 !== skill.content.sha256 ||
      parsed.name !== skill.slug ||
      parsed.description !== skill.description ||
      parsed.license !== skill.content.license
    )
      return "Skill instruction content, metadata or checksum does not match.";
    if (!licenses.has(skill.content.license))
      return "Sharing instructions requires a supported redistribution license in SKILL.md; preserve its author and license notices.";
    if (skill.requiredCapabilities.length || skill.dependencySlugs.length)
      return "Native instruction files currently require no external capabilities or skill dependencies.";
    if (/(?:^|[\s([`])(?:scripts|references|assets)\//mu.test(parsed.markdown))
      return "This skill references files outside SKILL.md. Share a self-contained instruction file; bundled assets are not supported yet.";
  } catch {
    return "The included SKILL.md is invalid or contains sensitive content.";
  }
  return undefined;
}
