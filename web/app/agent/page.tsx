import Link from "next/link";
import {
    readDecisions,
    type AgentDecision,
    type AgentAction,
    type ToolTraceEntry,
} from "@/lib/agent-decisions";
import { formatCompactUsd } from "@/lib/format";
import { AgentProfileBanner } from "@/components/agent-profile-banner";
import { AgentTierPanel } from "@/components/agent-tier-panel";
import { AgentScopeRedirect } from "@/components/agent-scope-redirect";
import { getProfile } from "@/lib/agent-profiles";
import { EXPLORER_URL } from "@/lib/explorer";

export const metadata = { title: "Agent" };

// Re-read the log on every request — append-only, cheap to parse, and we
// want freshness for the "live feed" feel. No ISR; just dynamic.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ u?: string }>;

export default async function AgentPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const sp = await searchParams;
    const userScope = sp.u && /^0x[a-fA-F0-9]{40}$/.test(sp.u) ? sp.u : null;

    // No scope in the URL: defer to the client redirect, which forwards to
    // /agent?u=<address> once the wallet connects. Rendering a static empty
    // state here would hard-code "No agent set up yet" in the heading while
    // the client-side profile banner independently shows an active agent.
    if (!userScope) {
        return <AgentScopeRedirect basePath="/agent" />;
    }

    const profile = await getProfile(userScope);
    const feed = await readDecisions(
        200,
        { userAddr: userScope },
    );

    if (feed.decisions.length === 0) {
        return <EmptyState scopedTo={userScope} hasProfile={!!profile} />;
    }

    const tradeDecisions = feed.decisions.filter((d) => d.action !== "pass");
    const skippedDecisions = feed.decisions.filter((d) => d.action === "pass");
    const liveCalls = tradeDecisions.length;
    const total =
        feed.counts.buy_yes + feed.counts.buy_no + feed.counts.pass;
    const deployedTrades = tradeDecisions.filter((d) => !d.paper).length;
    const totalSpend = tradeDecisions.reduce((sum, d) => sum + d.cost_usdc, 0);
    const totalFees = tradeDecisions.reduce(
        (sum, d) => sum + d.platform_fee_usdc,
        0,
    );
    const avgEdge =
        liveCalls > 0 ? feed.totalEdgePts / liveCalls : 0;

    return (
        <div className="mx-auto max-w-[1280px] px-6 py-10">
            {/* Status line */}
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-text-mute mb-6 flex-wrap">
                <span className="h-1.5 w-1.5 rounded-full bg-yes live-dot" />
                <span>
                    / agent ·{" "}
                    <span className="text-accent">
                        scope · {userScope.slice(0, 6)}…{userScope.slice(-4)}
                    </span>
                </span>
                <span className="text-text-faint">·</span>
                <span>{feed.paperOnly ? "paper" : "live"}</span>
                {feed.lastTs && (
                    <>
                        <span className="text-text-faint">·</span>
                        <span className="num normal-case tracking-normal text-text-faint">
                            last call {relative(feed.lastTs)}
                        </span>
                    </>
                )}
            </div>

            <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium max-w-[42ch]">
                Agent activity,{" "}
                <span className="text-text-mute">
                    trades, and analysis.
                </span>
            </h1>

            <div className="mt-6">
                <AgentProfileBanner showSettingsLink={false} />
            </div>
            <div className="mt-4">
                <AgentTierPanel />
            </div>

            {/* Stat strip */}
            <div className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-b border-border py-6">
                <Stat label="trades" value={liveCalls.toString()} />
                <Stat
                    label="broadcast"
                    value={deployedTrades.toString()}
                    unit={`${tradeDecisions.length - deployedTrades} paper`}
                />
                <Stat
                    label="spent"
                    value={formatCompactUsd(totalSpend)}
                    unit={`${formatCompactUsd(totalFees)} fees`}
                />
                <Stat
                    label="avg edge"
                    value={`${avgEdge.toFixed(1)}pt`}
                    unit="on live calls"
                />
                {feed.bankroll !== null && (
                    <Stat
                        label="bankroll"
                        value={formatCompactUsd(feed.bankroll)}
                        unit="last snapshot"
                    />
                )}
            </div>

            {/* Trade ledger */}
            <div className="mt-8 flex flex-col gap-3">
                <div className="flex items-baseline justify-between gap-4 mb-1">
                    <h2 className="text-[12px] uppercase tracking-[0.22em] text-text-mute">
                        / trades
                    </h2>
                    <span className="num text-[11px] text-text-faint">
                        {feed.counts.buy_yes} yes · {feed.counts.buy_no} no
                    </span>
                </div>
                {tradeDecisions.length > 0 ? (
                    tradeDecisions.map((d) => (
                        <DecisionCard key={`${d.ts}-${d.market}`} d={d} />
                    ))
                ) : (
                    <div className="border border-border bg-bg-elev/30 px-5 py-6 text-[13px] text-text-dim">
                        No agent trades yet. When the agent opens a position,
                        it will appear here with sizing, fees, reasoning, and
                        the transaction link.
                    </div>
                )}
            </div>

            {skippedDecisions.length > 0 && (
                <details className="mt-8 border border-border bg-bg-elev/20 px-5 py-4 group">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-4">
                        <span className="text-[12px] uppercase tracking-[0.22em] text-text-mute">
                            / skipped opportunities
                        </span>
                        <span className="num text-[11px] text-text-faint">
                            {skippedDecisions.length} skipped · {total} total decisions
                        </span>
                    </summary>
                    <div className="mt-4 flex flex-col gap-3">
                        {skippedDecisions.slice(0, 25).map((d) => (
                            <DecisionCard key={`${d.ts}-${d.market}`} d={d} compact />
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
}

// ── Cards ─────────────────────────────────────────────────────────────────

function DecisionCard({
    d,
    compact = false,
}: {
    d: AgentDecision;
    compact?: boolean;
}) {
    const isPass = d.action === "pass";
    const accent = actionAccent(d.action);
    const hasBrain =
        d.brain_model !== null ||
        d.tool_trace.length > 0 ||
        d.news_summary.length > 0;

    return (
        <article
            className={`border ${accent.border} bg-bg-elev/40 px-5 py-4 transition-colors hover:bg-bg-elev/70`}
        >
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-x-8 gap-y-4">
                {/* Left: question + reasoning */}
                <div className="min-w-0 flex flex-col gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        <ActionChip action={d.action} />
                        <span className="text-[10.5px] uppercase tracking-[0.18em] text-text-mute">
                            {d.category}
                        </span>
                        <span className="text-text-faint">·</span>
                        <Link
                            href={`/markets/${d.market}`}
                            className="num text-[11px] text-text-mute hover:text-text transition-colors"
                        >
                            {short(d.market)}
                        </Link>
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
                                live
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
                            <span className="text-text-faint">pass · </span>
                            {d.pass_reason}
                        </div>
                    )}

                    {!compact && d.watch_for.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1">
                            {d.watch_for.slice(0, 4).map((w, i) => (
                                <span
                                    key={i}
                                    className="text-[10.5px] num text-text-mute bg-bg-elev border border-border px-2 py-0.5"
                                    title="watching for"
                                >
                                    {w}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* Right: numbers */}
                <div className="flex flex-col gap-3 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-6">
                    {/* Three-way price strip */}
                    <div className="grid grid-cols-3 gap-2">
                        <Probe
                            label="market"
                            value={pct(d.market_prob)}
                            tone="text-text-dim"
                        />
                        <Probe
                            label="crowd"
                            value={d.polymarket_prob !== null ? pct(d.polymarket_prob) : "—"}
                            tone="text-text-dim"
                        />
                        <Probe
                            label="ai"
                            value={pct(d.ai_prob)}
                            tone={accent.text}
                        />
                    </div>

                    {/* Edge + confidence + size */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                        <Meta
                            k="edge"
                            v={
                                <span
                                    className={
                                        d.edge_pts >= 0 ? "text-yes" : "text-no"
                                    }
                                >
                                    {d.edge_pts >= 0 ? "+" : ""}
                                    {d.edge_pts.toFixed(1)}pt
                                </span>
                            }
                        />
                        <Meta
                            k="conviction"
                            v={
                                <span className="text-text-dim">
                                    {Math.round(d.ai_confidence * 100)}%
                                </span>
                            }
                        />
                        <Meta
                            k="stake"
                            v={
                                <span className="text-text-dim">
                                    {(d.kelly_fraction * 100).toFixed(1)}%
                                </span>
                            }
                        />
                        <Meta
                            k="urgency"
                            v={
                                <span className="text-text-dim uppercase tracking-wide text-[10px]">
                                    {d.time_sensitivity}
                                </span>
                            }
                        />
                    </div>

                    {!isPass && (
                        <div className="border-t border-border pt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                            <Meta
                                k="size"
                                v={
                                    <span className="num text-text">
                                        ${d.cost_usdc.toFixed(2)}
                                    </span>
                                }
                            />
                            <Meta
                                k="shares"
                                v={
                                    <span className="num text-text-dim">
                                        {(d.shares / 1e6).toFixed(2)}
                                    </span>
                                }
                            />
                            <Meta
                                k="fee"
                                v={
                                    <span className="num text-text-dim">
                                        ${d.platform_fee_usdc.toFixed(4)}
                                    </span>
                                }
                            />
                            {d.tx_hash ? (
                                <div className="col-span-2">
                                    <Meta
                                        k="tx"
                                        v={
                                            <a
                                                href={`${EXPLORER_URL}/tx/${d.tx_hash}`}
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

            {!compact && hasBrain && <BrainTrace d={d} />}
        </article>
    );
}

// ── Analysis details ──────────────────────────────────────────────────────
// Keep raw evidence behind a disclosure so the page reads like an activity
// ledger first, with audit detail available when the user asks for it.

function BrainTrace({ d }: { d: AgentDecision }) {
    return (
        <div className="mt-4 border-t border-border pt-4 space-y-3">
            {d.news_summary && (
                <div>
                    <div className="text-[9.5px] uppercase tracking-[0.22em] text-text-mute mb-1.5 num">
                        / news summary
                    </div>
                    <p className="text-[12.5px] leading-[1.55] text-text-dim">
                        {d.news_summary}
                    </p>
                </div>
            )}

            {d.tool_trace.length > 0 && (
                <details className="group">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-[0.22em] text-text-mute hover:text-text-dim transition-colors num inline-flex items-center gap-2 list-none">
                        <span className="inline-block transition-transform group-open:rotate-90">
                            ▸
                        </span>
                        audit details ({d.tool_trace.length})
                    </summary>
                    <ol className="mt-3 space-y-2 num text-[11.5px]">
                        {d.tool_trace.map((step, i) => (
                            <TraceStep key={i} step={step} />
                        ))}
                    </ol>
                </details>
            )}
        </div>
    );
}

function TraceStep({ step }: { step: ToolTraceEntry }) {
    return (
        <li
            className={`border-l-2 ${
                step.is_error ? "border-no" : "border-accent/60"
            } pl-3 py-1`}
        >
            <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-text-faint">
                    {String(step.iteration).padStart(2, "0")}
                </span>
                <span
                    className={`${
                        step.is_error ? "text-no" : "text-text"
                    } font-medium`}
                >
                    {step.name}
                </span>
                <span className="text-[10px] text-text-faint normal-case tracking-normal ml-auto tabular">
                    {step.elapsed_ms}ms
                </span>
            </div>
            <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-[10.5px]">
                <CodeBlock label="input" value={step.input} />
                <CodeBlock label="result" value={step.result} />
            </div>
        </li>
    );
}

function CodeBlock({ label, value }: { label: string; value: unknown }) {
    // JSON.stringify is intentionally compact — judges scanning tool I/O at
    // a glance don't want pretty-printed 30-line blocks for a {q: "..."} arg.
    let serialized: string;
    try {
        serialized = JSON.stringify(value);
    } catch {
        serialized = String(value);
    }
    return (
        <div className="min-w-0">
            <span className="text-[9px] uppercase tracking-[0.18em] text-text-faint mr-1.5">
                {label}
            </span>
            <span className="text-text-dim break-words">
                {serialized.length > 240
                    ? serialized.slice(0, 240) + "…"
                    : serialized}
            </span>
        </div>
    );
}

function ActionChip({ action }: { action: AgentAction }) {
    const a = actionAccent(action);
    const label =
        action === "buy_yes" ? "buy yes" : action === "buy_no" ? "buy no" : "pass";
    return (
        <span
            className={`num text-[10px] uppercase tracking-[0.22em] ${a.text} border ${a.border} px-2 py-0.5 inline-flex items-center gap-1.5`}
        >
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
            <span className="text-right tabular">{v}</span>
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

// ── Empty state — preserves the original "agent isn't live yet" copy ─────

function EmptyState({
    scopedTo,
    hasProfile,
}: {
    scopedTo?: string | null;
    hasProfile: boolean;
}) {
    return (
        <div className="mx-auto max-w-[1280px] px-6 py-10">
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-text-mute mb-6">
                <span className="h-1.5 w-1.5 rounded-full bg-text-mute" />
                <span>/ agent · idle</span>
                {scopedTo && (
                    <>
                        <span className="text-text-faint">·</span>
                        <span className="text-accent normal-case tracking-normal">
                            scope {scopedTo.slice(0, 6)}…{scopedTo.slice(-4)}
                        </span>
                    </>
                )}
            </div>

            <h1 className="text-[28px] md:text-[36px] leading-[1.1] tracking-tight font-medium max-w-[36ch]">
                {!hasProfile ? (
                    <>
                        No agent has been{" "}
                        <span className="text-text-mute">
                            set up yet.
                        </span>
                    </>
                ) : scopedTo ? (
                    <>
                        Your agent{" "}
                        <span className="text-text-mute">
                            hasn&apos;t made a call yet.
                        </span>
                    </>
                ) : (
                    <>
                        The autonomous trader{" "}
                        <span className="text-text-mute">
                            hasn&apos;t made a call yet.
                        </span>
                    </>
                )}
            </h1>

            <div className="mt-6">
                <AgentProfileBanner showSettingsLink={false} />
            </div>
            <div className="mt-4">
                <AgentTierPanel />
            </div>

            <AgentIdleAnimation />
        </div>
    );
}

function AgentIdleAnimation() {
    return (
        <div
            className="relative mx-auto mt-12 h-[320px] w-full max-w-[760px] overflow-hidden border border-border bg-bg-elev/25"
            aria-label="Agent waiting animation"
        >
            <div className="absolute inset-x-10 top-1/2 h-px bg-border" />
            <div className="absolute inset-y-8 left-1/2 w-px bg-border" />

            <div className="agent-rail agent-rail-a" />
            <div className="agent-rail agent-rail-b" />
            <div className="agent-rail agent-rail-c" />
            <div className="agent-rail agent-rail-d" />

            <div className="agent-node left-[13%] top-[20%]" />
            <div className="agent-node right-[16%] top-[24%]" />
            <div className="agent-node left-[18%] bottom-[22%]" />
            <div className="agent-node right-[12%] bottom-[19%]" />

            <div className="absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2">
                <div className="agent-ring agent-ring-slow" />
                <div className="agent-ring agent-ring-fast" />
                <div className="agent-aperture" />
                <div className="absolute inset-[58px] border border-accent/50 bg-bg">
                    <div className="agent-core-grid" />
                    <div className="absolute inset-0 animate-[agentPulse_2.8s_ease-in-out_infinite] border border-yes/40" />
                    <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 bg-accent" />
                </div>
            </div>

            <div className="agent-ticker left-[9%] top-[47%]" />
            <div className="agent-ticker right-[9%] top-[47%]" />
            <div className="agent-ticker left-[47%] top-[9%] rotate-90" />
            <div className="agent-ticker left-[47%] bottom-[9%] rotate-90" />

            <style>{`
                .agent-rail {
                    position: absolute;
                    height: 1px;
                    background: linear-gradient(90deg, transparent, rgba(125, 249, 166, 0.75), transparent);
                    transform-origin: center;
                    animation: agentRail 3.6s linear infinite;
                }
                .agent-rail-a { left: 12%; right: 52%; top: 30%; animation-delay: -0.4s; }
                .agent-rail-b { left: 52%; right: 13%; top: 34%; animation-delay: -1.4s; }
                .agent-rail-c { left: 15%; right: 54%; bottom: 31%; animation-delay: -2.1s; }
                .agent-rail-d { left: 54%; right: 10%; bottom: 28%; animation-delay: -2.8s; }
                .agent-node {
                    position: absolute;
                    width: 10px;
                    height: 10px;
                    border: 1px solid rgba(125, 249, 166, 0.45);
                    background: rgba(125, 249, 166, 0.08);
                    animation: agentNode 2.4s ease-in-out infinite;
                }
                .agent-node:nth-of-type(6) { animation-delay: -0.6s; }
                .agent-node:nth-of-type(7) { animation-delay: -1.2s; }
                .agent-node:nth-of-type(8) { animation-delay: -1.8s; }
                .agent-ring {
                    position: absolute;
                    inset: 0;
                    border: 1px solid rgba(255, 255, 255, 0.13);
                }
                .agent-ring::before,
                .agent-ring::after {
                    content: "";
                    position: absolute;
                    width: 18px;
                    height: 18px;
                    border: 1px solid rgba(125, 249, 166, 0.55);
                    background: #070808;
                }
                .agent-ring::before { left: -9px; top: calc(50% - 9px); }
                .agent-ring::after { right: -9px; top: calc(50% - 9px); }
                .agent-ring-slow { animation: agentSpin 18s linear infinite; }
                .agent-ring-fast { inset: 22px; animation: agentSpin 9s linear infinite reverse; }
                .agent-aperture {
                    position: absolute;
                    inset: 36px;
                    border: 1px solid rgba(125, 249, 166, 0.28);
                    animation: agentAperture 4.5s ease-in-out infinite;
                }
                .agent-core-grid {
                    position: absolute;
                    inset: 8px;
                    background-image:
                        linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px);
                    background-size: 12px 12px;
                    animation: agentGrid 2.4s linear infinite;
                }
                .agent-ticker {
                    position: absolute;
                    width: 46px;
                    height: 6px;
                    border-left: 1px solid rgba(125, 249, 166, 0.45);
                    border-right: 1px solid rgba(125, 249, 166, 0.45);
                    animation: agentTicker 1.8s steps(4, end) infinite;
                }
                @keyframes agentRail {
                    0% { opacity: 0.12; transform: scaleX(0.25); }
                    45% { opacity: 0.8; transform: scaleX(1); }
                    100% { opacity: 0.12; transform: scaleX(0.25); }
                }
                @keyframes agentNode {
                    0%, 100% { opacity: 0.35; transform: scale(1); }
                    50% { opacity: 1; transform: scale(1.45); }
                }
                @keyframes agentSpin {
                    to { transform: rotate(360deg); }
                }
                @keyframes agentAperture {
                    0%, 100% { transform: rotate(0deg) scale(1); opacity: 0.6; }
                    50% { transform: rotate(45deg) scale(0.82); opacity: 1; }
                }
                @keyframes agentGrid {
                    to { background-position: 12px 12px; }
                }
                @keyframes agentPulse {
                    0%, 100% { transform: scale(1); opacity: 0.3; }
                    50% { transform: scale(1.18); opacity: 0.9; }
                }
                @keyframes agentTicker {
                    0%, 100% { opacity: 0.25; box-shadow: inset 8px 0 0 rgba(125, 249, 166, 0.2); }
                    50% { opacity: 0.9; box-shadow: inset 38px 0 0 rgba(125, 249, 166, 0.45); }
                }
            `}</style>
        </div>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function actionAccent(action: AgentAction) {
    switch (action) {
        case "buy_yes":
            return {
                border: "border-yes/35",
                text: "text-yes",
                dot: "bg-yes",
            };
        case "buy_no":
            return {
                border: "border-no/35",
                text: "text-no",
                dot: "bg-no",
            };
        default:
            return {
                border: "border-border",
                text: "text-text-mute",
                dot: "bg-text-faint",
            };
    }
}

function pct(p: number): string {
    return `${(p * 100).toFixed(1)}%`;
}

function short(addr: string): string {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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
