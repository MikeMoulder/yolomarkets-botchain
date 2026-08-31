import { createPublicClient, fallback, http, type Address } from "viem";
import { and, eq } from "drizzle-orm";
import { arcTestnet } from "./chain";
import { ADDRESSES, factoryAbi, marketAbi, Outcome } from "./contracts";
import { db } from "./db";
import { catalogMeta, marketIndex } from "./db/schema";
import { indexRowToSummary, V2_BACKFILLED_KEY } from "./catalog-index";

// 25 markets × 10 fields = 250 sub-calls per multicall — the free-tier Arc
// RPCs reject the older 750-call batches under load ("request limit reached").
const MARKET_READ_BATCH_SIZE = 25;
const MARKET_READ_BATCH_DELAY_MS = 150;

// The factory holds tens of thousands of markets (mostly resolved fast rounds),
// so a full on-chain read takes ~60-80s. The homepage/fast/setup pages are all
// `force-dynamic` and would otherwise pay that on every request. We cache the
// result with stale-while-revalidate: a fresh cache is served instantly; a
// stale one is served instantly while a single background refresh runs. Only a
// genuinely cold cache blocks the request. Detail pages use `getMarket`, which
// is uncached, so a specific market's trade page is always live.
const MARKETS_CACHE_TTL_MS = 30_000;

let marketsCache: { data: MarketSummary[]; at: number } | null = null;
let marketsInflight: Promise<MarketSummary[]> | null = null;

function refreshMarkets(): Promise<MarketSummary[]> {
    if (marketsInflight) return marketsInflight;
    marketsInflight = readAllMarkets()
        .then((rows) => {
            marketsCache = { data: rows, at: Date.now() };
            return rows;
        })
        .catch((err) => {
            // A refresh failing (RPC rate limits during the legacy scan, a
            // flaky node rotation) must never reject unhandled — the SWR
            // caller fires-and-forgets this promise. Serve the stale cache
            // and try again next TTL.
            console.warn("[markets] refresh failed; serving stale cache", err);
            if (marketsCache) return marketsCache.data;
            throw err;
        })
        .finally(() => {
            marketsInflight = null;
        });
    return marketsInflight;
}

function rpcTransport() {
    const urls = [
        ...(process.env.ARC_TESTNET_RPC_URLS?.split(",")
            .map((x) => x.trim())
            .filter(Boolean) ?? []),
        ...(process.env.ARC_TESTNET_RPC_URL ? [process.env.ARC_TESTNET_RPC_URL] : []),
        ...arcTestnet.rpcUrls.default.http,
    ];
    return fallback([...new Set(urls)].map((url) => http(url)));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: rpcTransport(),
    batch: { multicall: true },
});

const supportsMulticall = Boolean(arcTestnet.contracts?.multicall3);

export type MarketSummary = {
    address: Address;
    question: string;
    category: string;
    deadline: bigint;
    priceYes: bigint; // 1e18 = 100%
    totalLiquidity: bigint; // 6-dec
    initialLiquidity: bigint; // 6-dec
    resolved: boolean;
    outcome: Outcome;
    totalSharesYes: bigint;
    totalSharesNo: bigint;
    // true → market lives on the v1 factory (old bytecode: no claimRefund,
    // admin-key resolution). The catalog only carries unexpired v1 markets;
    // expired ones were deliberately left behind in the 2026-07-18 migration.
    legacy: boolean;
};

export type MarketDetail = MarketSummary & {
    resolutionCriteria: string;
};

export type MarketRevenue = {
    protocolFeeBps: number;
    accruedFees: bigint;
    reserveRequired: bigint;
    treasuryWithdrawable: bigint;
};

