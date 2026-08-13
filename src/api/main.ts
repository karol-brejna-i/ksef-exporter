import "dotenv/config";
import type { KsefClient } from "ksef-client";
import { seedCategorizationRules } from "../categorization/seed-rules.js";
import { loadConfig } from "../config/env.js";
import { createDb } from "../db/client.js";
import { KsefSessionManager } from "../ksef/client.js";
import { buildServer } from "./server.js";
import { proxyConfigurationWarning, startupContext } from "./startup-context.js";

/**
 * Real entry point (not exercised by tests): wires up the actual config,
 * SQLite database, and KSeF session, then starts listening. `buildServer`
 * itself is fully unit-tested with injected fakes (see server.test.ts).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const proxyWarning = proxyConfigurationWarning(process.env);
  if (proxyWarning) console.warn(proxyWarning);
  const { db } = createDb(config.DATABASE_PATH);
  // Idempotent (upsert keyed on matchType/matchValue), so it is safe on every
  // boot. Without it the database has no categories or Tier-1 rules at all,
  // which leaves the UI's category dropdown empty and Phase 4 categorization
  // inert -- see design/INVOICE_ITEMS_PLAN.md §4.
  await seedCategorizationRules(db);
  const sessionManager = new KsefSessionManager(config);

  const fastify = buildServer({
    db,
    config,
    getClient: (): Promise<KsefClient> => sessionManager.getClient(),
  });

  await fastify.listen({ port: config.PORT, host: "0.0.0.0" });
  fastify.log.info(startupContext(config), "app.started");
}

main().catch((error) => {
  console.error("Failed to start API server:", error);
  process.exitCode = 1;
});
