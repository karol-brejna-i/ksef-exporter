import { describe, expect, it } from "vitest";
import { DEFAULT_API_PORT, DEFAULT_WEB_DEV_PORT, resolveDevServer } from "./dev-server";

describe("resolveDevServer", () => {
  it("uses the documented defaults when nothing is set", () => {
    expect(resolveDevServer({})).toEqual({
      port: DEFAULT_WEB_DEV_PORT,
      proxyTarget: `http://localhost:${DEFAULT_API_PORT}`,
    });
  });

  it("derives the proxy target from the backend's PORT", () => {
    expect(resolveDevServer({ PORT: "3100" }).proxyTarget).toBe("http://localhost:3100");
  });

  it("accepts an already-expanded variable reference verbatim", () => {
    // loadEnv() resolves API_PROXY_TARGET=http://localhost:<dollar-brace>PORT<brace>
    // before we see it, so the helper only ever receives the finished URL.
    expect(
      resolveDevServer({ PORT: "3100", API_PROXY_TARGET: "http://localhost:3100" }).proxyTarget,
    ).toBe("http://localhost:3100");
  });

  it("prefers an explicit API_PROXY_TARGET over PORT", () => {
    expect(
      resolveDevServer({ PORT: "3100", API_PROXY_TARGET: "http://api.internal:8080" }).proxyTarget,
    ).toBe("http://api.internal:8080");
  });

  it("ignores a blank API_PROXY_TARGET", () => {
    expect(resolveDevServer({ API_PROXY_TARGET: "   ", PORT: "3100" }).proxyTarget).toBe(
      "http://localhost:3100",
    );
  });

  it("overrides the dev-server port via WEB_DEV_PORT", () => {
    expect(resolveDevServer({ WEB_DEV_PORT: "4000" }).port).toBe(4000);
  });

  it("falls back on a non-numeric or out-of-range port", () => {
    expect(resolveDevServer({ WEB_DEV_PORT: "nope" }).port).toBe(DEFAULT_WEB_DEV_PORT);
    expect(resolveDevServer({ WEB_DEV_PORT: "70000" }).port).toBe(DEFAULT_WEB_DEV_PORT);
    expect(resolveDevServer({ PORT: "0" }).proxyTarget).toBe(
      `http://localhost:${DEFAULT_API_PORT}`,
    );
  });
});
