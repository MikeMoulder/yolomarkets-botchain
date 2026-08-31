/**
 * Transport-agnostic Telegram update router — the admin command center's brain.
 *
 * The same `handleUpdate` is driven by two transports:
 *   · `app/api/telegram/webhook` — Telegram pushes to Vercel, and
 *   · `scripts/telegram-bot.ts`  — a pm2 long-poller on the VPS.
 * Only one may own the bot at a time (Telegram rejects getUpdates while a
 * webhook is registered), but the behaviour is identical either way.
 *
 * Traffic it handles:
 *   · slash commands + wizard replies,
 *   · `c*:` callbacks — the /create flow (lib/telegram-create), and
 *   · `L:` / `S:` / `X` callbacks — the Polymarket listing flow
 *     (scripts/telegram-suggest).
 *
 * Everything except `/start` is gated on TELEGRAM_ADMIN_CHAT_ID.
 */
import { formatUnits } from "viem";
import {
    answerCallbackQuery,
    downloadFile,
    editMessageText,
    escapeHtml,
    getFile,
    isAdminChat,
    sendMessage,
    type BotCommand,
    type InlineButton,
    type TelegramCallbackQuery,
    type TelegramMessage,
    type TelegramUpdate,
} from "./telegram";
import {
    buildListing,
    deployListing,
    fetchGammaMarketById,
    preflightCreate,
    type Listing,
} from "./list-market";
import {
    attachDraftImage,
    CREATE_CALLBACK_PREFIXES,
    handleCreateCallback,
    handleCreateCommand,
    handleDraftText,
} from "./telegram-create";
import { cancelOpenDrafts, getOpenDraft, isTextInputStep } from "./telegram-drafts";
import { isAllowedImageMime, mimeFromPath, MAX_IMAGE_BYTES } from "./market-images";

import { EXPLORER_URL } from "./explorer";

const EXPLORER = EXPLORER_URL;

/** Registered with `setMyCommands` so they show up in Telegram's "/" menu. */
export const BOT_COMMANDS: BotCommand[] = [
    { command: "create", description: "Create a new market (wizard or one-liner)" },
    { command: "cancel", description: "Abort the market you're drafting" },
    { command: "status", description: "Deployer key, balance, factory admin check" },
    { command: "help", description: "Show the command center help" },
    { command: "start", description: "Show this chat's id" },
];

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return handleCallback(update.callback_query);
    const message = update.message ?? update.edited_message;
    if (message) return handleMessage(message);
}

// ── Command router ───────────────────────────────────────────────────────────

async function handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat?.id;
    // A photo carries its command in `caption`, so `/create … ` works whether
    // it was typed or attached to the image.
    const text = (message.text ?? message.caption ?? "").trim();
    if (chatId === undefined || chatId === null) return;

    const chat = String(chatId);
    const userId = message.from?.id !== undefined ? String(message.from.id) : null;
    const isAdmin = isAdminChat(message.from?.id) || isAdminChat(chatId);

    const image = pickImage(message);
    if (image) {
        if (!isAdmin) return;
        // Command first (it may create the draft this image belongs to), then
        // attach — so `/create … ` + photo in one message works.
        if (text.startsWith("/create")) {
            await handleCreateCommand(chat, userId, text.slice("/create".length).trim()).catch(async (e) => {
                await sendMessage(chat, `❌ <code>${escapeHtml(String(e).slice(0, 300))}</code>`).catch(() => {});
            });
        }
        return attachImageToDraft(chat, image);
    }

    // `/start` stays open to everyone — it's how a user finds their chat id for
    // agent alerts. Everything else is admin-only.
    if (text.startsWith("/start")) {
        await handleStart(chat, message.chat?.type ?? "chat", isAdmin).catch(() => {});
        return;
    }

    if (!text.startsWith("/")) {
        // Not a command: it may be an answer to a wizard step.
        if (!isAdmin) return;
        return feedOpenDraft(chat, text);
    }

    // Strip the @botname suffix Telegram appends in groups.
    const [rawCommand] = text.split(/\s+/);
    const command = rawCommand.split("@")[0].toLowerCase();
    const args = text.slice(rawCommand.length).trim();

    if (!isAdmin) {
        await sendMessage(chat, "Not authorized.").catch(() => {});
        return;
    }

    try {
        switch (command) {
            case "/create":
                await handleCreateCommand(chat, userId, args);
                break;
            case "/cancel": {
                const n = await cancelOpenDrafts(chat);
                await sendMessage(chat, n > 0 ? "✕ Draft cancelled." : "Nothing to cancel.");
                break;
            }
            case "/status":
                await handleStatus(chat);
                break;
            case "/help":
                await sendMessage(chat, helpText());
                break;
            default:
                await sendMessage(chat, `Unknown command <code>${escapeHtml(command)}</code>.\n\n${helpText()}`);
        }
    } catch (e) {
        const reason = e instanceof Error ? e.message : "unknown error";
        await sendMessage(chat, `❌ <code>${escapeHtml(reason.slice(0, 400))}</code>`).catch(() => {});
    }
}

