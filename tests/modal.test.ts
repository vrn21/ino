import { expect, test } from "bun:test";
import { buildModalBridgePayload, ModalAdapter } from "../src/modal";

const request = {
  sessionId: "session-1",
  repository: { id: 1, fullName: "octo/repo", defaultBranch: "main", private: true, url: "https://github.com/octo/repo" },
  prompt: "Fix the test",
  harness: "codex" as const,
  credentials: { openaiApiKey: "sk-secret" },
};

test("Modal bridge payload launches Codex and keeps API key only in process environment", () => {
  const payload = buildModalBridgePayload(request, { MODAL_IMAGE: "codex:test" });
  expect(payload).toEqual({
    sessionId: "session-1",
    image: "codex:test",
    command: ["codex", "exec", "Fix the test"],
    environment: { OPENAI_API_KEY: "sk-secret" },
    repository: { fullName: "octo/repo", defaultBranch: "main", url: "https://github.com/octo/repo" },
  });
  expect(JSON.stringify(payload)).not.toContain('"credentials"');
});

test("Modal adapter uses local mock mode without network access", async () => {
  const adapter = new ModalAdapter({}, (() => { throw new Error("should not fetch"); }) as unknown as typeof fetch);
  await expect(adapter.launch(request)).resolves.toEqual({
    id: "mock-session-1", vncUrl: "https://mock-vnc.invalid/sessions/session-1",
  });
});

test("Modal remote mode constructs authenticated launch request", async () => {
  let captured: RequestInit | undefined;
  const adapter = new ModalAdapter(
    { MODAL_MODE: "remote", MODAL_ENDPOINT: "https://bridge.example/", MODAL_TOKEN: "modal-token" },
    (async (_url, init) => { captured = init; return new Response(JSON.stringify({ id: "modal-1", vncUrl: "https://vnc.example" })); }) as typeof fetch,
  );
  await expect(adapter.launch(request)).resolves.toEqual({ id: "modal-1", vncUrl: "https://vnc.example" });
  expect(captured?.headers).toEqual({ authorization: "Bearer modal-token", "content-type": "application/json" });
});
