import type { ModalLaunchRequest, ModalLaunchResult } from "./types";

export interface ModalEnvironment {
  MODAL_MODE?: "mock" | "remote";
  MODAL_ENDPOINT?: string;
  MODAL_TOKEN?: string;
  MODAL_IMAGE?: string;
}

/**
 * Expected by the optional Modal bridge endpoint. The bridge starts exactly one
 * Codex process and injects OPENAI_API_KEY only into that process environment.
 */
export interface ModalBridgePayload {
  sessionId: string;
  image: string;
  command: ["codex", "exec", string];
  environment: { OPENAI_API_KEY: string };
  repository: { fullName: string; defaultBranch: string; url: string };
}

export function buildModalBridgePayload(request: ModalLaunchRequest, env: ModalEnvironment): ModalBridgePayload {
  return {
    sessionId: request.sessionId,
    image: env.MODAL_IMAGE ?? "ghcr.io/openai/codex:latest",
    command: ["codex", "exec", request.prompt],
    environment: { OPENAI_API_KEY: request.credentials.openaiApiKey },
    repository: {
      fullName: request.repository.fullName,
      defaultBranch: request.repository.defaultBranch,
      url: request.repository.url,
    },
  };
}

/**
 * Modal's public API is intentionally isolated behind a small bridge because a
 * running Codex container needs repo checkout and VNC provisioning. In mock
 * mode (the default) no external network call is made, allowing local demos.
 */
export class ModalAdapter {
  constructor(private readonly env: ModalEnvironment, private readonly fetcher: typeof fetch = fetch) {}

  async launch(request: ModalLaunchRequest): Promise<ModalLaunchResult> {
    if (this.env.MODAL_MODE && this.env.MODAL_MODE !== "mock" && this.env.MODAL_MODE !== "remote") {
      throw new Error("MODAL_MODE must be mock or remote");
    }
    if (this.env.MODAL_MODE !== "remote") {
      return { id: `mock-${request.sessionId}`, vncUrl: `https://mock-vnc.invalid/sessions/${request.sessionId}` };
    }

    if (!this.env.MODAL_ENDPOINT || !this.env.MODAL_TOKEN) {
      throw new Error("Modal remote mode requires MODAL_ENDPOINT and MODAL_TOKEN");
    }

    const response = await this.fetcher(`${this.env.MODAL_ENDPOINT.replace(/\/$/, "")}/launch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.MODAL_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildModalBridgePayload(request, this.env)),
    });
    if (!response.ok) throw new Error(`Modal launch failed (${response.status})`);

    const result = await response.json() as { id?: unknown; vncUrl?: unknown };
    if (typeof result.id !== "string") throw new Error("Modal launch returned no job id");
    return { id: result.id, vncUrl: typeof result.vncUrl === "string" ? result.vncUrl : undefined };
  }
}
