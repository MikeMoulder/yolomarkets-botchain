"use client";

import { type Address } from "viem";
import { useAccount } from "wagmi";
import { activeChain } from "@/lib/chain";

export type WalletKind = "external" | null;

export type ActiveWallet = {
    address: Address | null;
    kind: WalletKind;
    isConnected: boolean;
    /** Whether the connected wallet is on the configured BOT network. */
    isWrongChain: boolean;
};

/**
 * Unifies the two wallet systems behind one shape so trading UI doesn't care
 * whether the user signed in via MetaMask (wagmi) or Circle email/OTP. This is
 * the "useUserAddress()" abstraction prescribed in CIRCLE_SETUP.md §9.
 *
 * An external wagmi connection takes precedence; the Circle connect flow calls
 * wagmi's disconnect(), so the two are mutually exclusive in practice.
 */
export function useActiveWallet(): ActiveWallet {
    const { address, chainId, isConnected } = useAccount();
    if (isConnected && address) {
        return {
            address,
            kind: "external",
            isConnected: true,
            isWrongChain: chainId !== activeChain.id,
        };
    }

    return { address: null, kind: null, isConnected: false, isWrongChain: false };
}
