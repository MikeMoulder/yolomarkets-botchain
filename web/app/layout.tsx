import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/lib/providers";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { MobileNav } from "@/components/mobile-nav";
import { AgentChat } from "@/components/agent-chat";

const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
    display: "swap",
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
    display: "swap",
});

export const metadata: Metadata = {
    title: {
        default: "yolomarkets.",
        template: "%s · yolomarkets.",
    },
    description:
        "Real-world prediction markets settled in USDT on BOT Chain. An autonomous agent reads the news, sizes by Kelly, and trades on your behalf.",
    // Resolves relative OG image URLs (including the per-market share cards at
    // app/markets/[address]/opengraph-image.tsx). Pointing at the wrong origin
    // silently breaks every link unfurl, so it follows NEXT_PUBLIC_SITE_URL.
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://yolomarkets.fun"),
    openGraph: {
        title: "yolomarkets.",
        description: "Prediction markets on BOT Chain, with an autonomous agent.",
        type: "website",
    },
};

export default function RootLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    return (
        <html
            lang="en"
            className={`${geistSans.variable} ${geistMono.variable}`}
            suppressHydrationWarning
        >
            <body className="min-h-dvh flex flex-col">
                <Providers>
                    <Header />
                    <main className="flex-1">{children}</main>
                    <Footer />
                    {/* Clearance so the floating dock never covers content */}
                    <div className="h-[96px] md:hidden" aria-hidden />
                    <MobileNav />
                    {/* Persistent agent chat bubble — lives in the layout so it
                        stays mounted (and the conversation survives) across pages. */}
                    <AgentChat />
                </Providers>
            </body>
        </html>
    );
}
