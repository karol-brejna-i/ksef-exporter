import { z } from "zod";

/**
 * Environment variable schema for the application.
 * See design/SPEC.md §3.1 and §3.5 for why these values are needed.
 */
const envSchema = z.object({
  /** Long-lived KSeF Token, scoped to InvoiceRead only. Treated as a secret. */
  KSEF_TOKEN: z.string().trim().min(1, "KSEF_TOKEN is required"),
  /** NIP of the company/context to authenticate as, e.g. "5265877635". */
  KSEF_NIP: z
    .string()
    .trim()
    .min(1, "KSEF_NIP is required")
    .transform((value) => value.replace(/[\s-]/g, ""))
    .refine((value) => /^\d{10}$/.test(value), {
      message: "KSEF_NIP must be a 10-digit NIP number",
    }),
  /** Which KSeF environment to talk to. */
  KSEF_ENVIRONMENT: z.enum(["TEST", "DEMO", "PRD"]).default("TEST"),
  /** Path to the SQLite database file (created if it doesn't exist). */
  DATABASE_PATH: z.string().trim().min(1).default("./data/ksef-exporter.sqlite"),

  /**
   * Single-owner login credentials for the API (SPEC §2.2.4). There is no
   * user-management system: one account, configured via the environment.
   * Treated as a secret, same as KSEF_TOKEN.
   */
  AUTH_USERNAME: z.string().trim().min(1, "AUTH_USERNAME is required"),
  AUTH_PASSWORD: z.string().min(8, "AUTH_PASSWORD must be at least 8 characters"),
  /** Secret used to sign/verify session JWTs. Treated as a secret. */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  /** Port the API server listens on. */
  PORT: z.coerce.number().int().positive().default(3000),
  /** Origin the frontend is served from, allow-listed for CORS. */
  WEB_ORIGIN: z.string().trim().min(1).default("http://localhost:5173"),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

/**
 * Parses and validates the given environment source into a typed AppConfig.
 * Fails fast with a descriptive, aggregated error message listing every
 * missing/invalid field, rather than crashing on the first one.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }

  return result.data;
}