async function readMarketSummary(
    address: Address,
    legacy = false,
): Promise<MarketSummary> {
    if (!supportsMulticall) {
        const [question, category, deadline, priceYes, totalLiquidity, initialLiquidity, resolved, outcome, totalSharesYes, totalSharesNo] =
            await Promise.all([
                publicClient.readContract({ address, abi: marketAbi, functionName: "question" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "category" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "deadline" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "priceYes" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "totalLiquidity" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "initialLiquidity" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "resolved" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "outcome" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "totalSharesYes" }),
                publicClient.readContract({ address, abi: marketAbi, functionName: "totalSharesNo" }),
            ]);
        return {
            address,
            question,
            category,
            deadline,
            priceYes,
            totalLiquidity,
            initialLiquidity,
            resolved,
            outcome: outcome as Outcome,
            totalSharesYes,
            totalSharesNo,
            legacy,
        };
    }

    const r = await publicClient.multicall({
        allowFailure: false,
        contracts: [
            { address, abi: marketAbi, functionName: "question" },
            { address, abi: marketAbi, functionName: "category" },
            { address, abi: marketAbi, functionName: "deadline" },
            { address, abi: marketAbi, functionName: "priceYes" },
            { address, abi: marketAbi, functionName: "totalLiquidity" },
            { address, abi: marketAbi, functionName: "initialLiquidity" },
            { address, abi: marketAbi, functionName: "resolved" },
            { address, abi: marketAbi, functionName: "outcome" },
            { address, abi: marketAbi, functionName: "totalSharesYes" },
            { address, abi: marketAbi, functionName: "totalSharesNo" },
        ],
    });
    return {
        address,
        question: r[0],
        category: r[1],
        deadline: r[2],
        priceYes: r[3],
        totalLiquidity: r[4],
        initialLiquidity: r[5],
        resolved: r[6],
        outcome: r[7] as Outcome,
        totalSharesYes: r[8],
        totalSharesNo: r[9],
        legacy,
    };
}

async function readMarketSummaryBatch(
    addresses: Address[],
    legacy = false,
): Promise<MarketSummary[]> {
    const contracts = addresses.flatMap((address) => [
        { address, abi: marketAbi, functionName: "question" },
        { address, abi: marketAbi, functionName: "category" },
        { address, abi: marketAbi, functionName: "deadline" },
        { address, abi: marketAbi, functionName: "priceYes" },
        { address, abi: marketAbi, functionName: "totalLiquidity" },
        { address, abi: marketAbi, functionName: "initialLiquidity" },
        { address, abi: marketAbi, functionName: "resolved" },
        { address, abi: marketAbi, functionName: "outcome" },
        { address, abi: marketAbi, functionName: "totalSharesYes" },
        { address, abi: marketAbi, functionName: "totalSharesNo" },
    ]);
    const results = await publicClient.multicall({
        allowFailure: true,
        contracts,
    });

    const rows: MarketSummary[] = [];
    for (let i = 0; i < addresses.length; i++) {
        const offset = i * 10;
        const slice = results.slice(offset, offset + 10);
        if (slice.some((row) => row.status !== "success")) {
            console.warn("[markets] failed to read market summary", addresses[i]);
            continue;
        }
        rows.push({
            address: addresses[i],
            question: slice[0].result as string,
            category: slice[1].result as string,
            deadline: slice[2].result as bigint,
            priceYes: slice[3].result as bigint,
            totalLiquidity: slice[4].result as bigint,
            initialLiquidity: slice[5].result as bigint,
            resolved: slice[6].result as boolean,
            outcome: slice[7].result as Outcome,
            totalSharesYes: slice[8].result as bigint,
            totalSharesNo: slice[9].result as bigint,
            legacy,
        });
    }
    return rows;
}

// ── Legacy (v1) liveness scan ──────────────────────────────────────────────
// The v1 factory holds ~13.8k markets, almost all expired fast rounds that
// were deliberately left behind in the 2026-07-18 v2 migration. Deadlines are
// immutable, so the expensive discovery of "which v1 markets are still open"
// runs ONCE per process — gently, to stay under RPC rate limits — and after
// that expiry is decided locally from the cached deadlines. Requests never
// block on this scan: until it completes the catalog simply serves v2 only.

type LegacyLive = { address: Address; deadline: bigint };

let legacyLiveCache: LegacyLive[] | null = null;
let legacyScanInflight: Promise<void> | null = null;

const LEGACY_PROBE_BATCH = 100;
const LEGACY_PROBE_DELAY_MS = 250;

