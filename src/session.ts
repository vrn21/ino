import { error, isRecord, json, readJson } from "./http";
import { ModalAdapter } from "./modal";
import type { ModalEnvironment } from "./modal";
import { isValidByosCredentials } from "./secrets";
import type { CodingSessionState, CreateSessionInput, MessageSessionInput, Repository, StartSessionInput } from "./types";

const STATE_KEY = "session";
const MAX_EVENTS = 200;
const MAX_LOG_BYTES = 96 * 1024;
const MAX_PROMPT_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 2_000;

function isRepository(value: unknown): value is Repository {
  if (!isRecord(value)
    || (typeof value.id !== "string" && typeof value.id !== "number")
    || typeof value.fullName !== "string" || value.fullName.length > 200
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.fullName)
    || typeof value.defaultBranch !== "string" || value.defaultBranch.length === 0 || value.defaultBranch.length > 255
    || typeof value.private !== "boolean"
    || typeof value.url !== "string" || value.url.length > 300) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" && url.hostname === "github.com"
      && url.pathname.replace(/^\//, "").replace(/\.git$/, "") === value.fullName;
  } catch {
    return false;
  }
}

function isCreateInput(value: unknown): value is CreateSessionInput {
  return isRecord(value) && isRepository(value.repo) && typeof value.prompt === "string"
    && value.prompt.trim().length > 0 && value.prompt.length <= MAX_PROMPT_LENGTH;
}

function isMessageInput(value: unknown): value is MessageSessionInput {
  return isRecord(value) && typeof value.message === "string"
    && value.message.trim().length > 0 && value.message.length <= MAX_MESSAGE_LENGTH;
}

export class CodingSession implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: ModalEnvironment) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/initialize") return this.initialize(request);
    if (request.method === "GET" && url.pathname === "/") return this.get();
    if (request.method === "POST" && url.pathname === "/start") return this.start(request);
    if (request.method === "POST" && url.pathname === "/message") return this.message(request);
    if (request.method === "POST" && url.pathname === "/stop") return this.stop();
    return error("Route not found", 404);
  }

  private async initialize(request: Request): Promise<Response> {
    const input = await readJson<unknown>(request);
    if (!isCreateInput(input)) return error("A canonical GitHub repo and prompt of at most 8,000 characters are required");
    const existing = await this.load();
    if (existing) return json(existing);

    const now = new Date().toISOString();
    const session: CodingSessionState = {
      id: this.state.id.toString(), status: "created", repo: input.repo, prompt: input.prompt.trim(),
      logs: [{ id: crypto.randomUUID(), at: now, type: "created", message: "Session created" }],
      mode: this.env.MODAL_MODE === "remote" ? "remote" : "mock",
      createdAt: now, updatedAt: now,
    };
    await this.save(session);
    return json(session, 201);
  }

  private async get(): Promise<Response> {
    const session = await this.load();
    return session ? json(session) : error("Session not found", 404);
  }

  private async start(request: Request): Promise<Response> {
    const input = await readJson<StartSessionInput>(request);
    if (!input || !isValidByosCredentials(input.credentials)) return error("A non-empty credentials.openaiApiKey is required");
    const session = await this.load();
    if (!session) return error("Session not found", 404);
    if (session.status !== "created") return error("Only newly created sessions can be started", 409);

    session.status = "starting";
    session.startedAt ??= new Date().toISOString();
    this.addEvent(session, "started", "Starting Codex in Modal");
    await this.save(session);

    try {
      // Credentials are passed directly to launch and are deliberately not added to session or events.
      const launched = await new ModalAdapter(this.env).launch({
        sessionId: session.id, repository: session.repo, prompt: session.prompt, harness: "codex", credentials: input.credentials,
      });
      session.status = "running";
      session.modalSessionId = launched.id;
      session.vncUrl = launched.vncUrl;
      this.addEvent(session, "started", session.mode === "mock" ? "Demo sandbox is running (Codex is not connected)" : "Codex is running");
      await this.save(session);
      return json(session);
    } catch (cause) {
      session.status = "failed";
      this.addEvent(session, "error", cause instanceof Error ? cause.message : "Modal launch failed");
      await this.save(session);
      return json(session, 502);
    }
  }

  private async message(request: Request): Promise<Response> {
    const input = await readJson<unknown>(request);
    if (!isMessageInput(input)) return error("A message of at most 2,000 characters is required");
    const session = await this.load();
    if (!session) return error("Session not found", 404);
    if (session.status !== "running") return error("Session is not running", 409);
    // A production bridge would forward this to the Modal process. Polling retains its event trail.
    this.addEvent(session, "message", input.message.trim());
    await this.save(session);
    return json(session);
  }

  private async stop(): Promise<Response> {
    const session = await this.load();
    if (!session) return error("Session not found", 404);
    if (session.status === "stopped") return json(session);
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    this.addEvent(session, "stopped", "Session stopped");
    await this.save(session);
    return json(session);
  }

  private async load(): Promise<CodingSessionState | undefined> { return this.state.storage.get<CodingSessionState>(STATE_KEY); }
  private async save(session: CodingSessionState): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await this.state.storage.put(STATE_KEY, session);
  }
  private addEvent(session: CodingSessionState, type: CodingSessionState["logs"][number]["type"], message: string): void {
    session.logs.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, message });
    while (session.logs.length > MAX_EVENTS || JSON.stringify(session.logs).length > MAX_LOG_BYTES) session.logs.shift();
  }
}
