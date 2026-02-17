import {
  ConfidentialClientApplication,
  PublicClientApplication,
  type AuthenticationResult,
  type Configuration,
} from "@azure/msal-node";
import { getConfig, getAuthMode } from "../config";
import { createChildLogger } from "../logger";

const log = createChildLogger("graph-auth");

const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];
const DELEGATED_SCOPES = [
  "Mail.Read",
  "Mail.ReadWrite",
  "Calendars.Read",
  "Tasks.Read",
  "User.Read",
];

let _confidentialApp: ConfidentialClientApplication | null = null;
let _publicApp: PublicClientApplication | null = null;
let _cachedToken: string | null = null;
let _tokenExpiry: Date | null = null;

// ── Get access token (auto-detects flow) ──────────────────────────

export async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 5-min buffer)
  if (_cachedToken && _tokenExpiry) {
    const bufferMs = 5 * 60 * 1000;
    if (new Date().getTime() < _tokenExpiry.getTime() - bufferMs) {
      return _cachedToken;
    }
  }

  const mode = getAuthMode();

  if (mode === "client_credentials") {
    return getClientCredentialsToken();
  } else {
    return getDelegatedToken();
  }
}

// ── Client Credentials Flow ───────────────────────────────────────

async function getClientCredentialsToken(): Promise<string> {
  const config = getConfig();

  if (!_confidentialApp) {
    const msalConfig: Configuration = {
      auth: {
        clientId: config.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${config.AZURE_TENANT_ID}`,
        clientSecret: config.AZURE_CLIENT_SECRET!,
      },
    };
    _confidentialApp = new ConfidentialClientApplication(msalConfig);
    log.info("Initialized MSAL ConfidentialClientApplication (client credentials flow)");
  }

  try {
    const result: AuthenticationResult | null =
      await _confidentialApp.acquireTokenByClientCredential({
        scopes: GRAPH_SCOPES,
      });

    if (!result?.accessToken) {
      throw new Error("No access token returned from client credentials flow");
    }

    _cachedToken = result.accessToken;
    _tokenExpiry = result.expiresOn;

    log.debug(
      { expiresOn: result.expiresOn?.toISOString() },
      "Acquired token via client credentials"
    );

    return result.accessToken;
  } catch (error) {
    log.error({ error }, "Failed to acquire token via client credentials");
    throw error;
  }
}

// ── Delegated Flow (refresh token) ────────────────────────────────

async function getDelegatedToken(): Promise<string> {
  const config = getConfig();

  if (!_publicApp) {
    const msalConfig: Configuration = {
      auth: {
        clientId: config.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${config.AZURE_TENANT_ID}`,
      },
    };
    _publicApp = new PublicClientApplication(msalConfig);
    log.info("Initialized MSAL PublicClientApplication (delegated flow)");
  }

  if (!config.AZURE_REFRESH_TOKEN) {
    throw new Error(
      "AZURE_REFRESH_TOKEN is required for delegated flow. Run the initial auth setup first."
    );
  }

  try {
    const result: AuthenticationResult | null =
      await _publicApp.acquireTokenByRefreshToken({
        refreshToken: config.AZURE_REFRESH_TOKEN,
        scopes: DELEGATED_SCOPES,
      });

    if (!result?.accessToken) {
      throw new Error("No access token returned from refresh token flow");
    }

    _cachedToken = result.accessToken;
    _tokenExpiry = result.expiresOn;

    log.debug(
      { expiresOn: result.expiresOn?.toISOString() },
      "Acquired token via refresh token"
    );

    return result.accessToken;
  } catch (error) {
    log.error(
      { error },
      "Failed to acquire token via refresh token. Token may have expired — re-authentication required."
    );
    throw error;
  }
}

// ── Reset (for testing / re-auth) ─────────────────────────────────

export function resetAuth(): void {
  _confidentialApp = null;
  _publicApp = null;
  _cachedToken = null;
  _tokenExpiry = null;
  log.info("Auth state reset");
}
