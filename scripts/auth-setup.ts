import "dotenv/config"; // Load .env file

/**
 * One-time auth setup for Smart Check-ins (Delegated Flow)
 *
 * This script performs the OAuth2 authorization code flow to obtain
 * a refresh token for accessing Microsoft Graph on your behalf.
 *
 * Usage:
 *   npx tsx scripts/auth-setup.ts
 *
 * Prerequisites:
 *   - AZURE_TENANT_ID and AZURE_CLIENT_ID set in environment (or .env file)
 *   - AZURE_CLIENT_SECRET set in environment (or .env file)
 *   - Your Entra app must have a redirect URI configured:
 *     http://localhost:3847/callback
 *     (Add this under Authentication > Web > Redirect URIs in Azure Portal)
 *
 * What it does:
 *   1. Opens your browser to Microsoft's sign-in page
 *   2. You sign in with your Microsoft 365 account
 *   3. Microsoft redirects back to a local server with an auth code
 *   4. The script exchanges the code for access + refresh tokens
 *   5. Prints the refresh token for you to store in Doppler / .env
 */

import http from "http";
import { URL } from "url";
import { ConfidentialClientApplication } from "@azure/msal-node";

// ── Config ────────────────────────────────────────────────────────

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3847/callback";
const PORT = 3847;

const SCOPES = [
  "offline_access", // Required to get a refresh token
  "Mail.Read", // Read inbox & sent folder (no write/send needed)
  "Calendars.Read", // Read calendar events
  "Tasks.Read", // Read To Do tasks (upgrade to Tasks.ReadWrite if Phase 2 needs task completion)
  "User.Read", // Basic profile info
];

// ── Validate ──────────────────────────────────────────────────────

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n❌ Missing required environment variables:");
  if (!TENANT_ID) console.error("   - AZURE_TENANT_ID");
  if (!CLIENT_ID) console.error("   - AZURE_CLIENT_ID");
  if (!CLIENT_SECRET) console.error("   - AZURE_CLIENT_SECRET");
  console.error("\nSet them in your environment or .env file, then try again.");
  console.error("Example: AZURE_TENANT_ID=xxx AZURE_CLIENT_ID=yyy AZURE_CLIENT_SECRET=zzz npx tsx scripts/auth-setup.ts\n");
  process.exit(1);
}

// ── MSAL Setup ────────────────────────────────────────────────────

const msalApp = new ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientSecret: CLIENT_SECRET,
  },
});

// ── Generate auth URL ─────────────────────────────────────────────

async function getAuthUrl(): Promise<string> {
  return await msalApp.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    prompt: "select_account", // Let user pick account; admin consent covers permissions
  });
}

// ── Exchange code for tokens ──────────────────────────────────────

async function exchangeCode(code: string): Promise<void> {
  try {
    const result = await msalApp.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
    });

    console.log("\n✅ Authentication successful!\n");
    console.log("────────────────────────────────────────────");
    console.log("Account:", result.account?.username);
    console.log("Token expires:", result.expiresOn?.toISOString());
    console.log("────────────────────────────────────────────\n");

    // MSAL v2 for Node doesn't directly expose the refresh token
    // from acquireTokenByCode. We need to get it from the cache.
    const cache = msalApp.getTokenCache().serialize();
    const cacheData = JSON.parse(cache);

    // Find the refresh token in the cache
    const refreshTokens = cacheData.RefreshToken;
    if (refreshTokens && Object.keys(refreshTokens).length > 0) {
      const firstKey = Object.keys(refreshTokens)[0];
      const refreshToken = refreshTokens[firstKey].secret;

      console.log("🔑 REFRESH TOKEN (store this securely in Doppler or .env):\n");
      console.log("────────────────────────────────────────────");
      console.log(refreshToken);
      console.log("────────────────────────────────────────────\n");
      console.log("Add to your .env file as:");
      console.log(`AZURE_REFRESH_TOKEN=${refreshToken}\n`);
      console.log("Or add to Doppler:");
      console.log(`doppler secrets set AZURE_REFRESH_TOKEN="${refreshToken}"\n`);
    } else {
      console.log("⚠️  Could not extract refresh token from cache.");
      console.log("   Make sure 'offline_access' is in the requested scopes.");
      console.log("\n   Raw cache for debugging:");
      console.log(JSON.stringify(cacheData, null, 2));
    }
  } catch (error) {
    console.error("\n❌ Failed to exchange auth code:", (error as Error).message);
    console.error("\nCommon causes:");
    console.error("  - The redirect URI doesn't match what's configured in Azure Portal");
    console.error("  - The auth code expired (try again quickly)");
    console.error("  - The client secret is wrong");
    process.exit(1);
  }
}

// ── Local callback server ─────────────────────────────────────────

async function startCallbackServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="font-family: Arial; padding: 40px; text-align: center;">
              <h1>❌ Authentication Failed</h1>
              <p>Error: ${error}</p>
              <p>${url.searchParams.get("error_description") || ""}</p>
              <p>You can close this window.</p>
            </body></html>
          `);
          server.close();
          reject(new Error(`Auth error: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="font-family: Arial; padding: 40px; text-align: center;">
              <h1>✅ Authentication Successful!</h1>
              <p>You can close this window and return to your terminal.</p>
            </body></html>
          `);
          server.close();
          resolve(code);
          return;
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(PORT, () => {
      console.log(`\n🌐 Callback server listening on http://localhost:${PORT}`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for authentication (5 minutes)"));
    }, 5 * 60 * 1000);
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🔐 Smart Check-ins — Microsoft Graph Auth Setup\n");
  console.log("This will open your browser to sign in with Microsoft.");
  console.log("Make sure you've added this redirect URI to your Entra app:");
  console.log(`  ${REDIRECT_URI}\n`);
  console.log("(Azure Portal → App registrations → EDD → Authentication → Web → Redirect URIs)\n");

  // Start callback server first
  const codePromise = startCallbackServer();

  // Generate and display auth URL
  const authUrl = await getAuthUrl();
  console.log("📋 Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\n⏳ Waiting for you to sign in...\n");

  // Try to open browser automatically
  try {
    const { exec } = await import("child_process");
    const platform = process.platform;
    if (platform === "darwin") exec(`open "${authUrl}"`);
    else if (platform === "win32") exec(`start "${authUrl}"`);
    else exec(`xdg-open "${authUrl}"`);
  } catch {
    // Ignore — user can open manually
  }

  // Wait for the callback
  const code = await codePromise;
  console.log("📨 Received auth code, exchanging for tokens...\n");

  // Exchange the code for tokens
  await exchangeCode(code);
}

main().catch((error) => {
  console.error("\n💥 Fatal error:", (error as Error).message);
  process.exit(1);
});
