import { describe, expect, it } from "vitest";
import { installedVersions, proxyConfigurationWarning, startupContext } from "./startup-context.js";

describe("startupContext", () => {
  it("finds the installed application and SDK versions", () => {
    expect(installedVersions()).toEqual({ appVersion: "0.1.0", ksefClientVersion: "0.6.1" });
  });

  it("contains useful runtime context without identifiers or secrets", () => {
    const context = startupContext(
      {
        KSEF_ENVIRONMENT: "PRD",
        DATABASE_PATH: "./data/ksef-exporter.sqlite",
        LOG_LEVEL: "info",
      },
      { appVersion: "0.1.0", ksefClientVersion: "0.6.1" },
    );

    expect(context).toEqual({
      event: "app.started",
      appVersion: "0.1.0",
      ksefClientVersion: "0.6.1",
      ksefEnvironment: "PRD",
      databasePath: "./data/ksef-exporter.sqlite",
      logLevel: "info",
    });
    expect(JSON.stringify(context)).not.toMatch(/token|password|nip|jwt/i);
  });
});

describe("proxyConfigurationWarning", () => {
  it("warns when only lowercase proxy variables are configured", () => {
    expect(proxyConfigurationWarning({ https_proxy: "http://proxy:912" })).toMatch(
      /uppercase HTTPS_PROXY\/HTTP_PROXY/,
    );
  });

  it("does not warn when a supported uppercase proxy variable is configured", () => {
    expect(
      proxyConfigurationWarning({
        https_proxy: "http://proxy:912",
        HTTPS_PROXY: "http://proxy:912",
      }),
    ).toBeNull();
  });

  it("does not warn when no proxy variables are configured", () => {
    expect(proxyConfigurationWarning({})).toBeNull();
  });
});
