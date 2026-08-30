import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { isAddress, type Address } from "viem";
import { getMarket, getMarketRevenue } from "@/lib/markets";
import { ADDRESSES } from "@/lib/contracts";
import { BetTicket } from "@/components/bet-ticket";
import { PaidEstimatePanel } from "@/components/paid-estimate-panel";
import { lookupNativeImage } from "@/lib/native-image-overlay";
import { adminImageFor, getAdminImageVersionsSafe, type ImageVersionMap } from "@/lib/market-images";
import { withDeadline, SSR_DEADLINE_MS, SSR_CRITICAL_DEADLINE_MS } from "@/lib/with-deadline";
import { ShareButton } from "@/components/share-button";
import { getFastMarketImage, matchesFastMarket } from "@/lib/fast-markets";
import { sanitizeReferenceCopy } from "@/lib/reference-copy";
import {
    parsePolymarketMirrorMeta,
    stripPolymarketMirrorMeta,
} from "@/lib/polymarket-mirror";
import {
    formatAbs,
    formatCents,
    formatOutcomeLabel,
    formatProb,
    formatTimeUntil,
    formatUsdc,
    priceToProb,
    shortAddr,
} from "@/lib/format";

export const revalidate = 15;

/** Per-market link preview: the question becomes the title, so a pasted market
 *  URL unfurls as the market itself rather than the generic site card. The
 *  image comes from the sibling opengraph-image.tsx automatically. */
export async function generateMetadata({
    params,
}: {
    params: Promise<{ address: string }>;
}): Promise<Metadata> {
    const { address } = await params;
    if (!isAddress(address)) return { title: "Market" };
    const m = await withDeadline(getMarket(address as Address), SSR_DEADLINE_MS, "metadata:getMarket", null);
    if (!m) return { title: "Market" };

    const prob = formatProb(priceToProb(m.priceYes));
    const description = `${prob} YES · ${m.category} · closes ${formatAbs(m.deadline)} — trade it on BOT Chain with USDT.`;
    return {
        title: m.question,
        description,
        openGraph: { title: m.question, description, type: "article" },
        twitter: { card: "summary_large_image", title: m.question, description },
    };
}

