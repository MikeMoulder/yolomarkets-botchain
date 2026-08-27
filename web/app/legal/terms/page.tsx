import type { Metadata } from "next";
import { LegalPage } from "../legal-page";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
    return (
        <LegalPage
            eyebrow="Legal · terms"
            title="Testnet terms of use"
            summary="YOLO Markets is currently a testnet product. These terms describe the practical operating assumptions for using the app while the platform remains in active development."
            sections={[
                {
                    heading: "Scope",
                    body: [
                        "This application is provided for testing, demonstration, and product development on Bohr testnet. Markets, balances, agent actions, and UI behavior may change without notice while the product is still being hardened.",
                        "By using the app, you understand that all activity is experimental and may be reset, paused, or modified if a bug, security issue, or operational problem is discovered.",
                    ],
                },
                {
                    heading: "User responsibilities",
                    body: [
                        "You are responsible for the wallet you connect, the transactions you sign, and the market positions you open. Review transaction prompts carefully before confirming any approval, buy, sell, claim, or admin action.",
                        "Do not rely on the platform for production custody, financial advice, or guaranteed uptime. If you are testing agent mode, keep position limits conservative until the workflow has been validated end to end.",
                    ],
                },
            ]}
        />
    );
}
