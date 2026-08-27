/**
 * Wrap top-volume solo Polymarket binary markets into native YOLO markets on Arc.
 *
 * Run:
 *   npm run markets:poly:wrap -- --dry-run
 *   npm run markets:poly:wrap -- --limit 10 --seed-usdc 1
 *   npm run markets:poly:wrap -- --limit 300 --seed-usdc 1 --min-volume-24h 1000
 *   npm run markets:poly:wrap -- --limit 120 --seed-usdc 1
 */
import "./load-env";
import {
    createPublicClient,
    createWalletClient,
    fallback,
    formatUnits,
    http,
    parseUnits,
    type Account,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain } from "../lib/chain";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi } from "../lib/contracts";
import {
    buildPolymarketMirrorCriteria,
    type PolymarketMirrorMeta,
} from "../lib/polymarket-mirror";

const GAMMA_BASE =
    process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const MARKET_READ_BATCH_SIZE = 40;
const MARKET_READ_BATCH_DELAY_MS = 150;

type RawMarket = {
    id: string;
    conditionId?: string;
    question?: string;
    slug?: string;
    outcomePrices?: string;
    outcomes?: string;
    clobTokenIds?: string;
    volume?: string | number;
    volumeNum?: number;
    volume24hr?: number;
    groupItemTitle?: string;
    closed?: boolean;
    endDate?: string;
    umaEndDate?: string;
    resolutionSource?: string;
    description?: string;
    image?: string;
    icon?: string;
    active?: boolean;
    events?: { id?: string; slug?: string; title?: string; endDate?: string }[];
};
type RawEvent = {
    id: string;
    title?: string;
    slug?: string;
    endDate?: string;
};

type Candidate = {
    title: string;
    category: string;
    criteria: string;
    deadline: bigint;
    volume24h: number;
    slug: string;
    eventSlug: string;
};

function arg(name: string, fallback: string): string {
    const ix = process.argv.indexOf(`--${name}`);
    return ix >= 0 ? (process.argv[ix + 1] ?? fallback) : fallback;
}

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
}

function getRpcUrls(): string[] {
    const multi = process.env.BOTCHAIN_RPC_URLS?.split(",")
        .map((x) => x.trim())
        .filter(Boolean) ?? [];
    const one = process.env.BOTCHAIN_RPC_URL?.trim();
    const urls = [...multi, ...(one ? [one] : []), ...activeChain.rpcUrls.default.http];
    return [...new Set(urls)];
}

function parsePrivateKey(raw: string): `0x${string}` {
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be 32-byte hex");
    }
    return key as `0x${string}`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonArray(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((x) => String(x));
    } catch {
        return [];
    }
}

function classifyCategoryFromText(text: string): string {
    const lower = text.toLowerCase();
    const checks: [string, RegExp][] = [
        ["Crypto", /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|stablecoin|xrp|doge)\b/],
        ["Sports", /\b(fifa|world cup|nba|nfl|mlb|nhl|ufc|tennis|wta|atp|soccer|football|baseball|basketball)\b/],
        ["Geopolitics", /\b(iran|israel|china|taiwan|russia|ukraine|war|gaza|hormuz|nuclear deal|invasion)\b/],
        ["Politics", /\b(trump|biden|election|senate|congress|president|presidential|supreme court|white house)\b/],
        ["Tech", /\b(openai|chatgpt|gpt|ai|spacex|tesla|apple|nvidia|ipo)\b/],
        ["Macro", /\b(fed|inflation|cpi|rates?|recession|gdp|treasury|unemployment|market cap)\b/],
        ["Culture", /\b(movie|music|album|celebrity|award|oscars?|grammys?|box office)\b/],
        ["Science", /\b(space|climate|weather|temperature|medicine|health|earthquake)\b/],
    ];
    return checks.find(([, re]) => re.test(lower))?.[0] ?? "Other";
}

