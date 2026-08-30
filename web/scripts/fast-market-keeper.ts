/**
 * Fast market keeper:
 * - Maintains one active market for each symbol/timeframe pair (BTC/ETH/SOL x 15m/1h)
 * - Resolves expired fast markets using spot prices from CoinGecko
 *
 * Run with:
 *   npm run markets:fast:keeper
 */
import { config as loadEnv } from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import {
    createPublicClient,
    createWalletClient,
    fallback,
    type Account,
    formatUnits,
    http,
    parseUnits,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "../lib/chain";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi, Outcome } from "../lib/contracts";

loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

// --legacy-factory: run against the v1 factory to resolve/sweep the fast
// rounds that were still open at the 2026-07-18 v2 cutover. In this mode the
// keeper NEVER creates markets — it only settles and sweeps what remains.
// v1 has no resolver role, so everything signs with the deployer (admin) key.
const LEGACY_MODE = process.argv.includes("--legacy-factory");
const FACTORY = LEGACY_MODE ? ADDRESSES.factoryLegacy : ADDRESSES.factory;

type SymbolCfg = {
    symbol: "BTC" | "ETH" | "SOL";
    coingeckoId: "bitcoin" | "ethereum" | "solana";
    binanceSymbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
};

type WindowCfg = {
    label: "15m" | "1h";
    seconds: number;
};

type FastMeta = {
    version: 1;
    symbol: "BTC" | "ETH" | "SOL";
    timeframe: "15m" | "1h";
    source: "coingecko" | "binance";
    startPrice: string; // decimal string
    startTs: number; // aligned candle open time (seconds)
};

const ALL_SYMBOLS: SymbolCfg[] = [
    { symbol: "BTC", coingeckoId: "bitcoin", binanceSymbol: "BTCUSDT" },
    { symbol: "ETH", coingeckoId: "ethereum", binanceSymbol: "ETHUSDT" },
    { symbol: "SOL", coingeckoId: "solana", binanceSymbol: "SOLUSDT" },
];

const ALL_WINDOWS: WindowCfg[] = [
    { label: "15m", seconds: 15 * 60 },
    { label: "1h", seconds: 60 * 60 },
];

function configuredList(name: string): string[] | null {
    const raw = process.env[name]?.trim();
    if (!raw) return null;
    return raw
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
}

const configuredSymbols = configuredList("FAST_MARKET_SYMBOLS");
const configuredWindows = configuredList("FAST_MARKET_WINDOWS");
const SYMBOLS: SymbolCfg[] = ALL_SYMBOLS.filter(
    (item) => !configuredSymbols || configuredSymbols.includes(item.symbol),
);
const WINDOWS: WindowCfg[] = ALL_WINDOWS.filter(
    (item) => !configuredWindows || configuredWindows.includes(item.label.toUpperCase()),
);

if (SYMBOLS.length === 0) {
    throw new Error("FAST_MARKET_SYMBOLS did not select a supported symbol");
}
if (WINDOWS.length === 0) {
    throw new Error("FAST_MARKET_WINDOWS did not select a supported timeframe");
}

const CATEGORY = "Fast";
const AUTO_PREFIX = "AUTO_FAST:";
const DEFAULT_SEED_USDC = "5";
const DEFAULT_POLL_SECONDS = 30;
const MARKET_READ_CONCURRENCY = 6;
const MARKET_READ_BATCH_DELAY_MS = 100;
const INITIAL_FAST_MARKET_SCAN_LIMIT = 48;
const RPC_READ_RETRIES = 3;
const DEFAULT_RESIDUAL_SWEEP_STATE_FILE = "config/fast-market-residual-sweep.state.json";
const DEFAULT_RESIDUAL_SWEEP_RECENT_LIMIT = 96;
const DEFAULT_RESIDUAL_SWEEP_INTERVAL_SECONDS = 60 * 60;
const DEFAULT_RESIDUAL_SWEEP_EMPTY_RECHECK_SECONDS = 12 * 60 * 60;
const DEFAULT_RESIDUAL_SWEEP_FULL_RESCAN_SECONDS = 7 * 24 * 60 * 60;
// Native USDC (18-dec) gas thresholds for the dedicated resolver key. It signs
// resolveMarket only and holds no funds of its own, so it drains steadily and
// used to need manual top-ups. When it dips below the floor, the keeper refills
// it from the deployer (which holds the treasury) so settlement never stalls.
const DEFAULT_RESOLVER_MIN_GAS_USDC = "0.05";
const DEFAULT_RESOLVER_TOPUP_USDC = "0.5";
const FAST_SYMBOL_RE = /\b(BTC|ETH|SOL)\b/i;
const FAST_TIMEFRAME_RE = /\b(15\s?m(in)?|1\s?h(our)?)\b/i;
const FAST_DIRECTION_RE = /\b(up|down|higher|lower|above|below)\b/i;
const FAST_CATEGORY_RE = /^(fast|turbo|speed)$/i;

function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
}

function getRpcUrls(): string[] {
    const multi = process.env.ARC_TESTNET_RPC_URLS?.split(",")
        .map((x) => x.trim())
        .filter(Boolean) ?? [];
    const one = process.env.ARC_TESTNET_RPC_URL?.trim();
    const urls = [...multi, ...(one ? [one] : []), ...arcTestnet.rpcUrls.default.http];
    return [...new Set(urls)];
}

