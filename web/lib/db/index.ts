/**
 * Singleton Postgres client. Reuses the connection across hot reloads in
 * dev so we don't run out of slots; in production each worker gets its own.
 *
 * Connection string lives in DATABASE_URL — see .env.example.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
    var __pgClient: ReturnType<typeof postgres> | undefined;
}

const url = process.env.DATABASE_URL;
const missingDbMessage =
    "DATABASE_URL is not set — configure your cloud Postgres (e.g. Neon) in .env.";

// Serverless (Vercel) spins up many function instances, each with its own pool.
// `max: 1` was sized for the Supabase SESSION pooler (:5432), which caps around
// 15 clients — but it also serialises every concurrent query in a render, so the
// homepage's listMarkets + adminImages reads queue behind each other and eat the
// SSR deadline. On the TRANSACTION pooler (:6543) far more clients are fine, so
// allow a few. Override with PG_POOL_MAX if the pooler ever pushes back.
// Long-running hosts (VPS / local dev) can hold a few connections.
const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const client =
    url
        ? (globalThis.__pgClient ??
            postgres(url, {
                max: Number(process.env.PG_POOL_MAX ?? (isServerless ? 3 : 4)),
                idle_timeout: isServerless ? 10 : 30,
                // Required by Next.js HMR AND by the Supabase transaction pooler
                // (pgbouncer transaction mode doesn't support prepared statements).
                prepare: false,
                // FAIL FAST. When the pooler is at its client cap it does not
                // reject — it makes new connections *wait*, and postgres-js has
                // no default connect timeout, so a starved pool turns into an
                // SSR render that hangs forever (HTTP 200, stream never ends).
                // An error is recoverable; an infinite wait is not.
                connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT_S ?? 10),
                connection: {
                    // Server-side ceiling on any single query, for the same reason.
                    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000),
                },
            }))
        : undefined;

if (client && process.env.NODE_ENV !== "production") {
    globalThis.__pgClient = client;
}

export const db = client
    ? drizzle(client, { schema })
    : (new Proxy(
          {},
          {
              get() {
                  throw new Error(missingDbMessage);
              },
          },
      ) as ReturnType<typeof drizzle>);
export { schema };
