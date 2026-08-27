import type { Metadata } from "next";
import { LegalPage } from "../legal-page";

export const metadata: Metadata = { title: "Attribution" };

export default function AttributionPage() {
    return (
        <LegalPage
            eyebrow="Legal · attribution"
            title="Data and software attribution"
            summary="The current app depends on external protocols, datasets, and open-source libraries. This page provides a lightweight attribution surface so the footer links resolve cleanly during development."
            sections={[
                {
                    heading: "Protocols and data",
                    body: [
                        "YOLO Markets runs on Bohr testnet and settles positions in Bohr USDT. Market discovery and reference catalog data currently draw from external market metadata where applicable.",
                        "Explorer links in the UI point to Bohr Scan, and test funds are sourced through the Bohr testnet faucet during development.",
                    ],
                },
                {
                    heading: "Software",
                    body: [
                        "The web app is built with Next.js, React, wagmi, viem, and TanStack Query. The contract system uses Solidity, Foundry, OpenZeppelin contracts, and PRBMath.",
                        "Where third-party dependencies impose license or attribution requirements, those obligations should be finalized before mainnet or broader public release.",
                    ],
                },
            ]}
        />
    );
}
