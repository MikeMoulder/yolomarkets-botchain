"use client";

// Agent v2 · M2/M3 — floating agent chat.
// A persistent bubble (mounted in the root layout, so it survives page
// navigation along with the conversation) that unfolds a chat panel. Streams
// the agent's SSE reply token-by-token, renders markdown, surfaces tool
// activity, and lets the user execute a proposed trade on their own wallet.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWriteContract, usePublicClient } from "wagmi";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { ADDRESSES, erc20Abi, marketAbi } from "@/lib/contracts";

type Msg = { role: "user" | "assistant"; content: string };

// The market-detail route is /markets/<address>. Pull that address out of the
// current path so the agent knows which market the user means by "this market".
// Deliberately narrow: /markets/fast and /markets/p/<slug> carry no address and
// must NOT match.
function marketFromPath(pathname: string | null): `0x${string}` | null {
    const m = /^\/markets\/(0x[0-9a-fA-F]{40})\/?$/.exec(pathname ?? "");
    return m ? (m[1] as `0x${string}`) : null;
}

// A prepared order from the agent's propose_trade tool. shares/max_cost are
// 6-dec integers as strings (bigint-safe over JSON).
type Order = {
    market: `0x${string}`;
    question: string;
    side: "YES" | "NO";
    side_id: 1 | 2;
    shares: string;
    shares_human: number;
    est_cost_usdc: number;
    max_cost: string;
    max_cost_usdc: number;
    fee_usdc: number;
    side_price: number;
    wallet_balance_usdc: number;
    sufficient_balance: boolean;
};

type TxStage = "idle" | "approving" | "buying" | "done" | "error";
type TxState = { stage: TxStage; hash?: string; error?: string };

type ChatEvent =
    | { type: "delta"; text: string }
    | { type: "status"; text: string; tool?: string }
    | { type: "tool"; name: string; ok: boolean }
    | { type: "proposal"; order: Order }
    | { type: "done" }
    | { type: "error"; message: string };

const SUGGESTIONS = [
    "What can you do?",
    "Show my positions",
    "How do I get testnet USDT?",
    "Explain your recent trades",
];

const CHAR_LIMIT = 600;

