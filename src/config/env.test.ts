import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.js";

const validEnv = {
  KSEF_TOKEN: "test-token-value",
  KSEF_NIP: "5265877635",
  KSEF_ENVIRONMENT: "TEST",
  AUTH_USERNAME: "owner",
  AUTH_PASSWORD: "a-strong-password",
  JWT_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("parses a valid environment successfully", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      KSEF_TOKEN: "test-token-value",
      KSEF_NIP: "5265877635",
      KSEF_ENVIRONMENT: "TEST",
      DATABASE_PATH: "./data/ksef-exporter.sqlite",
      AUTH_USERNAME: "owner",
      AUTH_PASSWORD: "a-strong-password",
      JWT_SECRET: "a".repeat(32),
      PORT: 3000,
      WEB_ORIGIN: "http://localhost:5173",
    });
  });

  it("defaults KSEF_ENVIRONMENT to TEST when omitted", () => {
    const { KSEF_ENVIRONMENT: _omit, ...rest } = validEnv;
    const config = loadConfig(rest);

    expect(config.KSEF_ENVIRONMENT).toBe("TEST");
  });

  it("defaults DATABASE_PATH when omitted", () => {
    const config = loadConfig(validEnv);

    expect(config.DATABASE_PATH).toBe("./data/ksef-exporter.sqlite");
  });

  it("honors a custom DATABASE_PATH", () => {
    const config = loadConfig({ ...validEnv, DATABASE_PATH: "/tmp/custom.sqlite" });

    expect(config.DATABASE_PATH).toBe("/tmp/custom.sqlite");
  });

  it("normalizes a NIP containing dashes/spaces into plain digits", () => {
    const config = loadConfig({ ...validEnv, KSEF_NIP: "526-587-76-35" });

    expect(config.KSEF_NIP).toBe("5265877635");
  });

  it("throws a descriptive error when KSEF_TOKEN is missing", () => {
    const { KSEF_TOKEN: _omit, ...rest } = validEnv;

    expect(() => loadConfig(rest)).toThrowError(/KSEF_TOKEN/);
  });

  it("throws a descriptive error when KSEF_NIP is not a 10-digit number", () => {
    expect(() => loadConfig({ ...validEnv, KSEF_NIP: "not-a-nip" })).toThrowError(
      /KSEF_NIP must be a 10-digit NIP number/,
    );
  });

  it("throws a descriptive error when KSEF_ENVIRONMENT is invalid", () => {
    expect(() => loadConfig({ ...validEnv, KSEF_ENVIRONMENT: "STAGING" })).toThrowError(
      /KSEF_ENVIRONMENT/,
    );
  });

  it("aggregates multiple errors into a single message", () => {
    expect(() => loadConfig({ KSEF_ENVIRONMENT: "STAGING" })).toThrowError(
      /KSEF_TOKEN[\s\S]*KSEF_NIP/,
    );
  });

  it("defaults PORT and WEB_ORIGIN when omitted", () => {
    const config = loadConfig(validEnv);

    expect(config.PORT).toBe(3000);
    expect(config.WEB_ORIGIN).toBe("http://localhost:5173");
  });

  it("throws a descriptive error when AUTH_USERNAME is missing", () => {
    const { AUTH_USERNAME: _omit, ...rest } = validEnv;

    expect(() => loadConfig(rest)).toThrowError(/AUTH_USERNAME/);
  });

  it("throws a descriptive error when AUTH_PASSWORD is too short", () => {
    expect(() => loadConfig({ ...validEnv, AUTH_PASSWORD: "short" })).toThrowError(/AUTH_PASSWORD/);
  });

  it("throws a descriptive error when JWT_SECRET is too short", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "short" })).toThrowError(/JWT_SECRET/);
  });
});
