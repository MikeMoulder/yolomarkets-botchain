"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    useAccount,
    useReadContract,
    useSignMessage,
    useWriteContract,
    useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits } from "viem";
import {
    ADDRESSES,
    erc20Abi,
} from "@/lib/contracts";
import { formatUsdc, shortAddr } from "@/lib/format";
import { PATTERN_LIST, type PatternId, PATTERNS } from "@/lib/agent-patterns";
import { signProfileOp } from "@/lib/client-auth";
import { useCircleWallet } from "@/lib/circle-session";
import { BridgeUsdc } from "@/components/bridge-usdc";

type Category = { label: string; count: number };
type NativeMarketLite = {
    address: `0x${string}`;
    question: string;
    category: string;
};

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function SetupWizard({
    categories,
    nativeMarkets,
}: {
    categories: Category[];
    nativeMarkets: NativeMarketLite[];
}) {
    const { address, isConnected } = useAccount();
    const { signMessageAsync } = useSignMessage();
    const { session: circleSession } = useCircleWallet();
    const router = useRouter();

    const [step, setStep] = useState<Step>(1);
    const [pattern, setPattern] = useState<PatternId>("value");
    const [marketsMode, setMarketsMode] = useState<
        "all" | "categories" | "watchlist"
    >("all");
    const [pickedCats, setPickedCats] = useState<Set<string>>(new Set());
    const [pickedMarkets, setPickedMarkets] = useState<Set<string>>(new Set());
    const [marketSearch, setMarketSearch] = useState("");
    const [budgetTotal, setBudgetTotal] = useState(20);
    const [budgetPerMarket, setBudgetPerMarket] = useState(2);
    const [budgetPerDay, setBudgetPerDay] = useState(10);
    const [agentAddress, setAgentAddress] = useState<`0x${string}` | null>(null);
    const [circleWalletId, setCircleWalletId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => setMounted(true), []);

    const activeAddress = address ?? circleSession?.address;
    const hasWagmiSigner = !!address && isConnected;
    const walletConnected = mounted && (!!activeAddress || hasWagmiSigner);

    // If the user is connected, advance past step 1 automatically
    useEffect(() => {
        if (walletConnected && step === 1) setStep(2);
    }, [walletConnected, step]);

    const filteredMarkets = useMemo(() => {
        const q = marketSearch.trim().toLowerCase();
        if (!q) return nativeMarkets.slice(0, 30);
        return nativeMarkets
            .filter(
                (m) =>
                    m.question.toLowerCase().includes(q) ||
                    m.category.toLowerCase().includes(q),
            )
            .slice(0, 30);
    }, [marketSearch, nativeMarkets]);

    async function handleSubmit() {
        if (!activeAddress || !hasWagmiSigner) {
            setError("Connect a browser wallet to sign and save this agent profile.");
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "profile.put",
                userAddr: activeAddress,
                signMessageAsync,
            });
            const res = await fetch("/api/agent/profile", {
                method: "PUT",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify({
                    userAddr: activeAddress,
                    pattern,
                    marketsMode,
                    categories: Array.from(pickedCats),
                    watchlist: Array.from(pickedMarkets),
                    budgetTotal,
                    budgetPerMarket,
                    budgetPerDay,
                    agentAddress,
                    circleWalletId,
                    active: true,
                }),
            });
            const data = (await res.json()) as { error?: string };
            if (!res.ok) {
                setError(data.error ?? `error: ${res.status}`);
                setSubmitting(false);
                return;
            }
            router.push(`/agent/feed?u=${activeAddress}`);
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "unknown error");
            setSubmitting(false);
        }
    }

    return (
        <div className="mx-auto max-w-[920px] px-6 py-10">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <div className="text-[11px] uppercase tracking-[0.22em] text-text-mute mb-2 num">
                        / set up your agent
                    </div>
                    <h1 className="text-[26px] md:text-[32px] leading-tight tracking-tight font-medium">
                        Build a trader that runs while you sleep
                    </h1>
                </div>
                <StepIndicator current={step} />
            </div>

            {/* What the user is actually signing up for. Kept accurate: the
                agent really does get two Circle wallets, and both are signed
                for by Circle's MPC rather than by a key we hold. */}
            <div className="border border-edge/30 bg-edge/5 px-4 py-3 text-[12px] text-edge mb-6 flex items-start gap-3">
                <span className="num text-[10px] uppercase tracking-[0.22em] shrink-0 mt-0.5">
                    / how it works
                </span>
                <span>
                    Your agent gets two wallets: one holds your USDT and
                    places the trades, and a second, much smaller one covers its
                    own running costs. Circle&rsquo;s MPC signs for both, so no
                    private key is ever held by us or by the agent, and it keeps
                    working while you are offline.
                </span>
            </div>

            {/* Step bodies */}
            {step === 1 && <Step1Connect connected={walletConnected} />}

            {step === 2 && (
                <Step2Pattern
                    pattern={pattern}
                    onPick={setPattern}
                    onNext={() => setStep(3)}
                />
            )}

            {step === 3 && (
                <Step3Markets
                    mode={marketsMode}
                    onMode={setMarketsMode}
                    categories={categories}
                    pickedCats={pickedCats}
                    setPickedCats={setPickedCats}
                    nativeMarkets={filteredMarkets}
                    pickedMarkets={pickedMarkets}
                    setPickedMarkets={setPickedMarkets}
                    search={marketSearch}
                    setSearch={setMarketSearch}
                    onBack={() => setStep(2)}
                    onNext={() => setStep(4)}
                />
            )}

            {step === 4 && (
                <Step4Limits
                    budgetTotal={budgetTotal}
                    setBudgetTotal={setBudgetTotal}
                    budgetPerMarket={budgetPerMarket}
                    setBudgetPerMarket={setBudgetPerMarket}
                    budgetPerDay={budgetPerDay}
                    setBudgetPerDay={setBudgetPerDay}
                    pattern={pattern}
                    onBack={() => setStep(3)}
                    onNext={() => setStep(5)}
                />
            )}

            {step === 5 && (
                <Step5Deploy
                    userAddr={activeAddress}
                    agentAddress={agentAddress}
                    setAgentAddress={setAgentAddress}
                    circleWalletId={circleWalletId}
                    setCircleWalletId={setCircleWalletId}
                    signMessageAsync={signMessageAsync}
                    hasConnectedSigner={hasWagmiSigner}
                    onBack={() => setStep(4)}
                    onNext={() => setStep(6)}
                />
            )}

            {step === 6 && (
                <Step6CircleAuthorization
                    agentAddress={agentAddress}
                    circleWalletId={circleWalletId}
                    onBack={() => setStep(5)}
                    onNext={() => setStep(7)}
                />
            )}

            {step === 7 && (
                <Step7Fund
                    userAddr={activeAddress}
                    agentAddress={agentAddress}
                    budgetTotal={budgetTotal}
                    onBack={() => setStep(6)}
                    onNext={() => setStep(8)}
                />
            )}

            {step === 8 && (
                <Step8Review
                    pattern={pattern}
                    marketsMode={marketsMode}
                    pickedCats={pickedCats}
                    pickedMarkets={pickedMarkets}
                    budgetTotal={budgetTotal}
                    budgetPerMarket={budgetPerMarket}
                    budgetPerDay={budgetPerDay}
                    agentAddress={agentAddress}
                    circleWalletId={circleWalletId}
                    onBack={() => setStep(7)}
                    onSubmit={handleSubmit}
                    submitting={submitting}
                    error={error}
                />
            )}
        </div>
    );
}