export function AgentChat() {
    const { address, isConnected } = useActiveWallet();
    const [open, setOpen] = useState(false);
    const [messages, setMessages] = useState<Msg[]>([]);
    const [input, setInput] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [proposal, setProposal] = useState<Order | null>(null);
    const [tx, setTx] = useState<TxState>({ stage: "idle" });
    const scrollRef = useRef<HTMLDivElement>(null);
    const { writeContractAsync } = useWriteContract();
    const publicClient = usePublicClient();
    const currentMarket = marketFromPath(usePathname());

    useEffect(() => {
        if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [messages, status, open, proposal, tx]);

    function applyEvent(evt: ChatEvent) {
        if (evt.type === "delta") {
            setStatus(null);
            setMessages((m) => {
                const copy = m.slice();
                const last = copy[copy.length - 1];
                if (last && last.role === "assistant") {
                    copy[copy.length - 1] = { ...last, content: last.content + evt.text };
                }
                return copy;
            });
        } else if (evt.type === "status") {
            setStatus(evt.text);
        } else if (evt.type === "proposal") {
            setProposal(evt.order);
            setTx({ stage: "idle" });
        } else if (evt.type === "error") {
            setError(evt.message || "The agent hit an error.");
        }
    }

    async function send(text: string) {
        const msg = text.trim().slice(0, CHAR_LIMIT);
        if (!msg || streaming) return;
        if (!address) {
            setError("Connect a wallet to chat with your agent.");
            return;
        }
        setError(null);
        const history = messages.slice(-10);
        setMessages((m) => [
            ...m,
            { role: "user", content: msg },
            { role: "assistant", content: "" },
        ]);
        setInput("");
        setStreaming(true);
        setStatus(null);

        try {
            const res = await fetch("/api/agent/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: msg,
                    userAddr: address,
                    history,
                    // Which market the user is looking at, if any — lets the
                    // agent resolve "this market" without asking.
                    currentMarket,
                }),
            });
            if (!res.ok || !res.body) {
                const j = await res.json().catch(() => ({}));
                throw new Error(j.error || `agent error (${res.status})`);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 2);
                    if (!frame.startsWith("data:")) continue;
                    try {
                        applyEvent(JSON.parse(frame.slice(5).trim()) as ChatEvent);
                    } catch {
                        /* ignore malformed frame */
                    }
                }
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Chat failed.");
            setMessages((m) => {
                const last = m[m.length - 1];
                return last && last.role === "assistant" && last.content === ""
                    ? m.slice(0, -1)
                    : m;
            });
        } finally {
            setStreaming(false);
            setStatus(null);
        }
    }

                // Execute a prepared order on the user's own connected wallet: USDT approve
    // (if needed) → buy. The agent never signs this — the wallet prompt is the
    // authorization.
    async function confirmTrade(order: Order) {
        if (!address || !publicClient) {
            setTx({ stage: "error", error: "Connect a wallet first." });
            return;
        }
        const market = order.market;
        const maxCost = BigInt(order.max_cost);
        const shares = BigInt(order.shares);
        try {
            const allowance = (await publicClient.readContract({
                address: ADDRESSES.usdc,
                abi: erc20Abi,
                functionName: "allowance",
                args: [address, market],
            })) as bigint;
            if (allowance < maxCost) {
                setTx({ stage: "approving" });
                const ah = await writeContractAsync({
                    address: ADDRESSES.usdc,
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [market, maxCost],
                });
                await publicClient.waitForTransactionReceipt({ hash: ah });
            }
            setTx({ stage: "buying" });
            const bh = await writeContractAsync({
                address: market,
                abi: marketAbi,
                functionName: "buy",
                args: [order.side_id, shares, maxCost],
            });
            await publicClient.waitForTransactionReceipt({ hash: bh });
            setTx({ stage: "done", hash: bh });
            void fetch("/api/agent/chat/record", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userAddr: address,
                    market: order.market,
                    question: order.question,
                    side: order.side,
                    sharesHuman: order.shares_human,
                    costUsdc: order.est_cost_usdc,
                    txHash: bh,
                }),
            }).catch(() => {});
            setProposal(null);
            setMessages((m) => [
                ...m,
                {
                    role: "assistant",
                    content: `Done — you bought **${order.shares_human} ${order.side}** shares in "${order.question}". It'll show in your positions shortly.`,
                },
            ]);
        } catch (e) {
            const raw = e instanceof Error ? e.message : "Transaction failed.";
            const friendly = /user rejected|denied|rejected the request/i.test(raw)
                ? "You rejected the transaction."
                : raw.slice(0, 140);
            setTx({ stage: "error", error: friendly });
        }
    }

    function dismissProposal() {
        setProposal(null);
        setTx({ stage: "idle" });
    }

    const nearLimit = input.length >= CHAR_LIMIT * 0.75;

    return (
        <div className="fixed right-4 bottom-24 md:bottom-6 z-[60] flex flex-col items-end gap-3 print:hidden">
            {open && (
                <section className="flex w-[calc(100vw-2rem)] sm:w-[390px] max-h-[72vh] flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl shadow-black/50 backdrop-blur-sm">
                    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-bg-elev/40 px-5 py-3">
                        <div className="flex items-center gap-2.5">
                            <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full rounded-full bg-yes opacity-60 animate-ping" />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-yes" />
                            </span>
                            <span className="text-[12px] uppercase tracking-[0.22em] text-text-mute">
                                agent
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            aria-label="Minimize chat"
                            className="-mr-1 p-1 text-text-faint hover:text-text transition-colors"
                        >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path d="M4 8.5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                        </button>
                    </header>

                    <div
                        ref={scrollRef}
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5"
                    >
                        {messages.length === 0 &&
                            (isConnected ? (
                                <div className="flex flex-col gap-3">
                                    <p className="text-[13px] leading-[1.6] text-text-dim">
                                        <span className="text-text">Hey — I&apos;m your YOLO agent.</span>{" "}
                                        Ask me about the platform, any market, your positions across
                                        both wallets, or tell me to prepare a trade you confirm in
                                        your wallet.
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {SUGGESTIONS.map((s) => (
                                            <button
                                                key={s}
                                                type="button"
                                                onClick={() => send(s)}
                                                disabled={streaming}
                                                className="num text-[11px] text-text-mute border border-border bg-bg-elev px-2.5 py-1 hover:border-accent/50 hover:text-text transition-colors disabled:opacity-40"
                                            >
                                                {s}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
                                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" className="text-text-faint" aria-hidden="true">
                                        <rect x="5" y="10.5" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                                        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                                    </svg>
                                    <p className="max-w-[240px] text-[13px] leading-[1.6] text-text-dim">
                                        Connect your wallet to chat with your agent — I use it to read
                                        your positions and prepare trades you approve.
                                    </p>
                                </div>
                            ))}

                        {messages.map((m, i) =>
                            m.role === "user" ? (
                                <div
                                    key={i}
                                    className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-border bg-bg-elev px-3 py-2 text-[13.5px] leading-[1.5] text-text"
                                >
                                    {m.content}
                                </div>
                            ) : (
                                <div key={i} className="flex max-w-[94%] flex-col gap-1.5">
                                    <span className="num text-[9.5px] uppercase tracking-[0.22em] text-accent">
                                        agent
                                    </span>
                                    <div className="text-[13.5px] leading-[1.6] text-text break-words">
                                        {m.content ? (
                                            <Markdown text={m.content} />
                                        ) : streaming && i === messages.length - 1 ? (
                                            <span className="text-text-mute italic">
                                                {status ?? "Thinking…"}
                                                <Caret />
                                            </span>
                                        ) : null}
                                        {m.content && streaming && i === messages.length - 1 && (
                                            <Caret />
                                        )}
                                    </div>
                                </div>
                            ),
                        )}
                    </div>

                    {(proposal || tx.stage !== "idle") && (
                        <div className="shrink-0 border-t border-accent/40 bg-accent/5 px-5 py-4">
                            <div className="mb-2 flex items-baseline justify-between gap-3">
                                <span className="text-[10px] uppercase tracking-[0.22em] text-accent num">
                                    / confirm trade
                                </span>
                                <span className="num text-[10px] text-text-faint">
                                    on your connected wallet
                                </span>
                            </div>

                            {proposal && (
                                <>
                                    <div className="mb-3 text-[13.5px] leading-snug text-text">
                                        Buy{" "}
                                        <span className={proposal.side === "YES" ? "text-yes" : "text-no"}>
                                            {proposal.shares_human} {proposal.side}
                                        </span>{" "}
                                        shares — <span className="text-text-dim">{proposal.question}</span>
                                    </div>
                                    <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                                        <CardStat k="est. cost" v={`$${proposal.est_cost_usdc.toFixed(2)}`} />
                                        <CardStat k="max" v={`$${proposal.max_cost_usdc.toFixed(2)}`} />
                                        <CardStat k="fee" v={`$${proposal.fee_usdc.toFixed(4)}`} />
                                        <CardStat k="price" v={`${Math.round(proposal.side_price * 100)}%`} />
                                    </div>
                                    {!proposal.sufficient_balance && (
                                        <div className="mb-3 text-[11.5px] text-no num">
                                            Not enough USDT (${proposal.wallet_balance_usdc.toFixed(2)}) to
                                            cover the max cost.
                                        </div>
                                    )}
                                </>
                            )}

                            {tx.stage === "idle" && proposal && (
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => void confirmTrade(proposal)}
                                        disabled={!proposal.sufficient_balance || !isConnected}
                                        className="num text-[11px] uppercase tracking-[0.18em] text-bg bg-accent px-4 py-1.5 hover:bg-accent/85 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        confirm in wallet
                                    </button>
                                    <button
                                        type="button"
                                        onClick={dismissProposal}
                                        className="num text-[11px] uppercase tracking-[0.18em] text-text-mute border border-border px-3 py-1.5 hover:text-text transition-colors"
                                    >
                                        cancel
                                    </button>
                                </div>
                            )}
                            {(tx.stage === "approving" || tx.stage === "buying") && (
                                <div className="flex items-center gap-2 text-[12.5px] text-text-mute num">
                                    <span className="h-1.5 w-1.5 rounded-full bg-accent live-dot" />
                                    {tx.stage === "approving"
                                        ? "Approving USDT — confirm in your wallet…"
                                        : "Placing the trade — confirm in your wallet…"}
                                </div>
                            )}
                            {tx.stage === "done" && tx.hash && (
                                <div className="text-[12.5px] text-yes num">
                                    ✓ Confirmed ·{" "}
                                    <a
                                        href={`https://scan.bohr.life/tx/${tx.hash}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-accent hover:text-text break-all"
                                    >
                                        {tx.hash.slice(0, 14)}…
                                    </a>
                                </div>
                            )}
                            {tx.stage === "error" && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="min-w-0 flex-1 text-[12.5px] text-no num">
                                        {tx.error}
                                    </span>
                                    {proposal && (
                                        <button
                                            type="button"
                                            onClick={() => void confirmTrade(proposal)}
                                            className="num text-[11px] uppercase tracking-[0.18em] text-accent border border-accent/40 px-3 py-1 hover:bg-accent/10"
                                        >
                                            retry
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={dismissProposal}
                                        className="num text-[11px] uppercase tracking-[0.18em] text-text-mute border border-border px-3 py-1 hover:text-text"
                                    >
                                        dismiss
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {error && (
                        <div className="shrink-0 border-t border-no/30 bg-no/5 px-5 py-2.5 text-[12px] text-no num">
                            {error}
                        </div>
                    )}

                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void send(input);
                        }}
                        className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-3"
                    >
                        <input
                            value={input}
                            onChange={(e) => setInput(e.target.value.slice(0, CHAR_LIMIT))}
                            maxLength={CHAR_LIMIT}
                            placeholder={isConnected ? "Ask your agent…" : "Connect a wallet to chat"}
                            disabled={streaming || !isConnected}
                            className="flex-1 bg-transparent px-2 py-1.5 text-[13.5px] text-text placeholder:text-text-faint outline-none disabled:opacity-50"
                        />
                        {nearLimit && (
                            <span
                                className={`num text-[10px] tabular ${
                                    input.length >= CHAR_LIMIT ? "text-no" : "text-text-faint"
                                }`}
                            >
                                {input.length}/{CHAR_LIMIT}
                            </span>
                        )}
                        <button
                            type="submit"
                            disabled={streaming || !isConnected || !input.trim()}
                            className="num text-[11px] uppercase tracking-[0.18em] text-bg bg-accent px-3.5 py-1.5 hover:bg-accent/85 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            {streaming ? "…" : "send"}
                        </button>
                    </form>
                </section>
            )}

            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-label={open ? "Minimize agent chat" : "Ask the agent"}
                aria-expanded={open}
                className="relative grid h-14 w-14 place-items-center rounded-full bg-accent text-bg shadow-lg shadow-accent/30 transition-transform hover:scale-105 hover:bg-accent/90 active:scale-95"
            >
                {open ? (
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M11 6 L12.4 11.6 L18 13 L12.4 14.4 L11 20 L9.6 14.4 L4 13 L9.6 11.6 Z" />
                        <path
                            d="M18.6 3 L19.2 5 L21.2 5.6 L19.2 6.2 L18.6 8.2 L18 6.2 L16 5.6 L18 5 Z"
                            opacity="0.85"
                        />
                    </svg>
                )}
                {!open && streaming && (
                    <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-yes ring-2 ring-bg live-dot" />
                )}
            </button>
        </div>
    );
}

function Caret() {
    return (
        <span className="inline-block w-[7px] h-[14px] -mb-0.5 ml-0.5 bg-accent animate-[chatCaret_1s_steps(2)_infinite]">
            <style>{`@keyframes chatCaret { 0%,100% { opacity: 1 } 50% { opacity: 0 } }`}</style>
        </span>
    );
}

function CardStat({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-[0.18em] text-text-faint num">
                {k}
            </span>
            <span className="num tabular text-[13px] text-text">{v}</span>
        </div>
    );
}

// ── Lightweight, injection-safe markdown ────────────────────────────────────
// Renders a useful subset — paragraphs, bold, inline code, links (with href
// sanitized), and bullet/numbered lists — as React nodes. Never uses
// dangerouslySetInnerHTML, so model output can't inject HTML.

function safeHref(href: string): string | null {
    if (/^https?:\/\//i.test(href)) return href;
    if (href === "/" || /^\/[A-Za-z0-9]/.test(href)) return href; // internal path
    return null;
}

function renderInline(text: string): ReactNode[] {
    const nodes: ReactNode[] = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s)]+)/g;
    let last = 0;
    let key = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) nodes.push(text.slice(last, m.index));
        const tok = m[0];
        if (tok.startsWith("`")) {
            nodes.push(
                <code
                    key={key++}
                    className="rounded bg-bg-elev border border-border px-1 py-0.5 text-[0.86em] num text-text-dim"
                >
                    {tok.slice(1, -1)}
                </code>,
            );
        } else if (tok.startsWith("**")) {
            nodes.push(
                <strong key={key++} className="font-semibold text-text">
                    {tok.slice(2, -2)}
                </strong>,
            );
        } else if (tok.startsWith("[")) {
            const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
            const href = mm ? safeHref(mm[2]) : null;
            if (mm && href) {
                nodes.push(<InlineLink key={key++} href={href} label={mm[1]} />);
            } else if (mm) {
                nodes.push(mm[1]);
            }
        } else {
            const href = safeHref(tok);
            if (href) nodes.push(<InlineLink key={key++} href={href} label={tok} />);
            else nodes.push(tok);
        }
        last = m.index + tok.length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
}

function InlineLink({ href, label }: { href: string; label: string }) {
    const cls =
        "text-accent underline decoration-accent/40 underline-offset-2 hover:text-text break-words";
    // External → new tab. Internal path → Next Link for client-side navigation
    // (no full reload); the chat bubble lives in the layout so it persists.
    if (/^https?:\/\//i.test(href)) {
        return (
            <a href={href} target="_blank" rel="noreferrer" className={cls}>
                {label}
            </a>
        );
    }
    return (
        <Link href={href} className={cls}>
            {label}
        </Link>
    );
}

function Markdown({ text }: { text: string }) {
    const lines = text.split("\n");
    const blocks: ReactNode[] = [];
    let i = 0;
    let key = 0;
    while (i < lines.length) {
        const line = lines[i];
        const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
            blocks.push(
                <div key={key++} className="mt-0.5 text-[13px] font-semibold text-text">
                    {renderInline(heading[1])}
                </div>,
            );
            i++;
            continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
                i++;
            }
            blocks.push(
                <ul key={key++} className="flex list-disc flex-col gap-0.5 pl-4 marker:text-accent">
                    {items.map((it, j) => (
                        <li key={j}>{renderInline(it)}</li>
                    ))}
                </ul>,
            );
            continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
                i++;
            }
            blocks.push(
                <ol key={key++} className="flex list-decimal flex-col gap-0.5 pl-4 marker:text-text-faint">
                    {items.map((it, j) => (
                        <li key={j}>{renderInline(it)}</li>
                    ))}
                </ol>,
            );
            continue;
        }
        if (line.trim() === "") {
            i++;
            continue;
        }
        const para: string[] = [];
        while (
            i < lines.length &&
            lines[i].trim() !== "" &&
            !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
        ) {
            para.push(lines[i]);
            i++;
        }
        blocks.push(
            <p key={key++} className="break-words">
                {para.map((p, j) => (
                    <span key={j}>
                        {renderInline(p)}
                        {j < para.length - 1 && <br />}
                    </span>
                ))}
            </p>,
        );
    }
    return <div className="flex flex-col gap-2">{blocks}</div>;
}
