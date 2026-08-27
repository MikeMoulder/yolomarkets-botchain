"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConnect } from "wagmi";
import { ArrowGlyph, CloseGlyph, WalletGlyph } from "./wallet-glyphs";

type WalletModalContextValue = {
    openWalletModal: () => void;
    closeWalletModal: () => void;
};

const WalletModalContext = createContext<WalletModalContextValue | null>(null);

export function useWalletModal(): WalletModalContextValue {
    const context = useContext(WalletModalContext);
    if (!context) throw new Error("useWalletModal must be used inside WalletModalProvider");
    return context;
}

export function WalletModalProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const openWalletModal = useCallback(() => setOpen(true), []);
    const closeWalletModal = useCallback(() => setOpen(false), []);

    useEffect(() => setMounted(true), []);
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") closeWalletModal();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [closeWalletModal, open]);

    return (
        <WalletModalContext.Provider value={{ openWalletModal, closeWalletModal }}>
            {children}
            {mounted && open
                ? createPortal(<ConnectWalletModal onClose={closeWalletModal} />, document.body)
                : null}
        </WalletModalContext.Provider>
    );
}

function ConnectWalletModal({ onClose }: { onClose: () => void }) {
    const { connectors, connect, isPending } = useConnect();
    return (
        <div
            className="fixed inset-0 z-[100] grid min-h-dvh place-items-center bg-black/68 px-4 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
            <div className="w-full max-w-[480px] border border-border-strong bg-bg-elev shadow-2xl shadow-black/60">
                <div className="flex items-start justify-between border-b border-border px-5 py-4">
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-text-mute">sign in</div>
                        <h2 className="mt-1 text-[18px] font-semibold text-text">Connect wallet</h2>
                    </div>
                    <button onClick={onClose} className="flex h-8 w-8 items-center justify-center border border-border bg-bg-elev-2 text-text-mute" aria-label="Close wallet modal">
                        <CloseGlyph />
                    </button>
                </div>
                <div className="space-y-2 px-5 py-5">
                    {connectors.map((connector) => (
                        <button
                            key={connector.uid}
                            onClick={() => { connect({ connector }); onClose(); }}
                            disabled={isPending}
                            className="group flex w-full items-center gap-3 border border-border bg-bg-elev-2 px-3 py-3 text-left hover:border-border-bright disabled:opacity-50"
                        >
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-border-strong bg-bg">
                                <WalletGlyph kind={connector.name} size="lg" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-[13px] font-medium text-text">{connector.name}</span>
                                <span className="mt-0.5 block text-[11px] text-text-mute">Connect an external wallet.</span>
                            </span>
                            <ArrowGlyph />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
