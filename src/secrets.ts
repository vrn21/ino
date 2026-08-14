import { ModalBridgeError } from "./modal";
import type { ByosCredentials } from "./types";

/**
 * Validate credentials without inspecting or returning their value. Callers must
 * pass the credentials directly to the launcher and must not write them to state.
 */
export function isValidByosCredentials(value: unknown): value is ByosCredentials {
  if (typeof value !== "object" || value === null) return false;
  const credentials = value as Record<string, unknown>;
  return typeof credentials.openaiApiKey === "string" && /^sk(?:-[A-Za-z0-9_-]+)$/.test(credentials.openaiApiKey)
    && (credentials.githubToken === undefined || (typeof credentials.githubToken === "string" && /^(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+$/.test(credentials.githubToken)));
}

/** Avoid reflecting provider errors or agent output that could include a submitted secret. */
export function safeRuntimeError(cause: unknown, fallback = "Modal operation failed"): string {
  return cause instanceof ModalBridgeError ? `${fallback} (${cause.diagnostic()})` : fallback;
}
