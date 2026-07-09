/**
 * Manual smoke test for the KSeF authentication module (Phase 1).
 *
 * NOT part of the automated test suite (no assertions, real network calls).
 * Use this to verify end-to-end auth against a real KSeF environment once
 * you have a KSEF_TOKEN configured in `.env` (see `.env.example`).
 *
 * Usage:
 *   pnpm run smoke:ksef
 */
import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { KsefSessionManager } from "./client.js";

async function main() {
  const config = loadConfig();
  const manager = new KsefSessionManager(config);

  console.log(`Connecting to KSeF (${config.KSEF_ENVIRONMENT}) as NIP ${config.KSEF_NIP}...`);
  const client = await manager.getClient();

  const accessToken = await client.authManager.getAccessToken();
  if (!accessToken) {
    throw new Error("Authenticated, but no access token was returned.");
  }

  console.log("Authentication successful. Access token obtained (not printed).");
}

main().catch((error) => {
  console.error("KSeF smoke test failed:", error);
  process.exitCode = 1;
});