export default async function MarketPage({
    params,
}: {
    params: Promise<{ address: string }>;
}) {
    const { address } = await params;
    if (!isAddress(address)) notFound();

    // Deadlined: a stalled chain/DB read must degrade, never hang the render.
    // `m` is load-bearing (no market → 404), but revenue is admin trim, so a
    // slow revenue read just renders without it.
    const [m, revenue] = await Promise.all([
        withDeadline(getMarket(address as Address), SSR_CRITICAL_DEADLINE_MS, "getMarket", null),
        withDeadline(getMarketRevenue(address as Address), SSR_DEADLINE_MS, "getMarketRevenue", null),
    ]);
    if (!m) notFound();

    const marketProb = priceToProb(m.priceYes);
    // Same precedence as the catalog cards: admin-set cover art wins, then the
    // fast-market token logo, then the fuzzy Polymarket overlay.
    const adminImage = adminImageFor(
        await withDeadline(getAdminImageVersionsSafe(), SSR_DEADLINE_MS, "adminImages", new Map() as ImageVersionMap),
        m.address,
    );
    const fastImage = matchesFastMarket(m) ? getFastMarketImage(m.question) : null;
    const image =
        adminImage ??
        fastImage ??
        (await withDeadline(lookupNativeImage(m.question), SSR_DEADLINE_MS, "imageOverlay", null));

    return (
        <div className="mx-auto max-w-[1280px] px-6 py-8 md:py-10">
            {/* Crumb */}
            <Link
                href="/"
                className="text-[12px] text-text-mute hover:text-text-dim transition-colors"
            >
                ← markets
            </Link>

            {/* Meta line */}
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.18em] text-text-mute">
                <span>{m.category}</span>
                <span className="text-text-faint">·</span>
                <span>
                    closes <span className="num text-text-dim normal-case tracking-normal">{formatAbs(m.deadline)}</span>
                </span>
                <span className="text-text-faint">·</span>
                <span>
                    in <span className="num text-text-dim normal-case tracking-normal">{formatTimeUntil(m.deadline)}</span>
                </span>
                <span className="text-text-faint">·</span>
                <a
                    href={`https://scan.bohr.life/address/${m.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="num normal-case tracking-normal text-text-dim hover:text-text transition-colors"
                >
                    {shortAddr(m.address, 6)}
                </a>
                <div className="ml-auto normal-case tracking-normal">
                    <ShareButton address={m.address} question={m.question} />
                </div>
            </div>

            {/* Question + (optional) hero image */}
            <div className="mt-4 grid grid-cols-1 md:grid-cols-[112px_1fr] gap-5 items-start">
                {image && (
                    <div className="glass-shine-periodic glass-market-icon relative w-[112px] h-[112px] shrink-0 bg-bg-elev-2 border rounded-lg overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={image}
                            alt=""
                            loading="eager"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            className="absolute inset-0 w-full h-full object-cover"
                        />
                    </div>
                )}
                <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium max-w-[44ch]">
                    {m.question}
                </h1>
            </div>

            {/* Big prices */}
            <div className="mt-8 grid grid-cols-2 gap-4 max-w-[360px]">
                <PriceCard label="YES" value={formatCents(marketProb)} accent="yes" />
                <PriceCard label="NO" value={formatCents(1 - marketProb)} accent="no" />
            </div>

            {m.resolved && (
                <div className="mt-6 inline-flex items-center gap-3 border border-border bg-bg-elev px-3 py-2 text-[12px]">
                    <span className="text-text-mute uppercase tracking-[0.15em]">
                        resolved
                    </span>
                    <span
                        className={
                            m.outcome === 1
                                ? "text-yes font-medium"
                                : m.outcome === 2
                                  ? "text-no font-medium"
                                  : "text-text-dim"
                        }
                    >
                        {formatOutcomeLabel(m.outcome)}
                    </span>
                </div>
            )}

            {/* Main grid: AI panel + bet ticket */}
            <div className="mt-10 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
                <div className="space-y-6">
                    <PaidEstimatePanel marketAddress={m.address} marketProb={marketProb} />

                    {/* Resolution criteria */}
                    <section className="border border-border bg-bg-elev/40">
                        <div className="border-b border-border px-5 py-2.5">
                            <h3 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                                / resolution criteria
                            </h3>
                        </div>
                        <div className="px-5 py-4 text-[13px] text-text-dim leading-relaxed">
                            {renderResolutionCriteria(m.resolutionCriteria) || (
                                <span className="text-text-faint italic">(none provided)</span>
                            )}
                        </div>
                    </section>

                    {/* Market details */}
                    <section className="border border-border bg-bg-elev/40">
                        <div className="border-b border-border px-5 py-2.5">
                            <h3 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                                / market details
                            </h3>
                        </div>
                        <dl className="px-5 py-4 grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
                            <Detail
                                k="contract"
                                v={
                                    <a
                                        href={`https://scan.bohr.life/address/${m.address}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="hover:text-text"
                                    >
                                        {m.address}
                                    </a>
                                }
                            />
                            <Detail
                                k="settlement"
                                v={
                                    <a
                                        href={`https://scan.bohr.life/address/${ADDRESSES.usdc}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="hover:text-text"
                                    >
                                        {shortAddr(ADDRESSES.usdc, 6)}
                                    </a>
                                }
                            />
                            <Detail k="liquidity" v={`$${formatUsdc(m.totalLiquidity)} USDT`} />
                            {revenue && (
                                <Detail
                                    k="protocol fee"
                                    v={`${(revenue.protocolFeeBps / 100).toFixed(2)}% per trade`}
                                />
                            )}
                            <Detail
                                k="open interest"
                                v={`${formatUsdc(m.totalSharesYes)} YES · ${formatUsdc(m.totalSharesNo)} NO`}
                            />
                        </dl>
                    </section>
                </div>

                <div>
                    <BetTicket
                        market={m.address}
                        initialPriceYes={m.priceYes}
                        deadline={m.deadline}
                        resolved={m.resolved}
                        legacy={m.legacy}
                    />
                </div>
            </div>
        </div>
    );
}

function PriceCard({
    label,
    value,
    accent,
}: {
    label: string;
    value: string;
    accent: "yes" | "no";
}) {
    const color = accent === "yes" ? "text-yes" : "text-no";
    return (
        <div className="border border-border bg-bg-elev/40 px-5 py-4">
            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute mb-1">
                {label}
            </div>
            <div className={`num text-[36px] leading-none tabular ${color}`}>{value}</div>
        </div>
    );
}

function Detail({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <>
            <dt className="text-[10px] uppercase tracking-[0.18em] text-text-mute">{k}</dt>
            <dd className="num text-text-dim tabular text-[12.5px] break-all">{v}</dd>
        </>
    );
}

type AutoFastMeta = {
    version: number;
    symbol: string;
    timeframe: string;
    source: string;
    startPrice: string;
    startTs: number;
};

function renderResolutionCriteria(criteria: string): React.ReactNode {
    if (!criteria) return null;

    const trimmed = criteria.trim();
    const mirror = parsePolymarketMirrorMeta(trimmed);
    if (mirror) {
        const cleaned = stripPolymarketMirrorMeta(trimmed);
        const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
        const descLine = lines.find(
            (l) =>
                l.startsWith("Reference criteria excerpt: ") ||
                l.startsWith("Polymarket criteria excerpt: "),
        );
        const description = descLine
            ? descLine
                .replace("Reference criteria excerpt: ", "")
                .replace("Polymarket criteria excerpt: ", "")
                .trim()
            : lines.filter(
                (l) =>
                    !l.startsWith("Resolves YES iff the exact underlying") &&
                    !l.startsWith("Resolves NO iff that Polymarket") &&
                    !l.startsWith("If Polymarket resolution"),
              ).join(" ").trim() || null;

        return (
            <div className="space-y-3">
                {description ? (
                    <p>{sanitizeReferenceCopy(description)}</p>
                ) : (
                    <span className="text-text-faint italic">(no criteria provided)</span>
                )}
            </div>
        );
    }

    const parsedFast = parseAutoFastMeta(trimmed);
    if (!parsedFast) {
        return <div className="whitespace-pre-wrap">{sanitizeReferenceCopy(trimmed)}</div>;
    }

    const remaining = trimmed.replace(/^AUTO_FAST:\{[\s\S]*?\}\s*/m, "").trim();
    const bullets = remaining
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

    return (
        <div className="space-y-3">
            <p>
                Auto-resolved fast market for <span className="num text-text">{parsedFast.symbol}</span>
                {" "}on a <span className="num text-text">{parsedFast.timeframe}</span> window.
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
                <dt className="text-text-mute">Start price</dt>
                <dd className="num text-text">${parsedFast.startPrice}</dd>
                <dt className="text-text-mute">Start time</dt>
                <dd className="num text-text">{formatAbs(parsedFast.startTs)}</dd>
                <dt className="text-text-mute">Price source</dt>
                <dd className="num text-text">{sanitizeReferenceCopy(parsedFast.source)}</dd>
            </dl>
            {bullets.length > 0 && (
                <ul className="list-disc pl-5 space-y-1">
                    {bullets.map((line) => (
                        <li key={line}>{sanitizeReferenceCopy(line)}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function parseAutoFastMeta(criteria: string): AutoFastMeta | null {
    const m = criteria.match(/^AUTO_FAST:(\{[\s\S]*?\})/m);
    if (!m) return null;
    try {
        const meta = JSON.parse(m[1]) as AutoFastMeta;
        if (
            typeof meta.version === "number" &&
            typeof meta.symbol === "string" &&
            typeof meta.timeframe === "string" &&
            typeof meta.source === "string" &&
            typeof meta.startPrice === "string" &&
            typeof meta.startTs === "number"
        ) {
            return meta;
        }
        return null;
    } catch {
        return null;
    }
}