async function scanLegacyLive(addresses: Address[]): Promise<LegacyLive[]> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const live: LegacyLive[] = [];
    let dropped = 0;

    async function probeBatch(batch: Address[]): Promise<Address[]> {
        const failed: Address[] = [];
        // Bohr does not deploy Multicall3 at the standard address. Use the
        // direct-read path there; otherwise every legacy probe is reported as
        // unprobeable even when the market itself is perfectly readable.
        if (!supportsMulticall) {
            const direct = await Promise.all(
                batch.map(async (address) => {
                    try {
                        const [deadline, resolved] = await Promise.all([
                            publicClient.readContract({
                                address,
                                abi: marketAbi,
                                functionName: "deadline",
                            }),
                            publicClient.readContract({
                                address,
                                abi: marketAbi,
                                functionName: "resolved",
                            }),
                        ]);
                        return { address, deadline, resolved };
                    } catch {
                        return null;
                    }
                }),
            );
            for (const row of direct) {
                if (!row) continue;
                if (row.deadline > now && !row.resolved) {
                    live.push({ address: row.address, deadline: row.deadline });
                }
            }
            for (let i = 0; i < batch.length; i++) {
                if (!direct[i]) failed.push(batch[i]);
            }
            return failed;
        }

        const results = await publicClient.multicall({
            allowFailure: true,
            contracts: batch.flatMap((address) => [
                { address, abi: marketAbi, functionName: "deadline" as const },
                { address, abi: marketAbi, functionName: "resolved" as const },
            ]),
        });
        for (let j = 0; j < batch.length; j++) {
            const deadline = results[j * 2];
            const resolved = results[j * 2 + 1];
            if (deadline.status !== "success" || resolved.status !== "success") {
                failed.push(batch[j]);
                continue;
            }
            if ((deadline.result as bigint) > now && !(resolved.result as boolean)) {
                live.push({ address: batch[j], deadline: deadline.result as bigint });
            }
        }
        return failed;
    }

    for (let i = 0; i < addresses.length; i += LEGACY_PROBE_BATCH) {
        let pending = addresses.slice(i, i + LEGACY_PROBE_BATCH);
        for (const backoffMs of [0, 1_000, 3_000]) {
            if (backoffMs > 0) await delay(backoffMs);
            try {
                pending = await probeBatch(pending);
            } catch {
                /* whole batch failed — retry after backoff */
            }
            if (pending.length === 0) break;
        }
        dropped += pending.length;
        if (i + LEGACY_PROBE_BATCH < addresses.length) await delay(LEGACY_PROBE_DELAY_MS);
    }
    if (dropped > 0) {
        console.warn(`[markets] legacy scan: ${dropped} market(s) unprobeable after retries — excluded`);
    }
    console.log(`[markets] legacy scan complete: ${live.length} of ${addresses.length} v1 markets still open`);
    return live;
}

function ensureLegacyScan(addresses: Address[]): void {
    if (legacyLiveCache || legacyScanInflight) return;
    legacyScanInflight = scanLegacyLive(addresses)
        .then((live) => {
            legacyLiveCache = live;
        })
        .catch((err) => {
            console.warn("[markets] legacy scan failed; will retry on next refresh", err);
        })
        .finally(() => {
            legacyScanInflight = null;
        });
}

/** Cached, stale-while-revalidate list of every market the factory has minted.
 *  Safe for the list/discovery pages; see `MARKETS_CACHE_TTL_MS`. */
export async function listMarkets(): Promise<MarketSummary[]> {
    if (marketsCache) {
        const age = Date.now() - marketsCache.at;
        // Serve stale immediately and kick a background refresh (fire-and-forget)
        // when past the TTL so no user request eats the full read.
        if (age > MARKETS_CACHE_TTL_MS && !marketsInflight) {
            void refreshMarkets();
        }
        return marketsCache.data;
    }
    // Cold: no data yet, so this one request has to wait for the read.
    return refreshMarkets();
}

async function readSummaries(
    addrs: Address[],
    legacy: boolean,
): Promise<MarketSummary[]> {
    const rows: MarketSummary[] = [];
    for (let i = 0; i < addrs.length; i += MARKET_READ_BATCH_SIZE) {
        const batch = addrs.slice(i, i + MARKET_READ_BATCH_SIZE);
        try {
            rows.push(...await (supportsMulticall
                ? readMarketSummaryBatch(batch, legacy)
                : Promise.all(batch.map((address) => readMarketSummary(address, legacy)))));
        } catch (err) {
            console.warn("[markets] batch read failed; falling back to per-market reads", err);
            const settled = await Promise.allSettled(
                batch.map((a) => readMarketSummary(a, legacy)),
            );
            for (const row of settled) {
                if (row.status === "fulfilled") rows.push(row.value);
                else console.warn("[markets] failed to read market summary", row.reason);
            }
        }
        if (i + MARKET_READ_BATCH_SIZE < addrs.length) {
            await delay(MARKET_READ_BATCH_DELAY_MS);
        }
    }
    return rows;
}

