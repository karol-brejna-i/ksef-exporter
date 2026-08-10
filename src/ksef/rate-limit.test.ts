import { KsefApiError, KsefRateLimitError } from "ksef-client";
import { describe, expect, it } from "vitest";
import { classifyKsefError } from "./rate-limit.js";

describe("classifyKsefError", () => {
  it("extracts safe rate-limit diagnostics without retaining the response body", () => {
    const error = new KsefRateLimitError(
      429,
      "Rate limit exceeded",
      { authorization: "Bearer secret", rawXml: "<Faktura>secret</Faktura>" },
      "180",
      180,
      { status: { code: 21159, description: "limit", details: [] } } as never,
    );

    const diagnostics = classifyKsefError(error);

    expect(diagnostics).toMatchObject({
      errorType: "KsefRateLimitError",
      errorCode: "21159",
      httpStatus: 429,
      retryAfterSeconds: 180,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Bearer secret");
    expect(JSON.stringify(diagnostics)).not.toContain("Faktura");
  });

  it("classifies an API error without exposing its response payload", () => {
    const error = new KsefApiError(400, "Bad request", { token: "secret-token" });

    expect(classifyKsefError(error)).toMatchObject({
      message: "Bad request",
      errorType: "KsefApiError",
      httpStatus: 400,
      retryAfterSeconds: null,
    });
    expect(JSON.stringify(classifyKsefError(error))).not.toContain("secret-token");
  });

  it("bounds unexpected error messages and retains a bounded cause chain", () => {
    const cause = new Error("authorization: Bearer secret-value");
    const error = new Error(`token=secret-token ${"x".repeat(1200)}`, { cause });

    const diagnostics = classifyKsefError(error);

    expect(diagnostics.message).toHaveLength(1000);
    expect(diagnostics.message).toContain("token=[REDACTED]");
    expect(diagnostics.causeChain).toEqual(["Error: authorization=[REDACTED] [REDACTED]"]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });
});
