import type { MarketSummary } from "@/lib/markets";
import { isFastMarket, getFastMarketImage, sortFastMarketsByDeadline } from "@/lib/fast-markets";
import { toNativeCardModel, type NativeCardModel } from "@/components/native-market-card";
import { adminImageFor, type ImageVersionMap } from "@/lib/market-images";

export type HomeGroup = {
    /** Stable key + the `?cat=` value used by the "see all" link. */
    key: string;
    label: string;
    /** Total markets in this group (may exceed `items.length` when capped). */
    total: number;
    items: NativeCardModel[];
};

export type HomeSections = {
    featured: NativeCardModel[];
    endingSoon: NativeCardModel[];
    groups: HomeGroup[];
};

/** Curated house category. Admin-authored markets tagged with this are
 *  surfaced in their own rail directly under Biggest Movers, ahead of Fast and
 *  every organic category — it is the editorial slot, not an organic bucket. */
export const ARC_SPECIAL_CATEGORY = "BOT Special";

/** Category display order for the grouped browse. Anything unmapped is
 *  appended alphabetically after these, so new admin categories still show. */
export const CATEGORY_ORDER = [
    ARC_SPECIAL_CATEGORY,
    "Crypto",
    "Politics",
    "Sports",
    "Geopolitics",
    "Tech",
    "Macro",
    "Culture",
    "Science",
];

const FEATURED_COUNT = 6;
const ENDING_SOON_COUNT = 8;
const GROUP_PREVIEW_COUNT = 10;

/** Resolve a card image, most specific first: art the admin set explicitly for
 *  this market (Telegram /create), then the fast-market token logo (BTC/ETH/SOL),
 *  then the Polymarket-overlay image fuzzy-matched by question. */
export function imageFor(
    m: MarketSummary,
    overlay: (q: string) => string | null,
    adminImages?: ImageVersionMap,
): string | null {
    const admin = adminImages ? adminImageFor(adminImages, m.address) : null;
    return admin ?? getFastMarketImage(m.question) ?? overlay(m.question);
}

function toCard(
    m: MarketSummary,
    overlay: (q: string) => string | null,
    adminImages?: ImageVersionMap,
): NativeCardModel {
    return toNativeCardModel(m, imageFor(m, overlay, adminImages));
}

/** Turn the active native (BOT Chain-tradeable) markets into a structured home page:
 *  a featured hero set, an "ending soon" rail, and category groups (Fast first,
 *  then by configured order, then the rest by size). Pure + deterministic so it
 *  can run in the server component. */
export function buildHomeSections(
    active: MarketSummary[],
    overlay: (q: string) => string | null,
    adminImages?: ImageVersionMap,
): HomeSections {
    const fast = active.filter(isFastMarket);
    const rest = active.filter((m) => !isFastMarket(m));

    // Featured — the "significant" markets: highest liquidity, then most
    // shares traded, drawn from non-fast markets (fast are uniformly seeded).
    // Falls back to the fast set only if there are no standard markets.
    const featuredPool = rest.length > 0 ? rest : fast;
    const featured = [...featuredPool]
        .sort(
            (a, b) =>
                Number(b.totalLiquidity - a.totalLiquidity) ||
                Number(
                    b.totalSharesYes + b.totalSharesNo - a.totalSharesYes - a.totalSharesNo,
                ),
        )
        .slice(0, FEATURED_COUNT)
        .map((m) => toCard(m, overlay, adminImages));

    // Ending soon — nearest deadline across everything, so the time-pressure
    // rail always has content even when standard markets are sparse.
    const endingSoon = [...active]
        .sort((a, b) => Number(a.deadline - b.deadline))
        .slice(0, ENDING_SOON_COUNT)
        .map((m) => toCard(m, overlay, adminImages));

    // Groups — Arc Special leads (editorial slot, sits right under Biggest
    // Movers), then Fast (the signature product), then organic categories.
    const groups: HomeGroup[] = [];
    const arcSpecial = rest.filter((m) => m.category.trim() === ARC_SPECIAL_CATEGORY);
    const organic = rest.filter((m) => m.category.trim() !== ARC_SPECIAL_CATEGORY);
    if (arcSpecial.length > 0) {
        const sorted = [...arcSpecial].sort((a, b) => Number(a.deadline - b.deadline));
        groups.push({
            key: ARC_SPECIAL_CATEGORY,
            label: ARC_SPECIAL_CATEGORY,
            total: arcSpecial.length,
            items: sorted.slice(0, GROUP_PREVIEW_COUNT).map((m) => toCard(m, overlay, adminImages)),
        });
    }
    if (fast.length > 0) {
        const sorted = sortFastMarketsByDeadline(fast);
        groups.push({
            key: "Fast",
            label: "Fast markets",
            total: fast.length,
            items: sorted.slice(0, GROUP_PREVIEW_COUNT).map((m) => toCard(m, overlay, adminImages)),
        });
    }

    const byCat = new Map<string, MarketSummary[]>();
    for (const m of organic) {
        const cat = m.category.trim() || "Other";
        const bucket = byCat.get(cat);
        if (bucket) bucket.push(m);
        else byCat.set(cat, [m]);
    }

    const orderedCats = [...byCat.keys()].sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a);
        const ib = CATEGORY_ORDER.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        // Both unmapped: bigger buckets first, then alphabetical.
        const sizeDiff = (byCat.get(b)?.length ?? 0) - (byCat.get(a)?.length ?? 0);
        return sizeDiff || a.localeCompare(b);
    });

    for (const cat of orderedCats) {
        const list = byCat.get(cat)!;
        const sorted = [...list].sort((a, b) => Number(a.deadline - b.deadline));
        groups.push({
            key: cat,
            label: cat,
            total: list.length,
            items: sorted.slice(0, GROUP_PREVIEW_COUNT).map((m) => toCard(m, overlay, adminImages)),
        });
    }

    return { featured, endingSoon, groups };
}