// v2 catalog comes from the Postgres index maintained by
// scripts/catalog-indexer.ts. The on-chain v2 factory now holds ~1k markets
// (mostly churned fast rounds) and grows every 15m, so reading them all per
// refresh was the app's heaviest RPC path. Returns null — so the caller falls
// back to a full RPC read — until the indexer finishes its first backfill (so a
// half-populated table is never served) or if the DB is unreachable.
async function readV2CatalogFromDb(): Promise<MarketSummary[] | null> {
    try {
        const ready = await db
            .select({ value: catalogMeta.value })
            .from(catalogMeta)
            .where(eq(catalogMeta.key, V2_BACKFILLED_KEY))
            .limit(1);
        if (ready[0]?.value !== "1") return null;

        const rows = await db
            .select()
            .from(marketIndex)
            .where(eq(marketIndex.legacy, false));
        return rows.map(indexRowToSummary);
    } catch (err) {
        console.warn("[markets] DB catalog read failed; falling back to RPC", err);
        return null;
    }
}

// v1 is frozen (read-only since the 2026-07-18 migration — no market is ever
// created there again), so its full address list is immutable and safe to read
// exactly once per process instead of on every catalog refresh.
let legacyAddrsCache: Address[] | null = null;
async function readLegacyAddrs(): Promise<Address[]> {
    if (legacyAddrsCache) return legacyAddrsCache;
    legacyAddrsCache = (await publicClient.readContract({
        address: ADDRESSES.factoryLegacy,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    return legacyAddrsCache;
}

/** Catalog source of truth since the 2026-07-18 v2 migration:
 *  - v2 factory: every market, including resolved ones (fast-round history
 *    rebuilds from here as v2 rounds settle). Served from the Postgres index.
 *  - v1 factory: only markets that are still open (unexpired + unresolved).
 *    Its ~13.8k expired fast rounds were deliberately left behind; positions
 *    in them remain claimable via the portfolio, which scans v1 directly. */
async function readAllMarkets(): Promise<MarketSummary[]> {
    // v2 — prefer the Postgres index; fall back to a full RPC read when the
    // indexer hasn't backfilled yet or the DB is unreachable.
    let v2Rows = await readV2CatalogFromDb();
    if (!v2Rows) {
        const v2Addrs = (await publicClient.readContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "allMarkets",
        })) as Address[];
        v2Rows = await readSummaries(v2Addrs, false);
    }

    // The v1 legacy liveness scan probes ~13.8k frozen markets over RPC on the
    // first render of every process. That's cheap on a long-running server, but
    // on serverless every cold instance re-runs it and hammers the RPC (it's what
    // made Vercel renders take ~30s), and it runs even when v2 came from the DB.
    // PAUSED by default: the catalog is v2-only unless CATALOG_INCLUDE_LEGACY=1.
    // The ~28 still-open v1 markets are frozen legacy being phased out
    // post-migration and remain reachable by direct URL.
    if (process.env.CATALOG_INCLUDE_LEGACY !== "1") return v2Rows;

    // v1 — frozen factory (addresses cached once). The once-per-process
    // liveness scan decides which are still open; we read just those for fresh
    // prices. Until the scan lands the catalog is v2-only.
    const v1Addrs = await readLegacyAddrs();
    ensureLegacyScan(v1Addrs);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const v1Open = (legacyLiveCache ?? []).filter((m) => m.deadline > nowSec);
    const v1Rows = (await readSummaries(v1Open.map((m) => m.address), true)).filter(
        (r) => !r.resolved && r.deadline > nowSec,
    );
    return [...v2Rows, ...v1Rows];
}

/** Single-market summary from the Postgres catalog index (v2 only). Reliable and
 *  cheap — unlike the chain reads, it can't be rate-limited into failure. */
async function readMarketSummaryFromIndex(
    address: Address,
): Promise<MarketSummary | null> {
    try {
        const rows = await db
            .select()
            .from(marketIndex)
            .where(
                and(
                    eq(marketIndex.legacy, false),
                    eq(marketIndex.address, address.toLowerCase()),
                ),
            )
            .limit(1);
        return rows[0] ? indexRowToSummary(rows[0]) : null;
    } catch {
        return null;
    }
}

export async function getMarket(address: Address): Promise<MarketDetail | null> {
    // Prefer the index for the summary so a rate-limited RPC can't 404 a valid
    // market (that was the Vercel symptom) — and each page does 1 chain read
    // instead of 12. Only resolutionCriteria isn't indexed, so read just that,
    // best-effort: an empty criteria panel beats a 404.
    const indexed = await readMarketSummaryFromIndex(address);
    if (indexed) {
        let resolutionCriteria = "";
        try {
            resolutionCriteria = (await publicClient.readContract({
                address,
                abi: marketAbi,
                functionName: "resolutionCriteria",
            })) as string;
        } catch {
            /* keep "" — the page still renders */
        }
        return { ...indexed, resolutionCriteria };
    }

    // Not in the index (v1 legacy, or the index is cold): read fully from chain.
    try {
        // A market not registered on the v2 factory is a legacy v1 market.
        const onV2 = (await publicClient.readContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "isMarket",
            args: [address],
        })) as boolean;
        const summary = await readMarketSummary(address, !onV2);
        const criteria = await publicClient.readContract({
            address,
            abi: marketAbi,
            functionName: "resolutionCriteria",
        });
        return { ...summary, resolutionCriteria: criteria };
    } catch {
        return null;
    }
}

