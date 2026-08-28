import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { resolveDevServer } from "./dev-server";

// Proxies API calls in dev so the browser only ever talks to one origin
// (avoids needing permissive CORS during local development; the API's own
// CORS allow-list is still there for non-proxied/production deployments).
//
// The proxy target and dev-server port come from the repo-root `.env*` files
// the backend also loads, so `PORT` is set in exactly one place. `loadEnv`
// expands `${VAR}` references, so `API_PROXY_TARGET=http://localhost:${PORT}`
// works; see dev-server.ts for the resolution rules.
//
// `APP_ENV` selects the tenant/mode file the same way it does for the backend
// (`APP_ENV=parkowa pnpm run dev:web`), falling back to Vite's own `--mode`.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  const envMode = process.env.APP_ENV ?? mode;
  const { port, proxyTarget } = resolveDevServer(loadEnv(envMode, repoRoot, ""));

  return {
    plugins: [react()],
    server: {
      port,
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: false,
      setupFiles: ["./src/setupTests.ts"],
    },
  };
});
