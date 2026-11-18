import type { AppType } from "@portal/api";
import { hc } from "hono/client";

/**
 * Typed RPC client, inferred from the server's own route definitions.
 *
 * There is no OpenAPI document and no code generation: renaming a field on the
 * server breaks `pnpm typecheck` in the app. That is the main reason the whole
 * stack is TypeScript rather than a typed-language backend.
 */
const client = hc<AppType>("/", {
  init: { credentials: "include" },
});

export const api = client.api;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

/** Narrow a Hono RPC response into data-or-throw, so callers stay linear. */
export async function unwrap<T>(response: {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}): Promise<T> {
  if (!response.ok) {
    let code = `http_${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      code = body.error ?? body.message ?? code;
    } catch {
      // Non-JSON error body (proxy 502, offline, etc.) — keep the status code.
    }
    throw new ApiError(response.status, code);
  }
  return (await response.json()) as T;
}

/** True when a failure is "the network is gone", not "the server said no". */
export function isOfflineError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && error.status >= 500);
}
