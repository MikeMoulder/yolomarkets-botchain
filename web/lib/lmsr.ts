// Client-side mirror of PredictionMarket's LMSR cost math.
//
// The contract inverts nothing: `previewBuy(outcome, shares)` returns the cost
// of a *given* share count. The bet ticket needs the opposite — "how many
// shares fit in this budget" — which used to be a binary search over dozens of
// sequential `previewBuy` RPC calls and repeatedly tripped the public Arc RPC's
// rate limit. Since the whole cost function is a closed form of three on-chain
// values (`b`, `qYes`, `qNo`), we read those once and evaluate it locally.
//
// Parity with contracts/src/PredictionMarket.sol:
//   C(qY, qN)      = b · ln(exp(qY/b) + exp(qN/b))            (18-dec SD59x18)
//   buy  baseCost  = ceil((C_new − C_old) / 1e12)             (18-dec → 6-dec)
//   sell gross     = floor((C_old − C_new) / 1e12)
//   fee            = floor(amount · protocolFeeBps / 10000)   (protocolFeeBps = 100)
//   buy  cost      = baseCost + fee     (rounded UP,   charged)
//   sell received  = gross    − fee     (rounded DOWN, paid out)
//
// Float64 differs from PRBMath's fixed-point exp/ln by << 1e-6 USDC, and every
// quote is taken with a 2% slippage buffer between the estimate and the on-chain
// `maxCost`, so tiny rounding drift can never turn into a Slippage() revert.

import { Outcome } from "./contracts";

const PROTOCOL_FEE_BPS = 100n; // must match PredictionMarket.protocolFeeBps

/** LMSR cost C(qY, qN) in whole-USDC float units, via the log-sum-exp form to
 *  stay finite even for very lopsided (near-0/near-1) markets. */
function costC(qYes: number, qNo: number, b: number): number {
    const x = qYes / b;
    const y = qNo / b;
    const m = Math.max(x, y);
    return b * (m + Math.log(Math.exp(x - m) + Math.exp(y - m)));
}

/** SD59x18 raw int (18-dec) → whole units float. */
function toFloat(raw: bigint): number {
    return Number(raw) / 1e18;
}

/** 6-dec shares bigint → whole-share float delta (q moves by shares·1e12 on-chain). */
function sharesToFloat(shares: bigint): number {
    return Number(shares) / 1e6;
}

/** Local equivalent of PredictionMarket.priceYes() for a candidate state. */
export function lmsrPriceYes(b: bigint, qYes: bigint, qNo: bigint): number {
    const x = toFloat(qYes) / toFloat(b);
    const y = toFloat(qNo) / toFloat(b);
    const delta = x - y;
    if (delta >= 0) {
        return 1 / (1 + Math.exp(-delta));
    }
    const e = Math.exp(delta);
    return e / (1 + e);
}

function feeOn(amount6: number): number {
    return Math.floor((amount6 * Number(PROTOCOL_FEE_BPS)) / 10_000);
}

/** Local equivalent of `previewBuy` — cost in 6-dec USDC, rounded UP, incl. fee. */
export function lmsrBuyCost(
    b: bigint,
    qYes: bigint,
    qNo: bigint,
    outcome: Outcome,
    shares: bigint,
): bigint {
    if (shares <= 0n || (outcome !== Outcome.Yes && outcome !== Outcome.No)) {
        return 0n;
    }
    const bf = toFloat(b);
    const qy = toFloat(qYes);
    const qn = toFloat(qNo);
    const d = sharesToFloat(shares);

    const c0 = costC(qy, qn, bf);
    const c1 =
        outcome === Outcome.Yes ? costC(qy + d, qn, bf) : costC(qy, qn + d, bf);

    const base6 = Math.ceil((c1 - c0) * 1e6);
    if (base6 <= 0) return 0n;
    return BigInt(base6 + feeOn(base6));
}

/** Local equivalent of `previewSell` — proceeds in 6-dec USDC, rounded DOWN, net of fee. */
export function lmsrSellProceeds(
    b: bigint,
    qYes: bigint,
    qNo: bigint,
    outcome: Outcome,
    shares: bigint,
): bigint {
    if (shares <= 0n || (outcome !== Outcome.Yes && outcome !== Outcome.No)) {
        return 0n;
    }
    const bf = toFloat(b);
    const qy = toFloat(qYes);
    const qn = toFloat(qNo);
    const d = sharesToFloat(shares);

    const c0 = costC(qy, qn, bf);
    const c1 =
        outcome === Outcome.Yes ? costC(qy - d, qn, bf) : costC(qy, qn - d, bf);

    const gross6 = Math.floor((c0 - c1) * 1e6);
    if (gross6 <= 0) return 0n;
    return BigInt(gross6 - feeOn(gross6));
}
