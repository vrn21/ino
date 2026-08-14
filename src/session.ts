import { error, isRecord, json, readJson } from "./http";
import { ModalAdapter, modalMode } from "./modal";
import type { ModalEnvironment, ModalRuntime } from "./modal";
import { isValidByosCredentials, safeRuntimeError } from "./secrets";
import type { CodingSessionState, CreateSessionInput, Repository, StartSessionInput } from "./types";

const STATE_KEY = "session";
const MAX_EVENTS = 200;
const MAX_LOG_BYTES = 96 * 1024;
const MAX_EVENT_MESSAGE_LENGTH = 8 * 1024;
const MAX_PROMPT_LENGTH = 8_000;

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

function truncateUtf8(value: string, limit: number): string {
  if (new TextEncoder().encode(value).byteLength <= limit) return value;
  let end = value.length;
  while (end > 0 && new TextEncoder().encode(value.slice(0, end)).byteLength > limit) end--;
  return value.slice(0, end);
}

export function sanitizeOutput(output: string): string {
  // Preserve normal agent output. Only redact recognizable credentials and headers.
  return truncateUtf8(output
    .replace(/sk(?:-[A-Za-z0-9_-]+)+/g, "[redacted OpenAI key]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted GitHub token]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted GitHub token]")
    .replace(/(Authorization:\s*(?:Basic|Bearer)\s+)[^\s]+/gi, "$1[redacted]"), MAX_EVENT_MESSAGE_LENGTH);
}

export class CodingSession implements DurableObject {
  private readonly modal: ModalRuntime;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ModalEnvironment,
    modal?: ModalRuntime,
  ) {
    this.modal = modal ?? new ModalAdapter(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/initialize") return this.initialize(request);
    if (request.method === "GET" && url.pathname === "/") return this.get();
    if (request.method === "POST" && url.pathname === "/start") return this.start(request);
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
      mode: modalMode(this.env),
      createdAt: now, updatedAt: now,
    };
    await this.save(session);
    return json(session, 201);
  }

  private async get(): Promise<Response> {
    const session = await this.load();
    if (!session) return error("Session not found", 404);
    await this.sync(session);
    return json(session);
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
      // Credentials are launch-only and are deliberately excluded from session state and events.
      const launched = await this.modal.launch({
        sessionId: session.id,
        repository: session.repo,
        prompt: session.prompt,
        harness: "codex",
        credentials: { ...input.credentials, githubToken: request.headers.get("x-github-token") ?? input.credentials.githubToken },
      });
      session.status = "running";
      session.modalSessionId = launched.id;
      session.vncUrl = launched.vncUrl;
      this.addEvent(session, "started", session.mode === "mock" ? "Demo sandbox is running (Codex is not connected)" : "Codex is running in a Modal sandbox");
      await this.save(session);
      return json(session);
    } catch (cause) {
      session.status = "failed";
      this.addEvent(session, "error", safeRuntimeError(cause, "Unable to start the Modal sandbox"));
      await this.save(session);
      return json(session, 502);
    }
  }

  private async stop(): Promise<Response> {
    const session = await this.load();
    if (!session) return error("Session not found", 404);
    if (session.status === "stopped") return json(session);

    try {
      if (session.modalSessionId) await this.modal.terminate(session.modalSessionId);
      session.status = "stopped";
      session.stoppedAt = new Date().toISOString();
      this.addEvent(session, "stopped", "Modal sandbox terminated");
      await this.save(session);
      return json(session);
    } catch (cause) {
      this.addEvent(session, "error", safeRuntimeError(cause, "Unable to terminate the Modal sandbox"));
      await this.save(session);
      return json(session, 502);
    }
  }

  private async sync(session: CodingSessionState): Promise<void> {
    if (session.status !== "running" || !session.modalSessionId || session.mode === "mock") return;
    try {
      const requestedOffset = session.modalLogOffset ?? 0;
      const status = await this.modal.status(session.modalSessionId, requestedOffset);
      const sanitizedLog = sanitizeOutput(status.log);
      // A retrying bridge must not move the cursor backwards or duplicate an already-read chunk.
      if (sanitizedLog && status.nextLogOffset > requestedOffset) this.addEvent(session, "output", sanitizedLog);
      session.modalLogOffset = Math.max(requestedOffset, status.nextLogOffset);
      if (status.agentExitCode !== undefined) {
        session.status = status.agentExitCode === 0 ? "stopped" : "failed";
        session.stoppedAt ??= new Date().toISOString();
        this.addEvent(session, status.agentExitCode === 0 ? "completed" : "error", status.agentExitCode === 0
          ? "Codex completed successfully"
          : "Codex exited with an error");
      } else if (status.sandboxExitCode !== null) {
        session.status = status.sandboxExitCode === 0 ? "stopped" : "failed";
        session.stoppedAt ??= new Date().toISOString();
        this.addEvent(session, session.status === "stopped" ? "completed" : "error", session.status === "stopped"
          ? "Modal sandbox completed"
          : "Modal sandbox exited unexpectedly");
      }
      await this.save(session);
    } catch (cause) {
      this.addEvent(session, "error", safeRuntimeError(cause, "Unable to refresh Modal status"));
      await this.save(session);
    }
  }

  private async load(): Promise<CodingSessionState | undefined> { return this.state.storage.get<CodingSessionState>(STATE_KEY); }
  private async save(session: CodingSessionState): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await this.state.storage.put(STATE_KEY, session);
  }
  private addEvent(session: CodingSessionState, type: CodingSessionState["logs"][number]["type"], message: string): void {
    session.logs.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, message: truncateUtf8(message, MAX_EVENT_MESSAGE_LENGTH) });
    while (session.logs.length > MAX_EVENTS || JSON.stringify(session.logs).length > MAX_LOG_BYTES) session.logs.shift();
  }
}
