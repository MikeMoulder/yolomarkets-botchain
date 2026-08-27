import Link from "next/link";
import type { NativeMover } from "@/lib/native-movers";
import { formatCents, formatUsdc } from "@/lib/format";

type Props = {
    movers: NativeMover[];
};

/** Horizontal strip of native BOT Chain markets ranked by the largest 24h move
 *  in their Polymarket counterpart. Cards link straight to the on-chain
 *  trade page (`/markets/<address>`), not the catalog detail. */
export function MoversStrip({ movers }: Props) {
    if (movers.length === 0) return null;

    return (
        <section className="relative overflow-hidden">
            {/* Ambient gradient mesh — slow-drifting wash behind the movers row */}
            <div className="mesh-ambient" aria-hidden />
            <div className="relative mx-auto max-w-[1440px] px-6 py-7">
                <header className="flex items-baseline justify-between mb-4">
                    <div className="flex items-baseline gap-3">
                        <span className="section-number text-[11px] tabular">02</span>
                        <h2 className="text-[12px] uppercase tracking-[0.24em] text-text-dim">
                            Biggest movers
                        </h2>
                        <span className="text-[11px] text-text-faint num lowercase">
                            tradeable on BOT Chain · last 24h
                        </span>
                    </div>
                    <span className="num text-[10.5px] text-text-faint tabular">
                        {movers.length} live
                    </span>
                </header>

                {/* Snap carousel on phones (next card peeks in from the right),
                    plain grid from sm up */}
                <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar -mx-6 px-6 scroll-pl-6 sm:mx-0 sm:px-0 sm:scroll-pl-0 sm:grid sm:grid-cols-2 lg:grid-cols-4 sm:overflow-visible">
                    {movers.map((m) => (
                        <MoverCard key={m.address} m={m} />
                    ))}
                </div>
            </div>
        </section>
    );
}

function MoverCard({ m }: { m: NativeMover }) {
    const up = m.deltaPct >= 0;
    const accentClass = up ? "movers-card-accent-up" : "movers-card-accent-down";

    return (
        <Link
            href={`/markets/${m.address}`}
            className={`card-lift card-lift-edge surface-soft group relative flex flex-col snap-start shrink-0 w-[82vw] max-w-[340px] sm:w-auto sm:max-w-none sm:shrink border border-border/80 hover:border-border-strong rounded-2xl overflow-hidden ${accentClass}`}
        >
            <div className="flex items-stretch gap-3 p-3">
                <div className="relative w-[64px] h-[64px] shrink-0 bg-bg-elev-2 overflow-hidden rounded-xl">
                    {m.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={m.image}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
                        />
                    ) : (
                        <div className="absolute inset-0 grid-underlay" />
                    )}
                </div>

                <div className="flex-1 flex flex-col min-w-0 gap-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className="num text-[9.5px] uppercase tracking-[0.18em] text-text-mute">
                            {m.category}
                        </span>
                        <span
                            className={`num text-[12px] tabular ${
                                up ? "text-yes" : "text-no"
                            }`}
                            title="24h move on reference market"
                        >
                            {up ? "+" : ""}
                            {m.deltaPct.toFixed(1)}
                            <span className="text-[10px] text-text-faint ml-0.5">pt</span>
                        </span>
                    </div>
                    <h3 className="text-[13px] leading-[1.3] text-text line-clamp-2 group-hover:text-text">
                        {m.question}
                    </h3>
                </div>
            </div>

            <div className="px-3 pb-3 pt-1 flex items-center justify-between text-[11px] num">
                <div className="flex items-center gap-2">
                    <span className="text-[9.5px] uppercase tracking-[0.2em] text-yes">
                        yes
                    </span>
                    <span className="text-text tabular text-[14px]">
                        {formatCents(m.priceYes)}
                    </span>
                </div>
                <span className="text-text-faint tabular">
                    ${formatUsdc(m.totalLiquidity)}
                    <span className="ml-1 lowercase">liq</span>
                </span>
            </div>
        </Link>
    );
}