function helpText(): string {
    return [
        "🎛 <b>YOLO command center</b>",
        "",
        "<code>/create</code> — author a new market (wizard, or one-liner args)",
        "<code>/cancel</code> — abort the market you're drafting",
        "<code>/status</code> — deployer key, balance, factory admin check",
        "<code>/help</code> — this list",
        "<code>/start</code> — show this chat's id",
        "",
        "<b>One-liner market</b>",
        "<code>/create question | deadline | seed [| category [| criteria]]</code>",
        "<i>/create Will BTC close above $150k on Dec 31 2026? | 2026-12-31 | 10</i>",
        "",
        "Deadlines take <code>7d</code>, <code>36h</code>, <code>2026-12-31</code> or <code>2026-12-31 18:00</code> (UTC).",
        "",
        "<b>Cover image</b> — send a photo any time while drafting and it becomes the market's card art. You can also send the photo <i>with</i> a <code>/create …</code> caption in one go.",
    ].join("\n");
}

async function handleStart(chat: string, chatType: string, isAdmin: boolean): Promise<void> {
    const lines = [
        "Use this chat id for YOLO Markets alerts:",
        `<code>${escapeHtml(chat)}</code>`,
        "",
        chatType === "private"
            ? "Paste it in Agent settings (or TELEGRAM_ADMIN_CHAT_ID for listing) to enable alerts."
            : "This is the group chat id. Paste it in Agent settings to send alerts here.",
    ];
    if (isAdmin) lines.push("", helpText());
    await sendMessage(chat, lines.join("\n"));
}

/** `/status` — the things that silently break market creation, in one card. */
async function handleStatus(chat: string): Promise<void> {
    const pre = await preflightCreate();
    const lines = ["🎛 <b>Command center status</b>", ""];
    if (pre.keyError) {
        lines.push(`⛔️ Deployer key: ${escapeHtml(pre.keyError)}`);
    } else {
        lines.push(
            `Factory: <code>${pre.factory}</code>`,
            `Factory admin: <code>${pre.factoryAdmin ?? "?"}</code>`,
            `Deployer: <code>${pre.deployer}</code>`,
            `Balance: $${pre.balanceUsdc.toFixed(2)} USDC`,
            "",
            pre.isAdmin
                ? "✅ Deployer is the factory admin — <code>/create</code> can deploy."
                : "⛔️ Deployer is NOT the factory admin — <code>/create</code> will revert <code>NotAdmin</code>. Fix <code>DEPLOYER_PRIVATE_KEY</code>.",
        );
    }
    await sendMessage(chat, lines.join("\n"));
}

// ── Images ───────────────────────────────────────────────────────────────────

type PickedImage = { fileId: string; mime: string | null; size: number };

