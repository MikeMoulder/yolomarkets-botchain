"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount, useSignMessage } from "wagmi";
import type { AgentProfile } from "@/lib/agent-profiles";
import { PATTERNS } from "@/lib/agent-patterns";
import { signProfileOp } from "@/lib/client-auth";

function signalLabel(signal: string): string {
    if (signal === "polymarket") return "crowd price";
    if (signal === "ai") return "independent view";
    return signal;
}

export function SettingsClient() {
    const { address, isConnected } = useAccount();
    const { signMessageAsync } = useSignMessage();
    const router = useRouter();

    const [profile, setProfile] = useState<AgentProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [telegramChatId, setTelegramChatId] = useState("");
    const [telegramEnabled, setTelegramEnabled] = useState(false);
    const [telegramEvents, setTelegramEvents] = useState<Set<string>>(
        new Set(["live_trade"]),
    );

    useEffect(() => {
        if (!address) {
            setLoading(false);
            return;
        }
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const r = await fetch(`/api/agent/profile?addr=${address}`);
                const data = (await r.json()) as { profile: AgentProfile | null };
                if (!cancelled) {
                    setProfile(data.profile);
                    setTelegramChatId(data.profile?.telegramChatId ?? "");
                    setTelegramEnabled(data.profile?.telegramEnabled ?? false);
                    setTelegramEvents(
                        new Set(data.profile?.telegramEvents ?? ["live_trade"]),
                    );
                }
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : "load failed");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [address]);

    async function togglePause() {
        if (!profile || !address) return;
        setBusy(true);
        setError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "profile.active",
                userAddr: address,
                signMessageAsync,
            });
            const r = await fetch("/api/agent/profile/active", {
                method: "POST",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify({
                    userAddr: address,
                    active: !profile.active,
                }),
            });
            const data = (await r.json()) as { profile?: AgentProfile; error?: string };
            if (data.profile) setProfile(data.profile);
            else if (data.error) setError(data.error);
        } catch (e) {
            setError(e instanceof Error ? e.message : "signature rejected");
        } finally {
            setBusy(false);
        }
    }

    async function destroy() {
        if (!address) return;
        if (!confirm("Delete this agent profile? This can't be undone.")) return;
        setBusy(true);
        setError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "profile.delete",
                userAddr: address,
                signMessageAsync,
            });
            const r = await fetch(`/api/agent/profile?addr=${address}`, {
                method: "DELETE",
                headers: authHeaders,
            });
            if (!r.ok) {
                const data = (await r.json().catch(() => ({}))) as { error?: string };
                setError(data.error ?? `delete failed (${r.status})`);
                return;
            }
            router.push("/agent");
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "signature rejected");
        } finally {
            setBusy(false);
        }
    }

    async function saveNotifications() {
        if (!profile || !address) return;
        setBusy(true);
        setError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "profile.notifications",
                userAddr: address,
                signMessageAsync,
            });
            const r = await fetch("/api/agent/notifications", {
                method: "POST",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify({
                    userAddr: address,
                    telegramChatId,
                    telegramEnabled,
                    telegramEvents: Array.from(telegramEvents),
                }),
            });
            const data = (await r.json()) as { profile?: AgentProfile; error?: string };
            if (data.profile) setProfile(data.profile);
            else if (data.error) setError(data.error);
        } catch (e) {
            setError(e instanceof Error ? e.message : "signature rejected");
        } finally {
            setBusy(false);
        }
    }

    function toggleTelegramEvent(event: string) {
        const next = new Set(telegramEvents);
        if (next.has(event)) next.delete(event);
        else next.add(event);
        setTelegramEvents(next);
    }

    if (!isConnected) {
        return (
            <div className="mx-auto max-w-[920px] px-6 py-16 text-center">
                <h1 className="text-[24px] font-medium mb-3">
                    Connect your wallet
                </h1>
                <p className="text-[13px] text-text-dim">
                    Agent settings are scoped to your wallet address.
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="mx-auto max-w-[920px] px-6 py-16 text-center text-text-mute text-[13px]">
                loading…
            </div>
        );
    }

    if (!profile) {
        return (
            <div className="mx-auto max-w-[920px] px-6 py-10">
                <BackLink href={address ? `/agent/feed?u=${address}` : "/agent"} />
                <div className="py-12 text-center">
                    <h1 className="text-[24px] font-medium mb-3">
                        No agent yet
                    </h1>
                    <p className="text-[13px] text-text-dim mb-6">
                        You don&apos;t have an agent profile on this wallet.
                    </p>
                    <Link
                        href="/agent/setup"
                        className="inline-block px-5 h-10 leading-10 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] num hover:bg-accent/15"
                    >
                        set one up →
                    </Link>
                </div>
            </div>
        );
    }

    const p =
        profile.pattern === "custom" ? null : PATTERNS[profile.pattern];

    return (
        <div className="mx-auto max-w-[920px] px-6 py-10">
            <BackLink href={address ? `/agent/feed?u=${address}` : "/agent"} />
            <div className="mb-6">
                <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute num mb-2">
                    / agent settings
                </div>
                <h1 className="text-[26px] md:text-[32px] leading-tight tracking-tight font-medium">
                    {p?.name ?? "Custom"} agent
                </h1>
                <div className="mt-3 flex items-center gap-3 text-[12px] text-text-dim">
                    <span
                        className={`num text-[10px] uppercase tracking-[0.22em] inline-flex items-center gap-1.5 ${
                            profile.active ? "text-yes" : "text-text-mute"
                        }`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full ${
                                profile.active ? "bg-yes live-dot" : "bg-text-mute"
                            }`}
                        />
                        {profile.active ? "active" : "paused"}
                    </span>
                    <span className="text-text-faint">·</span>
                    <span className="num text-text-mute">
                        created {formatDate(profile.createdAt)}
                    </span>
                </div>
            </div>

            {error && (
                <div className="mb-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                    {error}
                </div>
            )}

            {profile.agentAddress && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                    <CircleAgentWalletCard agentAddress={profile.agentAddress} />
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border border border-border mb-6">
                <Card label="pattern">
                    <div className="text-[14px] text-text">{p?.name ?? "Custom"}</div>
                    {p && (
                        <div className="text-[12px] text-text-dim mt-1 leading-snug">
                            {p.oneLiner}
                        </div>
                    )}
                </Card>
                <Card label="cadence">
                    <div className="text-[14px] text-text num">
                        every {profile.cadenceMinutes}m
                    </div>
                </Card>
                <Card label="markets">
                    <div className="text-[13px] text-text-dim">
                        {profile.marketsMode === "all"
                            ? "All live markets"
                            : profile.marketsMode === "categories"
                                ? profile.categories.join(", ") || "—"
                                : `${profile.watchlist.length} hand-picked`}
                    </div>
                </Card>
                <Card label="signals">
                    <div className="text-[13px] text-text-dim">
                        {profile.signals.map(signalLabel).join(" + ")}
                    </div>
                </Card>
                <Card label="risk knobs">
                    <div className="text-[12px] text-text-dim num space-y-0.5">
                        <div>kelly × {profile.kellyMult.toFixed(2)}</div>
                        <div>edge ≥ {(profile.edgeThreshold * 100).toFixed(1)}pt</div>
                        <div>conf ≥ {Math.round(profile.minConfidence * 100)}%</div>
                    </div>
                </Card>
                <Card label="budget">
                    <div className="text-[12px] text-text-dim num space-y-0.5 tabular">
                        <div>${profile.budgetTotal.toFixed(2)} total</div>
                        <div>${profile.budgetPerMarket.toFixed(2)} per market</div>
                        <div>${profile.budgetPerDay.toFixed(2)} per day</div>
                    </div>
                </Card>
            </div>

            <TelegramSettings
                chatId={telegramChatId}
                enabled={telegramEnabled}
                events={telegramEvents}
                busy={busy}
                onChatId={setTelegramChatId}
                onEnabled={setTelegramEnabled}
                onToggleEvent={toggleTelegramEvent}
                onSave={saveNotifications}
            />

            <div className="flex flex-wrap gap-3">
                <Link
                    href="/agent/setup"
                    className="px-4 h-9 leading-9 border border-border-strong text-text text-[12px] uppercase tracking-[0.18em] num hover:bg-bg-hover transition-colors"
                >
                    edit →
                </Link>
                <button
                    onClick={togglePause}
                    disabled={busy}
                    className="px-4 h-9 border border-border text-text-dim text-[12px] uppercase tracking-[0.18em] num hover:bg-bg-hover hover:text-text transition-colors disabled:opacity-50"
                >
                    {profile.active ? "pause" : "resume"}
                </button>
                <button
                    onClick={destroy}
                    disabled={busy}
                    className="ml-auto px-4 h-9 border border-no/40 text-no text-[12px] uppercase tracking-[0.18em] num hover:bg-no/10 transition-colors disabled:opacity-50"
                >
                    delete profile
                </button>
            </div>
        </div>
    );
}

function BackLink({ href }: { href: string }) {
    return (
        <Link
            href={href}
            className="inline-block mb-6 text-[11px] uppercase tracking-[0.2em] text-text-mute hover:text-text num"
        >
            ← back
        </Link>
    );
}

function CircleAgentWalletCard({
    agentAddress,
}: {
    agentAddress: `0x${string}`;
}) {
    return (
        <div className="border border-border bg-bg-elev/40 px-5 py-5">
            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-3">
                / circle agent wallet
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-[12.5px]">
                <span className="text-text-mute uppercase tracking-[0.16em] text-[10px] num">
                    address
                </span>
                <a
                    href={`https://scan.bohr.life/address/${agentAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="num text-text-dim tabular break-all hover:text-text"
                >
                    {agentAddress}
                </a>
                <span className="text-text-mute uppercase tracking-[0.16em] text-[10px] num">
                    signing
                </span>
                <span className="text-yes">Circle MPC</span>
            </div>
        </div>
    );
}

