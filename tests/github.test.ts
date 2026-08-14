import { expect, test } from "bun:test";
import { getIdentity, listRepositories } from "../src/github";

function rejectedGitHubFetch(status: number): typeof fetch {
  return (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status })) as unknown as typeof fetch;
}

test("GitHub identity rejects an invalid supplied token instead of falling back to demo identity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = rejectedGitHubFetch(401);
  try {
    await expect(getIdentity("invalid-token")).rejects.toThrow("GitHub rejected the token (401)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub repository listing rejects an invalid supplied token instead of returning demo repositories", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = rejectedGitHubFetch(403);
  try {
    await expect(listRepositories("invalid-token")).rejects.toThrow("GitHub rejected the token (403)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub routes use demo data only when no token is supplied", async () => {
  await expect(getIdentity()).resolves.toMatchObject({ id: "demo-user", mode: "demo" });
  await expect(listRepositories()).resolves.toMatchObject([{ fullName: "demo/hello-world" }]);
});
