import { requireAdminSession } from "@/lib/admin-session";
import { fetchWrappablePolymarketMarkets } from "@/lib/polymarket";
import { listMarkets, listTreasuryResiduals, publicClient } from "@/lib/markets";
import { matchesFastMarket } from "@/lib/fast-markets";
import { DeployPanel } from "./deploy-panel";
import { ResolutionPanel, type ResolvableRow, type ResolvedRow } from "./resolution-panel";
import { LogoutButton } from "./logout-button";
import { formatAbs, formatOutcomeLabel, formatUsdc, shortAddr } from "@/lib/format";
import Link from "next/link";
import { isAddress, type Address } from "viem";
import { WithdrawButton } from "./withdraw-button";
import { WithdrawAllButton } from "./withdraw-all-button";
import { ADDRESSES, factoryAbi } from "@/lib/contracts";
import { priceToProb } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Deploy" };

export default async function AdminPage() {
    const session = await requireAdminSession("/admin");
    const treasuryRecipient = getTreasuryRecipient(session.address);
    const minVolume24h = Number(process.env.POLYMARKET_ADMIN_MIN_VOLUME_24H ?? "0");

    const [eventsRes, nativeRes] = await Promise.allSettled([
        fetchWrappablePolymarketMarkets({
            order: "volume24hr",
            limit: 300,
            scanLimit: 500,
            includeGroupChildren: true,
            minVolume24h,
            revalidate: 86_400,
        }),
        listMarkets(),
    ]);
    const events = eventsRes.status === "fulfilled" ? eventsRes.value : [];
    const native = nativeRes.status === "fulfilled" ? nativeRes.value : [];

    // Build a set of normalized native questions so we can flag "already on BOT Chain"
    const nativeQuestionSet = new Set(
        native.map((m) => m.question.trim().toLowerCase()),
    );

    // ── Manual resolution ────────────────────────────────────────────────
    // Fast markets are excluded: fast-market-keeper settles those on a timer,
    // and hand-settling one would race it. Everything else that is past its
    // deadline needs a human.
    const nowSecAdmin = Math.floor(Date.now() / 1000);
    const settleable = native.filter((m) => !matchesFastMarket(m));
    const toRow = (m: (typeof settleable)[number]): ResolvableRow => ({
        address: m.address,
        question: m.question,
        category: m.category,
        deadline: Number(m.deadline),
        legacy: m.legacy ?? false,
        yesProb: priceToProb(m.priceYes),
        liquidityUsd: Number(m.totalLiquidity) / 1e6,
    });
    const awaitingResolution: ResolvableRow[] = settleable
        .filter((m) => !m.resolved && Number(m.deadline) <= nowSecAdmin)
        .sort((a, b) => Number(a.deadline) - Number(b.deadline))
        .map(toRow);
    const resolvedHistory: ResolvedRow[] = settleable
        .filter((m) => m.resolved)
        .sort((a, b) => Number(b.deadline) - Number(a.deadline))
        .slice(0, 60)
        .map((m) => ({ ...toRow(m), outcome: m.outcome as number }));

    // Which wallet may settle: v2 separates resolver from admin (audit H-1/H-2).
    const [resolverAddress, adminAddress] = await Promise.all([
        publicClient
            .readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: "resolver" })
            .catch(() => null) as Promise<Address | null>,
        publicClient
            .readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: "admin" })
            .catch(() => null) as Promise<Address | null>,
    ]);

    const residualRows = await listTreasuryResiduals(native);
    const fastResidualRows = residualRows.filter(({ market }) => matchesFastMarket(market));
    const revenueRows = residualRows.filter(({ market }) => !matchesFastMarket(market));

    fastResidualRows.sort(
        (a, b) =>
            Number(b.revenue.treasuryWithdrawable) - Number(a.revenue.treasuryWithdrawable),
    );
    revenueRows.sort(
        (a, b) =>
            Number(b.revenue.treasuryWithdrawable) - Number(a.revenue.treasuryWithdrawable),
    );

    return (
        <div className="mx-auto max-w-[1440px] px-6 py-8">
            {/* Header strip */}
            <header className="border-b border-border pb-5 mb-6">
                <div className="flex items-end justify-between gap-4 flex-wrap">
                    <div>
                        <div className="flex items-baseline gap-3 mb-2">
                            <span className="section-number text-[11px] tabular">00</span>
                            <span className="text-[11px] uppercase tracking-[0.24em] text-accent num">
                                Restricted · admin
                            </span>
                        </div>
                        <h1 className="text-[26px] font-medium tracking-tight text-text">
                            Market deployment
                        </h1>
                        <p className="mt-1.5 text-[12.5px] text-text-dim max-w-[60ch] leading-[1.55]">
                            Wrap any reference binary event into a YOLO market on BOT Chain by
                            calling{" "}
                            <span className="num text-text">
                                MarketFactory.createMarket
                            </span>
                            . Seed liquidity is paid in USDC from the connected admin
                            wallet.
                        </p>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] num">
                        <div className="border border-border bg-bg-elev rounded-sm px-3 py-1.5">
                            <span className="text-text-faint uppercase tracking-[0.18em] text-[9.5px] mr-2">
                                withdrawals
                            </span>
                            <span className="text-text tabular">
                                {shortAddr(treasuryRecipient)}
                            </span>
                        </div>
                        <div className="border border-border bg-bg-elev rounded-sm px-3 py-1.5">
                            <span className="text-text-faint uppercase tracking-[0.18em] text-[9.5px] mr-2">
                                session
                            </span>
                            <span className="text-text tabular">
                                {shortAddr(session.address)}
                            </span>
                        </div>
                        <LogoutButton />
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
                    <Stat label="catalog" value={String(events.length)} unit="events shown" />
                    <Stat
                        label="on arc"
                        value={String(native.length)}
                        unit="native markets"
                    />
                    <Stat label="settlement" value="USDT" unit="6-dec, Bohr testnet" />
                    <Stat label="factory" value="0x1BED…7441" unit="MarketFactory" />
                </div>
            </header>

            {/* Deploy panel does the actual wrapping via wagmi. */}
            <DeployPanel
                events={events.map((e) => ({
                    id: e.id,
                    title: e.title,
                    slug: e.slug,
                    image: e.image,
                    category: e.category,
                    yesPrice: e.outcomes[0]?.yesPrice ?? 0.5,
                    deltaPct: e.outcomes[0]?.deltaPct ?? 0,
                    volume24h: e.volume24h,
                    endTs: e.endTs,
                    alreadyOnArc: nativeQuestionSet.has(e.title.trim().toLowerCase()),
                }))}
            />

            <ResolutionPanel
                awaiting={awaitingResolution}
                resolved={resolvedHistory}
                resolverAddress={resolverAddress}
                adminAddress={adminAddress}
            />

            <section className="mt-8 border border-border bg-bg-elev rounded-[2px] overflow-hidden">
                <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
                    <div className="flex items-baseline gap-3">
                        <span className="section-number text-[11px] tabular">03</span>
                        <h2 className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                            Fast market residuals
                        </h2>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="num text-[11px] text-text-faint">
                            only contracts with withdrawable USDC
                        </span>
                        <WithdrawAllButton
                            recipient={treasuryRecipient}
                            items={fastResidualRows.map(({ market, revenue }) => ({
                                market: market.address,
                                withdrawable: revenue.treasuryWithdrawable.toString(),
                                legacy: market.legacy,
                            }))}
                        />
                    </div>
                </header>

                {fastResidualRows.length === 0 ? (
                    <div className="px-4 py-8 text-[12px] text-text-dim">
                        No fast market contracts currently have residual funds.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[1040px] text-[12px]">
                            <thead className="bg-bg-elev-2/50 text-text-faint uppercase tracking-[0.16em] text-[10px]">
                                <tr>
                                    <th className="text-left px-4 py-2.5 font-normal">fast market</th>
                                    <th className="text-left px-4 py-2.5 font-normal">state</th>
                                    <th className="text-right px-4 py-2.5 font-normal">deadline</th>
                                    <th className="text-right px-4 py-2.5 font-normal">contract balance</th>
                                    <th className="text-right px-4 py-2.5 font-normal">reserve</th>
                                    <th className="text-right px-4 py-2.5 font-normal">residual</th>
                                    <th className="text-right px-4 py-2.5 font-normal">action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {fastResidualRows.map(({ market, revenue }) => (
                                    <tr key={market.address} className="border-t border-border">
                                        <td className="px-4 py-2.5 text-text-dim">
                                            <Link
                                                href={`/markets/${market.address}`}
                                                className="hover:text-text transition-colors"
                                            >
                                                {market.question}
                                            </Link>
                                            <div className="num text-[10px] text-text-faint mt-1">
                                                {shortAddr(market.address, 6)}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-left num tabular text-text-dim">
                                            {market.resolved
                                                ? formatOutcomeLabel(market.outcome)
                                                : "live"}
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-text-dim">
                                            {formatAbs(market.deadline)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-text-dim">
                                            ${formatUsdc(market.totalLiquidity)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-text-dim">
                                            ${formatUsdc(revenue.reserveRequired)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-accent">
                                            ${formatUsdc(revenue.treasuryWithdrawable)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right">
                                            <WithdrawButton
                                                market={market.address}
                                                recipient={treasuryRecipient}
                                                withdrawable={revenue.treasuryWithdrawable}
                                                legacy={market.legacy}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className="mt-8 border border-border bg-bg-elev rounded-[2px] overflow-hidden">
                <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
                    <div className="flex items-baseline gap-3">
                        <span className="section-number text-[11px] tabular">04</span>
                        <h2 className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                            Standard market revenue
                        </h2>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="num text-[11px] text-text-faint">
                            non-fast contracts with withdrawable USDC
                        </span>
                        <WithdrawAllButton
                            recipient={treasuryRecipient}
                            items={revenueRows.map(({ market, revenue }) => ({
                                market: market.address,
                                withdrawable: revenue.treasuryWithdrawable.toString(),
                                legacy: market.legacy,
                            }))}
                        />
                    </div>
                </header>

                {revenueRows.length === 0 ? (
                    <div className="px-4 py-8 text-[12px] text-text-dim">
                        No standard market contracts currently have withdrawable funds.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[960px] text-[12px]">
                            <thead className="bg-bg-elev-2/50 text-text-faint uppercase tracking-[0.16em] text-[10px]">
                                <tr>
                                    <th className="text-left px-4 py-2.5 font-normal">market</th>
                                    <th className="text-right px-4 py-2.5 font-normal">fee</th>
                                    <th className="text-right px-4 py-2.5 font-normal">accrued fees</th>
                                    <th className="text-right px-4 py-2.5 font-normal">reserve</th>
                                    <th className="text-right px-4 py-2.5 font-normal">withdrawable</th>
                                    <th className="text-right px-4 py-2.5 font-normal">action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {revenueRows.map(({ market, revenue }) => (
                                    <tr key={market.address} className="border-t border-border">
                                        <td className="px-4 py-2.5 text-text-dim">
                                            <Link
                                                href={`/markets/${market.address}`}
                                                className="hover:text-text transition-colors"
                                            >
                                                {market.question}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-text-dim">
                                            {(revenue.protocolFeeBps / 100).toFixed(2)}%
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-text-dim">
                                            ${formatUsdc(revenue.accruedFees)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-text-dim">
                                            ${formatUsdc(revenue.reserveRequired)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right num tabular text-text">
                                            ${formatUsdc(revenue.treasuryWithdrawable)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right">
                                            <WithdrawButton
                                                market={market.address}
                                                recipient={treasuryRecipient}
                                                withdrawable={revenue.treasuryWithdrawable}
                                                legacy={market.legacy}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}

function getTreasuryRecipient(fallback: string): Address {
    const configured = process.env.DEPLOYER_ADDRESS;
    if (configured && isAddress(configured)) return configured;
    if (isAddress(fallback)) return fallback;
    throw new Error("No valid DEPLOYER_ADDRESS configured for admin withdrawals.");
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
        <div className="border border-border bg-bg-elev-2/40 rounded-sm px-3 py-2.5">
            <div className="text-[9px] uppercase tracking-[0.22em] text-text-faint mb-1 num">
                {label}
            </div>
            <div className="num text-[15px] tabular text-text leading-none">
                {value}
                {unit && (
                    <span className="text-text-faint text-[10px] ml-1.5 lowercase tracking-normal">
                        {unit}
                    </span>
                )}
            </div>
        </div>
    );
}
