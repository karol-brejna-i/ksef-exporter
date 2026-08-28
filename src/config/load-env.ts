import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

/**
 * Vite-style `.env` loading for the backend.
 *
 * Mirrors how the `web/` Vite app resolves env files: a shared base `.env` is
 * always loaded, then a mode-specific `.env.<mode>` (and their `.local`
 * siblings) layer on top with increasing priority. The mode is chosen by the
 * `APP_ENV` variable -- the analogue of Vite's `--mode`, since there is no CLI
 * flag here -- and defaults to {@link DEFAULT_MODE}.
 *
 * Values already present in the real environment always win over any file, so
 * `KSEF_NIP=... pnpm run dev:api` and CI-injected secrets are never clobbered.
 *
 * Precedence, lowest to highest:
 *
 *   .env  <  .env.local  <  .env.<mode>  <  .env.<mode>.local  <  process.env
 *
 * Variable expansion (`${OTHER}`) is intentionally not supported -- this
 * matches the previous `import "dotenv/config"` behavior. Add `dotenv-expand`
 * here if it is ever needed.
 */

export const DEFAULT_MODE = "development";

/** The env files for `mode`, ordered lowest to highest priority. */
export function envFilesForMode(mode: string): string[] {
  return [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
}

export interface LoadEnvOptions {
  /** Overrides `env.APP_ENV`; falls back to {@link DEFAULT_MODE}. */
  mode?: string;
  /** Directory the `.env*` files are resolved against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The environment object to populate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface LoadEnvResult {
  /** The resolved mode. */
  mode: string;
  /** Files that existed and were read, in the order they were applied. */
  loaded: string[];
}

/**
 * Reads the mode's `.env*` files and assigns every key that is not already set
 * on `env`. Missing files are skipped silently. The only side effect is
 * mutating the passed-in `env` object (`process.env` by default).
 */
export function loadEnvFiles(options: LoadEnvOptions = {}): LoadEnvResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const mode = options.mode ?? env.APP_ENV ?? DEFAULT_MODE;

  const merged: Record<string, string> = {};
  const loaded: string[] = [];

  for (const name of envFilesForMode(mode)) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    Object.assign(merged, parse(readFileSync(path)));
    loaded.push(name);
  }

  for (const [key, value] of Object.entries(merged)) {
    if (env[key] === undefined) env[key] = value;
  }

  return { mode, loaded };
}
