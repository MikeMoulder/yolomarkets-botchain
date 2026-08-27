"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type Address, isAddress } from "viem";
import {
    useSwitchChain,
    useWaitForTransactionReceipt,
    useWriteContract,
} from "wagmi";
import { activeChain } from "@/lib/chain";
import { ADDRESSES, erc20Abi } from "@/lib/contracts";
import { EstimatePanel } from "@/components/estimate-panel";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { useWalletModal } from "@/components/wallet-modal";
import type { Estimate } from "@/lib/llm";

const INSIGHT_FEE_USDC = "0.05";
const INSIGHT_FEE_MICRO = 50_000n; // 0.05 USDC with 6 decimals

const insightRecipientRaw = process.env.NEXT_PUBLIC_AI_INSIGHT_FEE_RECIPIENT;
const insightRecipient: Address | undefined =
    insightRecipientRaw && isAddress(insightRecipientRaw)
        ? (insightRecipientRaw as Address)
        : undefined;

export function PaidEstimatePanel({
    marketAddress,
    marketProb,
}: {
    marketAddress: Address;
    marketProb: number;
}) {
    const { kind, isConnected, isWrongChain } = useActiveWallet();
    const { openWalletModal } = useWalletModal();
    const { switchChain } = useSwitchChain();

    const [estimate, setEstimate] = useState<Estimate | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [stage, setStage] = useState<"idle" | "paying" | "requesting">("idle");
    const [paymentHash, setPaymentHash] = useState<`0x${string}` | undefined>();

    const { writeContractAsync, isPending: payingPending } = useWriteContract();
    const { isLoading: paymentConfirming, isSuccess: paymentConfirmed } =
        useWaitForTransactionReceipt({
            hash: paymentHash,
            chainId: activeChain.id,
            query: { enabled: !!paymentHash },
        });

    const wrongChain = kind === "external" && isWrongChain;
    const busy = payingPending || paymentConfirming || stage === "requesting";

    const ctaLabel = useMemo(() => {
        if (stage === "requesting") return "generating insight...";
        if (stage === "paying") {
            return paymentConfirming ? "confirming payment..." : "waiting for wallet...";
        }
        return `pay ${INSIGHT_FEE_USDC} USDC and request AI insight`;
    }, [paymentConfirming, stage]);

    const requestedForHashRef = useRef<`0x${string}` | null>(null);

    useEffect(() => {
        if (!paymentConfirmed || !paymentHash) return;
        if (requestedForHashRef.current === paymentHash) return;
        requestedForHashRef.current = paymentHash;

        let cancelled = false;
        setStage("requesting");
        setError(null);

        (async () => {
            try {
                const r = await fetch(`/api/markets/${marketAddress}/insight`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ txHash: paymentHash }),
                });

                const raw = await r.text();
                let payload: { estimate?: Estimate; error?: string } = {};
                try {
                    payload = JSON.parse(raw) as { estimate?: Estimate; error?: string };
                } catch {
                    // Non-JSON responses (e.g. framework error pages) are surfaced below.
                }

                if (!r.ok || !payload.estimate) {
                    throw new Error(
                        payload.error ??
                            (raw && !raw.startsWith("<") ? raw : "failed to request insight"),
                    );
                }

                if (!cancelled) {
                    setEstimate(payload.estimate);
                    setStage("idle");
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : "failed to request insight");
                    setStage("idle");
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [marketAddress, paymentConfirmed, paymentHash]);

    async function handleRequest() {
        if (!insightRecipient) {
            setError("AI insight fee recipient is not configured");
            return;
        }

        setError(null);
        setStage("paying");

        try {
            const txHash = await writeContractAsync({
                address: ADDRESSES.usdc,
                abi: erc20Abi,
                functionName: "transfer",
                args: [insightRecipient, INSIGHT_FEE_MICRO],
            });
            setPaymentHash(txHash);
        } catch (e) {
            setError(e instanceof Error ? e.message : "payment failed");
            setStage("idle");
        }
    }

    if (estimate) {
        return <EstimatePanel estimate={estimate} marketProb={marketProb} />;
    }

    return (
        <section className="border border-border bg-bg-elev/40">
            <div className="flex items-center justify-between border-b border-border px-5 py-2.5">
                <h3 className="text-[10px] uppercase tracking-[0.22em] text-text-mute">
                    / ai estimate
                </h3>
                <span className="text-[10px] uppercase tracking-[0.15em] text-text-mute num">
                    fee {INSIGHT_FEE_USDC} USDC
                </span>
            </div>

            <div className="px-5 py-6 space-y-4">
                <p className="text-[13px] text-text-dim leading-relaxed">
                    Insights are now on-demand. Pay {INSIGHT_FEE_USDC} USDC to request a fresh
                    AI estimate for this market. After payment confirmation, analysis and
                    sources will appear here.
                </p>

                {!isConnected ? (
                    <button
                        onClick={openWalletModal}
                        className="w-full h-11 border border-border-bright bg-text text-bg text-[13px] font-medium transition-opacity hover:opacity-90"
                    >
                        connect wallet to request insight
                    </button>
                ) : wrongChain ? (
                    <button
                        onClick={() => switchChain({ chainId: activeChain.id })}
                        className="w-full h-11 border border-warn/40 bg-warn/10 text-warn text-[13px] hover:bg-warn/20 transition-colors"
                    >
                        switch to {activeChain.name} to request
                    </button>
                ) : (
                    <button
                        onClick={handleRequest}
                        disabled={busy || !insightRecipient}
                        className="w-full h-11 border border-border-bright bg-text text-bg text-[13px] font-medium disabled:opacity-50 transition-opacity"
                    >
                        {ctaLabel}
                    </button>
                )}

                {paymentHash && (
                    <p className="text-[11px] text-text-mute">
                        payment tx:{" "}
                        <a
                            href={`${activeChain.blockExplorers.default.url}/tx/${paymentHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="num text-text-dim hover:text-text underline-offset-2 hover:underline"
                        >
                            {paymentHash.slice(0, 16)}...
                        </a>
                    </p>
                )}

                {error && (
                    <div className="border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                        {error}
                    </div>
                )}

                {!insightRecipient && (
                    <div className="border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
                        Missing NEXT_PUBLIC_AI_INSIGHT_FEE_RECIPIENT in env.
                    </div>
                )}
            </div>
        </section>
    );
}