export async function getMarketRevenue(address: Address): Promise<MarketRevenue> {
    try {
        if (!supportsMulticall) {
            const [protocolFeeBps, accruedFees, reserveRequired, treasuryWithdrawable] =
                await Promise.all([
                    publicClient.readContract({
                        address,
                        abi: marketAbi,
                        functionName: "protocolFeeBps",
                    }) as Promise<number>,
                    publicClient.readContract({
                        address,
                        abi: marketAbi,
                        functionName: "accruedFees",
                    }) as Promise<bigint>,
                    publicClient.readContract({
                        address,
                        abi: marketAbi,
                        functionName: "reserveRequired",
                    }) as Promise<bigint>,
                    publicClient.readContract({
                        address,
                        abi: marketAbi,
                        functionName: "treasuryWithdrawable",
                    }) as Promise<bigint>,
                ]);
            return {
                protocolFeeBps: Number(protocolFeeBps),
                accruedFees,
                reserveRequired,
                treasuryWithdrawable,
            };
        }

        const r = await publicClient.multicall({
            allowFailure: true,
            contracts: [
                { address, abi: marketAbi, functionName: "protocolFeeBps" },
                { address, abi: marketAbi, functionName: "accruedFees" },
                { address, abi: marketAbi, functionName: "reserveRequired" },
                { address, abi: marketAbi, functionName: "treasuryWithdrawable" },
            ],
        });

        return {
            protocolFeeBps:
                r[0]?.status === "success" ? Number((r[0].result as number) ?? 0) : 0,
            accruedFees:
                r[1]?.status === "success" ? (r[1].result as bigint) : 0n,
            reserveRequired:
                r[2]?.status === "success" ? (r[2].result as bigint) : 0n,
            treasuryWithdrawable:
                r[3]?.status === "success" ? (r[3].result as bigint) : 0n,
        };
    } catch {
        return {
            protocolFeeBps: 0,
            accruedFees: 0n,
            reserveRequired: 0n,
            treasuryWithdrawable: 0n,
        };
    }
}

export type MarketResidual = { market: MarketSummary; revenue: MarketRevenue };

// One Multicall3 aggregate per this many markets. 500 measured clean over the
// whole catalog, and CLAUDE.md records free Arc RPCs rejecting 750-call batches
// with "request limit reached" — 400 keeps a margin under that ceiling while
// still covering 5k markets in ~13 requests.
const RESIDUAL_SCAN_CHUNK = 400;

// viem re-splits a multicall at `batchSize` BYTES of calldata (default 1024,
// i.e. ~6 calls), which would silently turn each chunk above back into ~70
// requests. 0 disables that second layer of splitting so RESIDUAL_SCAN_CHUNK is
// the real unit — safe because we already bound the chunk by call count.
const RESIDUAL_SCAN_MULTICALL = { allowFailure: true, batchSize: 0 } as const;

// With splitting off, each chunk is one big serial round-trip, so the wall time
// is just 13 requests end to end. Overlapping a few recovers the parallelism
// viem's own splitting gave us without going back to thousands of requests.
const RESIDUAL_SCAN_CONCURRENCY = 4;

// The scan is read-only bookkeeping and residuals only move when a keeper
// settles a round, so a stale-while-revalidate cache (same shape as the
// catalog's above) keeps repeat admin loads instant.
const RESIDUAL_CACHE_TTL_MS = 60_000;

