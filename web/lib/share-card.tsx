/**
 * Shareable ticket images — the market card and the bet card.
 *
 * Rendered with `next/og` (Satori → resvg), which is a *subset* of CSS: flexbox
 * only (no grid), no shorthand-heavy rules, and any element with more than one
 * child needs an explicit `display: flex`. Everything here is written to those
 * rules on purpose — see node_modules/next/dist/docs/.../image-response.md.
 *
 * Typeface: @vercel/og bundles Geist-Regular as its default font — the same
 * family the app uses (`next/font/google` Geist) — so no `fontFamily` is
 * declared and no font file is shipped. Two consequences worth knowing:
 *   · There is no bold cut available, so hierarchy comes from size, colour,
 *     letter-spacing and layout rather than weight. That suits the app's
 *     restrained look anyway.
 *   · Satori shapes some space pairs (notably after "r") slightly wide. It is
 *     a shaping artifact, not a layout bug: verified identical with an
 *     explicitly registered Geist ttf, at every letterSpacing, and with
 *     block vs flex text nodes. `wordSpacing` is ignored by Satori. Don't
 *     chase it.
 *
 * Text nodes are `display: block` on purpose: a Satori div defaults to
 * `display: flex`, which turns each word into a flex item — and a block node
 * may only have ONE child, so interpolate rather than mixing value + literal.
 */
import { ImageResponse } from "next/og";

// Design tokens, mirrored from app/globals.css. Satori can't read CSS vars.
export const C = {
    bg: "#0a0d12",
    elev: "#11151c",
    elev2: "#181d26",
    border: "rgba(255,255,255,0.09)",
    borderStrong: "rgba(255,255,255,0.15)",
    text: "#f0f1f4",
    dim: "#a8acb5",
    mute: "#6c7280",
    faint: "#4a4e58",
    yes: "#4ec9a3",
    no: "#f76b6b",
    accent: "#2cb1ff",
    edge: "#f0c14b",
    brandDot: "#e85b5b",
} as const;

export const SIZE = { width: 1200, height: 630 };

/** Deterministic hue per market, so an artless card still feels bespoke and a
 *  given market always renders the same colour. */
export function hueFor(seed: string): number {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
    return h;
}

export function truncate(s: string, max: number): string {
    const t = s.trim().replace(/\s+/g, " ");
    return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Question type size steps down as the question gets longer, so a short punchy
 *  market fills the card and a long one still fits without clipping. */
function questionSize(len: number): number {
    if (len <= 48) return 56;
    if (len <= 80) return 47;
    if (len <= 120) return 40;
    return 34;
}

export function centsLabel(p: number): string {
    return `${Math.round(p * 100)}¢`;
}

export function compactUsd(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    // Cents matter below $1k — a payout reading "$143" when it's $142.50 makes
    // the card look approximate, which is the opposite of what a receipt wants.
    return `$${n.toFixed(2)}`;
}

export function timeLeft(deadlineSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
    const s = deadlineSec - nowSec;
    if (s <= 0) return "closed";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m left`;
    if (s < 86_400) return `${Math.round(s / 3600)}h left`;
    return `${Math.round(s / 86_400)}d left`;
}

/** Lowercased on purpose: checksum casing is noise on a share card, and mixing
 *  the two across cards looked like a bug. */
export function shortAddress(a: string): string {
    const s = a.toLowerCase();
    return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

// ── Shared chrome ───────────────────────────────────────────────────────────

/** Micro-label: uppercase, wide tracking — the app's section-label idiom. */
function Label({ children, color = C.mute }: { children: string; color?: string }) {
    return (
        <div style={{ display: "block", fontSize: 17, letterSpacing: 3.4, textTransform: "uppercase", color }}>
            {children}
        </div>
    );
}

/** The wordmark, including the crimson full stop that the app treats as the
 *  actual brand mark. */
function Wordmark({ scale = 1 }: { scale?: number }) {
    return (
        <div style={{ display: "flex", alignItems: "baseline", fontSize: 27 * scale, color: C.text, letterSpacing: -0.4 }}>
            yolomarkets
            {/* Pulled tight: as its own flex child the dot otherwise sits a full
                space away and the wordmark reads as "yolomarkets ." */}
            <div style={{ display: "flex", color: C.brandDot, fontSize: 33 * scale, marginLeft: -3 * scale }}>.</div>
        </div>
    );
}

/** Inset of the ticket from the image edge — the "matting" that makes it read
 *  as a physical card sitting on a surface rather than a full-bleed banner. */
const MAT = 54;

function Frame({ accent, children }: { accent: string; children: React.ReactNode }) {
    return (
        // ── Backdrop: darker than the card, tinted by the ticket's accent, so
        //    the card lifts off it. Corner glows sit out here rather than on the
        //    card itself, which keeps the card surface clean.
        <div
            style={{
                width: "100%",
                height: "100%",
                display: "flex",
                padding: MAT,
                backgroundColor: "#05070a",
                backgroundImage: `radial-gradient(820px 620px at 92% -12%, ${accent}44 0%, transparent 58%), radial-gradient(700px 560px at 4% 114%, #2cb1ff33 0%, transparent 56%), linear-gradient(115deg, rgba(255,255,255,0.05) 0%, transparent 34%), linear-gradient(160deg, #0a0e15 0%, #05070a 52%, #080c13 100%)`,
            }}
        >
            {/* ── The ticket itself. */}
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    flex: 1,
                    position: "relative",
                    borderRadius: 28,
                    border: `1px solid ${C.borderStrong}`,
                    backgroundColor: C.bg,
                    // Faint interior washes — much softer than the backdrop, so
                    // the card reads as lit rather than painted.
                    backgroundImage: `radial-gradient(820px 420px at 100% 0%, ${accent}14 0%, transparent 62%), radial-gradient(560px 360px at 0% 100%, #2cb1ff0f 0%, transparent 60%)`,
                    // Drop shadow + a hairline top highlight = the card edge.
                    boxShadow: `0 28px 70px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,255,255,0.03)`,
                    overflow: "hidden",
                }}
            >
                {/* Top accent rule — the one saturated element on the card. */}
                <div style={{ display: "flex", position: "absolute", top: 0, left: 0, right: 0, height: 4, backgroundImage: `linear-gradient(90deg, ${accent} 0%, ${accent}00 78%)` }} />
                {children}
            </div>
        </div>
    );
}

