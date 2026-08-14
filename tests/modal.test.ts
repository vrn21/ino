import { expect, test } from "bun:test";
import { buildModalBridgePayload, ModalAdapter, modalMode } from "../src/modal";

const request = {
  sessionId: "session-1",
  repository: { id: 1, fullName: "octo/repo", defaultBranch: "main", private: true, url: "https://github.com/octo/repo" },
  prompt: "Fix the test",
  harness: "codex" as const,
  credentials: { openaiApiKey: "sk-synthetic-secret", githubToken: "github_pat_synthetic" },
};

test("bridge payload carries launch-only credentials without command interpolation", () => {
  const payload = buildModalBridgePayload(request);
  expect(payload).toEqual({
    sessionId: "session-1",
    repository: { fullName: "octo/repo", defaultBranch: "main", url: "https://github.com/octo/repo" },
    prompt: "Fix the test",
    credentials: request.credentials,
  });
});

test("Modal mock mode is explicit and never fetches a bridge", async () => {
  const adapter = new ModalAdapter({ MODAL_MODE: "mock" }, (() => { throw new Error("bridge must not be called"); }) as unknown as typeof fetch);
  await expect(adapter.launch(request)).resolves.toEqual({ id: "mock-session-1", vncUrl: "https://mock-vnc.invalid/sessions/session-1" });
  await expect(adapter.status("mock-session-1", 4)).resolves.toEqual({ log: "", nextLogOffset: 4, sandboxExitCode: null });
});

test("remote Modal is the default and requires bridge configuration", async () => {
  expect(modalMode({})).toBe("remote");
  await expect(new ModalAdapter({}).launch(request)).rejects.toThrow("Modal bridge is not configured");
});

test("fetch-only bridge client authenticates launch, bounded status, and termination", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    if (url.toString().includes("/launch")) return new Response(JSON.stringify({ id: "sb-123", vncUrl: "https://desktop.modal.run/vnc.html?autoconnect=1" }));
    if (url.toString().includes("/status/")) return new Response(JSON.stringify({ log: "Codex completed\n", nextLogOffset: 21, agentExitCode: 0, sandboxExitCode: null }));
    return new Response(JSON.stringify({ terminated: true }));
  }) as typeof fetch;
  const adapter = new ModalAdapter({ MODAL_ENDPOINT: "https://bridge.example/api/", MODAL_BRIDGE_TOKEN: "bridge-secret" }, fetcher);

  await expect(adapter.launch(request)).resolves.toEqual({ id: "sb-123", vncUrl: "https://desktop.modal.run/vnc.html?autoconnect=1" });
  await expect(adapter.status("sb-123", 5)).resolves.toEqual({ log: "Codex completed\n", nextLogOffset: 21, agentExitCode: 0, sandboxExitCode: null });
  await adapter.terminate("sb-123");

  expect(calls.map((call) => call.url)).toEqual([
    "https://bridge.example/api/launch",
    "https://bridge.example/api/status/sb-123?offset=5",
    "https://bridge.example/api/terminate/sb-123",
  ]);
  expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer bridge-secret", "content-type": "application/json" });
  expect(calls[0]?.init?.body).toBe(JSON.stringify(buildModalBridgePayload(request)));
  expect(JSON.stringify(calls[0]?.init)).toContain(request.credentials.openaiApiKey);
});

test("bridge rejects invalid endpoint and never accepts a non-HTTPS VNC URL", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ id: "sb-123", vncUrl: "http://invalid.example" }))) as unknown as typeof fetch;
  await expect(new ModalAdapter({ MODAL_ENDPOINT: "http://bridge.example", MODAL_BRIDGE_TOKEN: "secret" }, fetcher).launch(request)).rejects.toThrow("HTTPS");
  await expect(new ModalAdapter({ MODAL_ENDPOINT: "https://bridge.example", MODAL_BRIDGE_TOKEN: "secret" }, fetcher).launch(request))
    .resolves.toEqual({ id: "sb-123", vncUrl: undefined });
});
