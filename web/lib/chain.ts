import { defineChain } from "viem";

export const botChain = defineChain({
    id: 677,
    name: "BOT Chain",
    nativeCurrency: {
        name: "BOT",
        symbol: "BOT",
        decimals: 18,
    },
    rpcUrls: {
        default: { http: ["https://rpc.botchain.ai"] },
    },
    blockExplorers: {
        default: { name: "BOT Scan", url: "https://scan.botchain.ai" },
    },
    contracts: {
        multicall3: {
            address: "0xcA11bde05977b3631167028862bE2a173976CA11",
        },
    },
});

export const bohrTestnet = defineChain({
    id: 968,
    name: "Bohr Testnet",
    nativeCurrency: {
        name: "BOT",
        symbol: "tBOT",
        decimals: 18,
    },
    rpcUrls: {
        default: { http: ["https://rpc.bohr.life"] },
    },
    blockExplorers: {
        default: { name: "Bohr Scan", url: "https://scan.bohr.life" },
    },
    testnet: true,
});

export const ACTIVE_CHAIN_ID: 677 | 968 =
    Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 968) === 677 ? 677 : 968;

export const activeChain = ACTIVE_CHAIN_ID === 677 ? botChain : bohrTestnet;

// Kept as a compatibility alias while the remaining call sites migrate to
// the network-neutral name.
export const arcTestnet = activeChain;
