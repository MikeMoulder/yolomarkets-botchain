import Link from "next/link";
import type { NativeCardModel } from "./native-market-card";
import { formatCents, formatCompactUsd, formatTimeUntil } from "@/lib/format";

/** Hero rail of the highest-signal tradeable markets. Landscape cards with the
 *  image as a backdrop and the question overlaid — a premium treatment distinct
 *  from the dense catalog cards. Horizontal snap-scroll on every breakpoint. */
export function FeaturedRail({ items }: { items: NativeCardModel[] }) {
    if (items.length === 0) return null;

    return (
        <section className="relative overflow-hidden border-b border-border">
            <div className="mesh-ambient" aria-hidden />
            <div className="relative mx-auto max-w-[1440px] px-6 py-7">
                <header className="flex items-baseline justify-between mb-4">
                    <div className="flex items-baseline gap-3">
                        <span className="section-number text-[11px] tabular">01</span>
                        <h2 className="text-[12px] uppercase tracking-[0.24em] text-text-dim">
                            Featured
                        </h2>
                        <span className="text-[11px] text-text-faint num lowercase">
                            top markets · live on BOT Chain
                        </span>
                    </div>
                </header>

                <div className="flex gap-3.5 overflow-x-auto snap-x snap-mandatory no-scrollbar -mx-6 px-6 scroll-pl-6 sm:mx-0 sm:px-0 sm:scroll-pl-0">
                    {items.map((m) => (
                        <FeaturedCard key={m.address} m={m} />
                    ))}
                </div>
            </div>
        </section>
    );
}

function FeaturedCard({ m }: { m: NativeCardModel }) {
    const yes = m.yesProb;
    const no = 1 - yes;
    const ends = formatTimeUntil(m.deadlineSec);

    return (
        <Link
            href={`/markets/${m.address}`}
            className="card-lift surface-soft group relative flex flex-col shrink-0 snap-start w-[290px] sm:w-[350px] border border-border/80 hover:border-yes/45 focus-visible:border-accent outline-none rounded-2xl overflow-hidden"
        >
            <div className="relative h-[150px] sm:h-[176px] bg-bg-elev-2 overflow-hidden">
                {m.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={m.imageUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.05]"
                    />
                ) : (
                    <div className="absolute inset-0 grid-underlay opacity-70" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/50 to-transparent pointer-events-none" />
                <div className="absolute top-3 left-3 num text-[9.5px] uppercase tracking-[0.18em] text-text bg-bg/70 backdrop-blur-md px-2 py-0.5 border border-border-strong rounded-full">
                    {m.category}
                </div>
                <h3 className="absolute inset-x-3 bottom-2.5 text-[15px] leading-[1.3] font-medium text-text line-clamp-2">
                    {m.question}
                </h3>
            </div>

            <div className="flex flex-col p-3.5 gap-3">
                <div className="grid grid-cols-2 gap-2">
                    <div className="pill-yes flex items-center justify-between px-3 py-2 rounded-xl">
                        <span className="text-[9.5px] uppercase tracking-[0.2em] text-yes font-medium">yes</span>
                        <span className="num text-[14px] text-text tabular">{formatCents(yes)}</span>
                    </div>
                    <div className="pill-no flex items-center justify-between px-3 py-2 rounded-xl">
                        <span className="text-[9.5px] uppercase tracking-[0.2em] text-no font-medium">no</span>
                        <span className="num text-[14px] text-text tabular">{formatCents(no)}</span>
                    </div>
                </div>
                <div className="flex items-center justify-between text-[10.5px] num tracking-wide">
                    <span className="text-text-mute">
                        $<span className="text-text-dim tabular">{formatCompactUsd(m.liqUsd).replace(/^\$/, "")}</span>
                        <span className="text-text-faint ml-1.5 lowercase">liq</span>
                    </span>
                    <span className="text-text-mute tabular">
                        {ends} <span className="text-text-faint lowercase">left</span>
                    </span>
                </div>
            </div>
        </Link>
    );
}
