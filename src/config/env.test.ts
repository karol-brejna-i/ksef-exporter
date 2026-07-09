import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.js";

const validEnv = {
  KSEF_TOKEN: "test-token-value",
  KSEF_NIP: "5265877635",
  KSEF_ENVIRONMENT: "TEST",
};

describe("loadConfig", () => {
  it("parses a valid environment successfully", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      KSEF_TOKEN: "test-token-value",
      KSEF_NIP: "5265877635",
      KSEF_ENVIRONMENT: "TEST",
    });
  });

  it("defaults KSEF_ENVIRONMENT to TEST when omitted", () => {
    const { KSEF_ENVIRONMENT: _omit, ...rest } = validEnv;
    const config = loadConfig(rest);

    expect(config.KSEF_ENVIRONMENT).toBe("TEST");
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
});
