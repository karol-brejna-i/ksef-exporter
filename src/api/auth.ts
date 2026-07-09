import { createHash, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/env.js";

/**
 * Constant-time string comparison. Hashing both inputs first (to a
 * fixed-length digest) before `timingSafeEqual` avoids leaking the
 * candidate's length via early rejection, which a naive
 * `timingSafeEqual(Buffer.from(a), Buffer.from(b))` would do whenever
 * lengths differ (it throws instead of comparing).
 */
function safeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Verifies the given credentials against the single, env-configured
 * owner account (SPEC §2.2.4 — no user-management system).
 */
export function verifyCredentials(
  config: Pick<AppConfig, "AUTH_USERNAME" | "AUTH_PASSWORD">,
  username: string,
  password: string,
): boolean {
  return safeEqual(username, config.AUTH_USERNAME) && safeEqual(password, config.AUTH_PASSWORD);
}
