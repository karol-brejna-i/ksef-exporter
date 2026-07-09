import type { KsefClient } from "ksef-client";
import { KsefSessionExpiredError } from "ksef-client";
import { describe, expect, it, vi } from "vitest";
import { type ConnectFn, KsefSessionManager } from "./client.js";

const config = {
  KSEF_TOKEN: "test-token",
  KSEF_NIP: "5265877635",
  KSEF_ENVIRONMENT: "TEST" as const,
};

function fakeClient(getAccessToken: () => Promise<string | null>): KsefClient {
  return {
    authManager: { getAccessToken },
  } as unknown as KsefClient;
}

describe("KsefSessionManager", () => {
  it("connects once and returns a usable client (happy path)", async () => {
    const client = fakeClient(async () => "access-token-1");
    const connect: ConnectFn = vi.fn().mockResolvedValue(client);
    const manager = new KsefSessionManager(config, connect);

    const result = await manager.getClient();

    expect(result).toBe(client);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      environment: "TEST",
      token: "test-token",
      context: { type: "Nip", value: "5265877635" },
    });
  });

  it("reuses the cached client/session on subsequent calls (no re-auth)", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("access-token-1");
    const client = fakeClient(getAccessToken);
    const connect: ConnectFn = vi.fn().mockResolvedValue(client);
    const manager = new KsefSessionManager(config, connect);

    await manager.getClient();
    await manager.getClient();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("delegates access-token refresh to the SDK's AuthManager without reconnecting", async () => {
    // Simulates AuthManager transparently refreshing an expired access token
    // using a still-valid refresh token -- no full re-auth (connect) needed.
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce("access-token-1")
      .mockResolvedValueOnce("access-token-2-refreshed");
    const client = fakeClient(getAccessToken);
    const connect: ConnectFn = vi.fn().mockResolvedValue(client);
    const manager = new KsefSessionManager(config, connect);

    const first = await manager.getClient();
    const second = await manager.getClient();

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("transparently re-authenticates from scratch when the session has fully expired", async () => {
    const staleClient = fakeClient(
      vi.fn().mockRejectedValue(new KsefSessionExpiredError("refresh token expired")),
    );
    const freshClient = fakeClient(vi.fn().mockResolvedValue("access-token-fresh"));
    const connect: ConnectFn = vi
      .fn()
      .mockResolvedValueOnce(staleClient)
      .mockResolvedValueOnce(freshClient);
    const manager = new KsefSessionManager(config, connect);

    const result = await manager.getClient();

    expect(result).toBe(freshClient);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not retry indefinitely if re-authentication also results in an expired session", async () => {
    const alwaysExpiredClient = () =>
      fakeClient(vi.fn().mockRejectedValue(new KsefSessionExpiredError("still expired")));
    const connect: ConnectFn = vi.fn().mockImplementation(async () => alwaysExpiredClient());
    const manager = new KsefSessionManager(config, connect);

    await expect(manager.getClient()).rejects.toThrow(KsefSessionExpiredError);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("surfaces a connection failure (e.g. failed auth status polling) as a clear error, not a hang", async () => {
    const authError = new Error("auth status: failed");
    const connect: ConnectFn = vi.fn().mockRejectedValue(authError);
    const manager = new KsefSessionManager(config, connect);

    await expect(manager.getClient()).rejects.toThrow(authError);
  });

  it("retries connecting on the next call after a prior connection failure", async () => {
    const client = fakeClient(vi.fn().mockResolvedValue("access-token-1"));
    const connect: ConnectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(client);
    const manager = new KsefSessionManager(config, connect);

    await expect(manager.getClient()).rejects.toThrow("network blip");
    const result = await manager.getClient();

    expect(result).toBe(client);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
