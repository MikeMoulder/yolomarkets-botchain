/**
 * Input parsing + validation for admin-authored markets (the Telegram
 * `/create` command center).
 *
 * Unlike `lib/list-market`, which mirrors an existing Polymarket market, these
 * markets are written from scratch by the admin — so everything the contract
 * needs (question, deadline, seed, resolution criteria) has to be parsed out of
 * chat text and sanity-checked before a tx is signed.
 */
import { classifyCategoryFromText } from "./list-market";

/** Contract writes these to immutable storage; keep them small enough that the
 *  createMarket calldata stays cheap and the UI can render them. */
export const MAX_QUESTION_LEN = 200;
export const MAX_CRITERIA_LEN = 1000;

/** A market must outlive the deploy round-trip by a sane margin. */
export const MIN_TTL_SECONDS = 10 * 60;
/** Two years. Guards against a fat-fingered year (2036 instead of 2026). */
export const MAX_TTL_SECONDS = 730 * 86_400;

export const MIN_SEED_USDC = 0.1;
export const MAX_SEED_USDC = 10_000;

/** Categories the catalog already filters on — same set `classifyCategoryFromText`
 *  can return, so an auto-classified draft always lands on a known chip. */
export const CATEGORIES = [
    // Curated house rail — sits directly under Biggest Movers on the homepage.
    // Deliberately absent from `classifyCategoryFromText`: it is an editorial
    // pick, never something auto-inferred from the question text.
    "BOT Special",
    "Crypto",
    "Sports",
    "Politics",
    "Geopolitics",
    "Tech",
    "Macro",
    "Culture",
    "Science",
    "Other",
] as const;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T,>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T,>(error: string): ParseResult<T> => ({ ok: false, error });

// ── Question ────────────────────────────────────────────────────────────────

export function parseQuestion(raw: string): ParseResult<string> {
    const q = raw.trim().replace(/\s+/g, " ");
    if (q.length < 8) return fail("Question is too short — write a full yes/no question.");
    if (q.length > MAX_QUESTION_LEN) {
        return fail(`Question is ${q.length} chars; keep it under ${MAX_QUESTION_LEN}.`);
    }
    return ok(q);
}

// ── Deadline ────────────────────────────────────────────────────────────────

const RELATIVE_RE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/;

const UNIT_SECONDS: Record<string, number> = {
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    d: 86_400, day: 86_400, days: 86_400,
    w: 604_800, week: 604_800, weeks: 604_800,
};

/**
 * Accepts a relative span (`36h`, `7d`, `2w`), a bare date (`2026-12-31` →
 * 23:59:59 UTC that day), a date + time (`2026-12-31 18:00`, UTC), or a full
 * ISO timestamp with an explicit zone. Everything without a zone is read as
 * UTC — the admin chats from anywhere, and the chain only knows UTC.
 */
