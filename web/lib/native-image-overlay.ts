/**
 * Map native market questions back to Polymarket event imagery.
 *
 * Two-pass lookup:
 *   1. Exact normalized-title match — fast hit for markets that were wrapped
 *      from a Polymarket event (the title is preserved verbatim during wrap).
 *   2. Token-overlap fuzzy match — catches admin-created markets whose
 *      question text doesn't appear verbatim in the Polymarket catalog
 *      (e.g. our 5 originals: ETH/USD, Fed cut, GPT-6, Lakers, Trump-Xi).
 *      Uses synonym expansion (eth↔ethereum, fomc↔fed, lakers↔nba, etc.) so
 *      the obvious topical overlap actually scores. Tiebreaks by 24h volume
 *      so we pick the most-traded event when several match equally.
 *
 *  Final fallback (no match): caller renders the CSS-art tile instead.
 */

import { cache } from "react";
import { fetchWrappablePolymarketMarkets, type PolymarketEvent } from "./polymarket";

export type NativeImageLookup = (question: string) => string | null;
export type NativeMatchLookup = (question: string) => PolymarketEvent | null;

type OverlayResult = { lookup: NativeMatchLookup; eventCount: number };

/** Explicit overrides — applied first, before exact/fuzzy match. Used for
 *  admin-created markets whose question text doesn't surface in the current
 *  Polymarket catalog (so fuzzy match correctly returns nothing) but for
 *  which we have a known-good Polymarket S3 asset.
 *
 *  Keys are normalized (trim + lowercase) match against the on-chain question.
 *  Values must be 200-verified Polymarket-upload S3 URLs.
 */
const OVERRIDES: Record<string, string> = {
    "will openai release gpt-6 before october 1, 2026?":
        "https://polymarket-upload.s3.us-east-2.amazonaws.com/openai.png",
};

const ASSET_OVERRIDES: { re: RegExp; image: string }[] = [
    {
        re: /\b(SOL|Solana)\b/i,
        image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/SOL-logo.png",
    },
    {
        // Use the current Federal Reserve chair for rate/FOMC markets rather
        // than inheriting stale Powell artwork from a fuzzy Polymarket match.
        re: /\b(fed|federal reserve|fomc|interest rates?|federal funds|monetary policy)\b/i,
        image: "https://www.federalreserve.gov/aboutthefed/images/chairman-warsh-130x168.png",
    },
];

// ── Tokenization ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "else",
    "will", "would", "could", "should", "do", "does", "did", "has", "have", "had",
    "this", "that", "these", "those", "it", "its", "as", "next", "any",
    "before", "after", "above", "below", "from", "into", "out", "for",
    "with", "without", "on", "off", "in", "at", "to", "of", "by",
    "again", "further", "once", "during", "while", "yes", "no",
    "all", "each", "few", "more", "most", "some", "such", "than",
    "very", "just", "only", "also", "still", "now",
]);

/** Tokens that are technically distinctive (length-wise) but contribute too
 *  much noise — generic verbs, market-status words, time words. Score-blocked.
 *
 *  The competition/outcome cluster (win, cup, fifa, world, champion, …) is the
 *  important one: templated families like "Will <country> win the 2026 FIFA
 *  World Cup?" otherwise all share those tokens, so a market whose entity isn't
 *  in the catalog cross-matches a sibling and inherits the wrong flag. Blocking
 *  them forces the match to hinge on the distinctive entity (the country). */
const NOISE_TOKENS = new Set([
    "hold", "make", "made", "release", "released", "close", "closes", "opens",
    "open", "rise", "fall", "rises", "falls", "gain", "loss", "level", "levels",
    "year", "years", "day", "days", "week", "weeks", "month", "months",
    "time", "times", "decision", "meeting", "vote", "votes", "person",
    "people", "place", "things", "stuff", "real", "fake", "true", "false",
    "high", "low", "good", "bad", "big", "small",
    // Competition / outcome words — generic across whole market families.
    "win", "wins", "winner", "winners", "won", "winning",
    "cup", "fifa", "uefa", "world", "champion", "champions", "championship",
    "championships", "league", "playoff", "playoffs", "tournament", "series",
    "goalscorer", "scorer", "final", "finals", "title", "trophy", "medal",
]);

