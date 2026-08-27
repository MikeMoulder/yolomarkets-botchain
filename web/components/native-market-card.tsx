import Link from "next/link";
import type { MarketSummary } from "@/lib/markets";
import {
    formatCents,
    formatCompactUsd,
    formatTimeUntil,
    priceToProb,
} from "@/lib/format";

/** Plain-data card model. The on-chain `MarketSummary` carries bigints, which
 *  can't cross the server→client boundary — server pages convert with
 *  `toNativeCardModel` before handing markets to client components. */
export type NativeCardModel = {
    address: string;
    question: string;
    category: string;
    /** YES probability, 0..1 */
    yesProb: number;
    /** Total liquidity in whole USDC */
    liqUsd: number;
    deadlineSec: number;
    imageUrl: string | null;
};

export function toNativeCardModel(
    m: MarketSummary,
    imageUrl?: string | null,
): NativeCardModel {
    return {
        address: m.address,
        question: m.question,
        category: m.category,
        yesProb: priceToProb(m.priceYes),
        liqUsd: Number(m.totalLiquidity) / 1e6,
        deadlineSec: Number(m.deadline),
        imageUrl: imageUrl ?? null,
    };
}

type Props = {
    m: NativeCardModel;
};

    /** A native YOLO market card — these are actually tradeable on BOT Chain. Below
 *  `sm` the card collapses into a compact horizontal row (small thumbnail,
 *  two-line title) so a phone screen fits several markets instead of one.
 */
export function NativeMarketCard({ m }: Props) {
    const yes = m.yesProb;
    const no = 1 - yes;
    const ends = formatTimeUntil(m.deadlineSec);
    const href = `/markets/${m.address}`;

    return (
        <Link
            href={href}
            className="card-lift surface-soft group relative flex flex-row sm:flex-col border border-border/80 hover:border-yes/45 focus-visible:border-accent outline-none rounded-2xl overflow-hidden"
        >
            {m.imageUrl ? (
                <NativeImageHeader src={m.imageUrl} category={m.category} />
            ) : (
                <NativeArt category={m.category} title={m.question} />
            )}

            <div className="flex-1 min-w-0 flex flex-col p-3 gap-2 sm:p-3.5 sm:gap-3">
                <h3 className="text-[13px] sm:text-[13.5px] leading-[1.35] font-medium text-text line-clamp-2 sm:line-clamp-3 sm:min-h-[3em]">
                    {m.question}
                </h3>

                <div className="grid grid-cols-2 gap-2">
                    <div className="pill-yes flex items-center justify-between px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl">
                        <span className="text-[9.5px] uppercase tracking-[0.2em] text-yes font-medium">
                            yes
                        </span>
                        <span className="num text-[12.5px] sm:text-[13.5px] text-text tabular">
                            {formatCents(yes)}
                        </span>
                    </div>
                    <div className="pill-no flex items-center justify-between px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl">
                        <span className="text-[9.5px] uppercase tracking-[0.2em] text-no font-medium">
                            no
                        </span>
                        <span className="num text-[12.5px] sm:text-[13.5px] text-text tabular">
                            {formatCents(no)}
                        </span>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-2 mt-auto pt-2 sm:pt-2.5 border-t border-border/70 text-[10.5px] num tracking-wide">
                    <span className="text-text-mute truncate">
                        ${" "}
                        <span className="text-text-dim tabular">
                            {formatCompactUsd(m.liqUsd).replace(/^\$/, "")}
                        </span>
                        <span className="text-text-faint ml-1.5 lowercase">liq</span>
                    </span>
                    <span className="text-text-mute tabular shrink-0">
                        {ends} <span className="text-text-faint lowercase">left</span>
                    </span>
                </div>
            </div>
        </Link>
    );
}

/** Pure-CSS hero for a native market. No image — typography only, with a
 *  deterministic accent line whose position is derived from the category,
 *  so each category reads as a different mark. Renders as a narrow strip on
 *  mobile and a full square on `sm+`.
 */
function NativeArt({ category, title }: { category: string; title: string }) {
    // Pick a hue offset deterministically from the title hash so each market
    // has a subtle unique tint, without ever drifting from the dark palette.
    const hue = hashHue(title);
    // Where the diagonal accent line sits — vertical offset per-category.
    const accent = categoryAccent(category);

    return (
        <div className="relative w-[88px] shrink-0 self-stretch sm:w-auto sm:self-auto sm:aspect-square overflow-hidden bg-bg-elev-2">
            {/* Grid underlay */}
            <div className="absolute inset-0 grid-underlay opacity-60" />
            {/* Subtle radial tint */}
            <div
                className="absolute inset-0"
                style={{
                    background: `radial-gradient(ellipse at ${accent.x}% ${accent.y}%, hsla(${hue}, 50%, 60%, 0.08), transparent 60%)`,
                }}
            />
            {/* Diagonal accent line */}
            <div
                className="absolute"
                style={{
                    top: `${accent.y}%`,
                    left: 0,
                    right: 0,
                    height: "1px",
                    background: `linear-gradient(to right, transparent, hsla(${hue}, 70%, 55%, 0.45), transparent)`,
                }}
            />
            <div className="hidden sm:block absolute top-2.5 left-2.5 num text-[9.5px] uppercase tracking-[0.18em] text-text bg-bg/70 backdrop-blur-md px-2 py-0.5 border border-border-strong rounded-full">
                {category}
            </div>
            {/* Centered category sigil */}
            <div className="absolute inset-0 flex items-center justify-center">
                <span
                    className="num uppercase text-text-mute text-[11px] tracking-[0.14em] sm:text-[clamp(20px,5vw,36px)] sm:tracking-[0.22em]"
                >
                    {category}
                </span>
            </div>
            {/* Bottom hairline */}
            <div className="absolute left-0 right-0 bottom-0 h-px bg-border" />
        </div>
    );
}

/** Image-led header used when we successfully resolved the native market's
 *  question to a Polymarket-source image via the overlay map. Wears the same
 *  category chrome as the CSS-art variant so the cards read as siblings.
 *
 *  Uses a plain <img> rather than next/image because next/image with `fill +
 *  unoptimized` in Next 16 has rendering quirks for cross-origin S3 URLs that
 *  contain '+' characters (e.g. BTC+fullsize.png). The plain tag just works.
 */
function NativeImageHeader({ src, category }: { src: string; category: string }) {
    return (
        <div className="relative w-[88px] shrink-0 self-stretch sm:w-auto sm:self-auto sm:aspect-square overflow-hidden bg-bg-elev-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 scale-[1.18] sm:scale-100 sm:group-hover:scale-[1.04]"
            />
            {/* Subtle bottom-fade so the badges read against bright images */}
            <div className="hidden sm:block absolute inset-0 bg-gradient-to-t from-bg/80 via-bg/15 to-transparent pointer-events-none" />
            <div className="hidden sm:block absolute top-2.5 left-2.5 num text-[9.5px] uppercase tracking-[0.18em] text-text bg-bg/70 backdrop-blur-md px-2 py-0.5 border border-border-strong rounded-full">
                {category}
            </div>
        </div>
    );
}

function hashHue(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
}

function categoryAccent(category: string): { x: number; y: number } {
    const map: Record<string, { x: number; y: number }> = {
        Crypto: { x: 78, y: 32 },
        Macro: { x: 22, y: 62 },
        Politics: { x: 50, y: 22 },
        Sports: { x: 30, y: 72 },
        Tech: { x: 70, y: 60 },
    };
    return map[category] ?? { x: 50, y: 50 };
}
