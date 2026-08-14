import { expect, test } from "bun:test";
import { CodingSession, sanitizeOutput } from "../src/session";
import type { ModalRuntime } from "../src/modal";
import type { CodingSessionState } from "../src/types";

const repository = {
  id: 1,
  fullName: "acme/agent",
  defaultBranch: "main",
  private: true,
  url: "https://github.com/acme/agent",
};

class FakeDurableObjectState {
  readonly id = { toString: () => "durable-session-id" };
  readonly writes: CodingSessionState[] = [];
  private value: CodingSessionState | undefined;
  readonly storage = {
    get: async <T>(_key: string): Promise<T | undefined> => this.value as T | undefined,
    put: async (_key: string, value: CodingSessionState): Promise<void> => {
      const snapshot = JSON.parse(JSON.stringify(value)) as CodingSessionState;
      this.value = snapshot;
      this.writes.push(snapshot);
    },
  };

  persisted(): CodingSessionState | undefined { return this.value; }
}

function fakeRuntime(): ModalRuntime {
  return {
    launch: async () => ({ id: "modal-sandbox-id", vncUrl: "https://desktop.modal.run" }),
    status: async (_id, offset) => ({ log: "working\n", nextLogOffset: offset + 8, sandboxExitCode: null }),
    terminate: async () => undefined,
  };
}

function createSession(state = new FakeDurableObjectState(), modal = fakeRuntime()): { state: FakeDurableObjectState; session: CodingSession } {
  return {
    state,
    session: new CodingSession(state as unknown as DurableObjectState, { MODAL_MODE: "mock" }, modal),
  };
}

function request(path: string, body?: unknown, githubToken?: string): Request {
  return new Request(`https://session.test${path}`, {
    method: path === "/" ? "GET" : "POST",
    headers: body === undefined ? (githubToken ? { "x-github-token": githubToken } : undefined) : {
      "content-type": "application/json", ...(githubToken ? { "x-github-token": githubToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("session rejects non-canonical repository URLs and overlong prompts before persisting state", async () => {
  const { state, session } = createSession();
  const nonCanonical = await session.fetch(request("/initialize", {
    repo: { ...repository, url: "https://github.com/acme/agent/issues" }, prompt: "Implement it",
  }));
  expect(nonCanonical.status).toBe(400);
  expect(state.persisted()).toBeUndefined();

  const overlongPrompt = await session.fetch(request("/initialize", { repo: repository, prompt: "a".repeat(8_001) }));
  expect(overlongPrompt.status).toBe(400);
  expect(state.persisted()).toBeUndefined();
});

test("session launch, bounded sync, and stop never persist BYOS keys and terminate the sandbox", async () => {
  const openAiKey = "sk-test-synthetic-key-must-never-persist";
  const githubToken = "github_pat_test_synthetic_never_persist";
  const state = new FakeDurableObjectState();
  let launchCredentials: unknown;
  const modal: ModalRuntime = {
    launch: async (launch) => {
      launchCredentials = launch.credentials;
      return { id: "modal-sandbox-id", vncUrl: "https://desktop.modal.run" };
    },
    status: async (_id, offset) => ({ log: `${openAiKey}\n${githubToken}\n${"x".repeat(9_000)}`, nextLogOffset: offset + 9_000, sandboxExitCode: null }),
    terminate: async (id) => { expect(id).toBe("modal-sandbox-id"); },
  };
  const { session } = createSession(state, modal);

  expect((await session.fetch(request("/initialize", { repo: repository, prompt: "Fix the failing test" }))).status).toBe(201);
  const started = await session.fetch(request("/start", { credentials: { openaiApiKey: openAiKey } }, githubToken));
  expect(started.status).toBe(200);
  expect(launchCredentials).toEqual({ openaiApiKey: openAiKey, githubToken });

  const synced = await session.fetch(request("/"));
  const syncedText = await synced.text();
  expect(syncedText).not.toContain(openAiKey);
  expect(syncedText).not.toContain(githubToken);
  expect(syncedText).not.toContain("synthetic-key-must-never-persist");
  expect(JSON.parse(syncedText) as CodingSessionState).toMatchObject({ status: "running", modalSessionId: "modal-sandbox-id" });
  expect(JSON.stringify(state.writes)).not.toContain(openAiKey);
  expect(JSON.stringify(state.writes)).not.toContain(githubToken);
  expect((JSON.parse(syncedText) as CodingSessionState).logs.at(-1)?.message.length).toBeLessThanOrEqual(8_192);

  const stopped = await session.fetch(request("/stop"));
  expect(stopped.status).toBe(200);
  expect((await stopped.json() as CodingSessionState).status).toBe("stopped");
});

test("session ignores a stale status cursor to avoid duplicate polling output", async () => {
  const state = new FakeDurableObjectState();
  let polls = 0;
  const modal: ModalRuntime = {
    launch: async () => ({ id: "modal-sandbox-id" }),
    status: async () => ({ log: "already-read", nextLogOffset: polls++ === 0 ? 12 : 12, sandboxExitCode: null }),
    terminate: async () => undefined,
  };
  const session = new CodingSession(state as unknown as DurableObjectState, {}, modal);
  await session.fetch(request("/initialize", { repo: repository, prompt: "Fix it" }));
  await session.fetch(request("/start", { credentials: { openaiApiKey: "sk-test" } }));
  await session.fetch(request("/"));
  await session.fetch(request("/"));
  const outputEvents = state.persisted()?.logs.filter((event) => event.type === "output") ?? [];
  expect(outputEvents).toHaveLength(1);
  expect(state.persisted()?.modalLogOffset).toBe(12);
});

test("output sanitizer preserves normal logs, redacts credentials, and enforces an UTF-8 byte cap", () => {
  expect(sanitizeOutput("Reading package.json\nBuilt successfully\n")).toBe("Reading package.json\nBuilt successfully\n");
  expect(sanitizeOutput("token sk-synthetic-secret\nauthorization: Bearer secret-value")).toContain("[redacted OpenAI key]");
  const capped = sanitizeOutput("🙂".repeat(3_000));
  expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(8_192);
});

test("follow-up messages are not accepted because Codex exec has no safe input channel", async () => {
  const { session } = createSession();
  expect((await session.fetch(request("/message", { message: "do something else" }))).status).toBe(404);
});
