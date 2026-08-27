"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./wagmi";
import { WalletModalProvider } from "@/components/wallet-modal";

export function Providers({ children }: { children: ReactNode }) {
    const [qc] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: 30_000,
                        refetchOnWindowFocus: false,
                    },
                },
            }),
    );
    return (
        <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={qc}>
                <WalletModalProvider>{children}</WalletModalProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
