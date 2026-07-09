import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Proxies API calls in dev so the browser only ever talks to one origin
// (avoids needing permissive CORS during local development; the API's own
// CORS allow-list is still there for non-proxied/production deployments).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
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
});
