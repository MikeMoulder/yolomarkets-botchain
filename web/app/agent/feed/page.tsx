import Link from "next/link";
import { getAddress, type Address } from "viem";
import { readDecisions, type AgentDecision, type AgentAction } from "@/lib/agent-decisions";
import { formatCompactUsd } from "@/lib/format";
import { getProfile } from "@/lib/agent-profiles";
import { loadAgentPositions } from "@/lib/agent-positions";
import { publicClient } from "@/lib/markets";
import { ADDRESSES, erc20Abi } from "@/lib/contracts";
import {
    AgentPositionsPanel,
    type SerializablePosition,
} from "@/components/agent-positions-panel";
import { AgentProfileBanner } from "@/components/agent-profile-banner";
import { AgentScopeRedirect } from "@/components/agent-scope-redirect";

export const metadata = { title: "Agent Feed" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ u?: string }>;

export default async function AgentFeedPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const sp = await searchParams;
    const userScope = sp.u && /^0x[a-fA-F0-9]{40}$/.test(sp.u) ? sp.u : null;

    if (!userScope) {
        return <AgentScopeRedirect basePath="/agent/feed" />;
    }

    const feed = await readDecisions(200, { userAddr: userScope });
    const trades = feed.decisions.filter((d) => d.action !== "pass");
    const skipped = feed.decisions.filter((d) => d.action === "pass");
    const broadcast = trades.filter((d) => !d.paper);
    const totalSpend = trades.reduce((sum, d) => sum + d.cost_usdc, 0);
    const totalFees = trades.reduce((sum, d) => sum + d.platform_fee_usdc, 0);
    const avgEdge =
        trades.length > 0
            ? trades.reduce((sum, d) => sum + Math.abs(d.edge_pts), 0) / trades.length
            : 0;

    // Live on-chain positions + wallet balance for the exit / withdraw panel.
    // Only the broadcast trades have an on-chain position to exit.
    const profile = await getProfile(userScope);
    const { positions, walletBalanceMicro } = await loadPositionPanelData(
        profile?.agentAddress ?? null,
        broadcast,
    );

    return (
        <div className="mx-auto max-w-[1280px] px-6 py-10">
            <BackLink href="/agent" />

            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-text-mute mb-6 flex-wrap">
                <span className="h-1.5 w-1.5 rounded-full bg-yes live-dot" />
                <span>
                    / agent feed ·{" "}
                    <span className="text-accent">
                        {userScope.slice(0, 6)}…{userScope.slice(-4)}
                    </span>
                </span>
                {feed.lastTs && (
                    <>
                        <span className="text-text-faint">·</span>
                        <span className="num normal-case tracking-normal text-text-faint">
                            updated {relative(feed.lastTs)}
                        </span>
                    </>
                )}
            </div>

            <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium max-w-[42ch]">
                Agent transactions,{" "}
                <span className="text-text-mute">trades, and analysis.</span>
            </h1>

            <div className="mt-6">
                <AgentProfileBanner showFeedLink={false} />
            </div>

            <div className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-b border-border py-6">
                <Stat label="trades" value={trades.length.toString()} />
                <Stat
                    label="broadcast"
                    value={broadcast.length.toString()}
                    unit={`${trades.length - broadcast.length} paper`}
                />
                <Stat
                    label="spent"
                    value={formatCompactUsd(totalSpend)}
                    unit={`${formatCompactUsd(totalFees)} fees`}
                />
                <Stat label="avg edge" value={`${avgEdge.toFixed(1)}pt`} />
                {feed.bankroll !== null && (
                    <Stat
                        label="bankroll"
                        value={formatCompactUsd(feed.bankroll)}
                        unit="last snapshot"
                    />
                )}
            </div>

            {profile?.agentAddress && (
                <AgentPositionsPanel
                    userAddr={userScope}
                    positions={positions}
                    walletBalanceMicro={walletBalanceMicro}
                />
            )}

            <section className="mt-8 flex flex-col gap-3">
                <div className="flex items-baseline justify-between gap-4 mb-1">
                    <h2 className="text-[12px] uppercase tracking-[0.22em] text-text-mute">
                        / trades
                    </h2>
                    <span className="num text-[11px] text-text-faint">
                        {feed.counts.buy_yes} yes · {feed.counts.buy_no} no
                    </span>
                </div>

                {trades.length > 0 ? (
                    trades.map((d) => <TradeCard key={`${d.ts}-${d.market}`} d={d} />)
                ) : (
                    <div className="border border-border bg-bg-elev/30 px-5 py-6 text-[13px] text-text-dim">
                        No agent trades yet. When the agent opens a position, it
                        will appear here with sizing, fees, reasoning, and the
                        transaction link.
                    </div>
                )}
            </section>

            {skipped.length > 0 && (
                <details className="mt-8 border border-border bg-bg-elev/20 px-5 py-4">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-4">
                        <span className="text-[12px] uppercase tracking-[0.22em] text-text-mute">
                            / skipped opportunities
                        </span>
                        <span className="num text-[11px] text-text-faint">
                            {skipped.length} skipped
                        </span>
                    </summary>
                    <div className="mt-4 flex flex-col gap-3">
                        {skipped.slice(0, 25).map((d) => (
                            <TradeCard key={`${d.ts}-${d.market}`} d={d} compact />
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
}

async function loadPositionPanelData(
    agentAddress: string | null,
    broadcastTrades: AgentDecision[],
): Promise<{ positions: SerializablePosition[]; walletBalanceMicro: string }> {
    if (!agentAddress) return { positions: [], walletBalanceMicro: "0" };
    const agent = getAddress(agentAddress) as Address;

    // Most-recent question per market, for labelling the position cards.
    const questionByMarket = new Map<string, string>();
    for (const d of broadcastTrades) {
        const key = d.market.toLowerCase();
        if (!questionByMarket.has(key)) questionByMarket.set(key, d.question);
    }
    const markets = [...questionByMarket.keys()] as Address[];

    try {
        const [open, balance] = await Promise.all([
            loadAgentPositions(agent, markets),
            publicClient.readContract({
                address: ADDRESSES.usdc,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [agent],
            }) as Promise<bigint>,
        ]);
        const positions: SerializablePosition[] = open.map((p) => ({
            market: p.market,
            question: questionByMarket.get(p.market.toLowerCase()) ?? p.market,
            outcome: p.outcome as 1 | 2,
            shares: p.shares.toString(),
            exitProceeds: p.exitProceeds.toString(),
        }));
        return { positions, walletBalanceMicro: balance.toString() };
    } catch {
        // RPC hiccup shouldn't blank the whole feed — degrade to no panel data.
        return { positions: [], walletBalanceMicro: "0" };
    }
}

function BackLink({ href }: { href: string }) {
    return (
        <Link
            href={href}
            className="inline-block mb-6 text-[11px] uppercase tracking-[0.2em] text-text-mute hover:text-text num"
        >
            ← back
        </Link>
    );
}

function TradeCard({
    d,
    compact = false,
}: {
    d: AgentDecision;
    compact?: boolean;
}) {
    const isPass = d.action === "pass";
    const accent = actionAccent(d.action);

    return (
        <article className={`border ${accent.border} bg-bg-elev/40 px-5 py-4`}>
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-x-8 gap-y-4">
                <div className="min-w-0 flex flex-col gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        <ActionChip action={d.action} />
                        <span className="text-[10.5px] uppercase tracking-[0.18em] text-text-mute">
                            {d.category}
                        </span>
                        <span className="text-text-faint">·</span>
                        <time
                            dateTime={d.ts}
                            className="num text-[11px] text-text-faint"
                            title={d.ts}
                        >
                            {relative(d.ts)}
                        </time>
                        {!d.paper && (
                            <span className="ml-auto num text-[10px] uppercase tracking-[0.18em] text-yes border border-yes/30 px-1.5 py-0.5">
                                broadcast
                            </span>
                        )}
                    </div>

                    <h3 className="text-[15.5px] leading-snug text-text">
                        <Link
                            href={`/markets/${d.market}`}
                            className="hover:text-accent transition-colors"
                        >
                            {d.question}
                        </Link>
                    </h3>

                    {d.reasoning && (
                        <p className="text-[13px] leading-[1.55] text-text-dim">
                            {d.reasoning}
                        </p>
                    )}

                    {isPass && d.pass_reason && (
                        <div className="text-[11.5px] num text-text-mute">
                            <span className="text-text-faint">skip · </span>
                            {d.pass_reason}
                        </div>
                    )}

                    {!compact && d.watch_for.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1">
                            {d.watch_for.slice(0, 4).map((w, i) => (
                                <span
                                    key={i}
                                    className="text-[10.5px] num text-text-mute bg-bg-elev border border-border px-2 py-0.5"
                                >
                                    {w}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-3 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-6">
                    <div className="grid grid-cols-3 gap-2">
                        <Probe label="market" value={pct(d.market_prob)} tone="text-text-dim" />
                        <Probe
                            label="crowd"
                            value={d.polymarket_prob !== null ? pct(d.polymarket_prob) : "—"}
                            tone="text-text-dim"
                        />
                        <Probe label="agent" value={pct(d.ai_prob)} tone={accent.text} />
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                        <Meta k="edge" v={<span className={d.edge_pts >= 0 ? "text-yes" : "text-no"}>{d.edge_pts >= 0 ? "+" : ""}{d.edge_pts.toFixed(1)}pt</span>} />
                        <Meta k="conviction" v={`${Math.round(d.ai_confidence * 100)}%`} />
                        <Meta k="stake" v={`${(d.kelly_fraction * 100).toFixed(1)}%`} />
                        <Meta k="urgency" v={d.time_sensitivity} />
                    </div>

                    {!isPass && (
                        <div className="border-t border-border pt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                            <Meta k="size" v={`$${d.cost_usdc.toFixed(2)}`} />
                            <Meta k="shares" v={(d.shares / 1e6).toFixed(2)} />
                            <Meta k="fee" v={`$${d.platform_fee_usdc.toFixed(4)}`} />
                            {d.tx_hash ? (
                                <div className="col-span-2">
                                    <Meta
                                        k="tx"
                                        v={
                                            <a
                                                href={`https://scan.bohr.life/tx/${d.tx_hash}`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="num text-accent hover:text-text transition-colors break-all text-[11px]"
                                            >
                                                {d.tx_hash.slice(0, 14)}…
                                            </a>
                                        }
                                    />
                                </div>
                            ) : (
                                <div className="col-span-2 text-[10.5px] num uppercase tracking-[0.18em] text-text-faint">
                                    paper trade · no broadcast
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </article>
    );
}

function ActionChip({ action }: { action: AgentAction }) {
    const a = actionAccent(action);
    const label =
        action === "buy_yes" ? "buy yes" : action === "buy_no" ? "buy no" : "skip";
    return (
        <span className={`num text-[10px] uppercase tracking-[0.22em] ${a.text} border ${a.border} px-2 py-0.5 inline-flex items-center gap-1.5`}>
            <span className={`w-1 h-1 rounded-full ${a.dot}`} />
            {label}
        </span>
    );
}

function Probe({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone: string;
}) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-[0.18em] text-text-faint num">
                {label}
            </span>
            <span className={`num tabular text-[16px] leading-none ${tone}`}>
                {value}
            </span>
        </div>
    );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-[9.5px] uppercase tracking-[0.18em] text-text-mute num">
                {k}
            </span>
            <span className="text-right tabular num text-text-dim">{v}</span>
        </div>
    );
}

function Stat({
    label,
    value,
    unit,
}: {
    label: string;
    value: string;
    unit?: string;
}) {
    return (
        <div className="flex flex-col min-w-0">
            <span className="text-[9.5px] uppercase tracking-[0.22em] text-text-mute mb-1.5">
                {label}
            </span>
            <span className="num text-[18px] text-text tabular leading-none">
                {value}
                {unit && (
                    <span className="text-text-faint text-[10.5px] ml-1.5 lowercase tracking-normal">
                        · {unit}
                    </span>
                )}
            </span>
        </div>
    );
}

function actionAccent(action: AgentAction) {
    switch (action) {
        case "buy_yes":
            return { border: "border-yes/35", text: "text-yes", dot: "bg-yes" };
        case "buy_no":
            return { border: "border-no/35", text: "text-no", dot: "bg-no" };
        default:
            return { border: "border-border", text: "text-text-mute", dot: "bg-text-faint" };
    }
}

function pct(p: number): string {
    return `${(p * 100).toFixed(1)}%`;
}

function relative(ts: string): string {
    const then = Date.parse(ts);
    if (Number.isNaN(then)) return ts;
    const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
