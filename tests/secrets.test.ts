import { expect, test } from "bun:test";
import { isValidByosCredentials } from "../src/secrets";

test("BYOS validation requires a non-empty OpenAI key", () => {
  expect(isValidByosCredentials({ openaiApiKey: "key" })).toBe(true);
  expect(isValidByosCredentials({ openaiApiKey: "" })).toBe(false);
  expect(isValidByosCredentials({})).toBe(false);
});
