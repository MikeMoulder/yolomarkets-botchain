"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { signProfileOp } from "@/lib/client-auth";
import { EXPLORER_URL } from "@/lib/explorer";

export type SerializablePosition = {
    market: string;
    question: string;
    outcome: 1 | 2; // YES | NO
    shares: string; // micro, bigint-as-string
    exitProceeds: string; // micro
};

const EXPLORER_TX = `${EXPLORER_URL}/tx/`;

function fmtUsd(micro: bigint): string {
    return `$${(Number(micro) / 1e6).toFixed(2)}`;
}
function fmtShares(micro: bigint): string {
    return (Number(micro) / 1e6).toFixed(2);
}

export function AgentPositionsPanel({
    userAddr,
    positions,
    walletBalanceMicro,
}: {
    userAddr: string;
    positions: SerializablePosition[];
    walletBalanceMicro: string;
}) {
    const { address } = useAccount();
    const isOwner =
        !!address && address.toLowerCase() === userAddr.toLowerCase();

    return (
        <section className="mt-8 flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-4 mb-1">
                <h2 className="text-[12px] uppercase tracking-[0.22em] text-text-mute">
                    / open positions
                </h2>
                <span className="num text-[11px] text-text-faint">
                    {positions.length} live
                </span>
            </div>

            {!isOwner && (
                <div className="border border-border bg-bg-elev/20 px-4 py-2.5 text-[11.5px] text-text-mute num">
                    Connect the owner wallet ({userAddr.slice(0, 6)}…
                    {userAddr.slice(-4)}) to exit positions or withdraw.
                </div>
            )}

            <WithdrawRow
                userAddr={userAddr}
                isOwner={isOwner}
                balanceMicro={walletBalanceMicro}
            />

            {positions.length > 0 ? (
                positions.map((p) => (
                    <PositionRow
                        key={`${p.market}-${p.outcome}`}
                        userAddr={userAddr}
                        isOwner={isOwner}
                        position={p}
                    />
                ))
            ) : (
                <div className="border border-border bg-bg-elev/30 px-5 py-5 text-[13px] text-text-dim">
                    No open positions. The agent auto-claims winnings from
                    resolved markets; positions you can exit early show up here.
                </div>
            )}
        </section>
    );
}