const TELEGRAM_EVENT_OPTIONS = [
    {
        id: "live_trade",
        label: "Trades",
        detail: "Buys, sells, and completed fills.",
    },
    {
        id: "paper_trade",
        label: "Dry runs",
        detail: "Trades the agent considered but did not place.",
    },
    {
        id: "risk_pass",
        label: "Risk checks",
        detail: "Skipped trades and budget guardrails.",
    },
];

function TelegramSettings({
    chatId,
    enabled,
    events,
    busy,
    onChatId,
    onEnabled,
    onToggleEvent,
    onSave,
}: {
    chatId: string;
    enabled: boolean;
    events: Set<string>;
    busy: boolean;
    onChatId: (value: string) => void;
    onEnabled: (value: boolean) => void;
    onToggleEvent: (event: string) => void;
    onSave: () => void;
}) {
    const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME?.replace(
        /^@/,
        "",
    );
    const botHref = botUsername
        ? `https://t.me/${botUsername}?start=agent`
        : null;
    const hasChatId = chatId.trim().length > 0;

    return (
        <section className="mb-6 border border-border bg-bg">
            <div className="grid grid-cols-1 lg:grid-cols-[0.95fr_1.3fr]">
                <div className="p-5 lg:p-6 border-b lg:border-b-0 lg:border-r border-border">
                    <div className="flex items-start justify-between gap-4 mb-5">
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute mb-2 num">
                                / telegram alerts
                            </div>
                            <h2 className="text-[18px] font-medium tracking-tight">
                                Trade updates in Telegram
                            </h2>
                        </div>
                        <span
                            className={`shrink-0 h-7 px-3 inline-flex items-center border text-[10px] uppercase tracking-[0.18em] num ${
                                enabled && hasChatId
                                    ? "border-yes/40 bg-yes/10 text-yes"
                                    : "border-border-strong text-text-mute"
                            }`}
                        >
                            {enabled && hasChatId ? "connected" : "off"}
                        </span>
                    </div>
                    <p className="text-[12px] leading-relaxed text-text-dim max-w-[34rem]">
                        Get a compact note when your agent trades, skips a trade,
                        or hits a risk rule.
                    </p>
                    <div className="mt-5 flex flex-wrap gap-3">
                        {botHref && (
                            <a
                                href={botHref}
                                target="_blank"
                                rel="noreferrer"
                                className="h-9 px-4 inline-flex items-center border border-border-strong text-text text-[11px] uppercase tracking-[0.18em] num hover:bg-bg-hover transition-colors"
                            >
                                open bot
                            </a>
                        )}
                        <label className="h-9 px-4 inline-flex items-center gap-2 border border-border text-[11px] uppercase tracking-[0.18em] text-text-dim num hover:bg-bg-hover transition-colors cursor-pointer">
                            <input
                                type="checkbox"
                                checked={enabled}
                                onChange={(event) => onEnabled(event.target.checked)}
                                className="accent-current"
                            />
                            enable alerts
                        </label>
                    </div>
                </div>

                <div className="p-5 lg:p-6 space-y-5">
                    <div>
                        <label
                            htmlFor="telegram-chat-id"
                            className="block text-[10px] uppercase tracking-[0.22em] text-text-mute mb-2 num"
                        >
                            / chat id
                        </label>
                        <input
                            id="telegram-chat-id"
                            value={chatId}
                            onChange={(event) => onChatId(event.target.value)}
                            placeholder="123456789"
                            className="w-full h-11 border border-border bg-bg px-3 text-[14px] text-text outline-none focus:border-accent num"
                        />
                        <p className="mt-2 text-[11px] leading-relaxed text-text-mute">
                            Open the bot, send /start, then paste the chat id it
                            replies with.
                        </p>
                    </div>

                    <div>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute mb-3 num">
                            / send me
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            {TELEGRAM_EVENT_OPTIONS.map((option) => (
                                <label
                                    key={option.id}
                                    className={`min-h-[92px] border p-3 cursor-pointer transition-colors ${
                                        events.has(option.id)
                                            ? "border-accent bg-accent-bg/50"
                                            : "border-border hover:bg-bg-hover"
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={events.has(option.id)}
                                            onChange={() => onToggleEvent(option.id)}
                                            className="accent-current"
                                        />
                                        <span className="text-[12px] font-medium text-text">
                                            {option.label}
                                        </span>
                                    </div>
                                    <div className="mt-2 text-[11px] leading-snug text-text-mute">
                                        {option.detail}
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className="flex justify-end">
                        <button
                            onClick={onSave}
                            disabled={busy}
                            className="h-9 px-4 border border-accent bg-accent-bg text-accent text-[11px] uppercase tracking-[0.18em] num hover:bg-accent/15 transition-colors disabled:opacity-50"
                        >
                            save alerts
                        </button>
                    </div>
                </div>
            </div>
        </section>
    );
}

function Card({
    label,
    children,
}: {
    label: string;
    children: ReactNode;
}) {
    return (
        <div className="bg-bg p-5">
            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute mb-2 num">
                / {label}
            </div>
            {children}
        </div>
    );
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
}
