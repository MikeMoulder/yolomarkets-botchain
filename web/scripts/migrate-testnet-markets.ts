/**
 * Copy the current Polymarket mirror markets from the Bohr testnet factory to
 * the configured BOT Chain mainnet factory.
 *
 * This intentionally copies the source question/category/criteria/deadline,
 * rather than re-scanning Gamma and silently selecting a different market.
 * It never copies source addresses: CREATE2 produces new mainnet markets.
 *
 * Preview:
 *   npm run markets:migrate:testnet -- --dry-run --limit 15 --seed-usdc 0.1
 * Live:
 *   npm run markets:migrate:testnet -- --live --limit 15 --seed-usdc 0.1
 *
 * Optional comma-separated question exclusions:
 *   MIGRATION_EXCLUDE_QUESTIONS="Question to skip"
 */
import "./load-env";
import {
    createPublicClient,
    createWalletClient,
    fallback,
    formatUnits,
    http,
    parseUnits,
    type Account,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain, bohrTestnet } from "../lib/chain";
import { ADDRESSES, erc20Abi, factoryAbi, marketAbi } from "../lib/contracts";
import { parsePolymarketMirrorMeta } from "../lib/polymarket-mirror";

const SOURCE_RPC = process.env.MIGRATION_SOURCE_RPC_URL ?? "https://rpc.bohr.life";
const SOURCE_FACTORY = (process.env.MIGRATION_SOURCE_FACTORY_ADDRESS ??
    "0x4318E2D364Eec2146653c83E413d3eB81A699604") as Address;

const factoryTokenAbi = [
    ...factoryAbi,
    {
        type: "function",
        name: "usdc",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "predictMarket",
        stateMutability: "view",
        inputs: [
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "uint256" },
            { type: "uint256" },
        ],
        outputs: [{ type: "address" }],
    },
] as const;

type SourceRow = {
    address: Address;
    question: string;
    category: string;
    criteria: string;
    deadline: bigint;
    resolved: boolean;
};

function arg(name: string, fallbackValue: string): string {
    const ix = process.argv.indexOf(`--${name}`);
    return ix >= 0 ? (process.argv[ix + 1] ?? fallbackValue) : fallbackValue;
}

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function parsePrivateKey(raw: string): `0x${string}` {
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be a 32-byte hex key");
    }
    return key as `0x${string}`;
}

function rpcUrls(primary: string, fallbackUrl: string): string[] {
    return [...new Set([primary, fallbackUrl].filter(Boolean))];
}

function excludedQuestions(): Set<string> {
    return new Set(
        (process.env.MIGRATION_EXCLUDE_QUESTIONS ?? "")
            .split(",")
            .map((question) => question.trim().toLowerCase())
            .filter(Boolean),
    );
}