/** Extract an image from a message: a compressed photo (take the largest
 *  rendition — Telegram sends an ascending ladder) or an image sent as an
 *  uncompressed document. */
function pickImage(message: TelegramMessage): PickedImage | null {
    const photos = message.photo ?? [];
    if (photos.length > 0) {
        const largest = photos[photos.length - 1];
        return { fileId: largest.file_id, mime: null, size: largest.file_size ?? 0 };
    }
    const doc = message.document;
    if (doc?.mime_type?.startsWith("image/")) {
        return { fileId: doc.file_id, mime: doc.mime_type, size: doc.file_size ?? 0 };
    }
    return null;
}

/** Download an admin's photo and attach it to their open draft as cover art. */
async function attachImageToDraft(chat: string, picked: PickedImage): Promise<void> {
    const draft = await getOpenDraft(chat).catch(() => null);
    if (!draft) {
        await sendMessage(
            chat,
            "🖼 No market in progress — send <code>/create</code> first, then the photo (or send both together, the photo with a <code>/create …</code> caption).",
        ).catch(() => {});
        return;
    }

    try {
        if (picked.size > MAX_IMAGE_BYTES) {
            throw new Error(`image is ${Math.round(picked.size / 1024)} KB; limit is ${Math.round(MAX_IMAGE_BYTES / 1024)} KB`);
        }
        const file = await getFile(picked.fileId);
        if (!file.file_path) throw new Error("Telegram returned no file path");

        const mime = picked.mime ?? mimeFromPath(file.file_path);
        if (!isAllowedImageMime(mime)) throw new Error(`unsupported image type ${mime}`);

        const bytes = await downloadFile(file.file_path, MAX_IMAGE_BYTES);
        await attachDraftImage(draft, bytes, mime);
    } catch (e) {
        const reason = e instanceof Error ? e.message : "unknown error";
        await sendMessage(chat, `⚠️ Couldn't attach that image: ${escapeHtml(reason)}`).catch(() => {});
    }
}

/** Route a plain message into the open `/create` draft, if there is one. */
async function feedOpenDraft(chat: string, text: string): Promise<void> {
    let draft;
    try {
        draft = await getOpenDraft(chat);
    } catch (e) {
        // No DB → no wizard. Say so rather than swallowing every message.
        const reason = e instanceof Error ? e.message : "database unavailable";
        await sendMessage(
            chat,
            `❌ Draft store unavailable: <code>${escapeHtml(reason.slice(0, 200))}</code>`,
        ).catch(() => {});
        return;
    }
    if (!draft || !isTextInputStep(draft.step)) return;
    try {
        await handleDraftText(draft, text);
    } catch (e) {
        const reason = e instanceof Error ? e.message : "unknown error";
        await sendMessage(chat, `❌ <code>${escapeHtml(reason.slice(0, 400))}</code>`).catch(() => {});
    }
}

// ── Button callbacks ─────────────────────────────────────────────────────────

