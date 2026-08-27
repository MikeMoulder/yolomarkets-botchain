"use client";

import { useMemo, useState } from "react";
import {
    useAccount,
    useChainId,
    useReadContract,
    useSwitchChain,
    useWaitForTransactionReceipt,
    useWriteContract,
} from "wagmi";
import { erc20Abi, factoryAbi, ADDRESSES } from "@/lib/contracts";
import { arcTestnet } from "@/lib/chain";
import {
    formatCents,
    formatCompactUsd,
    formatTimeUntil,
    shortAddr,
} from "@/lib/format";

export type DeployableEvent = {
    id: string;
    title: string;
    slug: string;
    image: string | null;
    category: string;
    yesPrice: number;
    deltaPct: number;
    volume24h: number;
    endTs: number | null;
    alreadyOnArc: boolean;
};

const DEFAULTS = {
    seedUsdc: 1, // 1 USDC = 1_000_000 micro
    durationDays: 30,
    resolutionTemplate:
        "Resolves YES iff the underlying reference binary market resolves YES per its official resolution criteria.",
};

export function DeployPanel({ events }: { events: DeployableEvent[] }) {
    const { address, isConnected } = useAccount();
    const chainId = useChainId();
    const onArc = chainId === arcTestnet.id;
    const { switchChain } = useSwitchChain();

    const [query, setQuery] = useState("");
    const [seedUsdc, setSeedUsdc] = useState<number>(DEFAULTS.seedUsdc);
    const [days, setDays] = useState<number>(DEFAULTS.durationDays);
    const [selected, setSelected] = useState<DeployableEvent | null>(null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return events;
        return events.filter(
            (e) =>
                e.title.toLowerCase().includes(q) ||
                e.category.toLowerCase().includes(q),
        );
    }, [events, query]);

    // Read admin USDC balance + allowance for the factory
    const { data: balanceRaw } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: !!address && onArc, refetchInterval: 12_000 },
    });
    const { data: allowanceRaw } = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: address ? [address, ADDRESSES.factory] : undefined,
        query: { enabled: !!address && onArc, refetchInterval: 8_000 },
    });

    const balance = balanceRaw ? Number(balanceRaw) / 1e6 : 0;
    const allowance = allowanceRaw ? Number(allowanceRaw) / 1e6 : 0;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
            {/* Catalog list */}
            <section className="border border-border bg-bg-elev rounded-[2px] overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
                    <div className="flex items-baseline gap-3">
                        <span className="section-number text-[11px] tabular">01</span>
                        <span className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                            Catalog · select event
                        </span>
                    </div>
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter events…"
                        className="bg-bg-elev-2/60 border border-border focus:border-accent/60 outline-none px-3 h-8 text-[12px] w-[180px] rounded-sm placeholder:text-text-faint"
                    />
                </div>

                <ul className="divide-y divide-border max-h-[640px] overflow-y-auto">
                    {filtered.map((e) => {
                        const isSel = selected?.id === e.id;
                        return (
                            <li
                                key={e.id}
                                onClick={() => !e.alreadyOnArc && setSelected(e)}
                                className={`group flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                                    isSel
                                        ? "bg-accent/[0.08] border-l-2 border-accent"
                                        : "border-l-2 border-transparent hover:bg-bg-hover/40"
                                } ${e.alreadyOnArc ? "opacity-50 cursor-not-allowed" : ""}`}
                            >
                                <div className="relative w-9 h-9 shrink-0 bg-bg-elev-2 rounded-sm overflow-hidden">
                                    {e.image ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={e.image}
                                            alt=""
                                            loading="lazy"
                                            decoding="async"
                                            referrerPolicy="no-referrer"
                                            className="absolute inset-0 w-full h-full object-cover"
                                        />
                                    ) : (
                                        <div className="absolute inset-0 grid-underlay" />
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 text-[10px] num uppercase tracking-[0.16em] text-text-faint mb-0.5">
                                        <span>{e.category}</span>
                                        {e.alreadyOnArc && (
                                            <span className="text-yes">· on BOT Chain</span>
                                        )}
                                    </div>
                                    <div className="text-[12.5px] text-text truncate">
                                        {e.title}
                                    </div>
                                </div>
                                <div className="flex flex-col items-end gap-0.5 shrink-0">
                                    <span className="num text-[12px] tabular text-text">
                                        {formatCents(e.yesPrice)}
                                    </span>
                                    <span className="text-[9.5px] num tabular text-text-faint">
                                        {formatCompactUsd(e.volume24h)}
                                    </span>
                                </div>
                            </li>
                        );
                    })}
                    {filtered.length === 0 && (
                        <li className="px-4 py-8 text-center text-text-faint text-[12px] num">
                            no events matching “{query}”
                        </li>
                    )}
                </ul>
            </section>

            {/* Deploy form */}
            <aside className="border border-border bg-bg-elev rounded-[2px] flex flex-col">
                <div className="px-4 py-3 border-b border-border flex items-baseline gap-3">
                    <span className="section-number text-[11px] tabular">02</span>
                    <span className="text-[11px] uppercase tracking-[0.22em] text-text-mute num">
                        Deploy to BOT Chain
                    </span>
                </div>

                {!isConnected || !address ? (
                    <div className="p-4 text-[12.5px] text-text-dim">
                        Connect a wallet first. (Top-right of the page.)
                    </div>
                ) : !onArc ? (
                    <div className="p-4 flex flex-col gap-3">
                        <p className="text-[12.5px] text-text-dim">
                            Wrong network. Switch to{" "}
                            <span className="num text-text">Bohr Testnet</span>.
                        </p>
                        <button
                            onClick={() => switchChain({ chainId: arcTestnet.id })}
                            className="h-9 px-3 border border-warn/50 bg-warn/10 hover:bg-warn/20 text-warn text-[12px] num uppercase tracking-[0.18em] transition-colors rounded-sm"
                        >
                            switch to Bohr
                        </button>
                    </div>
                ) : (
                    <DeployForm
                        selected={selected}
                        balance={balance}
                        allowance={allowance}
                        seedUsdc={seedUsdc}
                        setSeedUsdc={setSeedUsdc}
                        days={days}
                        setDays={setDays}
                        onDeployed={() => {
                            setSelected(null);
                        }}
                    />
                )}

                {/* Wallet footer */}
                {isConnected && address && (
                    <div className="mt-auto border-t border-border px-4 py-3 grid grid-cols-2 gap-3 text-[11px]">
                        <div>
                            <div className="text-[9px] uppercase tracking-[0.18em] text-text-faint num mb-0.5">
                                signer
                            </div>
                            <div className="num tabular text-text-dim">
                                {shortAddr(address)}
                            </div>
                        </div>
                        <div>
                            <div className="text-[9px] uppercase tracking-[0.18em] text-text-faint num mb-0.5">
                                bankroll
                            </div>
                            <div className="num tabular text-text">
                                ${balance.toFixed(4)}
                            </div>
                        </div>
                    </div>
                )}
            </aside>
        </div>
    );
}

