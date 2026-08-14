import { expect, test } from "bun:test";
import worker from "../src/index";

test("Worker returns 404 for a malformed Durable Object session ID without calling a stub", async () => {
  let getCalled = false;
  const env = {
    SESSIONS: {
      idFromString: () => { throw new Error("invalid Durable Object ID"); },
      get: () => { getCalled = true; throw new Error("must not be called"); },
    },
    ASSETS: { fetch: () => new Response("asset") },
  } as unknown as Parameters<typeof worker.fetch>[1];

  const response = await worker.fetch(new Request("https://worker.test/api/sessions/not-a-do-id"), env);
  expect(response.status).toBe(404);
  expect(await response.json() as { error: string }).toEqual({ error: "Session not found" });
  expect(getCalled).toBe(false);
});