function deadlineFromMarket(
    m: RawMarket,
    e: RawEvent,
    nowSec: number,
    fallbackDurationDays: number,
    allowFallback: boolean,
): bigint | null {
    const rawDate = m.umaEndDate ?? m.endDate ?? e.endDate;
    if (rawDate) {
        const ts = Math.floor(new Date(rawDate).getTime() / 1000);
        if (Number.isFinite(ts) && ts > nowSec + 120) return BigInt(ts);
    }
    if (!allowFallback) return null;
    return BigInt(nowSec + fallbackDurationDays * 86_400);
}

function pickTokenIds(m: RawMarket): { yesTokenId: string | null; noTokenId: string | null } {
    const outcomes = parseJsonArray(m.outcomes).map((x) => x.toLowerCase());
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const yesIndex = outcomes.findIndex((x) => x === "yes");
    const noIndex = outcomes.findIndex((x) => x === "no");

    return {
        yesTokenId: yesIndex >= 0 ? (tokenIds[yesIndex] ?? null) : (tokenIds[0] ?? null),
        noTokenId: noIndex >= 0 ? (tokenIds[noIndex] ?? null) : (tokenIds[1] ?? null),
    };
}

function candidatesFromMarkets(
    markets: RawMarket[],
    existingQuestions: Set<string>,
    nowSec: number,
    fallbackDurationDays: number,
    allowFallbackDeadlines: boolean,
    minVolume24h: number,
    includeGroupChildren: boolean,
    maxPerEvent: number,
    maxPerCategory: number,
): Candidate[] {
    const out: Candidate[] = [];
    const seen = new Set<string>();

    for (const m of markets) {
        if (m.closed || m.active === false || !m.slug) continue;
        if (!includeGroupChildren && m.groupItemTitle) continue;

        const outcomes = parseJsonArray(m.outcomes).map((x) => x.toLowerCase());
        if (outcomes.length >= 2 && (!outcomes.includes("yes") || !outcomes.includes("no"))) {
            continue;
        }
        const volume24h = m.volume24hr ?? 0;
        if (volume24h < minVolume24h) continue;

        const title = (m.question?.trim() || m.groupItemTitle?.trim() || "Untitled").slice(0, 500);
        if (hasStaleImplicitDate(title, nowSec)) continue;
        const key = title.toLowerCase();
        const sourceKey = m.conditionId ?? m.slug;
        if (seen.has(sourceKey) || existingQuestions.has(key)) continue;

        const parent = m.events?.[0];
        const eventShell: RawEvent = {
            id: parent?.id ?? m.id,
            title: parent?.title ?? title,
            slug: parent?.slug,
            endDate: parent?.endDate,
        };
        const deadline = deadlineFromMarket(
            m,
            eventShell,
            nowSec,
            fallbackDurationDays,
            allowFallbackDeadlines,
        );
        if (deadline === null) continue;
        seen.add(sourceKey);

        const tokens = pickTokenIds(m);
        const meta: PolymarketMirrorMeta = {
            version: 1,
            polymarketSlug: m.slug,
            eventSlug: parent?.slug ?? null,
            conditionId: m.conditionId ?? null,
            yesTokenId: tokens.yesTokenId,
            noTokenId: tokens.noTokenId,
            resolutionSource: m.resolutionSource ?? null,
            endDate: m.endDate ?? parent?.endDate ?? null,
            umaEndDate: m.umaEndDate ?? null,
        };

        out.push({
            title,
            category: classifyCategoryFromText(`${title} ${parent?.title ?? ""}`),
            criteria: buildPolymarketMirrorCriteria(meta, m.description ?? null),
            deadline,
            volume24h,
            slug: m.slug,
            // Group children (e.g. every "X wins the Ballon d'Or", every
            // "LeBron plays for team Y") share one parent event slug; solo
            // markets fall back to their own slug so they are never capped.
            eventSlug: parent?.slug ?? m.slug,
        });
    }

    out.sort((a, b) => b.volume24h - a.volume24h);

    // Cap how many markets any single Polymarket event (and, separately, any
    // one category) contributes so a few huge multi-outcome events (sports
    // rosters, award nominees, price ladders) or one hot topic (e.g. Iran
    // date-variants) can't crowd out variety. Applied after the volume sort so
    // we keep the highest-volume representatives of each event/category.
    if (maxPerEvent > 0 || maxPerCategory > 0) {
        const perEvent = new Map<string, number>();
        const perCategory = new Map<string, number>();
        const capped: Candidate[] = [];
        for (const c of out) {
            if (maxPerEvent > 0 && (perEvent.get(c.eventSlug) ?? 0) >= maxPerEvent) continue;
            if (maxPerCategory > 0 && (perCategory.get(c.category) ?? 0) >= maxPerCategory) continue;
            perEvent.set(c.eventSlug, (perEvent.get(c.eventSlug) ?? 0) + 1);
            perCategory.set(c.category, (perCategory.get(c.category) ?? 0) + 1);
            capped.push(c);
        }
        return capped;
    }
    return out;
}