function Footer({ right }: { right: string }) {
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: 22,
                borderTop: `1px solid ${C.border}`,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <Wordmark />
                <div style={{ display: "flex", width: 1, height: 22, backgroundColor: C.borderStrong }} />
                <div style={{ display: "block", fontSize: 19, color: C.mute }}>prediction markets on BOT Chain</div>
            </div>
            <div style={{ display: "block", fontSize: 19, color: C.faint, letterSpacing: 1.2 }}>{right}</div>
        </div>
    );
}

/** Generated artwork for markets with no cover image — a category monogram on
 *  a hue derived from the address, so it reads as intentional rather than empty. */
function GeneratedArt({ category, hue, size }: { category: string; hue: number; size: number }) {
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: size,
                height: size,
                flexShrink: 0,
                borderRadius: 26,
                border: `1px solid ${C.border}`,
                backgroundImage: `linear-gradient(150deg, hsl(${hue} 62% 26%) 0%, hsl(${(hue + 42) % 360} 55% 13%) 100%)`,
            }}
        >
            <div style={{ display: "flex", fontSize: size * 0.34, color: "rgba(255,255,255,0.92)", letterSpacing: -1 }}>
                {category.slice(0, 2).toUpperCase()}
            </div>
        </div>
    );
}

function Art({ src, category, hue, size }: { src: string | null; category: string; hue: number; size: number }) {
    if (!src) return <GeneratedArt category={category} hue={hue} size={size} />;
    return (
        <div
            style={{
                display: "flex",
                width: size,
                height: size,
                flexShrink: 0,
                borderRadius: 26,
                overflow: "hidden",
                border: `1px solid ${C.borderStrong}`,
            }}
        >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} width={size} height={size} style={{ objectFit: "cover" }} alt="" />
        </div>
    );
}

/** The YES/NO split bar — the single clearest read of where the market sits. */
function ProbBar({ yes }: { yes: number }) {
    const pct = Math.max(0.02, Math.min(0.98, yes));
    return (
        <div style={{ display: "flex", width: "100%", height: 12, borderRadius: 999, overflow: "hidden", backgroundColor: C.elev2 }}>
            <div style={{ display: "flex", width: `${pct * 100}%`, backgroundImage: `linear-gradient(90deg, ${C.yes}cc, ${C.yes})` }} />
            <div style={{ display: "flex", flex: 1, backgroundImage: `linear-gradient(90deg, ${C.no}, ${C.no}cc)` }} />
        </div>
    );
}

function PricePill({ side, price }: { side: "yes" | "no"; price: number }) {
    const color = side === "yes" ? C.yes : C.no;
    return (
        <div
            style={{
                display: "flex",
                flex: 1,
                alignItems: "center",
                justifyContent: "space-between",
                padding: "18px 24px",
                borderRadius: 18,
                border: `1px solid ${color}44`,
                backgroundColor: `${color}12`,
            }}
        >
            <div style={{ display: "flex", fontSize: 20, letterSpacing: 3.2, textTransform: "uppercase", color }}>
                {side}
            </div>
            <div style={{ display: "flex", fontSize: 42, color: C.text, letterSpacing: -1 }}>{centsLabel(price)}</div>
        </div>
    );
}

