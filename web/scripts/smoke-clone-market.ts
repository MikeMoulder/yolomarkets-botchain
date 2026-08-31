/**
 * Exercise a live clone market through the same viem ABI/client path used by
 * the web application. Testnet only; callers must provide the market address.
 */
import "./load-env";
import {
    createPublicClient,
    createWalletClient,
    fallback,
    formatUnits,
    http,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain } from "../lib/chain";
import { ADDRESSES, erc20Abi, marketAbi } from "../lib/contracts";

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function parsePrivateKey(raw: string): `0x${string}` {
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("invalid private key");
    return key as `0x${string}`;
}

async function main(): Promise<void> {
    if (activeChain.id !== 968) throw new Error(`Refusing smoke test on chain ${activeChain.id}`);
    const market = required("CLONE_SMOKE_MARKET") as Address;
    const account = privateKeyToAccount(parsePrivateKey(required("DEPLOYER_PRIVATE_KEY")));
    const rpcUrls = [
        ...(process.env.ARC_TESTNET_RPC_URLS?.split(",").map((url) => url.trim()) ?? []),
        activeChain.rpcUrls.default.http[0],
    ].filter(Boolean);
    const transport = fallback([...new Set(rpcUrls)].map((url) => http(url)));
    const publicClient = createPublicClient({ chain: activeChain, transport });
    const walletClient = createWalletClient({ account, chain: activeChain, transport });
    const shares = 10_000n;

    const [question, deadline, resolved, tokenBalance, allowance] = await Promise.all([
        publicClient.readContract({ address: market, abi: marketAbi, functionName: "question" }),
        publicClient.readContract({ address: market, abi: marketAbi, functionName: "deadline" }),
        publicClient.readContract({ address: market, abi: marketAbi, functionName: "resolved" }),
        publicClient.readContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account.address],
        }),
        publicClient.readContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [account.address, market],
        }),
    ]);
    if (resolved) throw new Error("smoke market is already resolved");
    if (deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("smoke market expired");
    if (tokenBalance < 1_000_000n) throw new Error(`insufficient test token: ${formatUnits(tokenBalance, 6)}`);

    if (allowance < 1_000_000n) {
        const approval = await walletClient.writeContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: [market, (1n << 256n) - 1n],
            account,
            chain: activeChain,
        });
        await publicClient.waitForTransactionReceipt({ hash: approval });
        console.log(`[smoke] approved market tx=${approval}`);
    }

    const buySimulation = await publicClient.simulateContract({
        address: market,
        abi: marketAbi,
        functionName: "buy",
        args: [1, shares, 1_000_000n],
        account,
    });
    const buyTx = await walletClient.writeContract(buySimulation.request);
    await publicClient.waitForTransactionReceipt({ hash: buyTx });

    const sellSimulation = await publicClient.simulateContract({
        address: market,
        abi: marketAbi,
        functionName: "sell",
        args: [1, shares, 0n],
        account,
    });
    const sellTx = await walletClient.writeContract(sellSimulation.request);
    await publicClient.waitForTransactionReceipt({ hash: sellTx });

    console.log(JSON.stringify({
        chainId: activeChain.id,
        market,
        question,
        shares: shares.toString(),
        buyCost: (buySimulation.result as bigint).toString(),
        buyTx,
        sellReceived: (sellSimulation.result as bigint).toString(),
        sellTx,
    }));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