function parsePrivateKey(raw: string): `0x${string}` {
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be 32-byte hex");
    }
    return key as `0x${string}`;
}

function toUsdc6(amount: string): bigint {
    return parseUnits(amount, 6);
}

// Native gas balance on Arc is USDC at 18 decimals (same underlying value as the
// 6-dec ERC-20, different scale — see CLAUDE.md). Gas top-ups are plain native
// value transfers, so they must be denominated in 18-dec wei.
function toGasWei(amount: string): bigint {
    return parseUnits(amount, 18);
}

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return n;
}

function resolveRepoPath(rawPath: string): string {
    return path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(__dirname, "..", "..", rawPath);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapInBatches<T, R>(
    items: T[],
    batchSize: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        out.push(...(await Promise.all(batch.map(fn))));
        if (MARKET_READ_BATCH_DELAY_MS > 0 && i + batchSize < items.length) {
            await delay(MARKET_READ_BATCH_DELAY_MS);
        }
    }
    return out;
}

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RPC_READ_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt === RPC_READ_RETRIES) break;
            const waitMs = 350 * attempt;
            console.warn(`[keeper] ${label} failed; retrying in ${waitMs}ms`);
            await delay(waitMs);
        }
    }
    throw lastErr;
}

function buildQuestion(symbol: string, timeframe: string, startPrice: string): string {
    return `Will ${symbol} be UP in the next ${timeframe}? (Start: $${startPrice})`;
}

function buildResolutionCriteria(meta: FastMeta): string {
    const sourceLine =
        meta.source === "binance"
            ? "Price source: Binance klines close prices in USDT (treated as USD)."
            : "Price source: CoinGecko simple price endpoint in USD.";
    return [
        `${AUTO_PREFIX}${JSON.stringify(meta)}`,
        "Resolves YES iff candle close at deadline is strictly greater than start price.",
        sourceLine,
        "If equal, resolves NO.",
    ].join("\n");
}