// ── Step indicator ────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
    return (
        <div className="flex items-center gap-1.5">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <div
                    key={n}
                    className={`w-7 h-1 ${n <= current ? "bg-text" : "bg-border-strong"
                        }`}
                />
            ))}
        </div>
    );
}

// ── Step 1: Connect wallet ────────────────────────────────────────────────

function Step1Connect({ connected }: { connected: boolean }) {
    return (
        <section className="border border-border bg-bg-elev/30 px-6 py-10 text-center">
            <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-3">
                / step 01
            </div>
            <h2 className="text-[20px] font-medium mb-3">
                Connect a wallet to begin
            </h2>
            <p className="text-[13px] text-text-dim max-w-[44ch] mx-auto mb-6">
                Your wallet address is the key to your agent profile. Use the
                connect button in the top-right of the page.
            </p>
            {!connected && (
                <span className="num text-[11px] uppercase tracking-[0.18em] text-text-faint">
                    waiting…
                </span>
            )}
        </section>
    );
}

// ── Step 2: Pick pattern ──────────────────────────────────────────────────

function Step2Pattern({
    pattern,
    onPick,
    onNext,
}: {
    pattern: PatternId;
    onPick: (p: PatternId) => void;
    onNext: () => void;
}) {
    return (
        <section>
            <div className="flex items-baseline justify-between mb-5">
                <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / step 02
                    </div>
                    <h2 className="text-[20px] font-medium mt-1">
                        Pick a trading pattern
                    </h2>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {PATTERN_LIST.map((p) => {
                    const selected = pattern === p.id;
                    return (
                        <button
                            key={p.id}
                            onClick={() => onPick(p.id)}
                            className={`text-left border px-5 py-5 transition-all ${selected
                                ? "border-accent bg-accent-bg"
                                : "border-border bg-bg-elev/40 hover:border-border-strong hover:bg-bg-elev/70"
                                }`}
                        >
                            <div className="flex items-baseline justify-between gap-3 mb-2">
                                <span className="text-[15px] font-medium tracking-tight">
                                    {p.name}
                                </span>
                                <span className="num text-[10px] uppercase tracking-[0.18em] text-text-mute">
                                    {cadenceLabel(p.cadenceMinutes)}
                                </span>
                            </div>
                            <p className="text-[12.5px] text-text-dim leading-snug">
                                {p.oneLiner}
                            </p>
                        </button>
                    );
                })}
            </div>

            <Nav onNext={onNext} />
        </section>
    );
}

