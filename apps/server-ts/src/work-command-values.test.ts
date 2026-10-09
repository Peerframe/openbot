import { expect, it } from "vitest";
import { commandValue, strictCommandJson } from "./work-command-values.js";

it("retains Python strict JSON semantics before schemas or signature verification", () => {
  const decode = (text: string) => strictCommandJson(Buffer.from(text));
  expect(decode('{"z":2,"a":[1,{"z":"中 😀"}]}')).toEqual({ z: 2, a: [1, { z: "中 😀" }] });
  expect(commandValue(decode('{"z":2,"a":1}')).toString()).toBe('{"a":1,"z":2}');
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"nested":{"a":1,"a":2}}',
    "1.0",
    "[1e0]",
    '{"a":9007199254740992}',
    '{"a":"\\ud800"}',
    '{"a":"\\u0000"}',
    '{"":1}',
    '{"a":NaN}',
    "\ufeff{}",
    `[${"0,".repeat(4096)}0]`,
    "[".repeat(14) + "0" + "]".repeat(14),
  ])
    expect(() => decode(text), text).toThrow("invalid_command_contract");
  expect(() => strictCommandJson(Buffer.from([0xff]))).toThrow();
  expect(() =>
    commandValue({
      get a() {
        throw new Error("must not invoke accessors");
      },
    }),
  ).toThrow("invalid_command_contract");
  expect(() => commandValue(new Date())).toThrow();
  expect(() => commandValue(new Array(1))).toThrow();
});