function Stat({ label, value, color = C.text }: { label: string; value: string; color?: string }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Label>{label}</Label>
            <div style={{ display: "block", fontSize: 34, color, letterSpacing: -0.6 }}>{value}</div>
        </div>
    );
}

// ── Fallback ────────────────────────────────────────────────────────────────

/** Branded card for the cases where there's nothing to render (bad address,
 *  chain read failed). Sharing a link must never produce a broken image. */
export function fallbackTicket(message: string): ImageResponse {
    return new ImageResponse(
        (
            <Frame accent={C.accent}>
                <div
                    style={{
                        display: "flex",
                        flex: 1,
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 22,
                    }}
                >
                    <Wordmark scale={2.4} />
                    <div style={{ display: "block", fontSize: 26, color: C.mute, letterSpacing: 2 }}>{message}</div>
                </div>
            </Frame>
        ),
        SIZE,
    );
}

// ── Market ticket ───────────────────────────────────────────────────────────

export type MarketTicket = {
    address: string;
    question: string;
    category: string;
    yesProb: number;
    liquidityUsd: number;
    deadlineSec: number;
    imageSrc: string | null;
    resolved?: boolean;
    outcomeLabel?: string | null;
};

export function marketTicket(m: MarketTicket): ImageResponse {
    const hue = hueFor(m.address);
    const accent = m.resolved ? C.edge : C.accent;
    const question = truncate(m.question, 150);

    return new ImageResponse(
        (
            <Frame accent={accent}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "40px 46px 34px 46px" }}>
                    {/* Meta row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                        <div
                            style={{
                                display: "flex",
                                padding: "8px 18px",
                                borderRadius: 999,
                                border: `1px solid ${accent}55`,
                                backgroundColor: `${accent}14`,
                                fontSize: 18,
                                letterSpacing: 2.6,
                                textTransform: "uppercase",
                                color: accent,
                            }}
                        >
                            {truncate(m.category || "Other", 18)}
                        </div>
                        <div style={{ display: "block", fontSize: 19, color: C.mute, letterSpacing: 1.4 }}>
                            {m.resolved ? `resolved ${m.outcomeLabel ?? ""}`.trim() : timeLeft(m.deadlineSec)}
                        </div>
                    </div>

                    {/* Body: art + question. `flex: 1` distributes the slack
                        around this row instead of dumping it all below, which
                        left the prob bar visually welded to the artwork. */}
                    <div style={{ display: "flex", gap: 40, marginTop: 20, marginBottom: 20, flex: 1, alignItems: "center" }}>
                        <Art src={m.imageSrc} category={m.category || "Other"} hue={hue} size={150} />
                        <div style={{ display: "flex", flex: 1, flexDirection: "column" }}>
                            <div
                                style={{
                                    display: "block",
                                    fontSize: questionSize(question.length),
                                    lineHeight: 1.13,
                                    color: C.text,
                                    letterSpacing: -1.4,
                                }}
                            >
                                {question}
                            </div>
                        </div>
                    </div>

                    {/* Prices */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                        <ProbBar yes={m.yesProb} />
                        <div style={{ display: "flex", gap: 16 }}>
                            <PricePill side="yes" price={m.yesProb} />
                            <PricePill side="no" price={1 - m.yesProb} />
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    justifyContent: "center",
                                    gap: 6,
                                    padding: "14px 26px",
                                    borderRadius: 18,
                                    border: `1px solid ${C.border}`,
                                    backgroundColor: C.elev,
                                }}
                            >
                                <Label>liquidity</Label>
                                <div style={{ display: "flex", fontSize: 32, color: C.dim, letterSpacing: -0.6 }}>
                                    {compactUsd(m.liquidityUsd)}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", marginTop: 20 }}>
                        <Footer right={shortAddress(m.address)} />
                    </div>
                </div>
            </Frame>
        ),
        SIZE,
    );
}

// ── Bet ticket ──────────────────────────────────────────────────────────────

export type BetTicket = {
    address: string;
    question: string;
    category: string;
    side: "yes" | "no";
    /** Whole shares held (6-dec value already divided down). */
    shares: number;
    /** Current market price of the held side, 0..1 */
    price: number;
    deadlineSec: number;
    imageSrc: string | null;
    holder: string | null;
    resolved?: boolean;
    /** Set when the market is settled: did this side win? */
    won?: boolean | null;
};

