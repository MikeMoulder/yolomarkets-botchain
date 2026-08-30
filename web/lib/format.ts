// Formatting helpers — all keep tabular feel (compact, monospace-friendly).

/** USDC ERC-20 uses 6 decimals; returns "12.45" or "0.0123". */
export function formatUsdc(raw: bigint | number, opts: { sign?: boolean } = {}): string {
    const n = typeof raw === "bigint" ? Number(raw) / 1e6 : raw;
    const abs = Math.abs(n);
    const fmt =
        abs >= 1000
            ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 })
            : abs >= 1
              ? abs.toFixed(2)
              : abs.toFixed(4);
    const sign = opts.sign ? (n >= 0 ? "+" : "-") : n < 0 ? "-" : "";
    return `${sign}${fmt}`;
}

/** PredictionMarket.priceYes() returns int256 scaled by 1e18. Convert to 0..1. */
export function priceToProb(raw: bigint): number {
    return Number(raw) / 1e18;
}

/** "34.2%" / "0.05%" — adapts precision for very small / very large probs. */
export function formatProb(p: number, opts: { signed?: boolean } = {}): string {
    const pct = p * 100;
    const fmt =
        pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
    if (opts.signed) {
        return `${pct >= 0 ? "+" : ""}${fmt}%`;
    }
    return `${fmt}%`;
}

/** "34¢" — Polymarket-style cents display for prices. */
export function formatCents(p: number): string {
    const cents = p * 100;
    if (cents < 1) return `${cents.toFixed(2)}¢`;
    if (cents < 10) return `${cents.toFixed(1)}¢`;
    // Preserve one decimal place for thin-market prices such as 97.6¢;
    // rounding these to whole cents can incorrectly show 100¢.
    const rounded = Math.round(cents * 10) / 10;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}¢`;
}

/** "3d 4h" / "12h 5m" / "8m" — relative time until a UNIX timestamp. */
export function formatTimeUntil(deadline: bigint | number): string {
    const now = Math.floor(Date.now() / 1000);
    const t = typeof deadline === "bigint" ? Number(deadline) : deadline;
    const s = t - now;
    if (s <= 0) return "ended";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

/** "May 28, 16:00 UTC" — absolute, terse. */
export function formatAbs(deadline: bigint | number): string {
    const t = typeof deadline === "bigint" ? Number(deadline) : deadline;
    const d = new Date(t * 1000);
    const date = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
    });
    const time = d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
    });
    return `${date}, ${time} UTC`;
}

/** Compact USD: "$24.4M" / "$182k" / "$8.20" — tabular-friendly. */
export function formatCompactUsd(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "$0";
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
    return `$${n.toFixed(2)}`;
}

/** "0xa1b2…c3d4" */
export function shortAddr(addr: string, len = 4): string {
    if (!addr || addr.length < 10) return addr;
    return `${addr.slice(0, 2 + len)}…${addr.slice(-len)}`;
}

export function formatOutcomeLabel(outcome: number): string {
    if (outcome === 1) return "YES";
    if (outcome === 2) return "NO";
    if (outcome === 3) return "cancelled";
    return "—";
}

/** Slug-ify a question for URLs (best-effort, kept short). */
export function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}
