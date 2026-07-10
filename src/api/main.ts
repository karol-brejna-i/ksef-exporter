import "dotenv/config";
import type { KsefClient } from "ksef-client";
import { loadConfig } from "../config/env.js";
import { createDb } from "../db/client.js";
import { KsefSessionManager } from "../ksef/client.js";
import { buildServer } from "./server.js";

/**
 * Real entry point (not exercised by tests): wires up the actual config,
 * SQLite database, and KSeF session, then starts listening. `buildServer`
 * itself is fully unit-tested with injected fakes (see server.test.ts).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { db } = createDb(config.DATABASE_PATH);
  const sessionManager = new KsefSessionManager(config);

  const fastify = buildServer({
    db,
    config,
    getClient: (): Promise<KsefClient> => sessionManager.getClient(),
  });

  await fastify.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("Failed to start API server:", error);
  process.exitCode = 1;
});
