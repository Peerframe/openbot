import { expect, it } from "vitest";
import { hasIntegerTokens, parseJsonInput } from "./json-input.js";
it("retains strict-int token evidence without changing mathematical-integer or nested contracts", () => {
  for (const token of ["1.0", "1e0", "1E+0"]) {
    const value = parseJsonInput(`{"revision":${token}}`);
    expect(value).toEqual({ revision: 1 });
    expect(hasIntegerTokens(value, ["revision"])).toBe(false);
  }
  expect(
    hasIntegerTokens(parseJsonInput('{"revision":1,"child":{"revision":1.0}}'), ["revision"]),
  ).toBe(true);
  expect(hasIntegerTokens(parseJsonInput('{"revision":1.0,"revision":1}'), ["revision"])).toBe(
    true,
  );
  expect(hasIntegerTokens(parseJsonInput('{"revision":null}'), ["revision"])).toBe(true);
});
