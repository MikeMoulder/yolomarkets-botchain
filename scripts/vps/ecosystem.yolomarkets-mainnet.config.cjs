const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const rootEnvPath = "/root/BotChain/.env";
function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const values = {};
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        value = value.replace(/\s+#.*$/, "").trim();
        values[match[1]] = value;
    }
    return values;
}

const rootEnv = parseEnvFile(rootEnvPath);
const mainnetToken = rootEnv.USDC_ADDRESS || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C";
const factory = process.env.YOLO_MAINNET_FACTORY_ADDRESS || "";

const mainnetEnv = {
    ...rootEnv,
    NODE_ENV: "production",
    BOTCHAIN_RPC_URL: "https://rpc.botchain.ai",
    BOTCHAIN_RPC_URLS: "https://rpc.botchain.ai",
    ARC_TESTNET_RPC_URL: "https://rpc.botchain.ai",
    ARC_TESTNET_RPC_URLS: "https://rpc.botchain.ai",
    BOTCHAIN_CHAIN_ID: "677",
    NEXT_PUBLIC_CHAIN_ID: "677",
    NEXT_PUBLIC_BOTCHAIN_RPC_URLS: "https://rpc.botchain.ai",
    SETTLEMENT_TOKEN_ADDRESS: mainnetToken,
    NEXT_PUBLIC_SETTLEMENT_TOKEN_ADDRESS: mainnetToken,
    USDC_ADDRESS: mainnetToken,
    USDT_ADDRESS: mainnetToken,
    NEXT_PUBLIC_FACTORY_ADDRESS: factory,
    NEXT_PUBLIC_FACTORY_LEGACY_ADDRESS: "",
    CATALOG_INCLUDE_LEGACY: "0",
    DEPLOYER_PRIVATE_KEY: rootEnv.MAINNET_DEPLOYER_PRIVATE_KEY || "",
    DEPLOYER_ADDRESS: rootEnv.MAINNET_DEPLOYER_ADDRESS || "",
    RESOLVER_PRIVATE_KEY: rootEnv.MAINNET_RESOLVER_PRIVATE_KEY || "",
    RESOLVER_ADDRESS: rootEnv.MAINNET_RESOLVER_ADDRESS || "",
    TREASURY_ADDRESS: rootEnv.MAINNET_TREASURY_ADDRESS || "",
    ADMIN_ADDRESSES: rootEnv.MAINNET_DEPLOYER_ADDRESS || "",
    NEXT_PUBLIC_ADMIN_ADDRESSES: rootEnv.MAINNET_DEPLOYER_ADDRESS || "",
    FAST_MARKET_SEED_USDC: "0.5",
    FAST_MARKET_SYMBOLS: "BTC,ETH",
    FAST_MARKET_WINDOWS: "1h",
    AI_INSIGHT_FEE_USDT: "0.2",
    NEXT_PUBLIC_AI_INSIGHT_FEE_USDT: "0.2",
    FAST_MARKET_POLL_SECONDS: "30",
    POLYMARKET_WRAP_SEED_USDC: "0.1",
    POLYMARKET_WRAP_LIMIT: "20",
    // The existing catalog DB is testnet data and is deliberately not reused.
    // The app falls back to direct RPC reads until a separate mainnet DB exists.
    DATABASE_URL: "",
    PORT: "3101",
};

const web = path.join(repoRoot, "web");

module.exports = {
    apps: [
        {
            name: "yolomarkets-mainnet-web",
            cwd: web,
            script: "npm",
            args: "run start",
            interpreter: "none",
            env: mainnetEnv,
            autorestart: true,
            time: true,
        },
        {
            name: "yolomarkets-mainnet-fast-keeper",
            cwd: web,
            script: "npm",
            args: "run markets:fast:keeper",
            interpreter: "none",
            env: mainnetEnv,
            autorestart: true,
            time: true,
        },
        {
            name: "yolomarkets-mainnet-polymarket-resolver",
            cwd: web,
            script: "npm",
            args: "run markets:poly:resolver",
            interpreter: "none",
            env: mainnetEnv,
            autorestart: true,
            time: true,
        },
    ],
};