// ── Step 3: Markets ───────────────────────────────────────────────────────

function Step3Markets({
    mode,
    onMode,
    categories,
    pickedCats,
    setPickedCats,
    nativeMarkets,
    pickedMarkets,
    setPickedMarkets,
    search,
    setSearch,
    onBack,
    onNext,
}: {
    mode: "all" | "categories" | "watchlist";
    onMode: (m: "all" | "categories" | "watchlist") => void;
    categories: Category[];
    pickedCats: Set<string>;
    setPickedCats: (s: Set<string>) => void;
    nativeMarkets: NativeMarketLite[];
    pickedMarkets: Set<string>;
    setPickedMarkets: (s: Set<string>) => void;
    search: string;
    setSearch: (s: string) => void;
    onBack: () => void;
    onNext: () => void;
}) {
    function toggleCat(c: string) {
        const next = new Set(pickedCats);
        if (next.has(c)) next.delete(c);
        else next.add(c);
        setPickedCats(next);
    }
    function toggleMarket(addr: string) {
        const next = new Set(pickedMarkets);
        if (next.has(addr)) next.delete(addr);
        else next.add(addr);
        setPickedMarkets(next);
    }

    const valid =
        mode === "all" ||
        (mode === "categories" && pickedCats.size > 0) ||
        (mode === "watchlist" && pickedMarkets.size > 0);

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 03
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Which markets should it cover?
                </h2>
            </div>

            <div className="flex gap-2 mb-5">
                {(["all", "categories", "watchlist"] as const).map((m) => (
                    <button
                        key={m}
                        onClick={() => onMode(m)}
                        className={`px-4 py-2 text-[12px] border transition-colors ${mode === m
                            ? "border-accent text-accent bg-accent-bg"
                            : "border-border text-text-dim hover:border-border-strong hover:text-text"
                            }`}
                    >
                        {m === "all"
                            ? "All markets"
                            : m === "categories"
                                ? "By category"
                                : "Watchlist"}
                    </button>
                ))}
            </div>

            {mode === "all" && (
                <div className="border border-border bg-bg-elev/30 px-5 py-6 text-[13px] text-text-dim">
                    The agent will consider every live market on the factory.
                    Trades will still respect your per-market budget cap.
                </div>
            )}

            {mode === "categories" && (
                <div className="flex flex-wrap gap-2">
                    {categories.map((c) => {
                        const sel = pickedCats.has(c.label);
                        return (
                            <button
                                key={c.label}
                                onClick={() => toggleCat(c.label)}
                                className={`px-3 py-1.5 text-[12px] border transition-colors num ${sel
                                    ? "border-accent text-accent bg-accent-bg"
                                    : "border-border text-text-dim hover:border-border-strong hover:text-text"
                                    }`}
                            >
                                {c.label}
                                <span className="text-text-faint ml-2 tabular">
                                    {c.count}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            {mode === "watchlist" && (
                <div>
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="search markets…"
                        className="w-full px-3 py-2 text-[13px] bg-bg-elev border border-border focus:border-border-strong outline-none mb-3"
                    />
                    <div className="border border-border max-h-[380px] overflow-y-auto divide-y divide-border">
                        {nativeMarkets.map((m) => {
                            const sel = pickedMarkets.has(m.address);
                            return (
                                <button
                                    key={m.address}
                                    onClick={() => toggleMarket(m.address)}
                                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${sel
                                        ? "bg-accent-bg"
                                        : "hover:bg-bg-hover"
                                        }`}
                                >
                                    <span
                                        className={`w-3 h-3 border ${sel
                                            ? "border-accent bg-accent"
                                            : "border-border"
                                            }`}
                                    />
                                    <span className="text-[12.5px] text-text flex-1 truncate">
                                        {m.question}
                                    </span>
                                    <span className="num text-[10px] uppercase tracking-[0.18em] text-text-mute">
                                        {m.category}
                                    </span>
                                </button>
                            );
                        })}
                        {nativeMarkets.length === 0 && (
                            <div className="px-4 py-6 text-center text-[12px] text-text-mute">
                                no matches
                            </div>
                        )}
                    </div>
                    <div className="text-[11px] text-text-mute mt-2 num">
                        {pickedMarkets.size} picked
                    </div>
                </div>
            )}

            <Nav onBack={onBack} onNext={onNext} disabled={!valid} />
        </section>
    );
}

// ── Step 4: Limits ────────────────────────────────────────────────────────

function Step4Limits({
    budgetTotal,
    setBudgetTotal,
    budgetPerMarket,
    setBudgetPerMarket,
    budgetPerDay,
    setBudgetPerDay,
    pattern,
    onBack,
    onNext,
}: {
    budgetTotal: number;
    setBudgetTotal: (n: number) => void;
    budgetPerMarket: number;
    setBudgetPerMarket: (n: number) => void;
    budgetPerDay: number;
    setBudgetPerDay: (n: number) => void;
    pattern: PatternId;
    onBack: () => void;
    onNext: () => void;
}) {
    const cadence =
        pattern === "custom" ? 30 : PATTERNS[pattern]?.cadenceMinutes ?? 30;
    const runsPerDay = Math.max(1, Math.floor(1440 / cadence));
    const valid = budgetTotal > 0 && budgetPerMarket > 0 && budgetPerDay > 0
        && budgetPerMarket <= budgetTotal;

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 04
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Set spend limits
                </h2>
                <p className="text-[12.5px] text-text-dim mt-2 max-w-[60ch]">
                    Hard caps the agent cannot cross. The policy engine meters
                    every trade against these limits before the Circle wallet
                    submits it.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <BudgetField
                    label="Total budget"
                    sub="lifetime cap"
                    value={budgetTotal}
                    onChange={setBudgetTotal}
                />
                <BudgetField
                    label="Per market"
                    sub="single-market cap"
                    value={budgetPerMarket}
                    onChange={setBudgetPerMarket}
                />
                <BudgetField
                    label="Per day"
                    sub="daily spend cap"
                    value={budgetPerDay}
                    onChange={setBudgetPerDay}
                />
            </div>

            <div className="border border-border bg-bg-elev/30 px-5 py-4 text-[12.5px] text-text-dim">
                Cadence is set by the pattern:{" "}
                <span className="num text-text">{cadenceLabel(cadence)}</span>,
                roughly{" "}
                <span className="num text-text">{runsPerDay} runs/day</span>.
            </div>

            <Nav onBack={onBack} onNext={onNext} disabled={!valid} />
        </section>
    );
}

function BudgetField({
    label,
    sub,
    value,
    onChange,
}: {
    label: string;
    sub: string;
    value: number;
    onChange: (n: number) => void;
}) {
    return (
        <label className="block border border-border bg-bg-elev/40 px-4 py-3">
            <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num block">
                {label}
            </span>
            <span className="text-[10px] text-text-faint lowercase block mb-2">
                {sub}
            </span>
            <div className="flex items-baseline gap-2">
                <span className="num text-[12px] text-text-mute">$</span>
                <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value) || 0)}
                    className="num text-[20px] bg-transparent border-0 outline-none w-full tabular text-text"
                />
                <span className="text-[10px] text-text-faint num">USDT</span>
            </div>
        </label>
    );
}

// ── Step 5: Create Circle agent wallet ────────────────────────────────────

function Step5Deploy({
    userAddr,
    agentAddress,
    setAgentAddress,
    circleWalletId,
    setCircleWalletId,
    signMessageAsync,
    hasConnectedSigner,
    onBack,
    onNext,
}: {
    userAddr: `0x${string}` | undefined;
    agentAddress: `0x${string}` | null;
    setAgentAddress: (a: `0x${string}` | null) => void;
    circleWalletId: string | null;
    setCircleWalletId: (id: string | null) => void;
    signMessageAsync: (params: { message: string }) => Promise<`0x${string}`>;
    hasConnectedSigner: boolean;
    onBack: () => void;
    onNext: () => void;
}) {
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    async function handleCreate() {
        if (!userAddr) return;
        if (!hasConnectedSigner) {
            setCreateError(
                "Connect a browser wallet to sign agent setup. Circle wallet login is available for onboarding, but Circle profile-signing is not wired here yet.",
            );
            return;
        }
        setCreating(true);
        setCreateError(null);
        try {
            const authHeaders = await signProfileOp({
                op: "agent.wallet.create",
                userAddr,
                signMessageAsync,
            });
            const res = await fetch("/api/agent/circle-wallet", {
                method: "POST",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify({ userAddr }),
            });
            const data = (await res.json()) as {
                walletId?: string;
                address?: string;
                error?: string;
                detail?: string;
            };
            if (!res.ok || !data.walletId || !data.address) {
                setCreateError(data.detail ?? data.error ?? `error: ${res.status}`);
                return;
            }
            setCircleWalletId(data.walletId);
            setAgentAddress(data.address.toLowerCase() as `0x${string}`);
        } catch (e) {
            setCreateError(e instanceof Error ? e.message : "unknown error");
        } finally {
            setCreating(false);
        }
    }

    const ready = !!agentAddress;

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 05
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Create your Circle agent wallet
                </h2>
                <p className="text-[12.5px] text-text-dim mt-2 max-w-[60ch]">
                    A wallet on Bohr holds the USDT your
                    agent trades with. Circle signs agent transactions
                    server-side, so the runner can act while you are offline.
                </p>
            </div>

            <div className="border border-border bg-bg-elev/40 px-5 py-5">
                <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-x-6 gap-y-3 text-[13px] items-baseline">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / owner
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {userAddr ?? "—"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / agent
                    </span>
                    <span className="num text-text tabular break-all">
                        {agentAddress ?? "not created yet"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / circle id
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {circleWalletId ?? "—"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / status
                    </span>
                    <span className="text-[12.5px]">
                        {ready ? (
                            <span className="text-yes">
                                created · ready
                            </span>
                        ) : creating ? (
                            <span className="text-edge">
                                creating with Circle…
                            </span>
                        ) : (
                            <span className="text-text-mute">
                                not yet created
                            </span>
                        )}
                    </span>
                </div>

                {!ready && (
                    <div className="mt-5 flex flex-col items-start gap-3">
                        <button
                            onClick={handleCreate}
                            disabled={!userAddr || creating || !hasConnectedSigner}
                            className="px-5 h-10 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] hover:bg-accent/15 disabled:opacity-50 transition-colors num"
                        >
                            {creating ? "creating…" : "create wallet →"}
                        </button>
                        <p className="text-[11.5px] text-text-faint">
                            {hasConnectedSigner
                                ? "Requires one wallet signature to authorize setup. Circle handles the wallet creation server-side."
                                : "Circle wallet connected. Agent setup still needs a browser-wallet signature for profile authorization."}
                        </p>
                    </div>
                )}

                {createError && (
                    <div className="mt-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                        {createError}
                    </div>
                )}
            </div>

            <Nav onBack={onBack} onNext={onNext} disabled={!ready} />
        </section>
    );
}

// ── Step 6: Circle signing mode ──────────────────────────────────────────

function Step6CircleAuthorization({
    agentAddress,
    circleWalletId,
    onBack,
    onNext,
}: {
    agentAddress: `0x${string}` | null;
    circleWalletId: string | null;
    onBack: () => void;
    onNext: () => void;
}) {
    const ready = !!agentAddress && !!circleWalletId;

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 06
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Enable autonomous signing
                </h2>
                <p className="text-[12.5px] text-text-dim mt-2 max-w-[62ch]">
                    This agent uses Circle MPC signing. The runner submits
                    approved agent trades and reasoning payments from this
                    wallet without anyone storing a private key.
                </p>
            </div>

            <div className="border border-border bg-bg-elev/40 px-5 py-5">
                <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-x-6 gap-y-3 text-[13px] items-baseline">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / signer
                    </span>
                    <span className="text-text-dim">
                        Circle Developer-Controlled Wallet
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / wallet
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {agentAddress ?? "—"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / circle id
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {circleWalletId ?? "—"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / status
                    </span>
                    <span className={ready ? "text-yes" : "text-no"}>
                        {ready ? "ready" : "create the wallet first"}
                    </span>
                </div>
            </div>

            <Nav onBack={onBack} onNext={onNext} disabled={!ready} />
        </section>
    );
}

// ── Step 7: Fund agent ───────────────────────────────────────────────────

function Step7Fund({
    userAddr,
    agentAddress,
    budgetTotal,
    onBack,
    onNext,
}: {
    userAddr: `0x${string}` | undefined;
    agentAddress: `0x${string}` | null;
    budgetTotal: number;
    onBack: () => void;
    onNext: () => void;
}) {
    const [amount, setAmount] = useState(budgetTotal.toString());

    const { data: ownerBal, refetch: refetchOwnerBal } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: userAddr ? [userAddr] : undefined,
        query: { enabled: !!userAddr, refetchInterval: 8000 },
    });

    const { data: agentBal, refetch: refetchAgentBal } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: agentAddress ? [agentAddress] : undefined,
        query: { enabled: !!agentAddress, refetchInterval: 8000 },
    });

    const {
        writeContract,
        data: txHash,
        isPending: signing,
        error: writeError,
        reset: resetWrite,
    } = useWriteContract();

    const { isLoading: confirming, isSuccess: confirmed } =
        useWaitForTransactionReceipt({ hash: txHash });

    useEffect(() => {
        if (!confirmed) return;
        void refetchAgentBal();
        void refetchOwnerBal();
    }, [confirmed, refetchAgentBal, refetchOwnerBal]);

    const parsed = safeParseUsdc(amount);
    const ownerBalance = ownerBal ?? 0n;
    const tooMuch = parsed !== null && parsed > ownerBalance;
    const valid = parsed !== null && parsed > 0n && !tooMuch;
    const busy = signing || confirming;
    const funded = (agentBal ?? 0n) > 0n || confirmed;

    function handleFund() {
        if (!agentAddress || !valid || parsed === null) return;
        resetWrite();
        writeContract({
            address: ADDRESSES.usdc,
            abi: erc20Abi,
            functionName: "transfer",
            args: [agentAddress, parsed],
        });
    }

    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 07
                </div>
                <h2 className="text-[20px] font-medium mt-1">
                    Fund your agent
                </h2>
                <p className="text-[12.5px] text-text-dim mt-2 max-w-[60ch]">
                    Send USDT to the agent wallet so it has a balance to
                    trade with and pay reasoning requests.
                </p>
            </div>

            <div className="border border-border bg-bg-elev/40 px-5 py-5">
                <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-x-6 gap-y-3 text-[13px] items-baseline mb-5">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / from wallet
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {userAddr ?? "—"}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / to agent
                    </span>
                    <span className="num text-text-dim tabular break-all">
                        {agentAddress ? (
                            <a
                                href={`https://testnet.arcscan.app/address/${agentAddress}`}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-text transition-colors"
                            >
                                {shortAddr(agentAddress, 8)}
                            </a>
                        ) : (
                            "—"
                        )}
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / wallet balance
                    </span>
                    <span className="num text-text-dim tabular">
                        ${ownerBal !== undefined ? formatUsdc(ownerBal) : "—"} USDC
                    </span>

                    <span className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                        / agent balance
                    </span>
                    <span className="num text-text tabular">
                        ${agentBal !== undefined ? formatUsdc(agentBal) : "—"} USDC
                    </span>
                </div>

                <div className="border-t border-border pt-4">
                    <label className="block text-[10px] uppercase tracking-[0.22em] text-text-mute num mb-2">
                        / deposit amount
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="flex-1 flex items-center gap-2 border border-border bg-bg-elev px-3 h-10">
                            <span className="num text-[12px] text-text-mute">$</span>
                            <input
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                inputMode="decimal"
                                disabled={busy}
                                className="w-full bg-transparent outline-none num text-[14px] text-text disabled:opacity-50"
                            />
                            <span className="num text-[11px] text-text-faint">USDC</span>
                        </div>
                        <button
                            onClick={handleFund}
                            disabled={!agentAddress || !valid || busy}
                            className="px-5 h-10 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] hover:bg-accent/15 disabled:opacity-50 transition-colors num"
                        >
                            {confirming
                                ? "confirming…"
                                : signing
                                    ? "sending…"
                                    : "fund agent →"}
                        </button>
                    </div>

                    <div className="mt-3 text-[12px]">
                        {confirmed ? (
                            <span className="text-yes">funded · ready</span>
                        ) : tooMuch ? (
                            <span className="text-no">amount exceeds wallet balance</span>
                        ) : funded ? (
                            <span className="text-yes">agent already has funds</span>
                        ) : (
                            <span className="text-text-mute">
                                awaiting deposit
                            </span>
                        )}
                    </div>

                    {writeError && (
                        <div className="mt-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                            {writeError.message.split("\n")[0]}
                        </div>
                    )}
                </div>
            </div>

            {/* The funding box above assumes USDC already on Arc. For everyone
                who holds it elsewhere, this is the way in. */}
            <div className="mt-4">
                <BridgeUsdc
                    recipient={agentAddress ?? undefined}
                    onBridged={() => {
                        refetchOwnerBal();
                        refetchAgentBal();
                    }}
                />
            </div>

            <Nav onBack={onBack} onNext={onNext} disabled={!funded} />
        </section>
    );
}

// ── Step 8: Review ────────────────────────────────────────────────────────

function Step8Review({
    pattern,
    marketsMode,
    pickedCats,
    pickedMarkets,
    budgetTotal,
    budgetPerMarket,
    budgetPerDay,
    agentAddress,
    circleWalletId,
    onBack,
    onSubmit,
    submitting,
    error,
}: {
    pattern: PatternId;
    marketsMode: "all" | "categories" | "watchlist";
    pickedCats: Set<string>;
    pickedMarkets: Set<string>;
    budgetTotal: number;
    budgetPerMarket: number;
    budgetPerDay: number;
    agentAddress: `0x${string}` | null;
    circleWalletId: string | null;
    onBack: () => void;
    onSubmit: () => void;
    submitting: boolean;
    error: string | null;
}) {
    const p = pattern === "custom" ? null : PATTERNS[pattern];
    return (
        <section>
            <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-text-mute num">
                    / step 08
                </div>
                <h2 className="text-[20px] font-medium mt-1">Confirm</h2>
            </div>

            <dl className="grid grid-cols-[160px_1fr] gap-y-3 gap-x-6 border border-border bg-bg-elev/30 px-5 py-5 text-[13px]">
                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    pattern
                </dt>
                <dd className="text-text">
                    {p?.name ?? "Custom"}
                    {p && (
                        <span className="text-text-mute ml-2 text-[11.5px]">
                            · {p.oneLiner}
                        </span>
                    )}
                </dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    markets
                </dt>
                <dd className="text-text-dim">
                    {marketsMode === "all"
                        ? "All live markets"
                        : marketsMode === "categories"
                            ? `${pickedCats.size} categories: ${Array.from(pickedCats).join(", ")}`
                            : `${pickedMarkets.size} hand-picked`}
                </dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    budget total
                </dt>
                <dd className="num text-text tabular">${budgetTotal.toFixed(2)}</dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    per market
                </dt>
                <dd className="num text-text tabular">${budgetPerMarket.toFixed(2)}</dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    per day
                </dt>
                <dd className="num text-text tabular">${budgetPerDay.toFixed(2)}</dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    agent wallet
                </dt>
                <dd className="num text-text-dim tabular break-all text-[11.5px]">
                    {agentAddress ? (
                        <a
                            href={`https://testnet.arcscan.app/address/${agentAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-text transition-colors"
                        >
                            {shortAddr(agentAddress, 8)}
                        </a>
                    ) : (
                        <span className="text-text-faint">—</span>
                    )}
                </dd>

                <dt className="text-text-mute uppercase tracking-[0.18em] text-[10px] num">
                    execution
                </dt>
                <dd className="text-[11.5px]">
                    {circleWalletId ? (
                        <span className="text-yes">
                            Circle MPC ·{" "}
                            <span className="num text-text-dim">
                                {circleWalletId}
                            </span>
                        </span>
                    ) : (
                        <span className="text-text-faint">—</span>
                    )}
                </dd>
            </dl>

            {error && (
                <div className="mt-4 border border-no/30 bg-no/5 px-4 py-3 text-[12px] text-no">
                    {error}
                </div>
            )}

            <Nav
                onBack={onBack}
                primary={{
                    label: submitting ? "saving…" : "Activate agent",
                    onClick: onSubmit,
                    disabled: submitting,
                }}
            />
        </section>
    );
}

// ── Nav row ───────────────────────────────────────────────────────────────

function Nav({
    onBack,
    onNext,
    disabled,
    primary,
}: {
    onBack?: () => void;
    onNext?: () => void;
    disabled?: boolean;
    primary?: { label: string; onClick: () => void; disabled?: boolean };
}) {
    return (
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-border">
            {onBack ? (
                <button
                    onClick={onBack}
                    className="text-[12px] text-text-mute hover:text-text transition-colors"
                >
                    ← back
                </button>
            ) : (
                <Link
                    href="/agent"
                    className="text-[12px] text-text-mute hover:text-text transition-colors"
                >
                    ← cancel
                </Link>
            )}
            {primary ? (
                <button
                    onClick={primary.onClick}
                    disabled={primary.disabled}
                    className="px-5 h-9 border border-accent bg-accent-bg text-accent text-[12.5px] uppercase tracking-[0.18em] hover:bg-accent/15 disabled:opacity-50 transition-colors num"
                >
                    {primary.label} →
                </button>
            ) : (
                <button
                    onClick={onNext}
                    disabled={disabled}
                    className="px-5 h-9 border border-border-strong text-text text-[12.5px] uppercase tracking-[0.18em] hover:bg-bg-hover disabled:opacity-40 transition-colors num"
                >
                    continue →
                </button>
            )}
        </div>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function safeParseUsdc(v: string): bigint | null {
    try {
        const cleaned = v.trim();
        if (!cleaned || Number(cleaned) <= 0) return null;
        return parseUnits(cleaned, 6);
    } catch {
        return null;
    }
}

function cadenceLabel(mins: number): string {
    if (mins < 60) return `every ${mins}m`;
    if (mins < 1440) return `every ${Math.round(mins / 60)}h`;
    return "daily";
}
