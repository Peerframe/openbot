import { createHash } from "node:crypto";
import { isAlias, isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
import { scanSensitiveText } from "./sensitive-content.js";

const metadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().min(1).max(1024),
    license: z.string().min(1).max(500).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string().max(100), z.string().max(500)).optional(),
    "allowed-tools": z.string().min(1).max(1024).optional(),
  })
  .strict();

class StoreValidationError extends Error {}

/** Single-file standard adapter: parsing text never follows files, URLs or tool declarations. */
export function parseSkillDocument(input: string) {
  const markdown = input.replace(/\r\n/gu, "\n");
  const invalid = () =>
    new StoreValidationError(
      "Invalid SKILL.md: use bounded YAML metadata and a nonempty Markdown body.",
    );
  if (
    Buffer.byteLength(markdown) > 12 * 1024 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject known parser control-character hazards before YAML parsing.
    /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/u.test(markdown)
  )
    throw invalid();
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(markdown);
  const header = match?.[1];
  if (!header || !match?.[2]?.trim() || Buffer.byteLength(header) > 4096) throw invalid();
  if (Buffer.byteLength(JSON.stringify({ markdown })) > 14 * 1024) throw invalid();
  try {
    const document = parseDocument(header, {
      schema: "core",
      uniqueKeys: true,
      prettyErrors: false,
    });
    if (document.errors.length || document.warnings.length || /^%/mu.test(header)) throw invalid();
    let count = 0;
    visit(document, (key, node, path) => {
      if (++count > 256 || path.length > 8 || isAlias(node)) throw invalid();
      if (
        node &&
        typeof node === "object" &&
        (("tag" in node && node.tag) || ("anchor" in node && node.anchor))
      )
        throw invalid();
      if (key === "key" && (!isScalar(node) || typeof node.value !== "string")) throw invalid();
    });
    const metadata = metadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
    if (scanSensitiveText(markdown, "skill", { portable: false }).length) throw invalid();
    return { markdown, sha256: createHash("sha256").update(markdown).digest("hex"), ...metadata };
  } catch {
    throw invalid();
  }
}
