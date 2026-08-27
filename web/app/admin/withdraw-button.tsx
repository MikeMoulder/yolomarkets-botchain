"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    useAccount,
    useChainId,
    useSwitchChain,
    useWaitForTransactionReceipt,
    useWriteContract,
} from "wagmi";
import { type Address } from "viem";
import { arcTestnet } from "@/lib/chain";
import { ADDRESSES, factoryAbi } from "@/lib/contracts";

type Props = {
    market: Address;
    recipient: Address;
    withdrawable: bigint;
    // Legacy v1 markets must withdraw through the v1 factory.
    legacy?: boolean;
};

export function WithdrawButton({ market, recipient, withdrawable, legacy = false }: Props) {
    const router = useRouter();
    const { address } = useAccount();
    const chainId = useChainId();
    const onArc = chainId === arcTestnet.id;
    const { switchChain } = useSwitchChain();

    const [error, setError] = useState<string | null>(null);

    const {
        writeContractAsync,
        data: hash,
        isPending: writePending,
    } = useWriteContract();
    const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
        hash,
        query: { enabled: !!hash },
    });

    const disabled = withdrawable === 0n || writePending || confirming;

    async function onWithdraw() {
        if (!address) {
            setError("Connect admin wallet");
            return;
        }
        if (!onArc) {
            await switchChain({ chainId: arcTestnet.id });
            return;
        }

        setError(null);
        try {
            await writeContractAsync({
                address: legacy ? ADDRESSES.factoryLegacy : ADDRESSES.factory,
                abi: factoryAbi,
                functionName: "withdrawMarketTreasury",
                args: [market, recipient, withdrawable],
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "withdraw failed");
        }
    }

    if (isSuccess) {
        setTimeout(() => {
            router.refresh();
        }, 800);
    }

    return (
        <div className="flex items-center justify-end gap-2">
            <button
                onClick={onWithdraw}
                disabled={disabled}
                className="h-8 px-2.5 border border-accent/50 bg-accent/10 text-accent text-[10.5px] uppercase tracking-[0.14em] num disabled:opacity-40 rounded-sm"
            >
                {confirming
                    ? "withdrawing…"
                    : writePending
                      ? "signing…"
                      : "withdraw"}
            </button>
            {hash && (
                <a
                    href={`https://scan.bohr.life/tx/${hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] num text-text-faint hover:text-text-dim"
                >
                    tx
                </a>
            )}
            {error && <span className="text-[10px] text-no">{error}</span>}
        </div>
    );
}
