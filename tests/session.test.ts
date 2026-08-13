import { expect, test } from "bun:test";
import { CodingSession } from "../src/session";
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
      // Snapshot every persisted write so test assertions cannot be masked by mutation.
      const snapshot = JSON.parse(JSON.stringify(value)) as CodingSessionState;
      this.value = snapshot;
      this.writes.push(snapshot);
    },
  };

  persisted(): CodingSessionState | undefined {
    return this.value;
  }
}

function createSession(state = new FakeDurableObjectState()): { state: FakeDurableObjectState; session: CodingSession } {
  return {
    state,
    session: new CodingSession(state as unknown as DurableObjectState, { MODAL_MODE: "mock" }),
  };
}

function request(path: string, body?: unknown): Request {
  return new Request(`https://session.test${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("session rejects non-canonical repository URLs and overlong prompts before persisting state", async () => {
  const { state, session } = createSession();
  const nonCanonical = await session.fetch(request("/initialize", {
    repo: { ...repository, url: "https://github.com/acme/agent/issues" },
    prompt: "Implement it",
  }));
  expect(nonCanonical.status).toBe(400);
  expect(state.persisted()).toBeUndefined();

  const overlongPrompt = await session.fetch(request("/initialize", {
    repo: repository,
    prompt: "a".repeat(8_001),
  }));
  expect(overlongPrompt.status).toBe(400);
  expect(state.persisted()).toBeUndefined();
});

test("session lifecycle persists transitions without persisting or returning a BYOS key", async () => {
  const syntheticKey = "sk-test-synthetic-key-must-never-persist";
  const { state, session } = createSession();

  const created = await session.fetch(request("/initialize", { repo: repository, prompt: "Fix the failing test" }));
  expect(created.status).toBe(201);
  expect((await created.json() as CodingSessionState).status).toBe("created");

  const preStartMessage = await session.fetch(request("/message", { message: "Wait for test output" }));
  expect(preStartMessage.status).toBe(409);

  const started = await session.fetch(request("/start", { credentials: { openaiApiKey: syntheticKey } }));
  expect(started.status).toBe(200);
  const startedJson = await started.text();
  expect(startedJson).not.toContain(syntheticKey);
  expect(JSON.parse(startedJson) as CodingSessionState).toMatchObject({
    status: "running",
    modalSessionId: "mock-durable-session-id",
  });
  expect(JSON.stringify(state.writes)).not.toContain(syntheticKey);
  expect(JSON.stringify(state.persisted())).not.toContain(syntheticKey);

  const duplicateStart = await session.fetch(request("/start", { credentials: { openaiApiKey: syntheticKey } }));
  expect(duplicateStart.status).toBe(409);
  expect(await duplicateStart.json() as { error: string }).toEqual({ error: "Only newly created sessions can be started" });

  const overlongMessage = await session.fetch(request("/message", { message: "m".repeat(2_001) }));
  expect(overlongMessage.status).toBe(400);

  const messaged = await session.fetch(request("/message", { message: "Use the narrowest fix" }));
  expect(messaged.status).toBe(200);
  expect((await messaged.json() as CodingSessionState).logs.at(-1)).toMatchObject({ type: "message", message: "Use the narrowest fix" });

  const stopped = await session.fetch(request("/stop"));
  expect(stopped.status).toBe(200);
  expect((await stopped.json() as CodingSessionState).status).toBe("stopped");

  const stoppedMessage = await session.fetch(request("/message", { message: "This should not be accepted" }));
  expect(stoppedMessage.status).toBe(409);
  expect(await stoppedMessage.json() as { error: string }).toEqual({ error: "Session is not running" });
  expect(JSON.stringify(state.writes)).not.toContain(syntheticKey);
});
