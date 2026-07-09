import { describe, expect, it } from "vitest";
import { verifyCredentials } from "./auth.js";

const config = { AUTH_USERNAME: "owner", AUTH_PASSWORD: "a-strong-password" };

describe("verifyCredentials", () => {
  it("returns true for matching username and password", () => {
    expect(verifyCredentials(config, "owner", "a-strong-password")).toBe(true);
  });

  it("returns false for a wrong password", () => {
    expect(verifyCredentials(config, "owner", "wrong-password")).toBe(false);
  });

  it("returns false for a wrong username", () => {
    expect(verifyCredentials(config, "someone-else", "a-strong-password")).toBe(false);
  });

  it("returns false when both are wrong", () => {
    expect(verifyCredentials(config, "someone-else", "wrong-password")).toBe(false);
  });

  it("handles candidate strings of different lengths without throwing", () => {
    expect(verifyCredentials(config, "o", "short")).toBe(false);
  });
});
