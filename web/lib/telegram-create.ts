/**
 * The `/create` flow of the Telegram admin command center — author a brand new
 * YOLO market from chat, with no dashboard and no local shell.
 *
 * Two entry points share one state machine:
 *   · `/create` on its own  → guided wizard, one question per step
 *   · `/create q | 7d | 10` → straight to the review card
 *
 * The wizard keeps editing a single "card" message rather than spamming the
 * chat, so a five-step flow reads as one live panel. State lives in Postgres
 * (lib/telegram-drafts) because every Telegram update is its own request.
 */
import {
    editMessageText,
    escapeHtml,
    sendMessage,
    type InlineButton,
} from "./telegram";
import {
    claimDraftForDeploy,
    getDraft,
    patchDraft,
    startDraft,
    type MarketDraft,
} from "./telegram-drafts";
import {
    CATEGORIES,
    defaultCriteria,
    formatCountdown,
    formatDeadline,
    inferCategory,
    normalizeCategory,
    parseCreateArgs,
    parseCriteria,
    parseDeadline,
    parseQuestion,
    parseSeed,
} from "./market-draft";
import { deployMarket, preflightCreate, type CreatePreflight } from "./list-market";
import { formatBytes, putMarketImage } from "./market-images";

import { EXPLORER_URL } from "./explorer";

const EXPLORER = EXPLORER_URL;

/** Callback prefixes owned by this flow. Kept two chars so they never collide
 *  with the Polymarket listing buttons (`L:`, `S:`, `X`). */
export const CREATE_CALLBACK_PREFIXES = ["cd:", "cs:", "cc:", "cr:", "cg:", "cx:", "cp:", "ci:"];

