import { activeChain } from "./chain";

export const EXPLORER_URL = activeChain.blockExplorers.default.url;

export function explorerAddress(address: string): string {
    return `${EXPLORER_URL}/address/${address}`;
}

export function explorerTx(hash: string): string {
    return `${EXPLORER_URL}/tx/${hash}`;
}
