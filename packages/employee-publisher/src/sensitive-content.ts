import type { EmployeeExportFindingCode } from "@openbot/domain";

export interface SensitiveTextFinding {
  code: EmployeeExportFindingCode;
  location: string;
  message: string;
}

interface SensitiveTextPattern {
  code: EmployeeExportFindingCode;
  expression: RegExp;
  message: string;
  portableOnly?: boolean;
}

const sensitiveTextPatterns: ReadonlyArray<SensitiveTextPattern> = [
  {
    code: "private-key-content",
    expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    message: "A private-key marker was found. Remove it before continuing.",
  },
  {
    code: "credential-like-content",
    expression:
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{36}\b/i,
    message: "A credential-like token was found. Remove it before continuing.",
  },
  {
    code: "credential-like-content",
    expression:
      /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\bAIza[A-Za-z0-9_-]{35}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
    message: "A credential-like token was found. Remove it before continuing.",
  },
  {
    code: "credential-like-content",
    expression:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|session(?:id|_token)?)\s*[:=]\s*["']?[^\s"',;]{6,}/i,
    message: "A credential-like assignment was found. Remove it before continuing.",
  },
  {
    code: "credential-like-content",
    expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    message: "A bearer token was found. Remove it before continuing.",
  },
  {
    code: "local-path-content",
    expression: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/,
    message: "A user-specific local path was found. Replace it with a portable path.",
    portableOnly: true,
  },
];

/**
 * Finds credential-like text before it enters a durable or portable Employee record. Portable
 * fields additionally reject machine-local paths; local-only memories may legitimately refer to
 * such paths and are therefore checked only for credentials and private keys.
 */
export function scanSensitiveText(
  value: string,
  location: string,
  options: { portable: boolean },
): SensitiveTextFinding[] {
  return sensitiveTextPatterns.flatMap((pattern) => {
    if (pattern.portableOnly === true && !options.portable) return [];
    if (!pattern.expression.test(value)) return [];
    return [{ code: pattern.code, location, message: pattern.message }];
  });
}
