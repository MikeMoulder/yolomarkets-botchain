import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchPolymarketEventBySlug } from "@/lib/polymarket";
import {
    formatCents,
    formatCompactUsd,
    formatTimeUntil,
    formatAbs,
} from "@/lib/format";
import { sanitizeReferenceCopy } from "@/lib/reference-copy";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }) {
    const { slug } = await params;
    const e = await fetchPolymarketEventBySlug(slug);
    return {
        title: e?.title ?? "Market",
    };
}

export default async function PolymarketDetailPage({
    params,
}: {
    params: Params;
}) {
    const { slug } = await params;
    const e = await fetchPolymarketEventBySlug(slug);
    if (!e) notFound();

    const ends = e.endTs ? formatTimeUntil(e.endTs) : null;
    const endsAbs = e.endTs ? formatAbs(e.endTs) : null;

    return (
        <div className="mx-auto max-w-[1200px] px-6 py-6">
            <div className="mb-4">
                <Link
                    href="/"
                    className="text-[11px] uppercase tracking-[0.2em] text-text-mute hover:text-text num"
                >
                    ← / markets
                </Link>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 mb-8">
                {/* Image + meta sidebar */}
                <aside className="flex flex-col gap-4">
                    <div className="relative aspect-square bg-bg-elev border border-border overflow-hidden">
                        {e.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={e.image}
                                alt=""
                                loading="eager"
                                decoding="async"
                                referrerPolicy="no-referrer"
                                className="absolute inset-0 w-full h-full object-cover"
                            />
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-text-faint num text-[11px]">
                                no image
                            </div>
                        )}
                    </div>

                    <div className="flex flex-col gap-2 text-[11px] num">
                        <Meta k="category" v={e.category} />
                        <Meta k="source" v="Reference catalog" />
                        {ends && <Meta k="ends in" v={ends} />}
                        {endsAbs && <Meta k="resolves" v={endsAbs} />}
                        <Meta k="24h vol" v={formatCompactUsd(e.volume24h)} />
                        <Meta k="total vol" v={formatCompactUsd(e.volumeTotal)} />
                        {e.liquidity > 0 && (
                            <Meta k="liquidity" v={formatCompactUsd(e.liquidity)} />
                        )}
                    </div>

                    {e.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            {e.tags.slice(0, 8).map((t) => (
                                <span
                                    key={t}
                                    className="num text-[10px] uppercase tracking-[0.14em] text-text-mute bg-bg-elev border border-border px-2 py-0.5"
                                >
                                    {t}
                                </span>
                            ))}
                        </div>
                    )}
                </aside>

                {/* Main */}
                <main className="flex flex-col gap-6 min-w-0">
                    <header className="flex flex-col gap-3">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                            / event · {e.category.toLowerCase()}
                        </div>
                        <h1 className="text-[28px] md:text-[34px] leading-[1.12] tracking-tight font-medium">
                            {e.title}
                        </h1>
                    </header>

                    {/* Outcomes */}
                    <section className="border border-border bg-bg-elev">
                        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                            <span className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                                / {e.isBinary ? "outcome" : `options · ${e.outcomes.length}`}
                            </span>
                            <span className="text-[11px] num text-text-faint tabular">
                                {e.isBinary ? "binary · YES vs NO" : "winner-take-all"}
                            </span>
                        </div>

                        {e.isBinary ? (
                            <BinaryOutcome
                                yes={e.outcomes[0].yesPrice}
                                no={e.outcomes[0].noPrice}
                                delta={e.outcomes[0].deltaPct}
                            />
                        ) : (
                            <OptionsTable
                                outcomes={e.outcomes}
                                slug={e.slug}
                            />
                        )}
                    </section>

                    {/* Resolution */}
                    {e.description && (
                        <section className="border border-border bg-bg-elev">
                            <div className="px-5 py-3 border-b border-border">
                                <span className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                                    / resolution criteria
                                </span>
                            </div>
                            <div className="px-5 py-4 text-[13.5px] leading-[1.55] text-text-dim whitespace-pre-line">
                                {sanitizeReferenceCopy(e.description)}
                            </div>
                        </section>
                    )}

                    {/* Where to trade */}
                    <section className="border border-yes/30 bg-yes/[0.03]">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-4">
                            <div className="flex flex-col gap-1">
                                <span className="text-[11px] uppercase tracking-[0.22em] text-yes num">
                                    / catalog only
                                </span>
                                <p className="text-[13px] text-text-dim leading-snug">
                                    This event isn&apos;t yet wrapped to a YOLO market on BOT Chain.
                                    Propose it to the admin to deploy before it can be traded here.
                                </p>
                            </div>
                        </div>
                    </section>
                </main>
            </div>
        </div>
    );
}

