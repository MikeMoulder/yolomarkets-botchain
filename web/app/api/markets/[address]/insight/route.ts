import { NextResponse } from "next/server";
import {
    type Address,
    isAddress,
    parseUnits,
    type Hash,
} from "viem";
import { estimate, isEstimateProviderConfigured } from "@/lib/llm";
import { getMarket, publicClient } from "@/lib/markets";
import { ADDRESSES } from "@/lib/contracts";
import { priceToProb } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INSIGHT_FEE_USDT = process.env.AI_INSIGHT_FEE_USDT?.trim() || "0.2";
const INSIGHT_FEE_MICRO = parseUnits(INSIGHT_FEE_USDT, 6);
const ERC20_TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const AUTO_FAST_PREFIX = "AUTO_FAST:";

type AutoFastMeta = {
    version: number;
    symbol: "BTC" | "ETH" | "SOL";
    timeframe: "15m" | "1h";
    source: "coingecko" | "binance";
    startPrice: string;
    startTs: number;
};

const FAST_ASSETS: Record<
    AutoFastMeta["symbol"],
    { binanceSymbol: string; coingeckoId: string }
> = {
    BTC: { binanceSymbol: "BTCUSDT", coingeckoId: "bitcoin" },
    ETH: { binanceSymbol: "ETHUSDT", coingeckoId: "ethereum" },
    SOL: { binanceSymbol: "SOLUSDT", coingeckoId: "solana" },
};

function parseTransferCalldata(rawInput: `0x${string}`): {
    to: Address;
    value: bigint;
} | null {
    const input = rawInput.toLowerCase() as `0x${string}`;
    if (!input.startsWith(ERC20_TRANSFER_SELECTOR)) return null;
    // 4-byte selector + 32-byte to + 32-byte value = 138 chars including 0x
    if (input.length < 138) return null;

    const toWord = input.slice(10, 74);
    const valueWord = input.slice(74, 138);
    if (toWord.length !== 64 || valueWord.length !== 64) return null;

    const to = `0x${toWord.slice(24)}` as Address;
    let value: bigint;
    try {
        value = BigInt(`0x${valueWord}`);
    } catch {
        return null;
    }

    return { to, value };
}

function parseAutoFastMeta(criteria: string): AutoFastMeta | null {
    const first = criteria.split("\n")[0]?.trim() ?? "";
    if (!first.startsWith(AUTO_FAST_PREFIX)) return null;

    try {
        const parsed = JSON.parse(first.slice(AUTO_FAST_PREFIX.length)) as AutoFastMeta;
        if (
            parsed.version === 1 &&
            (parsed.symbol === "BTC" || parsed.symbol === "ETH" || parsed.symbol === "SOL") &&
            (parsed.timeframe === "15m" || parsed.timeframe === "1h") &&
            (parsed.source === "coingecko" || parsed.source === "binance") &&
            typeof parsed.startPrice === "string" &&
            typeof parsed.startTs === "number"
        ) {
            return parsed;
        }
    } catch {
        return null;
    }

    return null;
}

async function buildMarketContext(args: {
    resolutionCriteria: string;
    deadline: bigint;
}): Promise<string | undefined> {
    const meta = parseAutoFastMeta(args.resolutionCriteria);
    if (!meta) return undefined;

    const asset = FAST_ASSETS[meta.symbol];
    const nowSec = Math.floor(Date.now() / 1000);
    const deadlineSec = Number(args.deadline);
    const windowSec = meta.timeframe === "15m" ? 15 * 60 : 60 * 60;
    const startPrice = Number(meta.startPrice);

    const [spot, closes] = await Promise.all([
        fetchSpotPrice(asset).catch(() => null),
        fetchRecentBinanceCloses(asset.binanceSymbol, meta.timeframe).catch(() => []),
    ]);

    const lines = [
        `Fast crypto market detected at ${new Date().toISOString()}.`,
        `Instrument: ${meta.symbol}/USD; window: ${meta.timeframe}; resolution source declared by market: ${meta.source}.`,
        `Start price: $${meta.startPrice} at ${new Date(meta.startTs * 1000).toISOString()}.`,
        `Resolution rule: YES iff the close at deadline is strictly above the start price.`,
        `Deadline: ${new Date(deadlineSec * 1000).toISOString()}; time remaining: ${Math.max(0, deadlineSec - nowSec)} seconds of about ${windowSec} seconds.`,
    ];

    if (spot && Number.isFinite(startPrice) && startPrice > 0) {
        const diff = spot - startPrice;
        lines.push(
            `Current spot: $${spot.toFixed(4)} (${formatSigned(diff)} USD, ${formatSignedPct(diff / startPrice)} vs start).`,
        );
    } else {
        lines.push("Current spot: unavailable from Binance/CoinGecko during this request.");
    }

    if (closes.length > 0) {
        const momentum = [
            formatMomentum("1m", closes, spot, 1),
            formatMomentum("5m", closes, spot, 5),
            formatMomentum("15m", closes, spot, 15),
        ].filter(Boolean);
        if (momentum.length > 0) {
            lines.push(`Recent momentum: ${momentum.join("; ")}.`);
        }
    }

    return lines.join("\n");
}

