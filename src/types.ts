export type SessionStatus = "created" | "starting" | "running" | "stopped" | "failed";

export interface Identity {
  id: string;
  login: string;
  mode: "demo" | "github";
}

export interface Repository {
  id: number | string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
}

export interface SessionEvent {
  id: string;
  at: string;
  type: "created" | "started" | "message" | "stopped" | "error";
  message: string;
}

export interface CodingSessionState {
  id: string;
  status: SessionStatus;
  repo: Repository;
  prompt: string;
  logs: SessionEvent[];
  vncUrl?: string;
  modalSessionId?: string;
  mode: "mock" | "remote";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
}

export interface CreateSessionInput {
  repo: Repository;
  prompt: string;
}

/** Never persisted. These values are used only while launching the remote job. */
export interface ByosCredentials {
  openaiApiKey: string;
}

export interface StartSessionInput {
  credentials: ByosCredentials;
}

export interface MessageSessionInput {
  message: string;
}

export interface ModalLaunchRequest {
  sessionId: string;
  repository: Repository;
  prompt: string;
  harness: "codex";
  /** Ephemeral only: this object must never be written to Durable Object storage or logs. */
  credentials: ByosCredentials;
}

export interface ModalLaunchResult {
  id: string;
  vncUrl?: string;
}

export interface ApiError {
  error: string;
}