/** Domain synonyms — light-touch expansion so 3-letter symbols (ETH, BTC, GPT,
 *  FOMC) match their longer counterparts in Polymarket titles. */
const SYNONYMS: Record<string, string[]> = {
    eth: ["ethereum"], ethereum: ["eth"],
    btc: ["bitcoin"], bitcoin: ["btc"],
    sol: ["solana"], solana: ["sol"],
    fed: ["federal", "fomc", "warsh"],
    fomc: ["fed", "federal", "warsh"],
    federal: ["fed", "fomc", "warsh"],
    warsh: ["fed", "federal", "fomc"],
    rates: ["rate"], rate: ["rates"],
    nba: ["basketball", "playoffs", "champion", "champions", "finals"],
    lakers: ["nba", "basketball"],
    celtics: ["nba", "basketball"],
    warriors: ["nba", "basketball"],
    gpt: ["openai", "chatgpt"],
    openai: ["gpt", "chatgpt", "altman"],
    chatgpt: ["openai", "gpt"],
    xi: ["china", "chinese", "beijing", "jinping"],
    china: ["xi", "chinese", "beijing", "jinping"],
    jinping: ["xi", "china"],
    trump: ["donald", "maga"],
    biden: ["joe", "potus"],
    iran: ["iranian", "tehran"],
    iranian: ["iran"],
    russia: ["russian", "putin", "moscow"],
    putin: ["russia", "russian"],
};

function expand(token: string): string[] {
    return SYNONYMS[token] ?? [];
}

function tokenize(s: string): Set<string> {
    const out = new Set<string>();
    const raw = s
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);

    for (const t of raw) {
        if (STOPWORDS.has(t)) continue;
        // 3-letter symbols (eth, btc, fed, gpt, nba, ufc) survive
        if (t.length < 3) continue;
        out.add(t);
        for (const syn of expand(t)) out.add(syn);
    }
    return out;
}

/** Distinctive tokens drive scoring — they're the ones whose match means
 *  the events are actually about the same thing. */
function isDistinctive(token: string): boolean {
    // Year tokens (2020..2099) are too common across markets to be signal —
    // a GPT-6 market would otherwise match a BTC-in-2026 market on the year alone.
    if (/^20\d{2}$/.test(token)) return false;
    // Bare digits (small numbers like "150", "4000", etc.) are kept — they're
    // often price levels that ARE topical.
    if (NOISE_TOKENS.has(token)) return false;
    if (token.length < 4) {
        // Short tokens only count if they look like an acronym/symbol
        return /^[a-z0-9]+$/.test(token) && /[a-z]/.test(token);
    }
    return true;
}

// ── Public API ────────────────────────────────────────────────────────────

const normalizeKey = (s: string) => s.trim().toLowerCase();

export async function getNativeImageOverlay(): Promise<NativeImageLookup> {
    const match = await getNativeMatchOverlay();
    return (question: string) => match(question)?.image ?? null;
}

export async function lookupNativeImage(question: string): Promise<string | null> {
    const lookup = await getNativeImageOverlay();
    return lookup(question);
}

/**
 * Match a native market question to a Polymarket event using the same 3-tier
 * lookup as the image overlay (override → exact → fuzzy/synonym).
 * Returns the matched event (carries image + 24h delta + slug) or null.
 *
 * Used by the movers strip to surface tradeable-on-Arc markets whose
 * Polymarket counterpart is moving.
 */
// `cache` dedupes this within a single request: the homepage builds the match
// index for BOTH the image overlay and the movers strip, and tokenizing ~500
// Polymarket titles + the IDF index is the page's main leftover CPU cost. With
// `cache` it runs once per render instead of twice.
const getOverlayResult = cache(async (): Promise<OverlayResult> => {
    // Scan wider than we display: the extra reach pulls in more group
    // children (e.g. lower-profile World Cup countries) so their card can
    // match its own image instead of falling back to the CSS tile. The API
    // caps the returned set around 500 either way, so this stays cheap.
    const events = await fetchWrappablePolymarketMarkets({ limit: 500, scanLimit: 1200 });
    return { lookup: buildMatchLookup(events), eventCount: events.length };
});

export const getNativeMatchOverlay = cache(async (): Promise<NativeMatchLookup> => {
    return (await getOverlayResult()).lookup;
});

