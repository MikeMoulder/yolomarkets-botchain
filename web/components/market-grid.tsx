"use client";

import { useEffect, useState } from "react";
import type { PolymarketEvent } from "@/lib/polymarket";
import { useActiveWallet } from "@/lib/use-active-wallet";
import { MarketCard } from "./market-card";
import { NativeMarketCard, type NativeCardModel } from "./native-market-card";
import { useWalletModal } from "./wallet-modal";

/** First page of cards rendered for everyone (also what crawlers see). */
const INITIAL_COUNT = 20;
/** Cards revealed per "Show more" click once the user is signed in. */
const CHUNK = 40;

type Props = {
    /** Native BOT Chain markets, already converted to the serializable card model. */
    native: NativeCardModel[];
    /** Polymarket discovery events — rendered after the native block. */
    events: PolymarketEvent[];
};

/** Client-side catalog grid with progressive reveal. The full dataset arrives
 *  as props (it's already fetched server-side); only `INITIAL_COUNT` cards hit
 *  the DOM up front. "Show more" is gated on a connected wallet — anonymous
 *  visitors get the connect modal instead, and their click is honored
 *  automatically once the wallet lands. */
export function MarketGrid({ native, events }: Props) {
    const total = native.length + events.length;
    const [visible, setVisible] = useState(INITIAL_COUNT);
    const [pendingReveal, setPendingReveal] = useState(false);
    const { isConnected } = useActiveWallet();
    const { openWalletModal } = useWalletModal();

    useEffect(() => {
        if (pendingReveal && isConnected) {
            setPendingReveal(false);
            setVisible((v) => Math.min(v + CHUNK, total));
        }
    }, [pendingReveal, isConnected, total]);

    function onShowMore() {
        if (!isConnected) {
            setPendingReveal(true);
            openWalletModal();
            return;
        }
        setVisible((v) => Math.min(v + CHUNK, total));
    }

    const shownNative = native.slice(0, visible);
    const shownEvents =
        visible > native.length ? events.slice(0, visible - native.length) : [];
    const remaining = Math.max(total - visible, 0);

    return (
        <>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5 sm:gap-3">
                {shownNative.map((m) => (
                    <NativeMarketCard key={m.address} m={m} />
                ))}
                {shownEvents.map((e) => (
                    <MarketCard key={e.id} event={e} />
                ))}
            </div>

            {remaining > 0 && (
                <div className="mt-7 flex flex-col items-center gap-2.5">
                    <button
                        onClick={onShowMore}
                        className="glass-pill inline-flex h-11 items-center gap-2.5 rounded-full border px-6 text-[13px] text-text transition-[transform,filter] hover:brightness-125 active:scale-[0.97]"
                    >
                        {!isConnected && <LockGlyph />}
                        show more markets
                        <span className="num text-[11px] text-text-mute tabular">
                            +{Math.min(CHUNK, remaining)}
                        </span>
                    </button>
                    <span className="num text-[11px] text-text-faint tabular">
                        {isConnected
                            ? `${remaining} more in catalog`
                            : `connect a wallet to browse all ${total} markets`}
                    </span>
                </div>
            )}
        </>
    );
}

function LockGlyph() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 text-text-mute">
            <path
                d="M7 10V8a5 5 0 0 1 10 0v2m-11 0h12a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a1 1 0 0 1 1-1Z"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
        </svg>
    );
}
