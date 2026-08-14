import { expect, test } from "bun:test";
import { isValidByosCredentials, safeRuntimeError } from "../src/secrets";

test("BYOS validation requires a non-empty OpenAI key", () => {
  expect(isValidByosCredentials({ openaiApiKey: "sk-key" })).toBe(true);
  expect(isValidByosCredentials({ openaiApiKey: "" })).toBe(false);
  expect(isValidByosCredentials({ githubToken: "token" })).toBe(false);
  expect(isValidByosCredentials({ openaiApiKey: "sk-key", githubToken: "github_pat_token" })).toBe(true);
  expect(isValidByosCredentials({ openaiApiKey: "sk-key", githubToken: "" })).toBe(false);
});

test("runtime errors do not reflect secret-bearing provider messages", () => {
  expect(safeRuntimeError(new Error("request failed for sk-synthetic-secret"))).toBe("Modal operation failed");
});