function DeployForm({
    selected,
    balance,
    allowance,
    seedUsdc,
    setSeedUsdc,
    days,
    setDays,
    onDeployed,
}: {
    selected: DeployableEvent | null;
    balance: number;
    allowance: number;
    seedUsdc: number;
    setSeedUsdc: (n: number) => void;
    days: number;
    setDays: (n: number) => void;
    onDeployed: () => void;
}) {
    const seedMicro = BigInt(Math.round(seedUsdc * 1e6));
    const needsApproval = BigInt(Math.round(allowance * 1e6)) < seedMicro;
    const insufficient = seedUsdc > balance;

    // Approve flow
    const {
        writeContractAsync: writeApprove,
        data: approveTxHash,
        isPending: approvePending,
        reset: resetApprove,
    } = useWriteContract();
    const { isSuccess: approveDone, isLoading: approveMining } =
        useWaitForTransactionReceipt({ hash: approveTxHash });

    // Deploy flow
    const {
        writeContractAsync: writeCreate,
        data: createTxHash,
        isPending: createPending,
        reset: resetCreate,
    } = useWriteContract();
    const { isSuccess: createDone, isLoading: createMining } =
        useWaitForTransactionReceipt({ hash: createTxHash });

    const [error, setError] = useState<string | null>(null);

    async function handleApprove() {
        setError(null);
        try {
            await writeApprove({
                address: ADDRESSES.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [ADDRESSES.factory, seedMicro],
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "approve failed");
        }
    }

    async function handleDeploy() {
        if (!selected) return;
        setError(null);
        try {
            const deadline = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
            await writeCreate({
                address: ADDRESSES.factory,
                abi: factoryAbi,
                functionName: "createMarket",
                args: [
                    selected.title,
                    selected.category,
                    DEFAULTS.resolutionTemplate,
                    deadline,
                    seedMicro,
                ],
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "deploy failed");
        }
    }

    // Reset on success → caller can refresh
    if (createDone) {
        setTimeout(() => {
            resetApprove();
            resetCreate();
            onDeployed();
        }, 1200);
    }

    if (!selected) {
        return (
            <div className="p-5 text-[12.5px] text-text-dim leading-[1.55]">
                Pick an event from the catalog on the left.
                <div className="mt-3 text-text-faint text-[11px]">
                    Tip: filter by category or search to find the market you want to wrap.
                </div>
            </div>
        );
    }

    return (
        <div className="p-4 flex flex-col gap-4">
            {/* Selected event preview */}
            <div className="border border-border-strong bg-bg-elev-2/60 rounded-sm p-3">
                <div className="text-[9px] uppercase tracking-[0.22em] text-text-faint num mb-1">
                    selected
                </div>
                <div className="text-[13px] text-text leading-snug mb-2">
                    {selected.title}
                </div>
                <div className="flex items-center justify-between text-[11px] num">
                    <span className="text-text-mute">{selected.category}</span>
                    <span className="text-text tabular">
                        crowd {formatCents(selected.yesPrice)}
                    </span>
                </div>
            </div>

            {/* Form */}
            <div className="grid grid-cols-2 gap-3">
                <Field label="seed liquidity">
                    <div className="flex items-center bg-bg-elev-2/60 border border-border focus-within:border-accent/60 rounded-sm">
                        <input
                            type="number"
                            step="0.10"
                            min="0.10"
                            value={seedUsdc}
                            onChange={(e) => setSeedUsdc(Number(e.target.value))}
                            className="flex-1 bg-transparent px-2.5 py-1.5 text-[13px] num tabular outline-none w-full"
                        />
                        <span className="text-[10px] num tracking-[0.16em] text-text-mute pr-2">
                            USDT
                        </span>
                    </div>
                </Field>
                <Field label="duration">
                    <div className="flex items-center bg-bg-elev-2/60 border border-border focus-within:border-accent/60 rounded-sm">
                        <input
                            type="number"
                            step="1"
                            min="1"
                            value={days}
                            onChange={(e) => setDays(Number(e.target.value))}
                            className="flex-1 bg-transparent px-2.5 py-1.5 text-[13px] num tabular outline-none w-full"
                        />
                        <span className="text-[10px] num tracking-[0.16em] text-text-mute pr-2">
                            DAYS
                        </span>
                    </div>
                </Field>
            </div>

            {insufficient && (
                <div className="border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-warn rounded-sm">
                    Seed exceeds bankroll. Lower the amount or fund the wallet.
                </div>
            )}

            {/* Action — approve then deploy */}
            <div className="grid grid-cols-2 gap-2">
                <button
                    disabled={!needsApproval || insufficient || approvePending || approveMining}
                    onClick={handleApprove}
                    className={`h-10 border text-[12px] num uppercase tracking-[0.18em] transition-colors rounded-sm ${
                        !needsApproval
                            ? "border-yes/40 bg-yes/10 text-yes cursor-default"
                            : "border-border bg-bg-elev-2 text-text-dim hover:border-border-strong"
                    } disabled:opacity-60`}
                >
                    {!needsApproval
                        ? "1. approved ✓"
                        : approvePending
                            ? "1. signing…"
                            : approveMining
                                ? "1. mining…"
                                : "1. approve USDT"}
                </button>
                <button
                    disabled={
                        needsApproval ||
                        insufficient ||
                        createPending ||
                        createMining ||
                        createDone
                    }
                    onClick={handleDeploy}
                    className={`h-10 border text-[12px] num uppercase tracking-[0.18em] transition-colors rounded-sm ${
                        createDone
                            ? "border-yes/50 bg-yes/15 text-yes"
                            : "border-accent/50 bg-accent/10 text-accent hover:bg-accent/15"
                    } disabled:opacity-50`}
                >
                    {createDone
                        ? "2. deployed ✓"
                        : createPending
                            ? "2. signing…"
                            : createMining
                                ? "2. mining…"
                                : "2. deploy market"}
                </button>
            </div>

            {error && (
                <div className="border border-no/40 bg-no/10 px-3 py-2 text-[11.5px] text-no rounded-sm">
                    {truncate(error, 220)}
                </div>
            )}

            {createTxHash && (
                <div className="text-[11px] num text-text-mute tabular border-t border-border pt-3">
                    tx:{" "}
                    <a
                        href={`https://scan.bohr.life/tx/${createTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:underline"
                    >
                        {createTxHash.slice(0, 10)}…{createTxHash.slice(-6)}
                    </a>
                </div>
            )}

            {selected.endTs && (
                <div className="text-[10.5px] num text-text-faint tabular border-t border-border pt-3">
                    reference market ends in {formatTimeUntil(selected.endTs)}
                </div>
            )}
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[9px] uppercase tracking-[0.2em] text-text-faint num">
                {label}
            </span>
            {children}
        </label>
    );
}

function truncate(s: string, n: number) {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
