/**
 * Resolves the dev-server port and the `/api` proxy target from an
 * already-loaded env object. `vite.config.ts` builds that object with Vite's
 * `loadEnv()`, pointed at the repo-root `.env*` files the backend also reads,
 * so the two stay in sync without duplicating values.
 *
 * `loadEnv()` expands dollar-brace variable references before they reach here,
 * so writing `API_PROXY_TARGET=http://localhost:` followed by a `PORT`
 * reference in `.env` resolves correctly. The `http://localhost:<PORT>`
 * fallback below covers the common case where only `PORT` is set.
 */

/** Port the Vite dev server listens on when `WEB_DEV_PORT` is unset. */
export const DEFAULT_WEB_DEV_PORT = 5173;

/** API port assumed when neither `API_PROXY_TARGET` nor `PORT` is set; matches the backend default. */
export const DEFAULT_API_PORT = 3000;

export interface DevServerSettings {
  /** `server.port` for the Vite dev server. */
  port: number;
  /** `server.proxy['/api'].target` the browser's `/api/*` calls are forwarded to. */
  proxyTarget: string;
}

/**
 * Target precedence, highest first:
 *   1. `API_PROXY_TARGET` verbatim (already `${VAR}`-expanded by `loadEnv`)
 *   2. `http://localhost:<PORT>`, reusing the backend's own `PORT`
 *   3. `http://localhost:3000`, the documented default
 */
export function resolveDevServer(env: Record<string, string | undefined>): DevServerSettings {
  const explicitTarget = env.API_PROXY_TARGET?.trim();
  return {
    port: parsePort(env.WEB_DEV_PORT, DEFAULT_WEB_DEV_PORT),
    proxyTarget: explicitTarget || `http://localhost:${parsePort(env.PORT, DEFAULT_API_PORT)}`,
  };
}

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}
