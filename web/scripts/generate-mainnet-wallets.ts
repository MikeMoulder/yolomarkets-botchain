/**
 * Generate isolated mainnet bootstrap wallets and append them to the local
 * repository .env file.
 *
 * Security properties:
 * - Never prints or returns private keys.
 * - Never overwrites an existing MAINNET_* value.
 * - Writes only to the ignored root .env file.
 * - Does not generate a treasury key: production treasury custody belongs to
 *   a multisig/cold wallet whose address must be supplied separately.
 *
 * Run:
 *   npm run wallets:mainnet:generate
 */
import { appendFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV_PATH = path.resolve(__dirname, "..", "..", ".env");

type GeneratedWallet = {
    keyName: string;
    addressName: string;
    privateKey: `0x${string}`;
    address: string;
};

function valueFor(envText: string, name: string): string | null {
    const match = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
    return match?.[1]?.trim() || null;
}

async function main() {
    const envText = await readFile(ENV_PATH, "utf8");
    const names = [
        "MAINNET_DEPLOYER_PRIVATE_KEY",
        "MAINNET_DEPLOYER_ADDRESS",
        "MAINNET_RESOLVER_PRIVATE_KEY",
        "MAINNET_RESOLVER_ADDRESS",
    ];
    const existing = names.filter((name) => valueFor(envText, name));
    if (existing.length > 0) {
        throw new Error(
            `${existing.join(", ")} already exists in .env; refusing to overwrite credentials`,
        );
    }

    const deployerKey = generatePrivateKey();
    const resolverKey = generatePrivateKey();
    const wallets: GeneratedWallet[] = [
        {
            keyName: "MAINNET_DEPLOYER_PRIVATE_KEY",
            addressName: "MAINNET_DEPLOYER_ADDRESS",
            privateKey: deployerKey,
            address: privateKeyToAccount(deployerKey).address,
        },
        {
            keyName: "MAINNET_RESOLVER_PRIVATE_KEY",
            addressName: "MAINNET_RESOLVER_ADDRESS",
            privateKey: resolverKey,
            address: privateKeyToAccount(resolverKey).address,
        },
    ];

    const section = [
        "",
        "# Mainnet wallet credentials — generated locally; never commit or paste these values.",
        "# MAINNET_DEPLOYER is the temporary bootstrap/admin signer. Transfer admin to a multisig after deployment.",
        `MAINNET_DEPLOYER_PRIVATE_KEY=${wallets[0].privateKey}`,
        `MAINNET_DEPLOYER_ADDRESS=${wallets[0].address}`,
        "# MAINNET_RESOLVER is the limited hot signer used only by the resolution keeper.",
        `MAINNET_RESOLVER_PRIVATE_KEY=${wallets[1].privateKey}`,
        `MAINNET_RESOLVER_ADDRESS=${wallets[1].address}`,
        "# Set this to the production multisig/cold treasury address; do not create a treasury EOA here.",
        "MAINNET_TREASURY_ADDRESS=",
        "",
    ].join("\n");

    await appendFile(ENV_PATH, section, { encoding: "utf8" });
    try {
        await chmod(ENV_PATH, 0o600);
    } catch {
        // Windows ACLs are managed by the OS; the file is still ignored and
        // the failure does not invalidate the generated credentials.
    }

    console.log(`[mainnet-wallets] appended credentials to ${ENV_PATH}`);
    for (const wallet of wallets) {
        console.log(`[mainnet-wallets] ${wallet.addressName}=${wallet.address}`);
    }
    console.log("[mainnet-wallets] private keys were written to .env and were not printed");
    console.log("[mainnet-wallets] MAINNET_TREASURY_ADDRESS remains blank until a multisig is selected");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
