"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
    useReadContract,
    useSwitchChain,
    useWaitForTransactionReceipt,
    useWriteContract,
} from "wagmi";
import { type Address } from "viem";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, erc20Abi, marketAbi, Outcome } from "@/lib/contracts";
import { formatCents, formatProb, formatUsdc, priceToProb } from "@/lib/format";
import { lmsrBuyCost, lmsrPriceYes, lmsrSellProceeds } from "@/lib/lmsr";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { useWalletModal } from "@/components/wallet-modal";

const SLIPPAGE_BPS = 200; // 2%
const MIN_PRICE = 0.02;
const MAX_PRICE = 0.98;
const MAX_APPROVAL = (1n << 256n) - 1n;
type TradeMode = "buy" | "sell";

type TradeQuote = {
    shares: bigint;
    value: bigint; // buy: cost, sell: proceeds
    isLoading: boolean;
};

export function BetTicket({
    market,
    initialPriceYes,
    deadline,
    resolved,
    legacy = false,
}: {
    market: Address;
    initialPriceYes: bigint;
    // Unix seconds. Trading is closed on-chain (buy/sell revert PastDeadline)
    // once block.timestamp >= deadline; we mirror that in the UI.
    deadline: bigint;
    resolved: boolean;
    // v1-factory market: old bytecode without claimRefund(); cancelled
    // markets there still go through claim().
    legacy?: boolean;
}) {
    const router = useRouter();
    const { address, kind, isConnected, isWrongChain } = useActiveWallet();
    const { switchChain } = useSwitchChain();
    const { openWalletModal } = useWalletModal();

    const [mode, setMode] = useState<TradeMode>("buy");
    const [side, setSide] = useState<Outcome>(Outcome.Yes);
    const [amountStr, setAmountStr] = useState("5");
    const [hash, setHash] = useState<`0x${string}` | undefined>();
    const [pendingStage, setPendingStage] = useState<
        "idle" | "approving" | "buying" | "selling" | "claiming"
    >("idle");
    const [successTxHash, setSuccessTxHash] = useState<`0x${string}` | undefined>();
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [quote, setQuote] = useState<TradeQuote>({
        shares: 0n,
        value: 0n,
        isLoading: false,
    });

    // Live clock (client-only) so trading closes the instant the market passes
    // its deadline, even while the page stays open. Starts null so SSR and the
    // first client paint agree (no hydration mismatch); the effect fills it in
    // and re-checks every second. `deadline === 0n` (unknown) never expires.
    const [nowSec, setNowSec] = useState<number | null>(null);
    useEffect(() => {
        const tick = () => setNowSec(Math.floor(Date.now() / 1000));
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, []);
    const isExpired =
        nowSec !== null && deadline > 0n && nowSec >= Number(deadline);

    const amountWei = useMemo(() => {
        const f = Number.parseFloat(amountStr);
        if (!Number.isFinite(f) || f <= 0) return 0n;
        return BigInt(Math.round(f * 1e6));
    }, [amountStr]);

    const { data: priceYesRaw, refetch: refetchPriceYes } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "priceYes",
        query: { refetchInterval: 8_000, initialData: initialPriceYes },
    });

    // LMSR parameters for local quoting. `b` is immutable (fetch once); `qYes`/
    // `qNo` move with every trade, so refetch them on the same cadence as the
    // price (and after our own trades confirm). Reading these three lets us run
    // the buy/sell binary search entirely in-browser instead of hammering the
    // RPC with a previewBuy per iteration.
    const { data: bRaw } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "b",
        query: { staleTime: Infinity },
    });
    const { data: qYesRaw, refetch: refetchQYes } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "qYes",
        query: { refetchInterval: 8_000 },
    });
    const { data: qNoRaw, refetch: refetchQNo } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "qNo",
        query: { refetchInterval: 8_000 },
    });
    const { data: outcomeRaw } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "outcome",
        query: { enabled: resolved },
    });
    const pYes = priceToProb(priceYesRaw ?? initialPriceYes);
    const price = side === Outcome.Yes ? pYes : 1 - pYes;

    const quoteBudget = useMemo(() => {
        if (amountWei === 0n) return 0n;
        return (amountWei * 10_000n) / BigInt(10_000 + SLIPPAGE_BPS);
    }, [amountWei]);

    const { data: allowance, refetch: refetchAllowance } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: address ? [address, market] : undefined,
        query: { enabled: !!address },
    });

    const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 10_000 },
    });

    const { data: sharesYesRaw, refetch: refetchSharesYes } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "sharesYes",
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 10_000 },
    });

    const { data: sharesNoRaw, refetch: refetchSharesNo } = useReadContract({
        address: market,
        abi: marketAbi,
        functionName: "sharesNo",
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 10_000 },
    });

    const ownedShares = side === Outcome.Yes ? (sharesYesRaw ?? 0n) : (sharesNoRaw ?? 0n);

    const lmsrReady = bRaw !== undefined && qYesRaw !== undefined && qNoRaw !== undefined;

    const maxSellProceeds = useMemo(() => {
        if (!lmsrReady || ownedShares === 0n) return 0n;
        return lmsrSellProceeds(bRaw!, qYesRaw!, qNoRaw!, side, ownedShares);
    }, [lmsrReady, bRaw, qYesRaw, qNoRaw, side, ownedShares]);

    useEffect(() => {
        if (resolved || amountWei === 0n) {
            setQuote({ shares: 0n, value: 0n, isLoading: false });
            return;
        }
        if (!lmsrReady) {
            // LMSR parameters still loading — hold the ticket in "calculating".
            setQuote((current) => ({ ...current, isLoading: true }));
            return;
        }

        const b = bRaw!;
        const qy = qYesRaw!;
        const qn = qNoRaw!;

        // Debounce recompute on rapid input; the search itself is now pure local
        // math (no RPC) so it runs synchronously inside the timer.
        const timer = window.setTimeout(() => {
            let bestShares = 0n;
            let bestValue = 0n;

            if (mode === "buy") {
                const previewBuy = (shares: bigint) =>
                    lmsrBuyCost(b, qy, qn, side, shares);
                const withinPriceBand = (shares: bigint) => {
                    const delta = shares * 1_000_000_000_000n;
                    const nextYes = side === Outcome.Yes ? qy + delta : qy;
                    const nextNo = side === Outcome.No ? qn + delta : qn;
                    const nextPrice = lmsrPriceYes(b, nextYes, nextNo);
                    return nextPrice >= MIN_PRICE && nextPrice <= MAX_PRICE;
                };

                const scaledPrice = BigInt(Math.max(1, Math.round(price * 1_000_000)));
                let low = 0n;
                let lowCost = 0n;
                let high = (amountWei * 1_000_000n) / scaledPrice;
                if (high < 1n) high = 1n;

                let highCost = previewBuy(high);
                let expansions = 0;
                while (highCost <= quoteBudget && withinPriceBand(high) && expansions < 24) {
                    low = high;
                    lowCost = highCost;
                    high *= 2n;
                    highCost = previewBuy(high);
                    expansions += 1;
                }

                bestShares = low;
                bestValue = lowCost;

                if (highCost <= quoteBudget && withinPriceBand(high)) {
                    bestShares = high;
                    bestValue = highCost;
                } else {
                    let left = low;
                    let right = high;
                    while (left < right) {
                        const mid = (left + right + 1n) / 2n;
                        const midCost = previewBuy(mid);
                        if (midCost <= quoteBudget && withinPriceBand(mid)) {
                            bestShares = mid;
                            bestValue = midCost;
                            left = mid;
                        } else {
                            right = mid - 1n;
                        }
                    }
                }
            } else if (ownedShares > 0n) {
                const previewSell = (shares: bigint) =>
                    lmsrSellProceeds(b, qy, qn, side, shares);
                const withinPriceBand = (shares: bigint) => {
                    const delta = shares * 1_000_000_000_000n;
                    const nextYes = side === Outcome.Yes ? qy - delta : qy;
                    const nextNo = side === Outcome.No ? qn - delta : qn;
                    const nextPrice = lmsrPriceYes(b, nextYes, nextNo);
                    return nextPrice >= MIN_PRICE && nextPrice <= MAX_PRICE;
                };

                const maxProceeds = previewSell(ownedShares);
                if (maxProceeds <= amountWei && withinPriceBand(ownedShares)) {
                    bestShares = ownedShares;
                    bestValue = maxProceeds;
                } else {
                    let left = 0n;
                    let right = ownedShares;
                    while (left < right) {
                        const mid = (left + right + 1n) / 2n;
                        const midProceeds = previewSell(mid);
                        if (midProceeds <= amountWei && withinPriceBand(mid)) {
                            bestShares = mid;
                            bestValue = midProceeds;
                            left = mid;
                        } else {
                            right = mid - 1n;
                        }
                    }
                }
            }

            setQuote({ shares: bestShares, value: bestValue, isLoading: false });
        }, 150);

        return () => window.clearTimeout(timer);
    }, [
        amountWei,
        mode,
        ownedShares,
        price,
        quoteBudget,
        resolved,
        side,
        lmsrReady,
        bRaw,
        qYesRaw,
        qNoRaw,
    ]);

    const sharesToTrade = quote.shares;
    const quoteValue = quote.value;
    const maxCost = amountWei;
    const minReceived = quoteValue
        ? (quoteValue * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n
        : 0n;

    const needsApproval =
        mode === "buy" && quoteValue > 0n && (allowance === undefined || allowance < maxCost);
    const insufficientFunds =
        mode === "buy" && amountWei > 0n && (usdcBalance ?? 0n) < amountWei;

    const { writeContractAsync, isPending: writing } = useWriteContract();
    const { isLoading: confirming, isSuccess: confirmed } = useWaitForTransactionReceipt({
        hash,
        chainId: arcTestnet.id,
        query: { enabled: !!hash },
    });

    useEffect(() => {
        if (confirmed && hash) {
            void Promise.all([
                refetchAllowance(),
                refetchPriceYes(),
                refetchBalance(),
                refetchSharesYes(),
                refetchSharesNo(),
                refetchQYes(),
                refetchQNo(),
            ]);
            if (pendingStage === "buying") {
                setSuccessTxHash(hash);
                setSuccessMessage("Prediction placed successfully.");
            } else if (pendingStage === "selling") {
                setSuccessTxHash(hash);
                setSuccessMessage("Position sold successfully.");
            } else if (pendingStage === "claiming") {
                setSuccessTxHash(hash);
                setSuccessMessage("Winnings claimed successfully.");
            }
            router.refresh();
            setPendingStage("idle");
            setHash(undefined);
        }
    }, [
        confirmed,
        hash,
        pendingStage,
        refetchAllowance,
        refetchBalance,
        refetchPriceYes,
        refetchSharesNo,
        refetchSharesYes,
        refetchQYes,
        refetchQNo,
        router,
    ]);

    useEffect(() => {
        if (!successMessage) return;
        const timeout = window.setTimeout(() => {
            setSuccessMessage(null);
            setSuccessTxHash(undefined);
        }, 8000);
        return () => window.clearTimeout(timeout);
    }, [successMessage]);

    const wrongChain = kind === "external" && isWrongChain;
    const busy = writing || confirming || pendingStage !== "idle";
    const settledOutcome = outcomeRaw ?? Outcome.Unresolved;
    const sharesYes = sharesYesRaw ?? 0n;
    const sharesNo = sharesNoRaw ?? 0n;
    const hasPosition = sharesYes > 0n || sharesNo > 0n;
    const claimablePayout =
        settledOutcome === Outcome.Yes
            ? sharesYes
            : settledOutcome === Outcome.No
              ? sharesNo
              : 0n;
    const positionStatus =
        settledOutcome === Outcome.Cancelled
            ? "market cancelled"
            : claimablePayout > 0n
              ? "winning position"
              : hasPosition
                ? "position settled"
                : "no position";

    async function onClaim() {
        setPendingStage("claiming");
        // v2 markets refund cancellations via claimRefund() — claim() reverts
        // on Cancelled there. Legacy v1 bytecode only has claim().
        const useRefund = settledOutcome === Outcome.Cancelled && !legacy;
        try {
            const h = await writeContractAsync({
                address: market,
                abi: marketAbi,
                functionName: useRefund ? "claimRefund" : "claim",
                args: [],
            });
            setHash(h);
        } catch (e) {
            console.error(e);
            setPendingStage("idle");
        }
    }

    if (resolved) {
        const resultLabel =
            settledOutcome === Outcome.Unresolved
                ? "pending"
                : settledOutcome === Outcome.Cancelled
                  ? "cancelled"
                  : settledOutcome === Outcome.Yes
                    ? "YES"
                    : "NO";

        const isWin = isConnected && hasPosition && claimablePayout > 0n;
        const isLoss = isConnected && hasPosition && claimablePayout === 0n && settledOutcome !== Outcome.Cancelled && settledOutcome !== Outcome.Unresolved;
        const isCancelled = settledOutcome === Outcome.Cancelled;

        return (
            <Panel title="Trade">
                <div className="px-5 py-5 space-y-5">
                    {/* Result icon */}
                    <div className="flex flex-col items-center gap-2 py-3">
                        {isWin ? (
                            <div className="flex items-center justify-center w-16 h-16 rounded-full border-2 border-yes bg-yes/10">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-yes">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            </div>
                        ) : isLoss ? (
                            <div className="flex items-center justify-center w-16 h-16 rounded-full border-2 border-no bg-no/10">
                                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-no">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </div>
                        ) : (
                            <div className="flex items-center justify-center w-16 h-16 rounded-full border-2 border-border bg-bg-elev">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-mute">
                                    <circle cx="12" cy="12" r="10" />
                                    <line x1="12" y1="8" x2="12" y2="12" />
                                    <line x1="12" y1="16" x2="12.01" y2="16" />
                                </svg>
                            </div>
                        )}
                        <div className={`text-[13px] font-medium ${
                            isWin ? "text-yes" : isLoss ? "text-no" : "text-text-mute"
                        }`}>
                            {isWin
                                ? "You won!"
                                : isLoss
                                  ? "Position didn't win"
                                  : isCancelled
                                    ? "Market cancelled"
                                    : isConnected
                                      ? "No position"
                                      : "Market resolved"}
                        </div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-text-faint">
                            result: {resultLabel}
                        </div>
                    </div>

                    {/* Details */}
                    {isConnected && (
                        <div className="border border-border bg-bg-elev px-4 py-3 space-y-1.5">
                            {isWin && (
                                <RowKV
                                    k="claimable payout"
                                    v={<span className="text-yes font-medium">${formatUsdc(claimablePayout)} USDT</span>}
                                />
                            )}
                            {sharesYes > 0n && (
                                <RowKV k="your YES shares" v={formatUsdc(sharesYes)} />
                            )}
                            {sharesNo > 0n && (
                                <RowKV k="your NO shares" v={formatUsdc(sharesNo)} />
                            )}
                            {!hasPosition && (
                                <div className="text-[12px] text-text-mute py-0.5">
                                    {isCancelled
                                        ? "Positions can be reclaimed via the factory admin."
                                        : "No shares found for this wallet in this market."}
                                </div>
                            )}
                        </div>
                    )}

                    {!isConnected && (
                        <button
                            onClick={openWalletModal}
                            className="w-full border border-border bg-bg-elev px-4 py-3 text-left text-[12px] text-text-mute transition-colors hover:border-border-bright hover:text-text"
                        >
                            connect wallet to see your settlement details →
                        </button>
                    )}

                    {/* Claim button */}
                    {isConnected && isWin && (
                        wrongChain ? (
                            <button
                                onClick={() => switchChain({ chainId: arcTestnet.id })}
                                className="w-full h-11 border border-warn/40 bg-warn/10 text-warn text-[13px] hover:bg-warn/20 transition-colors"
                            >
                                switch to Bohr to claim
                            </button>
                        ) : (
                            <button
                                onClick={onClaim}
                                disabled={busy}
                                className="w-full h-11 bg-yes text-bg text-[13px] font-medium hover:bg-yes-dim disabled:opacity-50 transition-opacity"
                            >
                                {pendingStage === "claiming"
                                    ? confirming
                                        ? "confirming…"
                                        : "claiming…"
                                    : `Claim Winnings · $${formatUsdc(claimablePayout)}`}
                            </button>
                        )
                    )}

                    {/* Post-claim success */}
                    {successMessage && successTxHash && (
                        <div className="flex items-start gap-3 text-[12px] text-yes border border-yes/30 bg-yes/5 px-3 py-2.5">
                            <span aria-hidden className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-yes/40 bg-yes/10 text-[11px] leading-none">
                                ✓
                            </span>
                            <div className="min-w-0">
                                <div className="font-medium">{successMessage}</div>
                                <a
                                    className="num mt-0.5 inline-block text-[11px] underline-offset-2 hover:underline"
                                    href={`https://scan.bohr.life/tx/${successTxHash}`}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    View transaction {successTxHash.slice(0, 14)}…
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            </Panel>
        );
    }

    // Past deadline but not yet resolved: on-chain buy/sell revert
    // (PastDeadline), so hide the trade form and show a closed/awaiting state
    // instead of letting the user broadcast a doomed transaction.
    if (isExpired) {
        return (
            <Panel title="Trade">
                <div className="px-5 py-5 space-y-5">
                    <div className="flex flex-col items-center gap-2 py-3">
                        <div className="flex items-center justify-center w-16 h-16 rounded-full border-2 border-border bg-bg-elev">
                            <svg
                                width="28"
                                height="28"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="text-text-mute"
                            >
                                <circle cx="12" cy="12" r="10" />
                                <polyline points="12 6 12 12 16 14" />
                            </svg>
                        </div>
                        <div className="text-[13px] font-medium text-text-mute">
                            Trading closed
                        </div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-text-faint">
                            awaiting resolution
                        </div>
                    </div>

                    <p className="text-center text-[12px] leading-relaxed text-text-mute">
                        This market passed its deadline and can no longer be traded.
                        Once it&apos;s resolved you&apos;ll be able to claim any
                        winnings here.
                    </p>

                    {isConnected && hasPosition && (
                        <div className="border border-border bg-bg-elev px-4 py-3 space-y-1.5">
                            {sharesYes > 0n && (
                                <RowKV k="your YES shares" v={formatUsdc(sharesYes)} />
                            )}
                            {sharesNo > 0n && (
                                <RowKV k="your NO shares" v={formatUsdc(sharesNo)} />
                            )}
                        </div>
                    )}
                </div>
            </Panel>
        );
    }

    async function onApprove() {
        if (mode !== "buy" || quoteValue === 0n) return;
        setPendingStage("approving");
        try {
            const h = await writeContractAsync({
                address: ADDRESSES.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [market, MAX_APPROVAL],
            });
            setHash(h);
        } catch (e) {
            console.error(e);
            setPendingStage("idle");
        }
    }

    async function onBuy() {
        if (mode !== "buy" || quoteValue === 0n || sharesToTrade === 0n) return;
        setPendingStage("buying");
        try {
            const h = await writeContractAsync({
                address: market,
                abi: marketAbi,
                functionName: "buy",
                args: [side, sharesToTrade, maxCost],
            });
            setHash(h);
        } catch (e) {
            console.error(e);
            setPendingStage("idle");
        }
    }

    async function onSell() {
        if (mode !== "sell" || quoteValue === 0n || sharesToTrade === 0n) return;
        setPendingStage("selling");
        try {
            const h = await writeContractAsync({
                address: market,
                abi: marketAbi,
                functionName: "sell",
                args: [side, sharesToTrade, minReceived],
            });
            setHash(h);
        } catch (e) {
            console.error(e);
            setPendingStage("idle");
        }
    }

    return (
        <Panel title="Trade">
            <div className="px-5 py-5 space-y-5">
                <div className="border-b border-border">
                    <div className="grid grid-cols-2">
                        <button
                            onClick={() => setMode("buy")}
                            className={`relative h-9 text-[12px] uppercase tracking-[0.16em] transition-colors ${
                                mode === "buy"
                                    ? "text-text"
                                    : "text-text-mute hover:text-text-dim"
                            }`}
                        >
                            buy
                            <span
                                className={`absolute left-0 right-0 -bottom-px h-[2px] transition-colors ${
                                    mode === "buy" ? "bg-accent" : "bg-transparent"
                                }`}
                            />
                        </button>
                        <button
                            onClick={() => setMode("sell")}
                            className={`relative h-9 text-[12px] uppercase tracking-[0.16em] transition-colors ${
                                mode === "sell"
                                    ? "text-text"
                                    : "text-text-mute hover:text-text-dim"
                            }`}
                        >
                            sell
                            <span
                                className={`absolute left-0 right-0 -bottom-px h-[2px] transition-colors ${
                                    mode === "sell" ? "bg-accent" : "bg-transparent"
                                }`}
                            />
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                    <SideButton
                        active={side === Outcome.Yes}
                        accent="yes"
                        label="YES"
                        sub={formatCents(pYes)}
                        onClick={() => setSide(Outcome.Yes)}
                    />
                    <SideButton
                        active={side === Outcome.No}
                        accent="no"
                        label="NO"
                        sub={formatCents(1 - pYes)}
                        onClick={() => setSide(Outcome.No)}
                    />
                </div>

                <label className="block">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-text-mute mb-2">
                        <span>{mode === "buy" ? "spend" : "target receive"}</span>
                        <span>USDT</span>
                    </div>
                    <input
                        type="number"
                        step="0.5"
                        min="0"
                        inputMode="decimal"
                        value={amountStr}
                        onChange={(e) => setAmountStr(e.target.value)}
                        className="num w-full bg-bg-elev-2 border border-border focus:border-border-bright px-4 py-3 text-[22px] tabular text-text outline-none transition-colors"
                    />
                    <div className="flex gap-1 mt-2">
                        {[1, 5, 25, 100].map((v) => (
                            <button
                                key={v}
                                onClick={() => setAmountStr(v.toString())}
                                className="num text-[11px] px-2 py-1 border border-border text-text-dim hover:text-text hover:border-border-strong transition-colors"
                            >
                                ${v}
                            </button>
                        ))}
                        {mode === "sell" && (
                            <button
                                onClick={() => setAmountStr(formatInputUsdc(maxSellProceeds))}
                                disabled={maxSellProceeds === 0n}
                                className="num text-[11px] px-2 py-1 border border-accent/40 text-accent hover:border-accent/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                Max
                            </button>
                        )}
                    </div>
                </label>

                <RowKV
                    k={`your ${side === Outcome.Yes ? "YES" : "NO"} shares`}
                    v={formatUsdc(ownedShares)}
                />

                <div className="border border-border bg-bg-elev px-4 py-3 space-y-1.5">
                    <RowKV
                        k="shares"
                        v={
                            quoteValue
                                ? `${formatUsdc(sharesToTrade)} ${side === Outcome.Yes ? "YES" : "NO"}`
                                : "—"
                        }
                    />
                    <RowKV
                        k={mode === "buy" ? "estimated cost" : "estimated proceeds"}
                        v={quoteValue ? `$${formatUsdc(quoteValue)}` : "—"}
                    />
                    <RowKV
                        k={mode === "buy" ? "max cost (slippage)" : "min received (slippage)"}
                        v={
                            mode === "buy"
                                ? maxCost
                                    ? `$${formatUsdc(maxCost)}`
                                    : "—"
                                : minReceived
                                  ? `$${formatUsdc(minReceived)}`
                                  : "—"
                        }
                    />
                    <RowKV
                        k="avg execution"
                        v={
                            quoteValue && sharesToTrade > 0n
                                ? formatProb(Number(quoteValue) / Number(sharesToTrade))
                                : "—"
                        }
                    />
                </div>

                {!isConnected ? (
                    <ConnectPrompt label="connect wallet to trade" onClick={openWalletModal} />
                ) : wrongChain ? (
                    <button
                        onClick={() => switchChain({ chainId: arcTestnet.id })}
                        className="w-full h-11 border border-warn/40 bg-warn/10 text-warn text-[13px] hover:bg-warn/20 transition-colors"
                    >
                        switch to Bohr to trade
                    </button>
                ) : amountWei === 0n ? (
                    <ActionDisabled label="enter an amount" />
                ) : insufficientFunds ? (
                    <ActionDisabled label="insufficient USDT balance" />
                ) : mode === "sell" && ownedShares === 0n ? (
                    <ActionDisabled
                        label={`no ${side === Outcome.Yes ? "YES" : "NO"} shares to sell`}
                    />
                ) : quote.isLoading ? (
                    <ActionDisabled label="calculating…" />
                ) : sharesToTrade === 0n ? (
                    <ActionDisabled label="amount too small" />
                ) : needsApproval ? (
                    <button
                        onClick={onApprove}
                        disabled={busy}
                        className="w-full h-11 border border-border-bright bg-text text-bg text-[13px] font-medium disabled:opacity-50 transition-opacity"
                    >
                        {pendingStage === "approving"
                            ? confirming
                                ? "confirming approval…"
                                : "approving…"
                            : "approve market"}
                    </button>
                ) : (
                    <button
                        onClick={mode === "buy" ? onBuy : onSell}
                        disabled={busy}
                        className={`w-full h-11 text-[13px] font-medium transition-opacity disabled:opacity-50 ${
                            side === Outcome.Yes
                                ? "bg-yes text-bg hover:bg-yes-dim"
                                : "bg-no text-bg hover:bg-no-dim"
                        }`}
                    >
                        {mode === "buy"
                            ? pendingStage === "buying"
                                ? confirming
                                    ? "confirming buy…"
                                    : "buying…"
                                : `buy ${side === Outcome.Yes ? "YES" : "NO"}`
                            : pendingStage === "selling"
                              ? confirming
                                  ? "confirming sell…"
                                  : "selling…"
                              : `sell ${side === Outcome.Yes ? "YES" : "NO"}`}
                    </button>
                )}

                {successMessage && successTxHash && (
                    <div className="flex items-start gap-3 text-[12px] text-yes border border-yes/30 bg-yes/5 px-3 py-2.5">
                        <span
                            aria-hidden
                            className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-yes/40 bg-yes/10 text-[11px] leading-none"
                        >
                            ✓
                        </span>
                        <div className="min-w-0">
                            <div className="font-medium">{successMessage}</div>
                            <a
                                className="num mt-0.5 inline-block text-[11px] underline-offset-2 hover:underline"
                                href={`https://scan.bohr.life/tx/${successTxHash}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View transaction {successTxHash.slice(0, 14)}…
                            </a>
                        </div>
                    </div>
                )}
            </div>
        </Panel>
    );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="border border-border bg-bg-elev/40">
            <div className="border-b border-border px-5 py-2.5">
                <h3 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                    / {title.toLowerCase()}
                </h3>
            </div>
            {children}
        </section>
    );
}

function SideButton({
    active,
    accent,
    label,
    sub,
    onClick,
}: {
    active: boolean;
    accent: "yes" | "no";
    label: string;
    sub: string;
    onClick: () => void;
}) {
    const accentBorder = accent === "yes" ? "border-yes" : "border-no";
    const accentText = accent === "yes" ? "text-yes" : "text-no";
    return (
        <button
            onClick={onClick}
            className={`px-3 py-3 border transition-colors ${
                active
                    ? `${accentBorder} bg-bg-elev-2`
                    : "border-border hover:border-border-strong"
            }`}
        >
            <div className="flex items-baseline justify-between">
                <span
                    className={`text-[13px] font-medium tracking-tight ${
                        active ? accentText : "text-text-dim"
                    }`}
                >
                    {label}
                </span>
                <span
                    className={`num text-[12px] tabular ${active ? accentText : "text-text-mute"}`}
                >
                    {sub}
                </span>
            </div>
        </button>
    );
}

function RowKV({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between text-[12px]">
            <span className="text-text-mute">{k}</span>
            <span className="num text-text-dim tabular">{v}</span>
        </div>
    );
}

function ActionDisabled({ label }: { label: string }) {
    return (
        <button
            disabled
            className="w-full h-11 border border-border bg-bg-elev text-[13px] text-text-mute"
        >
            {label}
        </button>
    );
}

/** Active variant of the disabled action row — opens the wallet modal. Wears
 *  the primary button treatment so "connect wallet" reads as the next step. */
function ConnectPrompt({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="w-full h-11 border border-border-bright bg-text text-bg text-[13px] font-medium transition-opacity hover:opacity-90"
        >
            {label}
        </button>
    );
}

function formatInputUsdc(value: bigint): string {
    const whole = value / 1_000_000n;
    const frac = value % 1_000_000n;
    if (frac === 0n) return whole.toString();
    const fracTrimmed = frac.toString().padStart(6, "0").replace(/0+$/, "");
    return `${whole.toString()}.${fracTrimmed}`;
}
