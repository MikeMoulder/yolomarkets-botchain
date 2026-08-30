import type { Address } from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const ADDRESSES = {
    // v2 role-separated factory (2026-06-18, audit H-1/H-2 hardened) — the
    // canonical factory since 2026-07-18: all new markets are created here,
    // resolution goes through the dedicated resolver key, and cancelled
    // markets refund via claimRefund().
    factory: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? ZERO_ADDRESS) as Address,
    // v1 factory, read-only legacy: ~13.8k markets with the OLD bytecode (no
    // cancellation refund; resolution = admin key). The catalog only surfaces
    // its unexpired markets; the portfolio still scans it so positions and
    // claims keep working until they age out.
    factoryLegacy: (process.env.NEXT_PUBLIC_FACTORY_LEGACY_ADDRESS ?? ZERO_ADDRESS) as Address,
    usdc: (process.env.NEXT_PUBLIC_SETTLEMENT_TOKEN_ADDRESS ?? "0x75edC9335175Fc0552D51D48439F229c10420fe3") as Address,
} as const;

export enum Outcome {
    Unresolved = 0,
    Yes = 1,
    No = 2,
    Cancelled = 3,
}

export const factoryAbi = [
    {
        type: "function",
        name: "marketCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "allMarkets",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address[]" }],
    },
    {
        type: "function",
        name: "isMarket",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "markets",
        stateMutability: "view",
        inputs: [{ type: "uint256" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "admin",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        // Settlement authority on v2 — deliberately NOT the admin (audit H-1/H-2).
        // The admin panel reads this to tell the operator which wallet to connect.
        type: "function",
        name: "resolver",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "createMarket",
        stateMutability: "nonpayable",
        inputs: [
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "uint256" },
            { type: "uint256" },
        ],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "resolveMarket",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint8" }],
        outputs: [],
    },
    {
        type: "function",
        name: "rolloverMarket",
        stateMutability: "nonpayable",
        inputs: [
            { type: "address" },
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "uint256" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "withdrawMarketTreasury",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        outputs: [],
    },
] as const;

export const marketAbi = [
    {
        type: "event",
        name: "Bought",
        anonymous: false,
        inputs: [
            { indexed: true, name: "who", type: "address" },
            { indexed: true, name: "outcome", type: "uint8" },
            { indexed: false, name: "shares", type: "uint256" },
            { indexed: false, name: "cost", type: "uint256" },
            { indexed: false, name: "fee", type: "uint256" },
            { indexed: false, name: "newPriceYesRaw", type: "int256" },
        ],
    },
    {
        type: "event",
        name: "Sold",
        anonymous: false,
        inputs: [
            { indexed: true, name: "who", type: "address" },
            { indexed: true, name: "outcome", type: "uint8" },
            { indexed: false, name: "shares", type: "uint256" },
            { indexed: false, name: "received", type: "uint256" },
            { indexed: false, name: "fee", type: "uint256" },
            { indexed: false, name: "newPriceYesRaw", type: "int256" },
        ],
    },
    {
        type: "function",
        name: "question",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "category",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "resolutionCriteria",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "deadline",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "roundId",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "initialLiquidity",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "totalLiquidity",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "protocolFeeBps",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint16" }],
    },
    {
        type: "function",
        name: "MIN_PRICE_YES",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "int256" }],
    },
    {
        type: "function",
        name: "MAX_PRICE_YES",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "int256" }],
    },
    {
        type: "function",
        name: "accruedFees",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "reserveRequired",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "treasuryWithdrawable",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "priceYes",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "int256" }],
    },
    // LMSR parameters — `b` is immutable, `qYes`/`qNo` move with each trade.
    // Read together they let the client compute previewBuy/previewSell locally
    // instead of round-tripping the RPC on every keystroke. All SD59x18 (18-dec).
    {
        type: "function",
        name: "b",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "int256" }],
    },
    {
        type: "function",
        name: "qYes",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "int256" }],
    },
    {
        type: "function",
        name: "qNo",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "int256" }],
    },
    {
        type: "function",
        name: "resolved",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "outcome",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
    },
    {
        type: "function",
        name: "totalSharesYes",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "totalSharesNo",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "tradeCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "sharesYes",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "sharesNo",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "previewBuy",
        stateMutability: "view",
        inputs: [{ type: "uint8" }, { type: "uint256" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "previewSell",
        stateMutability: "view",
        inputs: [{ type: "uint8" }, { type: "uint256" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "buy",
        stateMutability: "nonpayable",
        inputs: [
            { type: "uint8" },
            { type: "uint256" },
            { type: "uint256" },
        ],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "sell",
        stateMutability: "nonpayable",
        inputs: [
            { type: "uint8" },
            { type: "uint256" },
            { type: "uint256" },
        ],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "claim",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        // v2 markets only: refund path for cancelled markets (claim() reverts
        // on Cancelled there). Legacy v1 bytecode does not have this function.
        type: "function",
        name: "claimRefund",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        // v2 markets only: net at-risk USDC refundable after cancellation.
        type: "function",
        name: "costBasis",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "withdrawTreasury",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [],
    },
] as const;

export const erc20Abi = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
    },
] as const;