function Meta({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
            <span className="text-[10px] uppercase tracking-[0.16em] text-text-mute">{k}</span>
            <span className="num text-text-dim tabular text-right truncate">{v}</span>
        </div>
    );
}

function BinaryOutcome({
    yes,
    no,
    delta,
}: {
    yes: number;
    no: number;
    delta?: number;
}) {
    return (
        <div className="px-5 py-5">
            <div className="flex items-end gap-6 mb-4">
                <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-1">
                        yes probability
                    </span>
                    <span className="num text-[48px] leading-none tabular text-text">
                        {Math.round(yes * 1000) / 10}%
                    </span>
                </div>
                {delta !== undefined && Math.abs(delta) >= 0.5 && (
                    <span
                        className={`num text-[14px] tabular ${
                            delta >= 0 ? "text-yes" : "text-no"
                        }`}
                    >
                        {delta >= 0 ? "+" : ""}
                        {delta.toFixed(1)}pt
                        <span className="text-text-faint text-[11px] ml-1 lowercase">24h</span>
                    </span>
                )}
            </div>

            <ProbBar yes={yes} />

            <div className="grid grid-cols-2 gap-3 mt-5">
                <Side
                    label="yes"
                    cents={formatCents(yes)}
                    accent="text-yes border-yes/30 bg-yes/5"
                />
                <Side
                    label="no"
                    cents={formatCents(no)}
                    accent="text-no border-no/30 bg-no/5"
                />
            </div>
        </div>
    );
}

function Side({
    label,
    cents,
    accent,
}: {
    label: string;
    cents: string;
    accent: string;
}) {
    return (
        <div
            className={`flex items-center justify-between px-4 py-3 border ${accent}`}
        >
            <span className="text-[11px] uppercase tracking-[0.22em] num">{label}</span>
            <span className="num text-[18px] tabular">{cents}</span>
        </div>
    );
}

function ProbBar({ yes }: { yes: number }) {
    return (
        <div className="prob-bar">
            <div className="yes-fill" style={{ width: `${yes * 100}%` }} />
            <div className="tick" style={{ left: `${yes * 100}%` }} />
        </div>
    );
}

function OptionsTable({
    outcomes,
    slug: _slug,
}: {
    outcomes: { label: string; yesPrice: number; noPrice: number; slug?: string; deltaPct?: number }[];
    slug: string;
}) {
    return (
        <div>
            {outcomes.map((o, i) => (
                <div
                    key={o.slug ?? `${o.label}-${i}`}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-5 py-3 border-b border-border last:border-b-0 hover:bg-bg-hover/40 transition-colors"
                >
                    <span className="text-[13.5px] text-text truncate">{o.label}</span>
                    {o.deltaPct !== undefined && Math.abs(o.deltaPct) >= 0.5 ? (
                        <span
                            className={`num text-[11px] tabular ${
                                o.deltaPct >= 0 ? "text-yes" : "text-no"
                            }`}
                        >
                            {o.deltaPct >= 0 ? "+" : ""}
                            {o.deltaPct.toFixed(1)}pt
                        </span>
                    ) : (
                        <span />
                    )}
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-[0.18em] text-yes num">
                            yes
                        </span>
                        <span className="num text-[14px] tabular text-text min-w-[44px] text-right">
                            {formatCents(o.yesPrice)}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}