function hasStaleImplicitDate(title: string, nowSec: number): boolean {
    const months: Record<string, number> = {
        january: 0,
        jan: 0,
        february: 1,
        feb: 1,
        march: 2,
        mar: 2,
        april: 3,
        apr: 3,
        may: 4,
        june: 5,
        jun: 5,
        july: 6,
        jul: 6,
        august: 7,
        aug: 7,
        september: 8,
        sep: 8,
        october: 9,
        oct: 9,
        november: 10,
        nov: 10,
        december: 11,
        dec: 11,
    };
    const lower = title.toLowerCase();
    if (/\b20\d{2}\b/.test(lower)) return false;

    const match = lower.match(
        /\b(?:by|before|on|through)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/,
    );
    if (!match) return false;

    const now = new Date(nowSec * 1000);
    const month = months[match[1]];
    const day = Number(match[2]);
    if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
        return false;
    }

    const impliedDeadline = Date.UTC(now.getUTCFullYear(), month, day, 23, 59, 59);
    return impliedDeadline < now.getTime();
}

async function fetchGammaMarkets(scanLimit: number): Promise<RawMarket[]> {
    const out: RawMarket[] = [];
    for (let offset = 0; out.length < scanLimit; offset += 100) {
        const params = new URLSearchParams({
            active: "true",
            closed: "false",
            limit: "100",
            offset: String(offset),
            order: "volume24hr",
            ascending: "false",
        });
        const res = await fetch(`${GAMMA_BASE}/markets?${params}`, {
            headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`Gamma markets fetch failed: ${res.status}`);
        const page = (await res.json()) as RawMarket[];
        if (page.length === 0) break;
        out.push(...page);
        if (page.length < 100) break;
    }
    return out.slice(0, scanLimit);
}

async function readExistingQuestions(
    publicClient: ReturnType<typeof createPublicClient>,
): Promise<Set<string>> {
    // Dedupe against BOTH factories: live v1 markets still show in the
    // catalog post-migration, so re-wrapping their questions on v2 would
    // list duplicates side by side.
    const addrs: Address[] = [];
    for (const factory of [ADDRESSES.factory, ADDRESSES.factoryLegacy]) {
        if (!factory || factory === "0x0000000000000000000000000000000000000000") continue;
        addrs.push(
            ...((await publicClient.readContract({
                address: factory,
                abi: factoryAbi,
                functionName: "allMarkets",
            })) as Address[]),
        );
    }

    const questions: string[] = [];
    for (let i = 0; i < addrs.length; i += MARKET_READ_BATCH_SIZE) {
        const batch = addrs.slice(i, i + MARKET_READ_BATCH_SIZE);
        if (activeChain.contracts?.multicall3) {
            const rows = await publicClient.multicall({
                allowFailure: true,
                contracts: batch.map((address) => ({
                    address,
                    abi: marketAbi,
                    functionName: "question",
                })),
            });
            for (const row of rows) {
                if (row.status === "success" && typeof row.result === "string") {
                    questions.push(row.result);
                }
            }
        } else {
            const rows = await Promise.allSettled(
                batch.map((address) =>
                    publicClient.readContract({ address, abi: marketAbi, functionName: "question" }),
                ),
            );
            for (const row of rows) {
                if (row.status === "fulfilled" && typeof row.value === "string") {
                    questions.push(row.value);
                }
            }
        }
        if (i + MARKET_READ_BATCH_SIZE < addrs.length) {
            await delay(MARKET_READ_BATCH_DELAY_MS);
        }
    }
    return new Set(questions.map((q) => q.trim().toLowerCase()));
}

async function ensureApproval(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: Account,
    minRequired: bigint,
) {
    const allowance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, ADDRESSES.factory],
    })) as bigint;
    if (allowance >= minRequired) return;

    const tx = await walletClient.writeContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDRESSES.factory, (1n << 256n) - 1n],
        account,
        chain: activeChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[poly-wrap] approved factory tx=${tx}`);
}

async function main() {
    const limit = Number(arg("limit", process.env.POLYMARKET_WRAP_LIMIT ?? "10"));
    const seedUsdc = parseUnits(arg("seed-usdc", process.env.POLYMARKET_WRAP_SEED_USDC ?? "1"), 6);
    const minVolume24h = Number(arg("min-volume-24h", process.env.POLYMARKET_WRAP_MIN_VOLUME_24H ?? "0"));
    const scanLimit = Number(arg("scan-limit", process.env.POLYMARKET_WRAP_SCAN_LIMIT ?? "500"));
    const fallbackDurationDays = Number(arg("fallback-duration-days", "30"));
    const allowFallbackDeadlines = flag("allow-fallback-deadlines");
    const includeGroupChildren = !flag("solo-only");
    const maxPerEvent = Number(arg("max-per-event", process.env.POLYMARKET_WRAP_MAX_PER_EVENT ?? "0"));
    const maxPerCategory = Number(arg("max-per-category", process.env.POLYMARKET_WRAP_MAX_PER_CATEGORY ?? "0"));
    const dryRun = flag("dry-run");
    const account = privateKeyToAccount(parsePrivateKey(env("DEPLOYER_PRIVATE_KEY")));
    const rpcUrls = getRpcUrls();
    const nowSec = Math.floor(Date.now() / 1000);

    const publicClient = createPublicClient({
        chain: activeChain,
        transport: fallback(rpcUrls.map((url) => http(url))),
    });
    const walletClient = createWalletClient({
        account,
        chain: activeChain,
        transport: fallback(rpcUrls.map((url) => http(url))),
    });

    console.log(`[poly-wrap] account=${account.address}`);
    console.log(`[poly-wrap] limit=${limit} scanLimit=${scanLimit} seed=${formatUnits(seedUsdc, 6)} minVolume24h=${minVolume24h} includeGroupChildren=${includeGroupChildren} maxPerEvent=${maxPerEvent} maxPerCategory=${maxPerCategory} dryRun=${dryRun}`);

    const [markets, existing] = await Promise.all([
        fetchGammaMarkets(scanLimit),
        readExistingQuestions(publicClient),
    ]);
    const plan = candidatesFromMarkets(
        markets,
        existing,
        nowSec,
        fallbackDurationDays,
        allowFallbackDeadlines,
        minVolume24h,
        includeGroupChildren,
        maxPerEvent,
        maxPerCategory,
    ).slice(0, limit);

    console.log(`[poly-wrap] plan=${plan.length}`);
    for (const [i, item] of plan.entries()) {
        console.log(
            `[${String(i + 1).padStart(2, "0")}] ${item.category.padEnd(12)} ${item.slug} deadline=${item.deadline} ${item.title}`,
        );
    }
    if (dryRun || plan.length === 0) return;

    const balance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
    })) as bigint;
    const needed = seedUsdc * BigInt(plan.length);
    if (balance < needed) {
        throw new Error(
            `Insufficient USDC: need ${formatUnits(needed, 6)}, have ${formatUnits(balance, 6)}`,
        );
    }

    await ensureApproval(publicClient, walletClient, account, seedUsdc * BigInt(plan.length));

    for (const [i, item] of plan.entries()) {
        const tx = await walletClient.writeContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "createMarket",
            args: [item.title, item.category, item.criteria, item.deadline, seedUsdc],
            account,
            chain: activeChain,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log(`[poly-wrap] created ${i + 1}/${plan.length} tx=${tx} ${item.slug}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
