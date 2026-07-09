import { KsefClient, type KsefConnectOptions, KsefSessionExpiredError } from "ksef-client";
import type { AppConfig } from "../config/env.js";

export type ConnectFn = (options: KsefConnectOptions) => Promise<KsefClient>;

const defaultConnect: ConnectFn = (options) => KsefClient.connect(options);

/**
 * Manages a single, lazily-created, self-healing KSeF client session.
 *
 * The underlying `ksef-client` SDK already implements the full KSeF-token
 * authentication flow (challenge -> encrypt -> submit -> poll -> redeem, see
 * design/SPEC.md §3.1) inside `KsefClient.connect()`, and transparently
 * refreshes the access token via `AuthManager.getAccessToken()` using the
 * refresh token. This wrapper adds exactly one thing on top: when the
 * refresh token itself has expired (surfaced by the SDK as
 * `KsefSessionExpiredError`), it transparently re-runs the full auth flow
 * from scratch (once) instead of leaving the caller with a dead session.
 */
export class KsefSessionManager {
  private clientPromise: Promise<KsefClient> | null = null;

  constructor(
    private readonly config: Pick<AppConfig, "KSEF_TOKEN" | "KSEF_NIP" | "KSEF_ENVIRONMENT">,
    private readonly connect: ConnectFn = defaultConnect,
  ) {}

  /**
   * Returns a connected KSeF client with a currently-valid access token.
   * Reconnects automatically (at most once per call) if the session has
   * fully expired (i.e. the refresh token is no longer usable).
   */
  async getClient(): Promise<KsefClient> {
    return this.getClientInternal(false);
  }

  private async getClientInternal(isRetry: boolean): Promise<KsefClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.connect({
        environment: this.config.KSEF_ENVIRONMENT,
        token: this.config.KSEF_TOKEN,
        context: { type: "Nip", value: this.config.KSEF_NIP },
      });
    }

    try {
      const client = await this.clientPromise;
      // Ensures the access token is valid, transparently refreshing it via
      // the SDK's own refresh-token flow if needed. Cheap no-op when the
      // cached access token is still valid.
      await client.authManager.getAccessToken();
      return client;
    } catch (error) {
      // Whatever failed, the cached (rejected or now-unusable) session must
      // not be reused as-is; the next call should attempt a fresh connect.
      this.clientPromise = null;

      if (error instanceof KsefSessionExpiredError && !isRetry) {
        return this.getClientInternal(true);
      }

      throw error;
    }
  }
}
