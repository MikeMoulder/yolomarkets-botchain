import Link from "next/link";
import { Logo } from "./logo";

const PRODUCT = [
    { href: "/", label: "Markets" },
    { href: "/portfolio", label: "Portfolio" },
    { href: "/agent", label: "Agent" },
    { href: "/admin", label: "Admin" },
];

const RESOURCES = [
    { href: "https://scan.bohr.life", label: "Bohr Explorer", external: true },
    { href: "https://faucet.bohr.life/basic/", label: "tBOT Faucet", external: true },
    { href: "https://rpc.bohr.life", label: "Bohr RPC", external: true },
];

const LEGAL = [
    { href: "/legal/terms", label: "Terms" },
    { href: "/legal/privacy", label: "Privacy" },
    { href: "/legal/risk", label: "Risk disclosure" },
    { href: "/legal/attribution", label: "Attribution" },
];

export function Footer() {
    return (
        <footer className="border-t border-border bg-bg-elev/30 mt-12">
            <div className="mx-auto max-w-[1440px] px-6 py-10">
                {/* Top grid */}
                <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_1fr_1fr] gap-8 md:gap-10">
                    {/* Brand column */}
                    <div className="flex flex-col gap-4 max-w-sm">
                        <Link
                            href="/"
                            className="flex items-center gap-2.5"
                            aria-label="yolomarkets home"
                        >
                            <Logo size={24} className="text-text shrink-0" />
                            <span className="text-[17px] font-semibold tracking-tight text-text leading-none">
                                yolomarkets<span className="text-brand-dot">.</span>
                            </span>
                        </Link>
                        <p className="text-[12.5px] leading-[1.6] text-text-dim">
                            Real-world prediction markets settled in USDT on BOT Chain.
                            An autonomous agent reads the news, sizes by Kelly,
                            and trades on your behalf.
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                            <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.18em] text-yes num">
                                <span className="w-1.5 h-1.5 rounded-full bg-yes live-dot" />
                                live · testnet
                            </span>
                        </div>
                    </div>

                    {/* Product */}
                    <FooterColumn label="Product">
                        {PRODUCT.map((l) => (
                            <FooterLink key={l.href} href={l.href}>
                                {l.label}
                            </FooterLink>
                        ))}
                    </FooterColumn>

                    {/* Resources */}
                    <FooterColumn label="Resources">
                        {RESOURCES.map((l) => (
                            <FooterLink key={l.href} href={l.href} external={l.external}>
                                {l.label}
                            </FooterLink>
                        ))}
                    </FooterColumn>

                    {/* Legal */}
                    <FooterColumn label="Legal">
                        {LEGAL.map((l) => (
                            <FooterLink key={l.href} href={l.href}>
                                {l.label}
                            </FooterLink>
                        ))}
                    </FooterColumn>
                </div>

            </div>
        </footer>
    );
}

function FooterColumn({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3">
            <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                / {label}
            </span>
            <ul className="flex flex-col gap-2">{children}</ul>
        </div>
    );
}

function FooterLink({
    href,
    children,
    external,
}: {
    href: string;
    children: React.ReactNode;
    external?: boolean;
}) {
    if (external) {
        return (
            <li>
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12.5px] text-text-dim hover:text-text transition-colors inline-flex items-center gap-1.5 group"
                >
                    {children}
                    <span className="text-text-faint text-[10px] group-hover:text-text-mute transition-colors">
                        ↗
                    </span>
                </a>
            </li>
        );
    }
    return (
        <li>
            <Link
                href={href}
                className="text-[12.5px] text-text-dim hover:text-text transition-colors"
            >
                {children}
            </Link>
        </li>
    );
}