async function handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data ?? "";

    // Admin gate: only allow-listed chat/user ids may drive listing or creation.
    if (!isAdminChat(cb.from?.id) && !isAdminChat(chatId)) {
        await answerCallbackQuery(cb.id, "Not authorized.").catch(() => {});
        return;
    }
    if (chatId === undefined || messageId === undefined) {
        await answerCallbackQuery(cb.id).catch(() => {});
        return;
    }

    // `/create` flow — owns its own cards and edits them in place.
    if (CREATE_CALLBACK_PREFIXES.some((p) => data.startsWith(p))) {
        try {
            const { toast } = await handleCreateCallback(data);
            await answerCallbackQuery(cb.id, toast).catch(() => {});
        } catch (e) {
            const reason = e instanceof Error ? e.message : "failed";
            await answerCallbackQuery(cb.id, reason.slice(0, 180)).catch(() => {});
        }
        return;
    }

    // X → dismiss
    if (data === "X") {
        await answerCallbackQuery(cb.id, "Dismissed").catch(() => {});
        await editMessageText(chatId, messageId, "✕ <i>Dismissed.</i>").catch(() => {});
        return;
    }

    // L:<id> → show liquidity presets
    if (data.startsWith("L:")) {
        const marketId = data.slice(2);
        await answerCallbackQuery(cb.id).catch(() => {});
        const m = await fetchGammaMarketById(marketId).catch(() => null);
        const listing = m ? buildListing(m) : null;
        if (!listing || "error" in listing) {
            const reason = listing && "error" in listing ? listing.error : "market not found";
            await editMessageText(chatId, messageId, `⚠️ Can't list this market: ${escapeHtml(reason)}`).catch(() => {});
            return;
        }
        await editMessageText(
            chatId,
            messageId,
            `${listingSummary(listing)}\n\n<b>Choose initial liquidity (USDC):</b>`,
            liquidityKeyboard(marketId),
        ).catch(() => {});
        return;
    }

    // S:<id>:<amount> → deploy
    if (data.startsWith("S:")) {
        const [, marketId, amtRaw] = data.split(":");
        const amount = Number(amtRaw);
        if (!marketId || !Number.isFinite(amount) || amount <= 0) {
            await answerCallbackQuery(cb.id, "Bad amount").catch(() => {});
            return;
        }
        await answerCallbackQuery(cb.id, `Listing with $${amount}…`).catch(() => {});
        await editMessageText(chatId, messageId, `⏳ <i>Listing with $${amount} liquidity…</i>`).catch(() => {});
        // Detached under the webhook transport so Telegram gets its 200 fast and
        // never retries (a retry would double-deploy). The poller awaits it.
        await listAndReport(marketId, amount, chatId, messageId);
        return;
    }

    await answerCallbackQuery(cb.id).catch(() => {});
}

async function listAndReport(
    marketId: string,
    amount: number,
    chatId: number | string,
    messageId: number,
): Promise<void> {
    try {
        const m = await fetchGammaMarketById(marketId);
        if (!m) throw new Error("market not found");
        const listing = buildListing(m);
        if ("error" in listing) throw new Error(listing.error);

        const { address, txHash } = await deployListing(listing, amount);
        const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://yolomarkets.fun").replace(/\/$/, "");
        await editMessageText(
            chatId,
            messageId,
            [
                `✅ <b>Listed on YOLO</b>`,
                escapeHtml(listing.title),
                `Category: ${escapeHtml(listing.category)} · Seed: $${amount}`,
                "",
                `<a href="${site}/markets/${address}">View market</a> · <a href="${EXPLORER}/tx/${txHash}">Tx</a>`,
            ].join("\n"),
        );
    } catch (e) {
        const reason = e instanceof Error ? e.message : "unknown error";
        await editMessageText(
            chatId,
            messageId,
            `❌ <b>Listing failed:</b> ${escapeHtml(reason)}`,
            [[{ text: "↺ Retry", callback_data: `L:${marketId}` }, { text: "✕ Dismiss", callback_data: "X" }]],
        ).catch(() => {});
    }
}

// ── Formatting ───────────────────────────────────────────────────────────────

function listingSummary(listing: Listing): string {
    const ends = listing.endDate ? new Date(listing.endDate).toISOString().slice(0, 10) : "—";
    const vol = listing.volume24h > 0 ? `$${formatUnits(BigInt(Math.round(listing.volume24h)), 0)}` : "—";
    return [
        `🆕 <b>${escapeHtml(listing.title)}</b>`,
        `Category: ${escapeHtml(listing.category)} · Ends: ${ends} · 24h vol: ${vol}`,
    ].join("\n");
}

function liquidityKeyboard(marketId: string): InlineButton[][] {
    const options = (process.env.LISTING_SEED_OPTIONS ?? "1,5,10,25")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    const row = options.map((amt) => ({ text: `$${amt}`, callback_data: `S:${marketId}:${amt}` }));
    return [row, [{ text: "✕ Cancel", callback_data: "X" }]];
}
