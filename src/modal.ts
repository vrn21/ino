import type { ModalLaunchRequest, ModalLaunchResult, ModalSandboxStatus } from "./types";

const LAUNCH_TIMEOUT_MS = 75_000;
const STATUS_TIMEOUT_MS = 10_000;
const TERMINATE_TIMEOUT_MS = 75_000;
const MAX_LOG_BYTES = 8 * 1024;

type ModalBridgeErrorCategory = "configuration" | "endpoint" | "timeout" | "transport" | "http" | "response";

/** Contains only a fixed category and optional HTTP status, never an upstream body or request data. */
export class ModalBridgeError extends Error {
  constructor(readonly category: ModalBridgeErrorCategory, readonly status?: number) {
    super(category === "http" && status !== undefined ? `Modal bridge HTTP ${status}` : `Modal bridge ${category} error`);
    this.name = "ModalBridgeError";
  }

  diagnostic(): string {
    return this.category === "http" && this.status !== undefined ? `bridge HTTP ${this.status}` : `bridge ${this.category}`;
  }
}

export interface ModalEnvironment {
  /** Set only for intentionally local/demo sessions. Remote Modal is otherwise the default. */
  MODAL_MODE?: "mock" | "remote";
  /** HTTPS URL for the Modal-hosted bridge, without a trailing slash. */
  MODAL_ENDPOINT?: string;
  /** Bearer secret shared with the Modal-hosted bridge. */
  MODAL_BRIDGE_TOKEN?: string;
}

export interface ModalRuntime {
  launch(request: ModalLaunchRequest): Promise<ModalLaunchResult>;
  status(sandboxId: string, logOffset: number): Promise<ModalSandboxStatus>;
  terminate(sandboxId: string): Promise<void>;
}

export interface ModalBridgePayload {
  sessionId: string;
  repository: { fullName: string; defaultBranch: string; url: string };
  prompt: string;
  credentials: ModalLaunchRequest["credentials"];
}

export function modalMode(env: ModalEnvironment): "mock" | "remote" {
  if (env.MODAL_MODE === "mock") return "mock";
  if (env.MODAL_MODE && env.MODAL_MODE !== "remote") throw new Error("Invalid Modal mode");
  return "remote";
}

export function buildModalBridgePayload(request: ModalLaunchRequest): ModalBridgePayload {
  return {
    sessionId: request.sessionId,
    repository: {
      fullName: request.repository.fullName,
      defaultBranch: request.repository.defaultBranch,
      url: request.repository.url,
    },
    prompt: request.prompt,
    // The bridge must receive these only in the launch request. The Worker never persists them.
    credentials: request.credentials,
  };
}

function bridgeUrl(endpoint: string, path: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ModalBridgeError("endpoint");
  }
  if (url.protocol !== "https:") throw new ModalBridgeError("endpoint");
  const [pathname, search = ""] = path.split("?", 2);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${pathname}`;
  url.search = search;
  return url.toString();
}

function boundedOffset(offset: number): number {
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function limitUtf8(value: string, limit: number): string {
  if (new TextEncoder().encode(value).byteLength <= limit) return value;
  let end = value.length;
  while (end > 0 && new TextEncoder().encode(value.slice(0, end)).byteLength > limit) end--;
  return value.slice(0, end);
}

function checkedVncUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new ModalBridgeError("http", response.status);
  try {
    const value = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof ModalBridgeError) throw cause;
    throw new ModalBridgeError("response");
  }
}

/** Fetch-only Modal bridge client; compatible with Cloudflare workerd. */
export class ModalAdapter implements ModalRuntime {
  constructor(private readonly env: ModalEnvironment, private readonly fetcher?: typeof fetch) {}

  async launch(request: ModalLaunchRequest): Promise<ModalLaunchResult> {
    if (modalMode(this.env) === "mock") {
      return { id: `mock-${request.sessionId}`, vncUrl: `https://mock-vnc.invalid/sessions/${request.sessionId}` };
    }
    const result = await this.request("/launch", { method: "POST", body: JSON.stringify(buildModalBridgePayload(request)) }, LAUNCH_TIMEOUT_MS);
    if (typeof result.id !== "string" || result.id.length === 0 || result.id.length > 200) {
      throw new ModalBridgeError("response");
    }
    return { id: result.id, vncUrl: checkedVncUrl(result.vncUrl) };
  }

  async status(sandboxId: string, logOffset: number): Promise<ModalSandboxStatus> {
    if (modalMode(this.env) === "mock") return { log: "", nextLogOffset: boundedOffset(logOffset), sandboxExitCode: null };
    const result = await this.request(`/status/${encodeURIComponent(sandboxId)}?offset=${boundedOffset(logOffset)}`, { method: "GET" }, STATUS_TIMEOUT_MS);
    const log = typeof result.log === "string" ? result.log : "";
    const nextLogOffset = typeof result.nextLogOffset === "number" ? boundedOffset(result.nextLogOffset) : boundedOffset(logOffset);
    const agentExitCode = typeof result.agentExitCode === "number" && Number.isInteger(result.agentExitCode) ? result.agentExitCode : undefined;
    const sandboxExitCode = typeof result.sandboxExitCode === "number" && Number.isInteger(result.sandboxExitCode)
      ? result.sandboxExitCode
      : null;
    return { log: limitUtf8(log, MAX_LOG_BYTES), nextLogOffset, agentExitCode, sandboxExitCode };
  }

  async terminate(sandboxId: string): Promise<void> {
    if (modalMode(this.env) === "mock") return;
    await this.request(`/terminate/${encodeURIComponent(sandboxId)}`, { method: "POST" }, TERMINATE_TIMEOUT_MS);
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.env.MODAL_ENDPOINT || !this.env.MODAL_BRIDGE_TOKEN) throw new ModalBridgeError("configuration");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const request = new Request(bridgeUrl(this.env.MODAL_ENDPOINT, path), {
        ...init,
        headers: {
          authorization: `Bearer ${this.env.MODAL_BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
      });
      // Calling a stored reference as this.fetcher(...) binds `this` to ModalAdapter.
      // workerd's native fetch rejects that with Illegal invocation, so native fetch
      // must be called directly. Tests may still inject a standalone fetch function.
      const response = this.fetcher ? await this.fetcher.call(undefined, request) : await fetch(request);
      return await responseJson(response);
    } catch (cause) {
      if (cause instanceof ModalBridgeError) throw cause;
      if (controller.signal.aborted) throw new ModalBridgeError("timeout");
      throw new ModalBridgeError("transport");
    } finally {
      clearTimeout(timeout);
    }
  }
}
