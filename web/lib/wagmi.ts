import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { ACTIVE_CHAIN_ID, activeChain, botChain, bohrTestnet } from "./chain";

// NEXT_PUBLIC_* is inlined at build time, so this must stay a static reference.
const browserRpcUrls = (process.env.NEXT_PUBLIC_BOTCHAIN_RPC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

const rpcUrls = browserRpcUrls.length ? browserRpcUrls : activeChain.rpcUrls.default.http;

export const wagmiConfig = createConfig({
    chains: [botChain, bohrTestnet],
    connectors: [
        injected({ shimDisconnect: true }),
    ],
    transports: {
        [botChain.id]: fallback((ACTIVE_CHAIN_ID === botChain.id ? rpcUrls : botChain.rpcUrls.default.http).map((url) => http(url))),
        [bohrTestnet.id]: fallback((ACTIVE_CHAIN_ID === bohrTestnet.id ? rpcUrls : bohrTestnet.rpcUrls.default.http).map((url) => http(url))),
    },
    ssr: true,
});

declare module "wagmi" {
    interface Register {
        config: typeof wagmiConfig;
    }
}