export function parseDeadline(raw: string, nowSec = Math.floor(Date.now() / 1000)): ParseResult<bigint> {
    const input = raw.trim();
    if (!input) return fail("Empty deadline.");

    let ts: number | null = null;

    const rel = RELATIVE_RE.exec(input);
    if (rel) {
        const amount = Number(rel[1]);
        const unit = UNIT_SECONDS[rel[2].toLowerCase()];
        if (!Number.isFinite(amount) || !unit) return fail("Couldn't read that duration.");
        ts = nowSec + Math.round(amount * unit);
    } else if (DATE_ONLY_RE.test(input)) {
        ts = Math.floor(Date.parse(`${input}T23:59:59Z`) / 1000);
    } else {
        const dt = DATE_TIME_RE.exec(input);
        // A trailing Z or ±hh:mm means the admin was explicit; otherwise assume UTC.
        const iso = dt ? `${dt[1]}T${dt[2]}:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input) ? input : `${input}Z`;
        const parsed = Date.parse(iso);
        ts = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }

    if (ts === null || !Number.isFinite(ts)) {
        return fail("Couldn't read that date. Try <code>7d</code>, <code>2026-12-31</code>, or <code>2026-12-31 18:00</code>.");
    }
    if (ts <= nowSec + MIN_TTL_SECONDS) {
        return fail(`Deadline must be at least ${MIN_TTL_SECONDS / 60} minutes out.`);
    }
    if (ts > nowSec + MAX_TTL_SECONDS) {
        return fail("Deadline is more than 2 years out — double-check the year.");
    }
    return ok(BigInt(ts));
}

// ── Seed liquidity ──────────────────────────────────────────────────────────

/** USDT is 6-dec on Bohr; anything finer would be silently truncated by
 *  `parseUnits`, so round here where we can tell the admin about it. */
export function parseSeed(raw: string): ParseResult<number> {
    const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "").replace(/\s*usdc$/i, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return fail("Seed must be a number, e.g. <code>10</code>.");
    const rounded = Math.round(n * 1e6) / 1e6;
    if (rounded < MIN_SEED_USDC) return fail(`Seed must be at least $${MIN_SEED_USDC} USDC.`);
    if (rounded > MAX_SEED_USDC) return fail(`Seed above $${MAX_SEED_USDC} — refusing as a fat-finger guard.`);
    return ok(rounded);
}

// ── Category & criteria ─────────────────────────────────────────────────────

export function normalizeCategory(raw: string): string | null {
    const want = raw.trim().toLowerCase();
    return CATEGORIES.find((c) => c.toLowerCase() === want) ?? null;
}

export function inferCategory(question: string): string {
    return classifyCategoryFromText(question);
}

/**
 * Default resolution criteria for a hand-written market. Deliberately spells
 * out that settlement is manual: unlike Polymarket mirrors, nothing in this
 * repo auto-resolves these — `polymarket-resolution-keeper` only settles
 * markets carrying POLYMARKET_MIRROR metadata.
 */
export function defaultCriteria(question: string, deadline: bigint): string {
    return [
        `Resolves YES if, at the deadline (${formatDeadline(deadline)}), the following is true: ${question}`,
        "Otherwise resolves NO.",
        "Settled manually by the YOLO Markets resolver from public reporting at the deadline.",
    ].join(" ");
}

export function parseCriteria(raw: string): ParseResult<string> {
    const c = raw.trim();
    if (c.length < 10) return fail("Criteria is too short to be useful.");
    if (c.length > MAX_CRITERIA_LEN) {
        return fail(`Criteria is ${c.length} chars; keep it under ${MAX_CRITERIA_LEN}.`);
    }
    return ok(c);
}

// ── One-shot `/create` arguments ────────────────────────────────────────────

export type CreateArgs = {
    question: string;
    deadline: bigint;
    seedUsdc: number;
    category: string | null;
    criteria: string | null;
};

/**
 * Parse the power-user form:
 *   /create <question> | <deadline> | <seed> [| <category>] [| <criteria>]
 *
 * Returns null (not an error) when the admin sent a bare `/create`, which
 * means "walk me through it".
 */
export function parseCreateArgs(
    raw: string,
    nowSec = Math.floor(Date.now() / 1000),
): ParseResult<CreateArgs> | null {
    const body = raw.trim();
    if (!body) return null;

    const parts = body.split("|").map((p) => p.trim());
    if (parts.length < 3) {
        return fail(
            "Need at least <code>question | deadline | seed</code> — or send a bare /create to be walked through it.",
        );
    }

    const question = parseQuestion(parts[0]);
    if (!question.ok) return fail(question.error);
    const deadline = parseDeadline(parts[1], nowSec);
    if (!deadline.ok) return fail(deadline.error);
    const seed = parseSeed(parts[2]);
    if (!seed.ok) return fail(seed.error);

    let category: string | null = null;
    if (parts[3]) {
        category = normalizeCategory(parts[3]);
        if (!category) {
            return fail(`Unknown category "${parts[3]}". One of: ${CATEGORIES.join(", ")}.`);
        }
    }

    let criteria: string | null = null;
    if (parts[4]) {
        // Rejoin anything past the 5th field — criteria prose may contain "|".
        const rest = parts.slice(4).join(" | ");
        const parsed = parseCriteria(rest);
        if (!parsed.ok) return fail(parsed.error);
        criteria = parsed.value;
    }

    return ok({ question: question.value, deadline: deadline.value, seedUsdc: seed.value, category, criteria });
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDeadline(deadline: bigint): string {
    return `${new Date(Number(deadline) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatCountdown(deadline: bigint, nowSec = Math.floor(Date.now() / 1000)): string {
    const secs = Number(deadline) - nowSec;
    if (secs <= 0) return "expired";
    if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
    if (secs < 86_400) return `in ${(secs / 3600).toFixed(1)}h`;
    return `in ${(secs / 86_400).toFixed(1)}d`;
}
