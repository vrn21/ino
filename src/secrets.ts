import type { ByosCredentials } from "./types";

/**
 * Validate credentials without inspecting or returning their value. Callers must
 * pass the credentials directly to the launcher and must not write them to state.
 */
export function isValidByosCredentials(value: unknown): value is ByosCredentials {
  const key = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>).openaiApiKey
    : undefined;
  return typeof key === "string" && key.length > 0;
}