function WithdrawRow({
    userAddr,
    isOwner,
    balanceMicro,
}: {
    userAddr: string;
    isOwner: boolean;
    balanceMicro: string;
}) {
    const { signMessageAsync } = useSignMessage();
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [tx, setTx] = useState<string | null>(null);
    const balance = BigInt(balanceMicro);

    async function withdraw() {
        if (!isOwner || busy || balance === 0n) return;
        setBusy(true);
        setMsg(null);
        setTx(null);
        try {
            const headers = await signProfileOp({
                op: "agent.wallet.withdraw",
                userAddr,
                signMessageAsync,
            });
            const r = await fetch("/api/agent/wallet/withdraw", {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify({ userAddr }), // full balance
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error ?? "withdraw failed");
            setTx(data.txHash);
            setMsg(`Withdrew ${fmtUsd(BigInt(data.amountMicro))} to your wallet`);
        } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="border border-border bg-bg-elev/40 px-5 py-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
                <span className="text-[9.5px] uppercase tracking-[0.18em] text-text-mute num">
                    agent wallet balance
                </span>
                <span className="num tabular text-[18px] leading-none text-text">
                    {fmtUsd(balance)}
                </span>
                {msg && (
                    <span
                        className={`num text-[11px] mt-1 ${tx ? "text-yes" : "text-no"}`}
                    >
                        {tx ? (
                            <a
                                href={`${EXPLORER_TX}${tx}`}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-text underline"
                            >
                                {msg} ↗
                            </a>
                        ) : (
                            msg
                        )}
                    </span>
                )}
            </div>
            <button
                type="button"
                onClick={withdraw}
                disabled={!isOwner || busy || balance === 0n}
                className="num text-[11px] uppercase tracking-[0.18em] border border-accent/40 text-accent px-4 py-2 hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
                {busy ? "withdrawing…" : "withdraw to wallet"}
            </button>
        </div>
    );
}

function PositionRow({
    userAddr,
    isOwner,
    position,
}: {
    userAddr: string;
    isOwner: boolean;
    position: SerializablePosition;
}) {
    const { signMessageAsync } = useSignMessage();
    const totalShares = BigInt(position.shares);
    const [pctSell, setPctSell] = useState(100); // 1–100
    const [busy, setBusy] = useState(false);
    const [quote, setQuote] = useState<string | null>(position.exitProceeds);
    const [msg, setMsg] = useState<string | null>(null);
    const [tx, setTx] = useState<string | null>(null);

    const sellShares = (totalShares * BigInt(pctSell)) / 100n;
    const sideLabel = position.outcome === 1 ? "YES" : "NO";
    const sideTone = position.outcome === 1 ? "text-yes" : "text-no";

    async function refreshQuote(nextPct: number) {
        const shares = (totalShares * BigInt(nextPct)) / 100n;
        if (shares <= 0n) {
            setQuote("0");
            return;
        }
        try {
            const r = await fetch(
                `/api/agent/positions/exit?market=${position.market}&outcome=${position.outcome}&shares=${shares.toString()}`,
            );
            const data = await r.json();
            if (r.ok) setQuote(data.received);
        } catch {
            /* keep last quote */
        }
    }

    async function exit() {
        if (!isOwner || busy || sellShares <= 0n) return;
        setBusy(true);
        setMsg(null);
        setTx(null);
        try {
            const headers = await signProfileOp({
                op: "agent.position.exit",
                userAddr,
                signMessageAsync,
            });
            const r = await fetch("/api/agent/positions/exit", {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify({
                    userAddr,
                    market: position.market,
                    outcome: position.outcome,
                    shares: sellShares.toString(),
                }),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error ?? "exit failed");
            setTx(data.txHash);
            setMsg(`Sold ${fmtShares(BigInt(data.shares))} ${sideLabel} shares`);
        } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <article className="border border-border bg-bg-elev/40 px-5 py-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
                <h3 className="text-[14.5px] leading-snug text-text min-w-0">
                    {position.question}
                </h3>
                <span
                    className={`num text-[10px] uppercase tracking-[0.2em] ${sideTone} border border-current/30 px-2 py-0.5 shrink-0`}
                >
                    {sideLabel}
                </span>
            </div>

            <div className="grid grid-cols-3 gap-3 text-[12px]">
                <Cell label="held" value={`${fmtShares(totalShares)} sh`} />
                <Cell
                    label="selling"
                    value={`${fmtShares(sellShares)} sh`}
                    tone={sideTone}
                />
                <Cell
                    label="you receive"
                    value={quote ? fmtUsd(BigInt(quote)) : "—"}
                    tone="text-text"
                />
            </div>

            <div className="flex items-center gap-3">
                <input
                    type="range"
                    min={1}
                    max={100}
                    value={pctSell}
                    disabled={!isOwner || busy}
                    onChange={(e) => setPctSell(Number(e.target.value))}
                    onMouseUp={() => refreshQuote(pctSell)}
                    onTouchEnd={() => refreshQuote(pctSell)}
                    className="flex-1 accent-accent disabled:opacity-40"
                />
                <div className="flex gap-1.5 shrink-0">
                    {[25, 50, 100].map((p) => (
                        <button
                            key={p}
                            type="button"
                            disabled={!isOwner || busy}
                            onClick={() => {
                                setPctSell(p);
                                void refreshQuote(p);
                            }}
                            className={`num text-[10px] px-2 py-1 border transition-colors disabled:opacity-40 ${
                                pctSell === p
                                    ? "border-accent text-accent"
                                    : "border-border text-text-mute hover:text-text"
                            }`}
                        >
                            {p === 100 ? "max" : `${p}%`}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex items-center justify-between gap-3">
                <span className="num text-[11px] text-text-faint">
                    {pctSell}% · exits early at AMM price (incl. fee &amp; slippage)
                </span>
                <button
                    type="button"
                    onClick={exit}
                    disabled={!isOwner || busy || sellShares <= 0n}
                    className={`num text-[11px] uppercase tracking-[0.18em] border px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${sideTone} border-current/40 hover:bg-current/10`}
                >
                    {busy ? "exiting…" : pctSell === 100 ? "exit position" : "sell"}
                </button>
            </div>

            {msg && (
                <div className={`num text-[11px] ${tx ? "text-yes" : "text-no"}`}>
                    {tx ? (
                        <a
                            href={`${EXPLORER_TX}${tx}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-text underline"
                        >
                            {msg} ↗
                        </a>
                    ) : (
                        msg
                    )}
                </div>
            )}
        </article>
    );
}

function Cell({
    label,
    value,
    tone = "text-text-dim",
}: {
    label: string;
    value: string;
    tone?: string;
}) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-[0.18em] text-text-faint num">
                {label}
            </span>
            <span className={`num tabular text-[15px] leading-none ${tone}`}>
                {value}
            </span>
        </div>
    );
}
