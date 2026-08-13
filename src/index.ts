import { getIdentity, listRepositories } from "./github";
import { error, json, readJson } from "./http";
import { CodingSession } from "./session";
import type { CreateSessionInput } from "./types";

export { CodingSession };

export interface Env {
  SESSIONS: DurableObjectNamespace;
  ASSETS: Fetcher;
  MODAL_MODE?: "mock" | "remote";
  MODAL_ENDPOINT?: string;
  MODAL_TOKEN?: string;
  MODAL_IMAGE?: string;
}

function githubToken(request: Request): string | undefined {
  return request.headers.get("x-github-token") ?? undefined;
}

function sessionStub(env: Env, sessionId: string): DurableObjectStub | null {
  try {
    return env.SESSIONS.get(env.SESSIONS.idFromString(sessionId));
  } catch {
    return null;
  }
}

function doRequest(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  return stub.fetch(`https://session.internal${path}`, init);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const token = githubToken(request);

    if (request.method === "GET" && url.pathname === "/api/auth/identity") {
      try { return json(await getIdentity(token)); } catch (cause) { return error(cause instanceof Error ? cause.message : "GitHub request failed", 401); }
    }
    if (request.method === "GET" && url.pathname === "/api/repositories") {
      try { return json(await listRepositories(token)); } catch (cause) { return error(cause instanceof Error ? cause.message : "GitHub request failed", 401); }
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const input = await readJson<CreateSessionInput>(request);
      if (!input) return error("A JSON session payload is required");
      const id = env.SESSIONS.newUniqueId();
      const response = await doRequest(env.SESSIONS.get(id), "/initialize", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      return response;
    }

    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(start|message|stop))?$/);
    if (!match) {
      if (url.pathname.startsWith("/api/")) return error("Route not found", 404);
      return env.ASSETS.fetch(request);
    }
    const [, id, action] = match;
    let path = "/";
    if (action) path = `/${action}`;
    if (!action && request.method !== "GET") return error("Method not allowed", 405);
    if (action && request.method !== "POST") return error("Method not allowed", 405);

    const stub = sessionStub(env, id);
    if (!stub) return error("Session not found", 404);
    const body = action === "stop" ? undefined : request.body;
    const headers = request.headers.get("content-type")
      ? { "content-type": request.headers.get("content-type")! }
      : undefined;
    return doRequest(stub, path, { method: request.method, headers, body });
  },
} satisfies ExportedHandler<Env>;
