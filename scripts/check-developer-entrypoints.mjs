import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// The repository deliberately uses plain files and scalar metadata. Native Codex discovery is a
// separate acceptance exercise; this check catches broken contributor routing without a model call.
export function validateDeveloperEntrypoints(root) {
  const failures = [];
  const rules = readFileSync(join(root, "AGENTS.md"), "utf8");
  const directory = join(root, ".agents/skills");
  let folders;
  try {
    folders = readdirSync(directory, { withFileTypes: true });
  } catch {
    return ["missing repository development skills directory"];
  }
  if (folders.length === 0) failures.push("no development skills discovered");
  const names = new Set();
  for (const folder of folders) {
    const path = join(directory, folder.name, "SKILL.md");
    if (!folder.isDirectory()) {
      failures.push(`${folder.name}: use a plain skill directory, not a symlink`);
      continue;
    }
    let source;
    try {
      if (!lstatSync(path).isFile()) throw new Error("not a plain file");
      source = readFileSync(path, "utf8");
    } catch {
      failures.push(`${folder.name}: missing plain SKILL.md`);
      continue;
    }
    const metadata = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
    const name = metadata?.match(/^name: ([a-z0-9-]{1,64})$/mu)?.[1];
    const description = metadata?.match(/^description: (.+)$/mu)?.[1]?.trim();
    if (!name || name !== basename(folder.name) || names.has(name))
      failures.push(`${folder.name}: missing, mismatched or duplicate skill name`);
    names.add(name);
    if (!description || /^(?:TODO|TBD|<.*>)$/iu.test(description))
      failures.push(`${folder.name}: missing concrete discovery description`);
    if (!rules.includes(`](.agents/skills/${folder.name}/SKILL.md)`))
      failures.push(`${folder.name}: root AGENTS must link the skill for explicit reading`);
  }
  return failures;
}