async function readSourceRows(
    client: ReturnType<typeof createPublicClient>,
): Promise<SourceRow[]> {
    const addresses = (await client.readContract({
        address: SOURCE_FACTORY,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];

    const rows = await Promise.all(
        addresses.map(async (address) => {
            const [question, category, criteria, deadline, resolved] = await Promise.all([
                client.readContract({ address, abi: marketAbi, functionName: "question" }),
                client.readContract({ address, abi: marketAbi, functionName: "category" }),
                client.readContract({
                    address,
                    abi: marketAbi,
                    functionName: "resolutionCriteria",
                }),
                client.readContract({ address, abi: marketAbi, functionName: "deadline" }),
                client.readContract({ address, abi: marketAbi, functionName: "resolved" }),
            ]);
            return {
                address,
                question,
                category,
                criteria,
                deadline,
                resolved,
            } as SourceRow;
        }),
    );

    return rows;
}

async function readExistingQuestions(
    client: ReturnType<typeof createPublicClient>,
): Promise<Set<string>> {
    const addresses = (await client.readContract({
        address: ADDRESSES.factory,
        abi: factoryAbi,
        functionName: "allMarkets",
    })) as Address[];
    const questions = await Promise.all(
        addresses.map((address) =>
            client.readContract({ address, abi: marketAbi, functionName: "question" }),
        ),
    );
    return new Set(questions.map((question) => question.trim().toLowerCase()));
}

async function ensureApproval(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: Account,
    requiredAmount: bigint,
): Promise<void> {
    const allowance = (await publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, ADDRESSES.factory],
    })) as bigint;
    if (allowance >= requiredAmount) return;

    const tx = await walletClient.writeContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDRESSES.factory, (1n << 256n) - 1n],
        account,
        chain: activeChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[migration] approved target factory tx=${tx}`);
}

async function main(): Promise<void> {
    if (activeChain.id !== 677) {
        throw new Error(`Refusing migration unless target chain is 677; got ${activeChain.id}`);
    }
    if (!flag("live") && !flag("dry-run")) {
        throw new Error("Choose --dry-run or --live");
    }

    const limit = Number(arg("limit", "20"));
    const seed = parseUnits(arg("seed-usdc", "0.1"), 6);
    const gasLimit = BigInt(process.env.MIGRATION_GAS_LIMIT ?? "5000000");
    const excluded = excludedQuestions();
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be positive");
    if (seed <= 0n) throw new Error("--seed-usdc must be positive");
    if (gasLimit <= 0n) throw new Error("MIGRATION_GAS_LIMIT must be positive");

    const account = privateKeyToAccount(parsePrivateKey(required("DEPLOYER_PRIVATE_KEY")));
    const sourceClient = createPublicClient({
        chain: bohrTestnet,
        transport: http(SOURCE_RPC),
    });
    const targetTransport = fallback(rpcUrls(
        process.env.BOTCHAIN_RPC_URL ?? "https://rpc.botchain.ai",
        "https://rpc.botchain.ai",
    ).map((url) => http(url)));
    const targetClient = createPublicClient({
        chain: activeChain,
        transport: targetTransport,
    });
    const walletClient = createWalletClient({
        account,
        chain: activeChain,
        transport: targetTransport,
    });

    const [sourceRows, existingQuestions, targetAdmin, targetToken] = await Promise.all([
        readSourceRows(sourceClient),
        readExistingQuestions(targetClient),
        targetClient.readContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "admin",
        }) as Promise<Address>,
        targetClient.readContract({
            address: ADDRESSES.factory,
            abi: factoryTokenAbi,
            functionName: "usdc",
        }) as Promise<Address>,
    ]);

    if (targetAdmin.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`Target factory admin is ${targetAdmin}, signer is ${account.address}`);
    }
    if (targetToken.toLowerCase() !== ADDRESSES.usdc.toLowerCase()) {
        throw new Error(`Target token mismatch: factory=${targetToken} env=${ADDRESSES.usdc}`);
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const selected = sourceRows
        .filter((row) => !row.resolved)
        .filter((row) => row.category.toLowerCase() !== "fast")
        .filter((row) => parsePolymarketMirrorMeta(row.criteria) !== null)
        .filter((row) => row.deadline > now + 120n)
        .filter((row) => !excluded.has(row.question.trim().toLowerCase()))
        .slice(0, limit);

    const plan = selected.filter(
        (row) => !existingQuestions.has(row.question.trim().toLowerCase()),
    );

    if (selected.length !== limit) {
        throw new Error(
            `Expected ${limit} eligible source mirror markets, found ${selected.length}. ` +
                "Refusing a partial migration.",
        );
    }

    console.log(`[migration] signer=${account.address}`);
    console.log(`[migration] source=${SOURCE_FACTORY} target=${ADDRESSES.factory}`);
    console.log(`[migration] token=${ADDRESSES.usdc} seed=${formatUnits(seed, 6)} × ${plan.length}`);
    console.log(`[migration] gas limit=${gasLimit}`);
    if (excluded.size > 0) console.log(`[migration] excluded questions=${excluded.size}`);
    for (const [i, row] of plan.entries()) {
        console.log(
            `[${String(i + 1).padStart(2, "0")}] ${row.address} ` +
                `deadline=${row.deadline} ${row.question}`,
        );
    }
    console.log(`[migration] already present in selected set=${selected.length - plan.length}`);
    if (flag("dry-run") || plan.length === 0) return;

    const balance = (await targetClient.readContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
    })) as bigint;
    const needed = seed * BigInt(plan.length);
    if (balance < needed) {
        throw new Error(`Insufficient target token: need ${formatUnits(needed, 6)}, have ${formatUnits(balance, 6)}`);
    }

    await ensureApproval(targetClient, walletClient, account, needed);
    for (const [i, row] of plan.entries()) {
        const { request, result } = await targetClient.simulateContract({
            address: ADDRESSES.factory,
            abi: factoryAbi,
            functionName: "createMarket",
            args: [row.question, row.category, row.criteria, row.deadline, seed],
            account,
            // The clone factory needs substantially less gas than the full
            // contract factory. Keep this configurable for either route.
            gas: gasLimit,
        });
        const tx = await walletClient.writeContract(request);
        await targetClient.waitForTransactionReceipt({ hash: tx });
        console.log(`[migration] created ${i + 1}/${plan.length} ${(result as Address)} tx=${tx}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
