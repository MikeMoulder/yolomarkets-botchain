"use client";

import { useEffect, useState } from "react";
import { useAccount, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { activeChain } from "@/lib/chain";
import { ADDRESSES, erc20Abi } from "@/lib/contracts";
import { formatUsdc, shortAddr } from "@/lib/format";
import { useWalletModal } from "./wallet-modal";
import { WalletGlyph } from "./wallet-glyphs";

export function WalletButton() {
    const { address, chainId, connector, isConnected } = useAccount();
    const { disconnect } = useDisconnect();
    const { switchChain } = useSwitchChain();
    const { openWalletModal } = useWalletModal();
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => setMounted(true), []);

    const { data: balance } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        chainId: activeChain.id,
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 15_000 },
    });

    if (!mounted) {
        return <button className="h-8 w-[112px] border border-border bg-bg-elev text-[12px]" />;
    }

    if (isConnected && chainId !== activeChain.id) {
        return (
            <button
                onClick={() => switchChain({ chainId: activeChain.id })}
                className="h-8 border border-warn/40 bg-warn/10 px-3 text-[12px] text-warn"
            >
                switch to {activeChain.name}
            </button>
        );
    }

    if (!isConnected || !address) {
        return (
            <button onClick={openWalletModal} className="h-8 border border-border-strong bg-bg-elev px-3 text-[12px] text-text">
                connect wallet
            </button>
        );
    }

    return (
        <div className="relative">
            <button
                onClick={() => setOpen((value) => !value)}
                className="flex h-8 items-center gap-2 border border-border-strong bg-bg-elev px-3 text-[12px] text-text"
                aria-expanded={open}
            >
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border-bright bg-bg-elev-2">
                    <WalletGlyph kind={connector?.name ?? "wallet"} size="sm" />
                </span>
                <span className="hidden sm:inline num">{balance !== undefined ? formatUsdc(balance) : "-"} USDT</span>
                <span className="num text-text-dim">{shortAddr(address)}</span>
            </button>
            {open && (
                <div className="absolute right-0 top-[calc(100%+8px)] z-[100] w-64 border border-border-strong bg-bg-elev p-3 shadow-2xl">
                    <div className="mb-3 text-[11px] text-text-mute">{connector?.name ?? "External wallet"}</div>
                    <button onClick={() => { disconnect(); setOpen(false); }} className="h-9 w-full border border-border bg-bg text-[12px] text-text">
                        disconnect
                    </button>
                </div>
            )}
        </div>
    );
}