let residualCache: { data: MarketResidual[]; at: number } | null = null;
let residualInflight: Promise<MarketResidual[]> | null = null;

/**
 * Every market currently holding a withdrawable treasury balance.
 *
 * The admin page discards each market whose `treasuryWithdrawable` is zero, and
 * as of writing that is 5030 of 5151 — so reading all four revenue fields per
 * market up front (one `eth_call` each, ~5k requests fired concurrently) spent
 * ~70s to throw away 98% of the result, and grew every time a fast round
 * churned. Instead: probe the one field the filter needs across the whole
 * catalog in a handful of aggregates, then fetch the remaining three only for
 * the markets that survive.
 */
export async function listTreasuryResiduals(
    markets: MarketSummary[],
): Promise<MarketResidual[]> {
    if (residualCache) {
        const age = Date.now() - residualCache.at;
        if (age > RESIDUAL_CACHE_TTL_MS && !residualInflight) {
            void refreshResiduals(markets);
        }
        return residualCache.data;
    }
    return refreshResiduals(markets);
}

function refreshResiduals(markets: MarketSummary[]): Promise<MarketResidual[]> {
    if (residualInflight) return residualInflight;
    residualInflight = scanTreasuryResiduals(markets)
        .then((rows) => {
            residualCache = { data: rows, at: Date.now() };
            return rows;
        })
        .catch((err) => {
            // Mirrors refreshMarkets: a background refresh must never reject
            // unhandled. Serve the stale scan and retry next TTL.
            console.warn("[markets] residual scan failed; serving stale cache", err);
            if (residualCache) return residualCache.data;
            throw err;
        })
        .finally(() => {
            residualInflight = null;
        });
    return residualInflight;
}

// ── Per-user positions ──────────────────────────────────────────────────────

export type UserPosition = { address: Address; sharesYes: bigint; sharesNo: bigint };

// One entry per wallet. Positions only change when that wallet trades or claims,
// so a short SWR window keeps the portfolio's polling free while staying fresh.
const POSITIONS_CACHE_TTL_MS = 20_000;
const positionsCache = new Map<string, { data: UserPosition[]; at: number }>();
const positionsInflight = new Map<string, Promise<UserPosition[]>>();

// 2 calls per market, so half the residual chunk keeps the same ~400 calls per
// Multicall3 aggregate — the ceiling the free Arc RPCs accept.
const POSITION_SCAN_CHUNK = Math.floor(RESIDUAL_SCAN_CHUNK / 2);

/**
 * Every market where `user` holds shares.
 *
 * This used to run in the browser: the portfolio fetched all v2 markets and
 * walked them in 40-market batches. That was fine at ~1k markets and fell over
 * at 5k+ — 133 sequential round-trips took longer than the 30s refetch
 * interval, so scans overlapped and the RPC answered 429 for everything. Doing
 * it here instead means one fallback-backed client, big aggregates, bounded
 * concurrency, and a cache shared by every tab.
 */
export async function listUserPositions(user: Address): Promise<UserPosition[]> {
    const key = user.toLowerCase();
    const cached = positionsCache.get(key);
    if (cached) {
        if (Date.now() - cached.at > POSITIONS_CACHE_TTL_MS && !positionsInflight.has(key)) {
            void refreshUserPositions(user, key);
        }
        return cached.data;
    }
    return refreshUserPositions(user, key);
}

function refreshUserPositions(user: Address, key: string): Promise<UserPosition[]> {
    const existing = positionsInflight.get(key);
    if (existing) return existing;

    const run = scanUserPositions(user)
        .then((rows) => {
            positionsCache.set(key, { data: rows, at: Date.now() });
            return rows;
        })
        .catch((err) => {
            // Serve stale rather than surfacing a partial/rate-limited scan.
            console.warn("[markets] position scan failed; serving stale", err);
            const stale = positionsCache.get(key);
            if (stale) return stale.data;
            throw err;
        })
        .finally(() => {
            positionsInflight.delete(key);
        });
    positionsInflight.set(key, run);
    return run;
}