function parseAutoMeta(criteria: string): FastMeta | null {
    const first = criteria.split("\n")[0] ?? "";
    if (!first.startsWith(AUTO_PREFIX)) return null;
    try {
        const parsed = JSON.parse(first.slice(AUTO_PREFIX.length)) as FastMeta;
        if (
            parsed?.version === 1 &&
            (parsed.symbol === "BTC" || parsed.symbol === "ETH" || parsed.symbol === "SOL") &&
            (parsed.timeframe === "15m" || parsed.timeframe === "1h") &&
            (parsed.source === "coingecko" || parsed.source === "binance")
        ) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

function alignedWindowStart(nowSec: number, windowSec: number): number {
    return Math.floor(nowSec / windowSec) * windowSec;
}

function findWindow(timeframe: FastMeta["timeframe"]): WindowCfg {
    const win = WINDOWS.find((w) => w.label === timeframe);
    if (!win) {
        throw new Error(`unsupported timeframe: ${timeframe}`);
    }
    return win;
}

async function fetchBinanceCandleClose(
    symbol: SymbolCfg["binanceSymbol"],
    interval: WindowCfg["label"],
    closeTsSec: number,
): Promise<number> {
    const win = findWindow(interval);
    const startMs = BigInt(closeTsSec - win.seconds) * 1000n;
    const endMs = BigInt(closeTsSec) * 1000n;
    const url =
        `https://api.binance.com/api/v3/klines?symbol=${symbol}` +
        `&interval=${interval}&startTime=${startMs.toString()}&endTime=${endMs.toString()}&limit=1`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Binance kline error: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
        throw new Error(`Missing Binance candle for ${symbol} ${interval} close=${closeTsSec}`);
    }

    const closeRaw = (rows[0] as unknown[])[4];
    const close = Number(closeRaw);
    if (!Number.isFinite(close) || close <= 0) {
        throw new Error(`Bad Binance close for ${symbol} ${interval}`);
    }
    return close;
}

async function fetchUsdPrices(ids: SymbolCfg[]): Promise<Record<string, number>> {
    const list = ids.map((x) => x.coingeckoId).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${list}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const out: Record<string, number> = {};
    for (const id of ids) {
        const v = json[id.coingeckoId]?.usd;
        if (!Number.isFinite(v) || !v || v <= 0) {
            throw new Error(`Missing USD price for ${id.coingeckoId}`);
        }
        out[id.symbol] = v;
    }
    return out;
}

async function ensureApproval(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    owner: Account,
    minRequired: bigint,
) {
    const allowance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner.address, FACTORY],
    })) as bigint;

    if (allowance >= minRequired) return;

    const tx = await walletClient.writeContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [FACTORY, (1n << 256n) - 1n],
        account: owner,
        chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[keeper] approved factory to spend USDC (tx: ${tx})`);
}

async function ensureResolverGas(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    funder: Account, // deployer — holds the treasury and pays for the top-up
    resolver: Account, // dedicated settlement key being refilled
    minGasWei: bigint,
    topupWei: bigint,
): Promise<void> {
    // Same key means there is no separate resolver to fund (legacy mode / fallback).
    if (funder.address.toLowerCase() === resolver.address.toLowerCase()) return;
    if (topupWei <= 0n) return;

    const resolverBalance = await publicClient.getBalance({ address: resolver.address });
    if (resolverBalance >= minGasWei) return;

    const funderBalance = await publicClient.getBalance({ address: funder.address });
    // Keep a buffer so the deployer never starves its own createMarket gas to
    // fund the resolver.
    if (funderBalance < topupWei * 4n) {
        console.warn(
            `[keeper] resolver ${resolver.address} low on gas (${formatUnits(resolverBalance, 18)} USDC) ` +
                `but funder balance ${formatUnits(funderBalance, 18)} USDC too low to top up safely; skipping`,
        );
        return;
    }

    const tx = await walletClient.sendTransaction({
        account: funder,
        chain: arcTestnet,
        to: resolver.address,
        value: topupWei,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(
        `[keeper] topped up resolver ${resolver.address} with ${formatUnits(topupWei, 18)} gas USDC ` +
            `(was ${formatUnits(resolverBalance, 18)}) tx=${tx}`,
    );
}

async function readUsdcBalance(
    publicClient: ReturnType<typeof createPublicClient>,
    owner: Account,
): Promise<bigint> {
    return (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner.address],
    })) as bigint;
}

type MarketRow = {
    address: Address;
    question: string;
    category: string;
    deadline: bigint;
    resolved: boolean;
    tradeCount: bigint | null;
    resolutionCriteria: string;
};

type KeeperState = {
    initialized: boolean;
    marketCount: number;
    tracked: Map<string, MarketRow>;
};

type ResidualSweepMarketState = {
    address: Address;
    fast: boolean;
    lastCheckedAt: number;
    empty: boolean;
};

type ResidualSweepState = {
    version: 1;
    updatedAt: number;
    fullScanAt: number;
    marketCount: number;
    markets: Record<string, ResidualSweepMarketState>;
};

type CreateMissingResult = {
    created: number;
    completeLiveSet: boolean;
};

const marketKey = (address: Address) => address.toLowerCase();

function emptyResidualSweepState(): ResidualSweepState {
    return {
        version: 1,
        updatedAt: 0,
        fullScanAt: 0,
        marketCount: 0,
        markets: {},
    };
}

function normalizeSweepState(raw: unknown): ResidualSweepState {
    if (!raw || typeof raw !== "object") return emptyResidualSweepState();

    const input = raw as Partial<ResidualSweepState>;
    if (input.version !== 1 || !input.markets || typeof input.markets !== "object") {
        return emptyResidualSweepState();
    }

    const state: ResidualSweepState = {
        version: 1,
        updatedAt: Number(input.updatedAt ?? 0),
        fullScanAt: Number(input.fullScanAt ?? 0),
        marketCount: Number(input.marketCount ?? 0),
        markets: {},
    };

    for (const [key, value] of Object.entries(input.markets)) {
        if (!value || typeof value !== "object") continue;
        const row = value as Partial<ResidualSweepMarketState>;
        if (typeof row.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.address)) continue;
        state.markets[key.toLowerCase()] = {
            address: row.address as Address,
            fast: Boolean(row.fast),
            lastCheckedAt: Number(row.lastCheckedAt ?? 0),
            empty: Boolean(row.empty),
        };
    }

    return state;
}

async function loadResidualSweepState(filePath: string): Promise<ResidualSweepState> {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return normalizeSweepState(JSON.parse(raw));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return emptyResidualSweepState();
        }
        console.warn(`[keeper] failed to load residual sweep state ${filePath}; starting fresh`, err);
        return emptyResidualSweepState();
    }
}

async function saveResidualSweepState(filePath: string, state: ResidualSweepState): Promise<void> {
    state.updatedAt = Math.floor(Date.now() / 1000);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function isResidualSweepDue(
    filePath: string,
    intervalSeconds: number,
    nowSec: number,
): Promise<boolean> {
    if (intervalSeconds === 0) return true;

    const state = await loadResidualSweepState(filePath);
    return state.updatedAt === 0 || nowSec - state.updatedAt >= intervalSeconds;
}

async function readTradeCount(
    publicClient: ReturnType<typeof createPublicClient>,
    address: Address,
): Promise<bigint | null> {
    try {
        return (await publicClient.readContract({
            address,
            abi: marketAbi,
            functionName: "tradeCount",
        })) as bigint;
    } catch {
        return null;
    }
}

async function marketHasTrades(
    publicClient: ReturnType<typeof createPublicClient>,
    row: MarketRow,
): Promise<boolean> {
    if (row.tradeCount !== null) return row.tradeCount > 0n;

    const [buys, sells] = await Promise.all([
        publicClient.getContractEvents({
            address: row.address,
            abi: marketAbi,
            eventName: "Bought",
            fromBlock: 0n,
            toBlock: "latest",
        }),
        publicClient.getContractEvents({
            address: row.address,
            abi: marketAbi,
            eventName: "Sold",
            fromBlock: 0n,
            toBlock: "latest",
        }),
    ]);

    return buys.length + sells.length > 0;
}

async function readFactoryMarkets(
    publicClient: ReturnType<typeof createPublicClient>,
): Promise<Address[]> {
    return withRetries("read factory markets", () =>
        publicClient.readContract({
            address: FACTORY,
            abi: factoryAbi,
            functionName: "allMarkets",
        }) as Promise<Address[]>,
    );
}

async function readMarketRow(
    publicClient: ReturnType<typeof createPublicClient>,
    address: Address,
): Promise<MarketRow> {
    const [question, category, deadline, resolved, resolutionCriteria] =
        await withRetries(`read ${address}`, () =>
            Promise.all([
                publicClient.readContract({ address, abi: marketAbi, functionName: "question" }) as Promise<string>,
                publicClient.readContract({ address, abi: marketAbi, functionName: "category" }) as Promise<string>,
                publicClient.readContract({ address, abi: marketAbi, functionName: "deadline" }) as Promise<bigint>,
                publicClient.readContract({ address, abi: marketAbi, functionName: "resolved" }) as Promise<boolean>,
                publicClient.readContract({ address, abi: marketAbi, functionName: "resolutionCriteria" }) as Promise<string>,
            ]) as Promise<[string, string, bigint, boolean, string]>,
        );
    const trades = await withRetries(`read tradeCount ${address}`, () =>
        readTradeCount(publicClient, address),
    );
    return {
        address,
        question,
        category,
        deadline,
        resolved,
        tradeCount: trades,
        resolutionCriteria,
    } as MarketRow;
}

function isAutoFastMarket(row: MarketRow): boolean {
    return row.category.trim().toLowerCase() === CATEGORY.toLowerCase() && !!parseAutoMeta(row.resolutionCriteria);
}

function matchesAdminFastMarket(row: Pick<MarketRow, "question" | "category">): boolean {
    if (FAST_CATEGORY_RE.test(row.category.trim())) return true;

    return (
        FAST_SYMBOL_RE.test(row.question) &&
        FAST_TIMEFRAME_RE.test(row.question) &&
        FAST_DIRECTION_RE.test(row.question)
    );
}

function activeFastMarketKey(row: MarketRow, nowSec: number): string | null {
    if (row.resolved) return null;
    if (Number(row.deadline) <= nowSec) return null;

    const meta = parseAutoMeta(row.resolutionCriteria);
    if (!meta) return null;
    return `${meta.symbol}:${meta.timeframe}`;
}

function hasCompleteLiveFastSet(rows: MarketRow[], nowSec: number): boolean {
    const active = new Set(
        rows
            .map((row) => activeFastMarketKey(row, nowSec))
            .filter((key): key is string => key !== null),
    );

    return SYMBOLS.every((sym) =>
        WINDOWS.every((win) => active.has(`${sym.symbol}:${win.label}`)),
    );
}

async function syncTrackedFastMarkets(
    publicClient: ReturnType<typeof createPublicClient>,
    state: KeeperState,
): Promise<MarketRow[]> {
    const addrs = await readFactoryMarkets(publicClient);
    const tracked = [...state.tracked.values()]
        .filter((row) => !row.resolved)
        .map((row) => row.address);

    let discovered: Address[] = [];
    if (!state.initialized || addrs.length < state.marketCount) {
        discovered = addrs.slice(-INITIAL_FAST_MARKET_SCAN_LIMIT);
        state.tracked.clear();
        state.initialized = true;
        console.log(
            `[keeper] syncing recent ${discovered.length}/${addrs.length} factory markets`,
        );
    } else if (addrs.length > state.marketCount) {
        discovered = addrs.slice(state.marketCount);
    }
    state.marketCount = addrs.length;

    const wanted = new Map<string, Address>();
    for (const address of [...tracked, ...discovered]) {
        wanted.set(marketKey(address), address);
    }

    if (wanted.size > 0) {
        const settled = await mapInBatches(
            [...wanted.values()],
            MARKET_READ_CONCURRENCY,
            (address) => readMarketRow(publicClient, address).then(
                (row) => ({ status: "fulfilled" as const, row }),
                (reason) => ({ status: "rejected" as const, address, reason }),
            ),
        );
        for (const item of settled) {
            if (item.status === "rejected") {
                console.warn(`[keeper] skipped unreadable market ${item.address}`, item.reason);
                continue;
            }
            const row = item.row;
            const key = marketKey(row.address);
            if (!row.resolved && isAutoFastMarket(row)) {
                state.tracked.set(key, row);
            } else {
                state.tracked.delete(key);
            }
        }
    }

    return [...state.tracked.values()];
}

async function readTreasuryWithdrawable(
    publicClient: ReturnType<typeof createPublicClient>,
    address: Address,
): Promise<bigint> {
    return withRetries(`read treasuryWithdrawable ${address}`, () =>
        publicClient.readContract({
            address,
            abi: marketAbi,
            functionName: "treasuryWithdrawable",
        }) as Promise<bigint>,
    );
}

async function readMarketSettlementState(
    publicClient: ReturnType<typeof createPublicClient>,
    address: Address,
): Promise<{ resolved: boolean; outcome: Outcome }> {
    const [resolved, outcome] = await withRetries(`read settlement state ${address}`, () =>
        Promise.all([
            publicClient.readContract({ address, abi: marketAbi, functionName: "resolved" }) as Promise<boolean>,
            publicClient.readContract({ address, abi: marketAbi, functionName: "outcome" }) as Promise<Outcome>,
        ]) as Promise<[boolean, Outcome]>,
    );

    return { resolved, outcome };
}

async function sweepFastMarketResiduals(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    owner: Account,
    stateFile: string,
    recentLimit: number,
    emptyRecheckSeconds: number,
    fullRescanSeconds: number,
): Promise<bigint> {
    const addrs = await readFactoryMarkets(publicClient);
    if (addrs.length === 0) return 0n;

    const sweepState = await loadResidualSweepState(stateFile);
    const nowSec = Math.floor(Date.now() / 1000);
    const fullScan =
        sweepState.fullScanAt === 0 ||
        addrs.length < sweepState.marketCount ||
        (fullRescanSeconds > 0 && nowSec - sweepState.fullScanAt >= fullRescanSeconds);
    const recentAddrs = recentLimit > 0 ? addrs.slice(-recentLimit) : [];
    const recentKeys = new Set(recentAddrs.map(marketKey));
    const candidates = addrs.filter((address) => {
        if (fullScan) return true;

        const key = marketKey(address);
        const cached = sweepState.markets[key];
        if (!cached) return true;
        if (recentKeys.has(key)) return true;
        if (cached.fast && !cached.empty) return true;
        if (cached.fast && nowSec - cached.lastCheckedAt >= emptyRecheckSeconds) return true;
        return false;
    });

    sweepState.marketCount = addrs.length;

    console.log(
        `[keeper] scanning ${candidates.length}/${addrs.length} markets for fast-market residuals` +
            `${fullScan ? " (full cache refresh)" : ""}`,
    );
    const settled = await mapInBatches(
        candidates,
        MARKET_READ_CONCURRENCY,
        async (address) => {
            return readMarketRow(publicClient, address).then(
                (row) => ({
                    status: "fulfilled" as const,
                    address,
                    fast: matchesAdminFastMarket(row),
                    resolved: row.resolved,
                }),
                (reason) => ({ status: "rejected" as const, address, reason }),
            );
        },
    );

    let total = 0n;
    let count = 0;
    let checked = 0;
    for (const item of settled) {
        if (item.status === "rejected") {
            console.warn(`[keeper] skipped residual scan for unreadable market ${item.address}`, item.reason);
            continue;
        }

        const key = marketKey(item.address);
        if (!item.fast) {
            sweepState.markets[key] = {
                address: item.address,
                fast: false,
                lastCheckedAt: nowSec,
                empty: true,
            };
            checked += 1;
            continue;
        }

        if (!item.resolved) {
            sweepState.markets[key] = {
                address: item.address,
                fast: true,
                lastCheckedAt: nowSec,
                empty: true,
            };
            checked += 1;
            continue;
        }

        let withdrawable = 0n;
        try {
            withdrawable = await readTreasuryWithdrawable(publicClient, item.address);
        } catch (err) {
            console.warn(`[keeper] failed to read residual for fast market ${item.address}`, err);
            continue;
        }
        if (withdrawable === 0n) {
            sweepState.markets[key] = {
                address: item.address,
                fast: true,
                lastCheckedAt: nowSec,
                empty: true,
            };
            checked += 1;
            continue;
        }

        try {
            const settlement = await readMarketSettlementState(publicClient, item.address);
            if (!settlement.resolved || settlement.outcome === Outcome.Unresolved) {
                sweepState.markets[key] = {
                    address: item.address,
                    fast: true,
                    lastCheckedAt: nowSec,
                    empty: true,
                };
                checked += 1;
                console.warn(
                    `[keeper] skipped fast residual sweep for unresolved market ${item.address}`,
                );
                continue;
            }

            const withdrawTx = await walletClient.writeContract({
                address: FACTORY,
                abi: factoryAbi,
                functionName: "withdrawMarketTreasury",
                args: [item.address, owner.address, withdrawable],
                account: owner,
                chain: arcTestnet,
            });
            await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
            total += withdrawable;
            count += 1;
            checked += 1;
            sweepState.markets[key] = {
                address: item.address,
                fast: true,
                lastCheckedAt: nowSec,
                empty: true,
            };
            console.log(
                `[keeper] swept fast residual ${formatUnits(withdrawable, 6)} USDC from ${item.address} to ${owner.address} tx=${withdrawTx}`,
            );
        } catch (err) {
            sweepState.markets[key] = {
                address: item.address,
                fast: true,
                lastCheckedAt: nowSec,
                empty: false,
            };
            checked += 1;
            console.warn(`[keeper] failed to sweep fast residual from ${item.address}`, err);
        }

        if (checked > 0 && checked % 25 === 0) {
            await saveResidualSweepState(stateFile, sweepState);
        }
    }

    if (fullScan) sweepState.fullScanAt = nowSec;
    await saveResidualSweepState(stateFile, sweepState);

    if (count > 0) {
        console.log(
            `[keeper] swept ${formatUnits(total, 6)} USDC from ${count} fast market residual${count === 1 ? "" : "s"}`,
        );
    } else {
        console.log("[keeper] no fast market residuals available to sweep");
    }
    return total;
}

async function settleExpiredMarket(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    resolveAccount: Account,
    nowSec: number,
    prices: Record<string, number>,
    row: MarketRow,
): Promise<void> {
    if (row.resolved) return;
    if (row.category.trim().toLowerCase() !== CATEGORY.toLowerCase()) return;
    if (Number(row.deadline) > nowSec) return;

    const meta = parseAutoMeta(row.resolutionCriteria);
    if (!meta) return;

    const sym = SYMBOLS.find((s) => s.symbol === meta.symbol);
    if (!sym) return;

    const start = Number(meta.startPrice);
    if (!Number.isFinite(start) || start <= 0) return;

    const configured =
        SYMBOLS.some((item) => item.symbol === meta.symbol) &&
        WINDOWS.some((item) => item.label === meta.timeframe);

    const hadTrades = await marketHasTrades(publicClient, row);
    if (!hadTrades) {
        // A previously configured timeframe (for example 1h) should not be
        // rolled over forever after it is removed from the allowlist. Retire
        // it as cancelled so its seed can be withdrawn and only the current
        // configured set continues recycling.
        if (!configured) {
            const tx = await walletClient.writeContract({
                address: FACTORY,
                abi: factoryAbi,
                functionName: "resolveMarket",
                args: [row.address, Outcome.Cancelled],
                account: resolveAccount,
                chain: arcTestnet,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });
            row.resolved = true;
            console.log(
                `[keeper] retired unconfigured empty ${meta.symbol} ${meta.timeframe} @ ${row.address} ` +
                    `(cancelled, seed recoverable) tx=${tx}`,
            );
            return;
        }

        const win = findWindow(meta.timeframe);
        const windowStart = alignedWindowStart(nowSec, win.seconds);
        let startClose = 0;
        let source: FastMeta["source"] = "binance";
        try {
            startClose = await fetchBinanceCandleClose(
                sym.binanceSymbol,
                meta.timeframe,
                windowStart,
            );
        } catch (err) {
            startClose = prices[meta.symbol] ?? 0;
            source = "coingecko";
            console.warn(
                `[keeper] Binance start close failed for rollover ${meta.symbol} ${meta.timeframe}; using CoinGecko spot`,
                err,
            );
        }
        if (!Number.isFinite(startClose) || startClose <= 0) return;

        const nextMeta: FastMeta = {
            version: 1,
            symbol: meta.symbol,
            timeframe: meta.timeframe,
            source,
            startPrice: startClose.toFixed(2),
            startTs: windowStart,
        };
        const nextQuestion = buildQuestion(meta.symbol, meta.timeframe, nextMeta.startPrice);
        const nextCriteria = buildResolutionCriteria(nextMeta);
        const nextDeadline = windowStart + win.seconds;

        const rolloverTx = await walletClient.writeContract({
            address: FACTORY,
            abi: factoryAbi,
            functionName: "rolloverMarket",
            args: [
                row.address,
                nextQuestion,
                CATEGORY,
                nextCriteria,
                BigInt(nextDeadline),
            ],
            account: resolveAccount,
            chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: rolloverTx });

        row.question = nextQuestion;
        row.category = CATEGORY;
        row.deadline = BigInt(nextDeadline);
        row.resolutionCriteria = nextCriteria;
        row.resolved = false;
        row.tradeCount = 0n;
        console.log(
            `[keeper] rolled over empty ${meta.symbol} ${meta.timeframe} @ ${row.address} ` +
                `(seed retained, deadline=${nextDeadline}) tx=${rolloverTx}`,
        );
        return;
    }

    let close = 0;
    if (meta.source === "binance") {
        try {
            close = await fetchBinanceCandleClose(
                sym.binanceSymbol,
                meta.timeframe,
                Number(row.deadline),
            );
        } catch (err) {
            close = prices[meta.symbol] ?? 0;
            console.warn(
                `[keeper] binance close fetch failed for ${meta.symbol} ${meta.timeframe}; falling back to CoinGecko spot for resolution`,
                err,
            );
        }
    } else {
        close = prices[meta.symbol] ?? 0;
    }
    if (!Number.isFinite(close) || close <= 0) return;

    const outcome = close > start ? Outcome.Yes : Outcome.No;
    const tx = await walletClient.writeContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: "resolveMarket",
        args: [row.address, outcome],
        account: resolveAccount,
        chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    row.resolved = true;
    console.log(
        `[keeper] resolved ${meta.symbol} ${meta.timeframe} @ ${row.address} as ${
            outcome === Outcome.Yes ? "YES" : "NO"
        } (start=${start}, close=${close}) tx=${tx}`,
    );
}

async function resolveExpired(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    // Signs resolveMarket. On v2 this is the dedicated resolver key (the
    // factory role-separates settlement from funds); in --legacy-factory mode
    // it is the same admin key, since v1 resolution is admin-only.
    resolveAccount: Account,
    nowSec: number,
    prices: Record<string, number>,
    rows: MarketRow[],
) {
    // Fault-isolate per market: one market's failure (a stuck settlement, a
    // transient RPC error, resolver briefly out of gas) must NOT abort the
    // whole pass, or `createMissing` downstream never runs and the entire fast
    // set silently freezes while the process stays "up".
    for (const row of rows) {
        try {
            await settleExpiredMarket(publicClient, walletClient, resolveAccount, nowSec, prices, row);
        } catch (err) {
            console.warn(`[keeper] failed to settle ${row.address}; will retry next loop`, err);
        }
    }
}

async function createMissing(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    owner: Account,
    seedUsdc: bigint,
    residualSweepStateFile: string,
    residualSweepRecentLimit: number,
    residualSweepEmptyRecheckSeconds: number,
    residualSweepFullRescanSeconds: number,
    nowSec: number,
    prices: Record<string, number>,
    rows: MarketRow[],
    state: KeeperState,
): Promise<CreateMissingResult> {
    let created = 0;
    for (const sym of SYMBOLS) {
        for (const win of WINDOWS) {
            const windowStart = alignedWindowStart(nowSec, win.seconds);
            const deadline = windowStart + win.seconds;

            const hasActive = rows.some((row) => {
                if (row.resolved) return false;
                if (Number(row.deadline) <= nowSec) return false;
                const meta = parseAutoMeta(row.resolutionCriteria);
                return !!meta && meta.symbol === sym.symbol && meta.timeframe === win.label;
            });

            if (hasActive) continue;

            // Prefer Binance candle close for window alignment; if unavailable,
            // keep the keeper running with CoinGecko spot as the start price.
            let startClose = 0;
            let source: FastMeta["source"] = "binance";
            try {
                startClose = await fetchBinanceCandleClose(sym.binanceSymbol, win.label, windowStart);
            } catch (err) {
                startClose = prices[sym.symbol] ?? 0;
                source = "coingecko";
                console.warn(
                    `[keeper] binance candle fetch failed for ${sym.symbol} ${win.label}; using CoinGecko spot to seed market`,
                    err,
                );
            }

            if (!Number.isFinite(startClose) || startClose <= 0) {
                console.warn(
                    `[keeper] missing usable start price for ${sym.symbol} ${win.label}; skipping market creation this loop`,
                );
                continue;
            }

            const startPrice = startClose.toFixed(2);
            const meta: FastMeta = {
                version: 1,
                symbol: sym.symbol,
                timeframe: win.label,
                source,
                startPrice,
                startTs: windowStart,
            };

            const question = buildQuestion(sym.symbol, win.label, startPrice);
            const criteria = buildResolutionCriteria(meta);

            let usdcBalance = await readUsdcBalance(publicClient, owner);
            if (usdcBalance < seedUsdc) {
                console.warn(
                    `[keeper] insufficient USDC to create ${sym.symbol} ${win.label}; ` +
                        `balance=${formatUnits(usdcBalance, 6)} seed=${formatUnits(seedUsdc, 6)}. ` +
                        "Sweeping fast market residuals to deployer wallet.",
                );
                await sweepFastMarketResiduals(
                    publicClient,
                    walletClient,
                    owner,
                    residualSweepStateFile,
                    residualSweepRecentLimit,
                    residualSweepEmptyRecheckSeconds,
                    residualSweepFullRescanSeconds,
                );
                usdcBalance = await readUsdcBalance(publicClient, owner);
                if (usdcBalance < seedUsdc) {
                    console.warn(
                        `[keeper] still insufficient USDC after residual sweep; ` +
                            `balance=${formatUnits(usdcBalance, 6)} seed=${formatUnits(seedUsdc, 6)}. ` +
                            "Skipping remaining market creation this loop.",
                    );
                    return {
                        created,
                        completeLiveSet: hasCompleteLiveFastSet(rows, nowSec),
                    };
                }
            }

            const tx = await walletClient.writeContract({
                address: FACTORY,
                abi: factoryAbi,
                functionName: "createMarket",
                args: [question, CATEGORY, criteria, BigInt(deadline), seedUsdc],
                account: owner,
                chain: arcTestnet,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });
            const marketCount = (await publicClient.readContract({
                address: FACTORY,
                abi: factoryAbi,
                functionName: "marketCount",
            })) as bigint;
            const address = (await publicClient.readContract({
                address: FACTORY,
                abi: factoryAbi,
                functionName: "markets",
                args: [marketCount - 1n],
            })) as Address;
            const row: MarketRow = {
                address,
                question,
                category: CATEGORY,
                deadline: BigInt(deadline),
                resolved: false,
                tradeCount: 0n,
                resolutionCriteria: criteria,
            };
            rows.push(row);
            state.tracked.set(marketKey(address), row);
            state.marketCount = Math.max(state.marketCount, Number(marketCount));
            created += 1;
            console.log(
                `[keeper] created ${sym.symbol} ${win.label} market (deadline=${deadline}) tx=${tx}`,
            );
        }
    }

    return {
        created,
        completeLiveSet: hasCompleteLiveFastSet(rows, nowSec),
    };
}

async function main() {
    const privateKey = parsePrivateKey(env("DEPLOYER_PRIVATE_KEY"));
    const account = privateKeyToAccount(privateKey);
    const resolveAccount = LEGACY_MODE
        ? account
        : privateKeyToAccount(
              parsePrivateKey(process.env.RESOLVER_PRIVATE_KEY ?? env("DEPLOYER_PRIVATE_KEY")),
          );
    const rpcUrls = getRpcUrls();
    const pollSeconds = Number(process.env.FAST_MARKET_POLL_SECONDS ?? DEFAULT_POLL_SECONDS);
    const seedUsdc = toUsdc6(process.env.FAST_MARKET_SEED_USDC ?? DEFAULT_SEED_USDC);
    const residualSweepStateFile = resolveRepoPath(
        process.env.FAST_MARKET_RESIDUAL_SWEEP_STATE_FILE ?? DEFAULT_RESIDUAL_SWEEP_STATE_FILE,
    );
    const residualSweepRecentLimit = Math.floor(
        envNumber("FAST_MARKET_RESIDUAL_SWEEP_RECENT_LIMIT", DEFAULT_RESIDUAL_SWEEP_RECENT_LIMIT),
    );
    const residualSweepIntervalSeconds = envNumber(
        "FAST_MARKET_RESIDUAL_SWEEP_INTERVAL_SECONDS",
        DEFAULT_RESIDUAL_SWEEP_INTERVAL_SECONDS,
    );
    const residualSweepEmptyRecheckSeconds = envNumber(
        "FAST_MARKET_RESIDUAL_SWEEP_EMPTY_RECHECK_SECONDS",
        DEFAULT_RESIDUAL_SWEEP_EMPTY_RECHECK_SECONDS,
    );
    const residualSweepFullRescanSeconds = envNumber(
        "FAST_MARKET_RESIDUAL_SWEEP_FULL_RESCAN_SECONDS",
        DEFAULT_RESIDUAL_SWEEP_FULL_RESCAN_SECONDS,
    );
    const resolverMinGasWei = toGasWei(
        process.env.RESOLVER_MIN_GAS_USDC ?? DEFAULT_RESOLVER_MIN_GAS_USDC,
    );
    const resolverTopupWei = toGasWei(
        process.env.RESOLVER_TOPUP_USDC ?? DEFAULT_RESOLVER_TOPUP_USDC,
    );

    const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: fallback(rpcUrls.map((url) => http(url))),
    });

    const walletClient = createWalletClient({
        account,
        chain: arcTestnet,
        transport: fallback(rpcUrls.map((url) => http(url))),
    });

    console.log(
        `[keeper] started as ${account.address}${LEGACY_MODE ? " (LEGACY v1 sweep mode)" : ""} — resolver=${resolveAccount.address} factory=${FACTORY}`,
    );
    console.log(`[keeper] rpc fallbacks: ${rpcUrls.map((url) => new URL(url).origin).join(", ")}`);
    console.log(`[keeper] seed per market: ${formatUnits(seedUsdc, 6)} USDC`);
    console.log(`[keeper] polling every ${pollSeconds}s`);
    console.log(
        `[keeper] market read concurrency=${MARKET_READ_CONCURRENCY} batchDelayMs=${MARKET_READ_BATCH_DELAY_MS} initialScan=${INITIAL_FAST_MARKET_SCAN_LIMIT}`,
    );
    console.log(
        `[keeper] residual sweep cache=${residualSweepStateFile} recent=${residualSweepRecentLimit} ` +
            `interval=${residualSweepIntervalSeconds}s emptyRecheck=${residualSweepEmptyRecheckSeconds}s ` +
            `fullRescan=${residualSweepFullRescanSeconds}s`,
    );
    if (!LEGACY_MODE && resolveAccount.address.toLowerCase() !== account.address.toLowerCase()) {
        console.log(
            `[keeper] resolver auto-top-up: refill to ${formatUnits(resolverTopupWei, 18)} USDC ` +
                `when below ${formatUnits(resolverMinGasWei, 18)} USDC (env RESOLVER_MIN_GAS_USDC / RESOLVER_TOPUP_USDC)`,
        );
    }

    const state: KeeperState = {
        initialized: false,
        marketCount: 0,
        tracked: new Map(),
    };

    for (;;) {
        try {
            const nowSec = Math.floor(Date.now() / 1000);
            if (!LEGACY_MODE) {
                await ensureApproval(publicClient, walletClient, account, seedUsdc);
                await ensureResolverGas(
                    publicClient,
                    walletClient,
                    account,
                    resolveAccount,
                    resolverMinGasWei,
                    resolverTopupWei,
                );
            }
            const prices = await fetchUsdPrices(SYMBOLS);
            const rows = await syncTrackedFastMarkets(publicClient, state);
            await resolveExpired(publicClient, walletClient, resolveAccount, nowSec, prices, rows);
            for (const row of rows) {
                if (row.resolved) state.tracked.delete(marketKey(row.address));
            }
            const createResult = LEGACY_MODE
                ? { created: 0, completeLiveSet: true }
                : await createMissing(
                      publicClient,
                      walletClient,
                      account,
                      seedUsdc,
                      residualSweepStateFile,
                      residualSweepRecentLimit,
                      residualSweepEmptyRecheckSeconds,
                      residualSweepFullRescanSeconds,
                      nowSec,
                      prices,
                      rows,
                      state,
                  );
            if (createResult.completeLiveSet) {
                const due = await isResidualSweepDue(
                    residualSweepStateFile,
                    residualSweepIntervalSeconds,
                    nowSec,
                );
                if (due) {
                    console.log(
                        `[keeper] live fast set complete (${SYMBOLS.length * WINDOWS.length}/${
                            SYMBOLS.length * WINDOWS.length
                        }); running hourly residual sweep after ${createResult.created} created this loop`,
                    );
                    await sweepFastMarketResiduals(
                        publicClient,
                        walletClient,
                        account,
                        residualSweepStateFile,
                        residualSweepRecentLimit,
                        residualSweepEmptyRecheckSeconds,
                        residualSweepFullRescanSeconds,
                    );
                }
            } else {
                console.warn("[keeper] live fast set incomplete after creation pass; postponing hourly residual sweep");
            }
        } catch (err) {
            console.error("[keeper] loop error:", err);
        }

        await delay(Math.max(5, pollSeconds) * 1000);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