async function fetchSpotPrice(asset: { binanceSymbol: string; coingeckoId: string }): Promise<number> {
    try {
        const res = await fetch(
            `https://api.binance.com/api/v3/ticker/price?symbol=${asset.binanceSymbol}`,
            { cache: "no-store", headers: { accept: "application/json" } },
        );
        if (res.ok) {
            const json = (await res.json()) as { price?: string };
            const price = Number(json.price);
            if (Number.isFinite(price) && price > 0) return price;
        }
    } catch {
        // Fall through to CoinGecko.
    }

    const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${asset.coingeckoId}&vs_currencies=usd`,
        { cache: "no-store", headers: { accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`CoinGecko price error: ${res.status}`);
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const price = json[asset.coingeckoId]?.usd;
    if (!Number.isFinite(price) || !price || price <= 0) {
        throw new Error(`missing price for ${asset.coingeckoId}`);
    }
    return price;
}

async function fetchRecentBinanceCloses(
    symbol: string,
    timeframe: AutoFastMeta["timeframe"],
): Promise<number[]> {
    const limit = timeframe === "15m" ? 20 : 70;
    const res = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`,
        { cache: "no-store", headers: { accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Binance kline error: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows
        .map((row) => (Array.isArray(row) ? Number(row[4]) : Number.NaN))
        .filter((close) => Number.isFinite(close) && close > 0);
}

function formatMomentum(
    label: string,
    closes: number[],
    currentSpot: number | null,
    lookback: number,
): string | null {
    const current = currentSpot ?? closes.at(-1);
    const previous = closes.length > lookback ? closes[closes.length - 1 - lookback] : undefined;
    if (!current || !previous) return null;
    return `${label} ${formatSignedPct((current - previous) / previous)}`;
}

function formatSigned(value: number): string {
    return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
}

function formatSignedPct(value: number): string {
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(3)}%`;
}

type Body = {
    txHash?: string;
};

export async function POST(
    req: Request,
    context: { params: Promise<{ address: string }> },
) {
    const { address } = await context.params;
    if (!isAddress(address)) {
        return NextResponse.json({ error: "invalid market address" }, { status: 400 });
    }

    // Do this before inspecting or accepting a payment. A configured fee
    // recipient must never make an unavailable AI provider look billable.
    if (!isEstimateProviderConfigured()) {
        return NextResponse.json(
            { error: "AI provider not configured; set OPENROUTER_API_KEY or GEMINI_API_KEY" },
            { status: 503, headers: { "cache-control": "no-store" } },
        );
    }

    const recipientRaw =
        process.env.AI_INSIGHT_FEE_RECIPIENT ??
        process.env.NEXT_PUBLIC_AI_INSIGHT_FEE_RECIPIENT;
    if (!recipientRaw || !isAddress(recipientRaw)) {
        return NextResponse.json(
            { error: "insight fee recipient not configured" },
            { status: 500 },
        );
    }
    const recipient = recipientRaw.toLowerCase() as Address;

    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }

    const txHash = body.txHash as Hash | undefined;
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return NextResponse.json({ error: "invalid tx hash" }, { status: 400 });
    }

    let receipt;
    try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
        return NextResponse.json(
            { error: "payment receipt not found yet; retry in a moment" },
            { status: 409 },
        );
    }

    if (receipt.status !== "success") {
        return NextResponse.json({ error: "payment transaction not successful" }, { status: 400 });
    }

    const hasValidPaymentByLog = receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== ADDRESSES.usdc.toLowerCase()) return false;
        if (!log.topics?.[0] || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) {
            return false;
        }
        const fromTopic = log.topics[1];
        const toTopic = log.topics[2];
        if (!fromTopic || !toTopic || !log.data || log.data === "0x") return false;

        const eventTo = (`0x${toTopic.slice(-40)}`).toLowerCase();
        let value: bigint;
        try {
            value = BigInt(log.data);
        } catch {
            return false;
        }

        return eventTo === recipient && value >= INSIGHT_FEE_MICRO;
    });

    let hasValidPaymentByCalldata = false;
    try {
        const tx = await publicClient.getTransaction({ hash: txHash });
        const txTo = tx.to?.toLowerCase();
        if (txTo === ADDRESSES.usdc.toLowerCase()) {
            const parsed = parseTransferCalldata(tx.input);
            hasValidPaymentByCalldata =
                !!parsed &&
                parsed.to.toLowerCase() === recipient &&
                parsed.value >= INSIGHT_FEE_MICRO;
        }
    } catch {
        // Keep flow resilient; log-based verification is already primary.
    }

    const hasValidPayment = hasValidPaymentByLog || hasValidPaymentByCalldata;

    if (!hasValidPayment) {
        return NextResponse.json(
            { error: `missing ${INSIGHT_FEE_USDT} USDT payment transfer in tx` },
            { status: 402 },
        );
    }

    const market = await getMarket(address as Address);
    if (!market) {
        return NextResponse.json({ error: "market not found" }, { status: 404 });
    }

    const marketContext = await buildMarketContext({
        resolutionCriteria: market.resolutionCriteria,
        deadline: market.deadline,
    });

    const aiEstimate = await estimate({
        question: market.question,
        criteria: market.resolutionCriteria,
        deadline: new Date(Number(market.deadline) * 1000).toUTCString(),
        marketProb: priceToProb(market.priceYes),
        context: marketContext,
    });

    if (!aiEstimate) {
        return NextResponse.json({ error: "estimate unavailable" }, { status: 503 });
    }

    return NextResponse.json({ ok: true, estimate: aiEstimate });
}