/**
 * Overlay plus a health flag.
 *
 * Callers that *gate* on artwork need to tell "this market genuinely has no
 * image" apart from "Polymarket was unreachable, so nothing has an image".
 * Treating the second as the first empties the catalog — see the artwork filter
 * in app/page.tsx.
 */
export async function getNativeImageOverlayResult(): Promise<{
    lookup: NativeImageLookup;
    /** False when the Polymarket scan came back empty — i.e. we know nothing,
     *  rather than knowing there is no match. */
    available: boolean;
}> {
    const { lookup, eventCount } = await getOverlayResult();
    return {
        lookup: (question: string) => lookup(question)?.image ?? null,
        available: eventCount > 0,
    };
}

/** Minimum share of the query's distinctive information (IDF-weighted) a
 *  candidate must recover to count as a match. A candidate that overlaps only
 *  on common tokens — while the query's rare entity token goes unmatched —
 *  falls below this and is rejected (→ CSS-art fallback instead of a wrong
 *  image). Tuned against the live catalog: World Cup siblings score ~0.0–0.4,
 *  true entity matches score 1.0. */
const MATCH_MIN_IDF_RATIO = 0.55;

function buildMatchLookup(events: PolymarketEvent[]): NativeMatchLookup {
    const exact = new Map<string, PolymarketEvent>();
    const indexed: { tokens: Set<string>; event: PolymarketEvent; vol: number }[] = [];
    // For override → event reverse-lookup (overrides only have an image URL,
    // so we resolve them back to events by matching the image URL exactly).
    const byImage = new Map<string, PolymarketEvent>();
    // Document frequency per token across the event corpus — drives IDF so that
    // rare, entity-bearing tokens (a country, a name) dominate the score and
    // common template tokens barely register.
    const df = new Map<string, number>();

    for (const e of events) {
        if (!e.image) continue;
        const key = normalizeKey(e.title);
        if (!exact.has(key)) exact.set(key, e);
        if (!byImage.has(e.image)) byImage.set(e.image, e);
        const tokens = tokenize(e.title);
        for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
        indexed.push({ tokens, event: e, vol: e.volume24h });
    }

    const N = indexed.length;
    // Smoothed IDF: unseen query tokens (df 0 — e.g. a country absent from the
    // catalog) get the highest weight, so a match that can't recover them is
    // heavily penalised.
    const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1));

    return (question: string) => {
        const key = normalizeKey(question);

        // Tier 1: manual overrides — resolve back to event via image URL
        const overrideImg = OVERRIDES[key];
        if (overrideImg) {
            const ev = byImage.get(overrideImg);
            if (ev) return ev;
            // Override image with no live event — surface a synthetic event-
            // shaped object so the image still flows through getNativeImageOverlay.
            return { image: overrideImg } as unknown as PolymarketEvent;
        }
        for (const override of ASSET_OVERRIDES) {
            if (!override.re.test(question)) continue;
            const ev = byImage.get(override.image);
            if (ev) return ev;
            return { image: override.image } as unknown as PolymarketEvent;
        }
        // Tier 2: exact title match
        const hit = exact.get(key);
        if (hit) return hit;

        // Tier 3: fuzzy overlap, IDF-weighted. A candidate must recover enough
        // of the query's distinctive information — matching only shared template
        // tokens (while the entity goes unmatched) fails the ratio and returns
        // no image, so the card shows its clean per-market CSS tile instead of a
        // sibling's picture.
        const qTokens = tokenize(question);
        if (qTokens.size === 0) return null;
        const qDistinct = new Set<string>();
        for (const t of qTokens) if (isDistinctive(t)) qDistinct.add(t);
        if (qDistinct.size === 0) return null;

        let queryMass = 0;
        for (const t of qDistinct) queryMass += idf(t);
        if (queryMass <= 0) return null;

        let best: { event: PolymarketEvent; recovered: number; vol: number } | null = null;
        for (const item of indexed) {
            let recovered = 0;
            for (const t of qDistinct) {
                if (item.tokens.has(t)) recovered += idf(t);
            }
            if (recovered <= 0) continue;
            if (recovered / queryMass < MATCH_MIN_IDF_RATIO) continue;
            if (
                best === null ||
                recovered > best.recovered ||
                (recovered === best.recovered && item.vol > best.vol)
            ) {
                best = { event: item.event, recovered, vol: item.vol };
            }
        }
        return best?.event ?? null;
    };
}