async function scanUserPositions(user: Address): Promise<UserPosition[]> {
    const markets = await listMarkets();
    // Legacy v1 is read-only and the portfolio scans it separately; v2 is the
    // live catalog.
    const v2 = markets.filter((m) => !m.legacy);

    const chunks = await mapChunks(v2, POSITION_SCAN_CHUNK, async (chunk) => {
        const res = await publicClient.multicall({
            ...RESIDUAL_SCAN_MULTICALL,
            contracts: chunk.flatMap((m) => [
                { address: m.address, abi: marketAbi, functionName: "sharesYes", args: [user] } as const,
                { address: m.address, abi: marketAbi, functionName: "sharesNo", args: [user] } as const,
            ]),
        });
        const held: UserPosition[] = [];
        chunk.forEach((m, i) => {
            const y = res[i * 2];
            const n = res[i * 2 + 1];
            const sharesYes = y?.status === "success" ? (y.result as bigint) : 0n;
            const sharesNo = n?.status === "success" ? (n.result as bigint) : 0n;
            if (sharesYes > 0n || sharesNo > 0n) held.push({ address: m.address, sharesYes, sharesNo });
        });
        return held;
    });
    return chunks.flat();
}

/** Split `items` into `size`-wide chunks and run `fn` over them with at most
 *  `RESIDUAL_SCAN_CONCURRENCY` in flight. Results keep chunk order. */
async function mapChunks<T, R>(
    items: T[],
    size: number,
    fn: (chunk: T[]) => Promise<R>,
): Promise<R[]> {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));

    const out = new Array<R>(chunks.length);
    let next = 0;
    const worker = async () => {
        for (let i = next++; i < chunks.length; i = next++) {
            out[i] = await fn(chunks[i]);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(RESIDUAL_SCAN_CONCURRENCY, chunks.length) }, worker),
    );
    return out;
}

async function scanTreasuryResiduals(
    markets: MarketSummary[],
): Promise<MarketResidual[]> {
    // Pass 1 — `treasuryWithdrawable` only, chunked into Multicall3 aggregates.
    const survivors = await mapChunks(markets, RESIDUAL_SCAN_CHUNK, async (chunk) => {
        const res = await publicClient.multicall({
            ...RESIDUAL_SCAN_MULTICALL,
            contracts: chunk.map((m) => ({
                address: m.address,
                abi: marketAbi,
                functionName: "treasuryWithdrawable",
            })),
        });
        return chunk.filter(
            (_, j) => res[j]?.status === "success" && (res[j].result as bigint) > 0n,
        );
    });
    const withResidual = survivors.flat();

    // Pass 2 — the other three fields, for the survivors only. Four calls per
    // market here, so a quarter of the chunk keeps the same per-request ceiling.
    const detailed = await mapChunks(
        withResidual,
        Math.floor(RESIDUAL_SCAN_CHUNK / 4),
        async (chunk) => {
            const res = await publicClient.multicall({
                ...RESIDUAL_SCAN_MULTICALL,
                contracts: chunk.flatMap((m) => [
                    { address: m.address, abi: marketAbi, functionName: "protocolFeeBps" },
                    { address: m.address, abi: marketAbi, functionName: "accruedFees" },
                    { address: m.address, abi: marketAbi, functionName: "reserveRequired" },
                    {
                        address: m.address,
                        abi: marketAbi,
                        functionName: "treasuryWithdrawable",
                    },
                ]),
            });
            return chunk.map((market, j): MarketResidual => {
                const [fee, accrued, reserve, withdrawable] = res.slice(j * 4, j * 4 + 4);
                return {
                    market,
                    revenue: {
                        protocolFeeBps:
                            fee?.status === "success" ? Number(fee.result ?? 0) : 0,
                        accruedFees:
                            accrued?.status === "success" ? (accrued.result as bigint) : 0n,
                        reserveRequired:
                            reserve?.status === "success" ? (reserve.result as bigint) : 0n,
                        treasuryWithdrawable:
                            withdrawable?.status === "success"
                                ? (withdrawable.result as bigint)
                                : 0n,
                    },
                };
            });
        },
    );
    const rows = detailed.flat();
    // Pass 1 read `treasuryWithdrawable` at an older block than pass 2; a
    // keeper sweeping in between can zero one out. Re-apply the filter.
    return rows.filter((r) => r.revenue.treasuryWithdrawable > 0n);
}

/** Cheap chain-status probe for the footer status indicator. */
export async function chainStatus(): Promise<{ block: bigint; ok: true } | { ok: false }> {
    try {
        const block = await publicClient.getBlockNumber();
        return { block, ok: true };
    } catch {
        return { ok: false };
    }
}
