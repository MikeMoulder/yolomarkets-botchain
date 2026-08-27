"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { ShareButton } from "@/components/share-button";
import { ADDRESSES, erc20Abi, Outcome } from "@/lib/contracts";
import {
    formatCents,
    formatOutcomeLabel,
    formatUsdc,
    priceToProb,
    shortAddr,
} from "@/lib/format";

// The v2 market list is supplied by the server (from the Postgres catalog
// index) so the browser never reads `allMarkets()` or does a per-market
// `getLogs` scan across ~15k markets — that fan-out (≈90k contract reads +
// ≈44k log queries) was freezing the tab. Here we only read the connected
// user's shares, in small multicall batches.
export type PortfolioMarket = {
    address: Address;
    question: string;
    priceYes: string; // 1e18, serialized as string across the RSC boundary
    resolved: boolean;
    outcome: Outcome;
};

type Row = {
    address: Address;
    question: string;
    priceYes: bigint;
    resolved: boolean;
    outcome: Outcome;
    sharesYes: bigint;
    sharesNo: bigint;
};

export function PortfolioClient({ markets }: { markets: PortfolioMarket[] }) {
    // useActiveWallet unifies wagmi (MetaMask/injected) AND Circle email/OTP
    // wallets — raw useAccount() only sees the former, which is why Circle users
    // saw "Connect wallet" here while external wallets worked.
    const { address, isConnected } = useActiveWallet();

    const { data: usdc } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 15_000 },
    });

    // Positions come from the server (/api/portfolio/positions), not the
    // browser. Scanning every v2 market here meant 133 sequential multicalls —
    // longer than this query's own refetch interval, so scans overlapped and
    // the public RPC answered 429 to everything. The server does it once with
    // big aggregates and caches the result.
    const {
        data: sharesByMarket = {},
        isLoading: sharesLoading,
    } = useQuery({
        queryKey: ["portfolio-positions", address],
        enabled: !!address,
        staleTime: 15_000,
        refetchInterval: 30_000,
        queryFn: async () => {
            const res = await fetch(`/api/portfolio/positions?user=${address}`);
            if (!res.ok) throw new Error(`positions ${res.status}`);
            const json = (await res.json()) as {
                positions: { address: string; sharesYes: string; sharesNo: string }[];
            };
            const out: Record<string, { yes: bigint; no: bigint }> = {};
            for (const p of json.positions) {
                out[p.address.toLowerCase()] = {
                    yes: BigInt(p.sharesYes),
                    no: BigInt(p.sharesNo),
                };
            }
            return out;
        },
    });

    if (!isConnected) {
        return (
            <Empty
                title="not connected"
                body="Connect a wallet to see the positions, claims, and PnL belonging to that address."
            />
        );
    }

    if (markets.length === 0) {
        return <Empty title="no markets" body="There aren't any markets to show yet." />;
    }

    const rows: Row[] = markets
        .map((m) => {
            const s = sharesByMarket[m.address.toLowerCase()];
            return {
                address: m.address,
                question: m.question,
                priceYes: BigInt(m.priceYes),
                resolved: m.resolved,
                outcome: m.outcome,
                sharesYes: s?.yes ?? 0n,
                sharesNo: s?.no ?? 0n,
            };
        })
        .filter((r) => r.sharesYes > 0n || r.sharesNo > 0n);

    const openRows = rows.filter((r) => !r.resolved);
    const historyRows = rows.filter((r) => r.resolved);

    const stillLoading = sharesLoading && rows.length === 0;

    // Aggregate exposure over open positions.
    const totalShares = openRows.reduce(
        (acc, r) => ({ yes: acc.yes + r.sharesYes, no: acc.no + r.sharesNo }),
        { yes: 0n, no: 0n },
    );

    // Mark-to-market value of unresolved positions only.
    const mtmTotal = openRows.reduce((acc, r) => {
        const pYes = priceToProb(r.priceYes);
        const mtmYes = Number(r.sharesYes) * pYes;
        const mtmNo = Number(r.sharesNo) * (1 - pYes);
        return acc + mtmYes + mtmNo;
    }, 0);

    return (
        <div className="space-y-8">
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border border border-border">
                <SummaryCell
                    label="USDT balance"
                    value={usdc !== undefined ? `$${formatUsdc(usdc)}` : "—"}
                />
                <SummaryCell label="open positions" value={openRows.length.toString()} />
                <SummaryCell label="history" value={historyRows.length.toString()} />
                <SummaryCell
                    label="shares (yes / no)"
                    value={`${formatUsdc(totalShares.yes)} / ${formatUsdc(totalShares.no)}`}
                    valueClass="tabular"
                />
                <SummaryCell
                    label="mark-to-market"
                    value={`$${(mtmTotal / 1e6).toFixed(2)}`}
                />
            </div>

            {/* Open positions */}
            <section className="border border-border">
                <div className="border-b border-border px-5 py-2.5 flex items-baseline justify-between">
                    <h2 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                        / open positions
                    </h2>
                    <span className="num text-[11px] text-text-faint">
                        {stillLoading ? "scanning…" : `${openRows.length} open`}
                    </span>
                </div>

                {stillLoading ? (
                    <div className="px-6 py-16 text-center text-text-mute text-[13px]">
                        loading positions…
                    </div>
                ) : openRows.length === 0 ? (
                    <div className="px-6 py-16 text-center">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                            no open positions
                        </div>
                        <p className="text-[13px] text-text-dim">
                            Place a bet from any market and it'll appear here.
                        </p>
                        <Link
                            href="/"
                            className="inline-block mt-4 text-[12px] text-text-dim hover:text-text border border-border-strong px-3 py-1.5 transition-colors"
                        >
                            browse markets →
                        </Link>
                    </div>
                ) : (
                    <div className="divide-y divide-border">
                        {openRows.map((r) => (
                            <PositionRow key={r.address} row={r} holder={address} />
                        ))}
                    </div>
                )}
            </section>

            {/* Resolved history (positions you still hold in resolved markets) */}
            <section className="border border-border">
                <div className="border-b border-border px-5 py-2.5 flex items-baseline justify-between">
                    <h2 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                        / history
                    </h2>
                    <span className="num text-[11px] text-text-faint">
                        {stillLoading ? "scanning…" : `${historyRows.length} resolved`}
                    </span>
                </div>

                {historyRows.length === 0 ? (
                    <div className="px-6 py-12 text-center">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                            no resolved history
                        </div>
                        <p className="text-[13px] text-text-dim">
                            Resolved markets where you still hold shares (unclaimed wins,
                            losses, cancellations) appear here.
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-border">
                        {historyRows.map((r) => (
                            <HistoryRow key={r.address} row={r} holder={address} />
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

function SummaryCell({
    label,
    value,
    valueClass,
}: {
    label: string;
    value: string;
    valueClass?: string;
}) {
    return (
        <div className="bg-bg px-5 py-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute mb-2">
                {label}
            </div>
            <div className={`num text-[20px] text-text tabular ${valueClass ?? ""}`}>
                {value}
            </div>
        </div>
    );
}

function PositionRow({ row, holder }: { row: Row; holder?: Address | null }) {
    const pYes = priceToProb(row.priceYes);
    const mtmYes = Number(row.sharesYes) * pYes;
    const mtmNo = Number(row.sharesNo) * (1 - pYes);
    const mtm = (mtmYes + mtmNo) / 1e6;

    return (
        <Link
            href={`/markets/${row.address}`}
            className="block px-5 py-4 hover:bg-bg-elev transition-colors"
        >
            <div className="grid grid-cols-12 gap-4 items-center">
                <div className="col-span-12 md:col-span-6">
                    <div className="text-[14px] text-text leading-snug">{row.question}</div>
                    <div className="num text-[10px] text-text-faint mt-1">
                        {shortAddr(row.address, 6)}
                    </div>
                </div>

                <div className="col-span-6 md:col-span-3 flex flex-col gap-1">
                    {row.sharesYes > 0n && (
                        <div className="flex items-baseline gap-2 num text-[12.5px]">
                            <span className="text-yes uppercase tracking-wider text-[10px] w-8">
                                yes
                            </span>
                            <span className="text-text-dim tabular">{formatUsdc(row.sharesYes)}</span>
                            <span className="text-text-faint">@</span>
                            <span className="text-text-mute tabular">{formatCents(pYes)}</span>
                        </div>
                    )}
                    {row.sharesNo > 0n && (
                        <div className="flex items-baseline gap-2 num text-[12.5px]">
                            <span className="text-no uppercase tracking-wider text-[10px] w-8">
                                no
                            </span>
                            <span className="text-text-dim tabular">{formatUsdc(row.sharesNo)}</span>
                            <span className="text-text-faint">@</span>
                            <span className="text-text-mute tabular">{formatCents(1 - pYes)}</span>
                        </div>
                    )}
                </div>

                <div className="col-span-6 md:col-span-3 flex items-center justify-end gap-3">
                    <div className="num text-[13px] text-text tabular text-right">
                        ${mtm.toFixed(2)}
                        <span className="text-text-faint text-[10px] ml-1 uppercase tracking-wider">
                            mtm
                        </span>
                    </div>
                    {holder && (
                        <ShareButton
                            address={row.address}
                            question={row.question}
                            user={holder}
                            compact
                        />
                    )}
                </div>
            </div>
        </Link>
    );
}

function HistoryRow({ row, holder }: { row: Row; holder?: Address | null }) {
    const payout = claimablePayout(row);
    const status = historyStatus(row);
    const statusClass =
        status === "won"
            ? "text-yes"
            : status === "lost"
              ? "text-no"
              : "text-text-mute";

    return (
        <Link
            href={`/markets/${row.address}`}
            className="block px-5 py-4 hover:bg-bg-elev transition-colors"
        >
            <div className="grid grid-cols-12 gap-4 items-center">
                <div className="col-span-12 md:col-span-6">
                    <div className="text-[14px] text-text leading-snug">{row.question}</div>
                    <div className="num text-[10px] text-text-faint mt-1">
                        {shortAddr(row.address, 6)}
                    </div>
                </div>

                <div className="col-span-6 md:col-span-3 flex flex-col gap-1">
                    {row.sharesYes > 0n && <HistoryShareLine side="yes" shares={row.sharesYes} />}
                    {row.sharesNo > 0n && <HistoryShareLine side="no" shares={row.sharesNo} />}
                </div>

                <div className="col-span-6 md:col-span-3 text-right">
                    <div className="num text-[11px] uppercase tracking-[0.16em] text-text-mute">
                        {formatOutcomeLabel(row.outcome)}
                    </div>
                    <div className={`num text-[12.5px] uppercase tracking-[0.14em] mt-1 ${statusClass}`}>
                        {status}
                    </div>
                    {payout > 0n && (
                        <div className="num text-[10px] text-text-faint mt-1">
                            ${formatUsdc(payout)} claimable
                        </div>
                    )}
                    {holder && (
                        <div className="flex justify-end mt-2">
                            <ShareButton
                                address={row.address}
                                question={row.question}
                                user={holder}
                                compact
                            />
                        </div>
                    )}
                </div>
            </div>
        </Link>
    );
}

function HistoryShareLine({ side, shares }: { side: "yes" | "no"; shares: bigint }) {
    const color = side === "yes" ? "text-yes" : "text-no";
    return (
        <div className="flex items-baseline gap-2 num text-[12.5px]">
            <span className={`${color} uppercase tracking-wider text-[10px] w-8`}>{side}</span>
            <span className="text-text-dim tabular">{formatUsdc(shares)}</span>
        </div>
    );
}

function claimablePayout(row: Row): bigint {
    if (!row.resolved) return 0n;
    if (row.outcome === Outcome.Yes) return row.sharesYes;
    if (row.outcome === Outcome.No) return row.sharesNo;
    return 0n;
}

function historyStatus(row: Row): string {
    if (row.outcome === Outcome.Cancelled) return "cancelled";
    if (claimablePayout(row) > 0n) return "won";
    return "lost";
}

function Empty({ title, body }: { title: string; body: string }) {
    return (
        <div className="border border-dashed border-border px-6 py-20 text-center">
            <div className="text-[11px] uppercase tracking-[0.18em] text-text-mute mb-2">
                / {title}
            </div>
            <p className="text-[13px] text-text-dim max-w-[40ch] mx-auto">{body}</p>
        </div>
    );
}