function deadlinePresets(): string[] {
    return (process.env.CREATE_DEADLINE_OPTIONS ?? "1h,6h,24h,3d,7d,30d")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

function seedPresets(): number[] {
    return (process.env.LISTING_SEED_OPTIONS ?? "1,5,10,25")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
}

function siteUrl(): string {
    return (process.env.NEXT_PUBLIC_SITE_URL ?? "https://yolomarkets.fun").replace(/\/$/, "");
}

function shortAddr(addr: string): string {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── Card rendering ──────────────────────────────────────────────────────────

/** Edit the draft's card in place, or open one if it doesn't have a message
 *  yet. Falls back to a fresh message when Telegram refuses the edit (message
 *  too old, or deleted by the admin). */
async function renderCard(
    draft: MarketDraft,
    text: string,
    keyboard?: InlineButton[][],
): Promise<void> {
    if (draft.cardMessageId !== null) {
        try {
            await editMessageText(draft.chatId, draft.cardMessageId, text, keyboard);
            return;
        } catch {
            // fall through to a new card
        }
    }
    const sent = (await sendMessage(draft.chatId, text, keyboard)) as { message_id?: number };
    if (sent?.message_id !== undefined) {
        await patchDraft(draft.id, { cardMessageId: sent.message_id });
        draft.cardMessageId = sent.message_id;
    }
}

const cancelRow = (id: string): InlineButton[] => [{ text: "✕ Cancel", callback_data: `cx:${id}` }];

function header(step: number): string {
    return `🆕 <b>New market</b> · step ${step}/4`;
}

function questionCard(draft: MarketDraft): { text: string; keyboard: InlineButton[][] } {
    return {
        text: [
            header(1),
            "",
            "Send the <b>question</b> — a claim that settles yes or no.",
            "",
            "<i>e.g. Will BTC close above $150,000 on Dec 31 2026?</i>",
        ].join("\n"),
        keyboard: [cancelRow(draft.id)],
    };
}

function deadlineCard(draft: MarketDraft): { text: string; keyboard: InlineButton[][] } {
    const presets = deadlinePresets();
    const rows: InlineButton[][] = [];
    for (let i = 0; i < presets.length; i += 3) {
        rows.push(
            presets.slice(i, i + 3).map((p) => ({ text: p, callback_data: `cd:${draft.id}:${p}` })),
        );
    }
    rows.push(cancelRow(draft.id));
    return {
        text: [
            header(2),
            `<b>${escapeHtml(draft.question ?? "")}</b>`,
            "",
            "When does it settle? Tap a preset or type one:",
            "<code>36h</code> · <code>2w</code> · <code>2026-12-31</code> · <code>2026-12-31 18:00</code> (UTC)",
        ].join("\n"),
        keyboard: rows,
    };
}

function seedCard(draft: MarketDraft): { text: string; keyboard: InlineButton[][] } {
    const row = seedPresets().map((amt) => ({
        text: `$${amt}`,
        callback_data: `cs:${draft.id}:${amt}`,
    }));
    return {
        text: [
            header(3),
            `<b>${escapeHtml(draft.question ?? "")}</b>`,
            `Ends: ${draft.deadline ? formatDeadline(draft.deadline) : "—"}`,
            "",
            "<b>Initial liquidity (USDC)</b> — tap a preset or type an amount.",
            "<i>This is the LMSR depth: more seed = flatter prices, but more of the deployer's USDC at risk.</i>",
        ].join("\n"),
        keyboard: [row, cancelRow(draft.id)],
    };
}

function categoryCard(draft: MarketDraft): { text: string; keyboard: InlineButton[][] } {
    const rows: InlineButton[][] = [];
    for (let i = 0; i < CATEGORIES.length; i += 3) {
        rows.push(
            CATEGORIES.slice(i, i + 3).map((c) => ({
                text: c === draft.category ? `• ${c}` : c,
                callback_data: `cc:${draft.id}:${c}`,
            })),
        );
    }
    rows.push(cancelRow(draft.id));
    return {
        text: [
            "🏷 <b>Category</b>",
            `<b>${escapeHtml(draft.question ?? "")}</b>`,
            "",
            `Current: <b>${escapeHtml(draft.category ?? "—")}</b> — pick another, or type one.`,
        ].join("\n"),
        keyboard: rows,
    };
}

function imageCard(draft: MarketDraft): { text: string; keyboard: InlineButton[][] } {
    const has = draft.imageData !== null;
    const rows: InlineButton[][] = [];
    if (has) rows.push([{ text: "🗑 Remove image", callback_data: `ci:${draft.id}:rm` }]);
    rows.push([{ text: "‹ Back to review", callback_data: `cp:${draft.id}` }]);
    rows.push(cancelRow(draft.id));
    return {
        text: [
            "🖼 <b>Cover image</b>",
            `<b>${escapeHtml(draft.question ?? "")}</b>`,
            "",
            "Send a photo — it becomes this market's card and hero art.",
            "<i>Square-ish crops read best; the card renders it at 1:1.</i>",
            "",
            has
                ? `Current: ${escapeHtml(draft.imageMime ?? "image")} · ${formatBytes(draft.imageSize ?? 0)}`
                : "Current: none — the catalog will fall back to a generated tile.",
        ].join("\n"),
        keyboard: rows,
    };
}

function criteriaCard(draft: MarketDraft): { text: string; keyboard: InlineButton[][] } {
    return {
        text: [
            "📝 <b>Resolution criteria</b>",
            `<b>${escapeHtml(draft.question ?? "")}</b>`,
            "",
            "Send the text that decides YES vs NO — name the source and the exact threshold.",
            "",
            "<i>Current:</i>",
            escapeHtml(draft.criteria ?? "—"),
        ].join("\n"),
        keyboard: [cancelRow(draft.id)],
    };
}

function preflightLines(pre: CreatePreflight, seed: number | null): string[] {
    if (pre.keyError) {
        return ["", `⛔️ <b>No deployer key:</b> ${escapeHtml(pre.keyError)}`];
    }
    const lines = [
        "",
        `Deployer: <code>${shortAddr(pre.deployer)}</code> · balance $${pre.balanceUsdc.toFixed(2)}`,
    ];
    if (!pre.isAdmin) {
        lines.push(
            `⛔️ <b>Not the factory admin.</b> Factory admin is <code>${pre.factoryAdmin ? shortAddr(pre.factoryAdmin) : "?"}</code> — <code>createMarket</code> would revert <code>NotAdmin</code>. Point <code>DEPLOYER_PRIVATE_KEY</code> at the admin key and redeploy the web app.`,
        );
    }
    if (pre.hasFunds === false && seed !== null) {
        lines.push(`⛔️ <b>Insufficient USDC:</b> need $${seed}, deployer holds $${pre.balanceUsdc.toFixed(2)}.`);
    }
    return lines;
}

async function confirmCard(draft: MarketDraft): Promise<{ text: string; keyboard: InlineButton[][] }> {
    const pre = await preflightCreate(draft.seedUsdc ?? undefined).catch((e) => {
        const msg = e instanceof Error ? e.message : "preflight failed";
        return {
            deployer: "0x0000000000000000000000000000000000000000",
            factory: "0x0000000000000000000000000000000000000000",
            factoryAdmin: null,
            isAdmin: false,
            balanceUsdc: 0,
            hasFunds: null,
            keyError: msg,
        } as CreatePreflight;
    });
    const blocked = !!pre.keyError || !pre.isAdmin || pre.hasFunds === false;

    const text = [
        "🔎 <b>Review — nothing is on-chain yet</b>",
        "",
        `<b>${escapeHtml(draft.question ?? "")}</b>`,
        `Category: ${escapeHtml(draft.category ?? "—")}`,
        `Ends: ${draft.deadline ? formatDeadline(draft.deadline) : "—"}${draft.deadline ? ` (${formatCountdown(draft.deadline)})` : ""}`,
        `Seed: $${draft.seedUsdc ?? "—"} USDC`,
        `Image: ${draft.imageData ? `✓ attached (${formatBytes(draft.imageSize ?? 0)})` : "none — send a photo to set one"}`,
        "",
        `<i>${escapeHtml(draft.criteria ?? "")}</i>`,
        ...preflightLines(pre, draft.seedUsdc),
    ].join("\n");

    const keyboard: InlineButton[][] = [];
    keyboard.push(
        blocked
            ? [{ text: "↻ Re-check", callback_data: `cp:${draft.id}` }]
            : [{ text: "✅ Create market", callback_data: `cg:${draft.id}` }],
    );
    keyboard.push([
        { text: "🏷 Category", callback_data: `cc:${draft.id}` },
        { text: "📝 Criteria", callback_data: `cr:${draft.id}` },
        { text: draft.imageData ? "🖼 Image ✓" : "🖼 Image", callback_data: `ci:${draft.id}` },
    ]);
    keyboard.push(cancelRow(draft.id));
    return { text, keyboard };
}

/** Draw whatever card matches the draft's current step. */
async function showStep(draft: MarketDraft): Promise<void> {
    switch (draft.step) {
        case "question": {
            const { text, keyboard } = questionCard(draft);
            return renderCard(draft, text, keyboard);
        }
        case "deadline": {
            const { text, keyboard } = deadlineCard(draft);
            return renderCard(draft, text, keyboard);
        }
        case "seed": {
            const { text, keyboard } = seedCard(draft);
            return renderCard(draft, text, keyboard);
        }
        case "category": {
            const { text, keyboard } = categoryCard(draft);
            return renderCard(draft, text, keyboard);
        }
        case "criteria": {
            const { text, keyboard } = criteriaCard(draft);
            return renderCard(draft, text, keyboard);
        }
        case "image": {
            const { text, keyboard } = imageCard(draft);
            return renderCard(draft, text, keyboard);
        }
        case "confirm": {
            const { text, keyboard } = await confirmCard(draft);
            return renderCard(draft, text, keyboard);
        }
        default:
            return;
    }
}

// ── Entry point: /create ────────────────────────────────────────────────────

/** Handle `/create [args]`. Returns nothing — everything is reported in chat. */
export async function handleCreateCommand(
    chatId: string,
    userId: string | null,
    args: string,
): Promise<void> {
    const parsed = parseCreateArgs(args);

    // Bare `/create` → guided wizard.
    if (parsed === null) {
        const draft = await startDraft(chatId, userId, { step: "question" });
        return showStep(draft);
    }

    if (!parsed.ok) {
        await sendMessage(
            chatId,
            [
                `⚠️ ${parsed.error}`,
                "",
                "<b>Usage</b>",
                "<code>/create question | deadline | seed [| category [| criteria]]</code>",
                "",
                "<i>/create Will BTC close above $150k on Dec 31 2026? | 2026-12-31 | 10</i>",
            ].join("\n"),
        );
        return;
    }

    const { question, deadline, seedUsdc, category, criteria } = parsed.value;
    const draft = await startDraft(chatId, userId, {
        step: "confirm",
        question,
        deadline,
        seedUsdc,
        category: category ?? inferCategory(question),
        criteria: criteria ?? defaultCriteria(question, deadline),
    });
    return showStep(draft);
}

// ── Free-text steps ─────────────────────────────────────────────────────────

/** Feed a plain chat message into the open draft. Returns true when the text
 *  was consumed by the wizard. */
export async function handleDraftText(draft: MarketDraft, text: string): Promise<boolean> {
    const value = text.trim();
    if (!value) return false;

    switch (draft.step) {
        case "question": {
            const q = parseQuestion(value);
            if (!q.ok) return warn(draft, q.error);
            const updated = await patchDraft(draft.id, {
                question: q.value,
                category: draft.category ?? inferCategory(q.value),
                step: "deadline",
            });
            if (updated) await showStep(updated);
            return true;
        }
        case "deadline": {
            const d = parseDeadline(value);
            if (!d.ok) return warn(draft, d.error);
            return applyDeadline(draft, d.value);
        }
        case "seed": {
            const s = parseSeed(value);
            if (!s.ok) return warn(draft, s.error);
            return applySeed(draft, s.value);
        }
        case "category": {
            const c = normalizeCategory(value);
            if (!c) return warn(draft, `Unknown category. One of: ${CATEGORIES.join(", ")}.`);
            return applyCategory(draft, c);
        }
        case "criteria": {
            const c = parseCriteria(value);
            if (!c.ok) return warn(draft, c.error);
            const updated = await patchDraft(draft.id, { criteria: c.value, step: "confirm" });
            if (updated) await showStep(updated);
            return true;
        }
        default:
            return false;
    }
}

/** Complain without losing the step — the card stays put, the reason arrives
 *  as its own message so the admin can just retype. */
async function warn(draft: MarketDraft, reason: string): Promise<boolean> {
    await sendMessage(draft.chatId, `⚠️ ${reason}`).catch(() => {});
    return true;
}

async function applyDeadline(draft: MarketDraft, deadline: bigint): Promise<boolean> {
    // Criteria is derived from the deadline, so refresh the default when the
    // admin hasn't hand-written one.
    const autoCriteria =
        !draft.criteria || (draft.question && draft.criteria === defaultCriteria(draft.question, draft.deadline ?? deadline));
    const updated = await patchDraft(draft.id, {
        deadline,
        step: draft.seedUsdc === null ? "seed" : "confirm",
        ...(autoCriteria && draft.question
            ? { criteria: defaultCriteria(draft.question, deadline) }
            : {}),
    });
    if (updated) await showStep(updated);
    return true;
}

async function applySeed(draft: MarketDraft, seedUsdc: number): Promise<boolean> {
    const criteria =
        draft.criteria ?? (draft.question && draft.deadline ? defaultCriteria(draft.question, draft.deadline) : null);
    const updated = await patchDraft(draft.id, {
        seedUsdc,
        step: "confirm",
        ...(criteria ? { criteria } : {}),
    });
    if (updated) await showStep(updated);
    return true;
}

async function applyCategory(draft: MarketDraft, category: string): Promise<boolean> {
    const updated = await patchDraft(draft.id, { category, step: "confirm" });
    if (updated) await showStep(updated);
    return true;
}

/**
 * Attach cover art to an open draft. Called from the router whenever the admin
 * sends a photo — from the image step, or at any other point in the flow (a
 * photo is unambiguous, so there's no reason to make them navigate to a step
 * first). The wizard resumes wherever it was, except on the terminal review
 * card where it re-renders to show the new image.
 */
export async function attachDraftImage(
    draft: MarketDraft,
    bytes: Buffer,
    mime: string,
): Promise<void> {
    // Mid-wizard, keep the admin on their current step; from `image` (or the
    // review card) drop them back on review.
    const step: MarketDraft["step"] =
        draft.step === "image" || draft.step === "confirm" ? "confirm" : draft.step;
    const updated = await patchDraft(draft.id, {
        imageData: bytes,
        imageMime: mime,
        imageSize: bytes.length,
        step,
    });
    if (!updated) return;
    await sendMessage(draft.chatId, `🖼 Image attached (${formatBytes(bytes.length)}).`).catch(() => {});
    await showStep(updated);
}

// ── Button callbacks ────────────────────────────────────────────────────────

export type CallbackOutcome = { toast?: string };

/** Route a `c*:` callback. Returns the toast to answer the callback query with. */
export async function handleCreateCallback(data: string): Promise<CallbackOutcome> {
    const [kind, id, ...rest] = data.split(":");
    const arg = rest.join(":");
    const draft = id ? await getDraft(id) : null;
    if (!draft) return { toast: "This draft is gone — send /create again." };

    switch (kind) {
        case "cx": {
            await patchDraft(draft.id, { step: "cancelled" });
            await renderCard(draft, "✕ <i>Market creation cancelled.</i>", []).catch(() => {});
            return { toast: "Cancelled" };
        }
        case "cd": {
            const d = parseDeadline(arg);
            if (!d.ok) return { toast: "Bad deadline" };
            await applyDeadline(draft, d.value);
            return {};
        }
        case "cs": {
            const s = parseSeed(arg);
            if (!s.ok) return { toast: "Bad amount" };
            await applySeed(draft, s.value);
            return {};
        }
        case "cc": {
            if (!arg) {
                const updated = await patchDraft(draft.id, { step: "category" });
                if (updated) await showStep(updated);
                return {};
            }
            const c = normalizeCategory(arg);
            if (!c) return { toast: "Unknown category" };
            await applyCategory(draft, c);
            return {};
        }
        case "cr": {
            const updated = await patchDraft(draft.id, { step: "criteria" });
            if (updated) await showStep(updated);
            return { toast: "Send the new criteria" };
        }
        case "ci": {
            if (arg === "rm") {
                const cleared = await patchDraft(draft.id, {
                    imageData: null,
                    imageMime: null,
                    imageSize: null,
                });
                if (cleared) await showStep(cleared);
                return { toast: "Image removed" };
            }
            const updated = await patchDraft(draft.id, { step: "image" });
            if (updated) await showStep(updated);
            return { toast: "Send a photo" };
        }
        case "cp": {
            await showStep(draft);
            return { toast: "Re-checked" };
        }
        case "cg": {
            // Atomic confirm → deploying. A second tap (or a Telegram retry)
            // finds the row already claimed and does nothing.
            const claimed = await claimDraftForDeploy(draft.id);
            if (!claimed) return { toast: "Already in flight" };
            await renderCard(claimed, "⏳ <i>Creating market on Arc…</i>", []).catch(() => {});
            // Detached: answer Telegram fast so it never retries the callback
            // (which would be a second deploy attempt). The result lands in the
            // same card when the tx confirms.
            void deployDraft(claimed);
            return { toast: "Creating…" };
        }
        default:
            return {};
    }
}

// ── Deploy ──────────────────────────────────────────────────────────────────

async function deployDraft(draft: MarketDraft): Promise<void> {
    try {
        if (!draft.question || !draft.deadline || draft.seedUsdc === null) {
            throw new Error("draft is incomplete");
        }
        const { address, txHash } = await deployMarket(
            {
                title: draft.question,
                category: draft.category ?? "Other",
                criteria: draft.criteria ?? defaultCriteria(draft.question, draft.deadline),
                deadline: draft.deadline,
            },
            draft.seedUsdc,
        );
        await patchDraft(draft.id, { step: "done", marketAddress: address, txHash });

        // Cover art is keyed by market address, so it can only be stored now
        // that the tx has minted one. A failure here must not read as a failed
        // market — the market is already live and immutable.
        let imageNote = "";
        if (draft.imageData && draft.imageMime) {
            try {
                await putMarketImage(address, draft.imageMime, draft.imageData);
                imageNote = `🖼 Cover image set (${formatBytes(draft.imageSize ?? draft.imageData.length)}).`;
            } catch (e) {
                const why = e instanceof Error ? e.message : "unknown error";
                imageNote = `⚠️ Market created, but the cover image failed to save: ${escapeHtml(why)}`;
            }
        }

        await renderCard(
            draft,
            [
                "✅ <b>Market live on YOLO</b>",
                escapeHtml(draft.question),
                `Category: ${escapeHtml(draft.category ?? "Other")} · Seed: $${draft.seedUsdc} · Ends: ${formatDeadline(draft.deadline)}`,
                ...(imageNote ? [imageNote] : []),
                "",
                `<a href="${siteUrl()}/markets/${address}">View market</a> · <a href="${EXPLORER}/tx/${txHash}">Tx</a>`,
                "",
                "<i>Hand-written markets are settled manually — the Polymarket keeper won't touch this one.</i>",
            ].join("\n"),
            [],
        );
    } catch (e) {
        const reason = e instanceof Error ? e.message : "unknown error";
        // Back to `confirm` so the retry button is a real retry, not a new draft.
        await patchDraft(draft.id, { step: "confirm", error: reason });
        await renderCard(
            draft,
            [
                "❌ <b>Creation failed</b>",
                escapeHtml(draft.question ?? ""),
                "",
                `<code>${escapeHtml(reason.slice(0, 400))}</code>`,
            ].join("\n"),
            [
                [{ text: "↻ Retry", callback_data: `cg:${draft.id}` }],
                [{ text: "✕ Dismiss", callback_data: `cx:${draft.id}` }],
            ],
        ).catch(() => {});
    }
}