export function betTicket(b: BetTicket): ImageResponse {
    const hue = hueFor(b.address);
    const sideColor = b.side === "yes" ? C.yes : C.no;
    // Every share pays out $1 if the side is correct — so the payout multiple
    // is just 1/price. That, not a fabricated P&L, is the honest brag: we have
    // no on-chain cost basis to compute entry from.
    const value = b.shares * b.price;
    const multiple = b.price > 0 ? 1 / b.price : 0;
    const settled = !!b.resolved;
    // A losing side pays nothing — printing the share count as "payout" would
    // be a lie on the one card people screenshot.
    const settledPayout = settled && !b.won ? 0 : b.shares;
    const accent = settled ? (b.won ? C.yes : C.no) : sideColor;
    const question = truncate(b.question, 110);

    return new ImageResponse(
        (
            <Frame accent={accent}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "36px 46px 34px 46px" }}>
                    {/* Position headline */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    padding: "12px 30px",
                                    borderRadius: 16,
                                    border: `1px solid ${sideColor}66`,
                                    backgroundColor: `${sideColor}18`,
                                    fontSize: 40,
                                    letterSpacing: 6,
                                    textTransform: "uppercase",
                                    color: sideColor,
                                }}
                            >
                                {b.side}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                <Label>{settled ? (b.won ? "settled · won" : "settled · lost") : "position"}</Label>
                                <div style={{ display: "block", fontSize: 30, color: C.dim, letterSpacing: -0.4 }}>
                                    {/* One expression, not value + literal: a block
                                        node with two children is a Satori error. */}
                                    {`${b.shares.toLocaleString("en-US", { maximumFractionDigits: 2 })} shares`}
                                </div>
                            </div>
                        </div>
                        {b.holder && (
                            <div
                                style={{
                                    display: "flex",
                                    padding: "9px 20px",
                                    borderRadius: 999,
                                    border: `1px solid ${C.border}`,
                                    backgroundColor: C.elev,
                                    fontSize: 20,
                                    color: C.mute,
                                    letterSpacing: 1,
                                }}
                            >
                                {shortAddress(b.holder)}
                            </div>
                        )}
                    </div>

                    {/* Market — `flex: 1` centres it in the slack rather than
                        leaving a void between the header and the stat bar. */}
                    <div style={{ display: "flex", gap: 32, marginTop: 20, marginBottom: 20, flex: 1, alignItems: "center" }}>
                        <Art src={b.imageSrc} category={b.category || "Other"} hue={hue} size={120} />
                        <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 12 }}>
                            <div style={{ display: "block", fontSize: question.length > 70 ? 31 : 37, lineHeight: 1.15, color: C.text, letterSpacing: -1 }}>
                                {question}
                            </div>
                            <div style={{ display: "block", fontSize: 19, color: C.faint, letterSpacing: 1.4 }}>
                                {settled ? "market settled" : timeLeft(b.deadlineSec)}
                            </div>
                        </div>
                    </div>

                    {/* The numbers. Settled cards drop the "value" column —
                        once the market pays $1 or $0 a share, value and payout
                        are the same figure printed twice. */}
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            // gap guarantees clearance so a wide figure never
                            // crowds the divider next to it.
                            gap: 28,
                            padding: "26px 34px",
                            borderRadius: 22,
                            border: `1px solid ${C.border}`,
                            backgroundColor: C.elev,
                        }}
                    >
                        <Stat label={settled ? "settled at" : "now"} value={centsLabel(b.price)} color={accent} />
                        <div style={{ display: "flex", width: 1, height: 58, backgroundColor: C.border }} />
                        {!settled && (
                            <>
                                <Stat label="value" value={compactUsd(value)} color={C.dim} />
                                <div style={{ display: "flex", width: 1, height: 58, backgroundColor: C.border }} />
                            </>
                        )}
                        <Stat label={settled ? "payout" : "pays"} value={compactUsd(settledPayout)} />
                        <div style={{ display: "flex", width: 1, height: 58, backgroundColor: C.border }} />
                        {/* The headline brag: what a correct call returns from here. */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                            <Label color={accent}>{settled ? "result" : "if right"}</Label>
                            <div style={{ display: "flex", fontSize: 52, color: accent, letterSpacing: -2 }}>
                                {settled ? (b.won ? "WON" : "LOST") : `${multiple.toFixed(2)}×`}
                            </div>
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", marginTop: 18 }}>
                        <Footer right={shortAddress(b.address)} />
                    </div>
                </div>
            </Frame>
        ),
        SIZE,
    );
}
