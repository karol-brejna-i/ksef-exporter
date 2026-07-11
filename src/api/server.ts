import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { KsefApiError, type KsefClient } from "ksef-client";
import { z } from "zod";
import { correctInvoiceCategory, InvoiceNotFoundError } from "../categorization/correct.js";
import type { AppConfig } from "../config/env.js";
import { listCategories } from "../db/categories.js";
import type { Db } from "../db/client.js";
import { listInvoices } from "../db/invoices.js";
import {
  createSyncRun,
  listRecentSyncRuns,
  markSyncRunError,
  markSyncRunSuccess,
} from "../db/sync-runs.js";
import { formatKsefError } from "../ksef/rate-limit.js";
import { syncPurchaseInvoices } from "../sync.js";
import { verifyCredentials } from "./auth.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export interface BuildServerDeps {
  db: Db;
  config: Pick<
    AppConfig,
    "AUTH_USERNAME" | "AUTH_PASSWORD" | "JWT_SECRET" | "WEB_ORIGIN" | "LOG_LEVEL"
  >;
  /** Returns a connected KSeF client; injectable so tests never touch the network. */
  getClient: () => Promise<Pick<KsefClient, "workflows">>;
  /** Injectable for tests; defaults to the real `syncPurchaseInvoices`. */
  sync?: typeof syncPurchaseInvoices;
}

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const syncBodySchema = z.object({
  windowFrom: z.string().min(1),
  windowTo: z.string().min(1),
});

const invoiceQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be formatted as YYYY-MM")
    .optional(),
  categoryId: z.coerce.number().int().positive().optional(),
});

const invoiceIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const categoryCorrectionBodySchema = z.object({
  categoryId: z.number().int().positive(),
});

/**
 * Builds (but does not start listening on) the Fastify app for the Phase 5
 * engine API. Dependencies are injected so the whole app is testable via
 * `fastify.inject()` without a real KSeF connection or a real HTTP socket.
 */
export function buildServer(deps: BuildServerDeps): FastifyInstance {
  // Logging was previously disabled entirely, which meant a long-running
  // import gave zero feedback in the server console (see design/SPEC.md
  // §2.2 NFR 5 / Phase 7 follow-up). LOG_LEVEL defaults to "info".
  const fastify = Fastify({ logger: { level: deps.config.LOG_LEVEL } });
  const sync = deps.sync ?? syncPurchaseInvoices;

  fastify.register(jwt, { secret: deps.config.JWT_SECRET });
  fastify.register(cors, { origin: deps.config.WEB_ORIGIN });

  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  // Never leak internal error details (stack traces, driver messages) to
  // the client; log server-side only.
  fastify.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    fastify.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({ error: statusCode < 500 ? error.message : "internal error" });
  });

  fastify.post("/auth/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "username and password are required" });
    }

    const { username, password } = parsed.data;
    if (!verifyCredentials(deps.config, username, password)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const token = fastify.jwt.sign({ sub: username }, { expiresIn: "12h" });
    return { token };
  });

  fastify.post("/sync", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = syncBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "windowFrom and windowTo are required" });
    }

    request.log.info(parsed.data, "sync: requested");
    const run = await createSyncRun(deps.db, parsed.data);
    try {
      const client = await deps.getClient();
      const result = await sync(deps.db, client, parsed.data, {
        logger: { info: (message, meta) => request.log.info(meta ?? {}, message) },
      });
      request.log.info({ invoiceCount: result.invoices.length }, "sync: succeeded");
      await markSyncRunSuccess(deps.db, run.id, result.invoices.length);
      return { invoiceCount: result.invoices.length };
    } catch (error) {
      const message = formatKsefError(error);
      request.log.error({ err: error }, "sync: failed");
      await markSyncRunError(deps.db, run.id, message);
      // KsefApiError's statusCode reflects KSeF's own response (e.g. 429 for
      // rate limiting); surface formatKsefError's friendlier message (with
      // retry-after info) for those instead of the SDK's raw message. Genuine
      // 5xx/unexpected errors still go through the generic error handler
      // below, which hides internal details.
      if (error instanceof KsefApiError && error.statusCode < 500) {
        return reply.code(error.statusCode).send({ error: message });
      }
      throw error;
    }
  });

  fastify.get("/sync/runs", { onRequest: [fastify.authenticate] }, async () => {
    const runs = await listRecentSyncRuns(deps.db);
    return { runs };
  });

  fastify.get("/invoices", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = invoiceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    }

    const invoices = await listInvoices(deps.db, parsed.data);
    return { invoices };
  });

  fastify.get("/categories", { onRequest: [fastify.authenticate] }, async () => {
    const categories = await listCategories(deps.db);
    return { categories };
  });

  fastify.patch(
    "/invoices/:id/category",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const paramsResult = invoiceIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: "invoice id must be a positive integer" });
      }

      const bodyResult = categoryCorrectionBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({ error: "categoryId is required" });
      }

      try {
        const invoice = await correctInvoiceCategory(
          deps.db,
          paramsResult.data.id,
          bodyResult.data.categoryId,
        );
        return { invoice };
      } catch (error) {
        if (error instanceof InvoiceNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  return fastify;
}
