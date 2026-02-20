import { Client } from "@microsoft/microsoft-graph-client";
import { getAccessToken } from "./auth";
import { getConfig, getAuthMode } from "../config";
import { createChildLogger } from "../logger";

const log = createChildLogger("graph-client");

let _client: Client | null = null;

// ── Initialize Graph client ───────────────────────────────────────

export function getGraphClient(): Client {
  if (_client) return _client;

  _client = Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessToken();
        done(null, token);
      } catch (error) {
        done(error as Error, null);
      }
    },
  });

  log.info("Microsoft Graph client initialized");
  return _client;
}

// ── User path helper ──────────────────────────────────────────────
// Client credentials flow requires /users/{id} instead of /me
// Delegated flow uses /me

export function getUserPath(): string {
  const mode = getAuthMode();

  if (mode === "client_credentials") {
    const config = getConfig();
    if (!config.GRAPH_USER_ID) {
      throw new Error(
        "GRAPH_USER_ID is required for client credentials flow. Set it to your Microsoft 365 UPN or user ID."
      );
    }
    return `/users/${config.GRAPH_USER_ID}`;
  }

  return "/me";
}

// ── Generic Graph request with error handling ─────────────────────

export async function graphPost<T>(path: string, body: unknown): Promise<T> {
  const client = getGraphClient();
  const fullPath = `${getUserPath()}${path}`;

  try {
    const result = await client.api(fullPath).post(body);
    log.debug({ path: fullPath }, "Graph API POST succeeded");
    return result as T;
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };
    log.error(
      { path: fullPath, statusCode: err.statusCode, message: err.message },
      "Graph API POST failed"
    );
    throw error;
  }
}

export async function graphGet<T>(path: string, queryParams?: Record<string, string>): Promise<T> {
  const client = getGraphClient();
  const fullPath = `${getUserPath()}${path}`;

  let request = client.api(fullPath);

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (key === "$filter") request = request.filter(value);
      else if (key === "$select") request = request.select(value);
      else if (key === "$top") request = request.top(parseInt(value));
      else if (key === "$orderby") request = request.orderby(value);
      else request = request.query({ [key]: value });
    }
  }

  try {
    const result = await request.get();
    log.debug({ path: fullPath }, "Graph API request succeeded");
    return result as T;
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };
    log.error(
      { path: fullPath, statusCode: err.statusCode, message: err.message },
      "Graph API request failed"
    );
    throw error;
  }
}
