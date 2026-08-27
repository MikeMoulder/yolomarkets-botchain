"""YOLO Markets autonomous trading agent — one pass over all live markets.

Pipeline per market:
    1. Read on-chain state (question, category, price, deadline, my position)
    2. Best-effort fuzzy match to a Polymarket Gamma market for a crowd prior
    3. Ask the LLM (Gemini by default, OpenRouter fallback) for a calibrated probability
    4. Compute edge & Kelly fraction (fractional by risk profile)
    5. If edge >= threshold AND confidence high enough, decide buy YES/NO
    6. Paper-trade by default. `--live` actually broadcasts the buy.
    7. Append a structured decision record to decisions.jsonl for the UI

Usage:
    uv run python loop.py                  # paper trade (default)
    uv run python loop.py --live           # broadcast buys on Arc
    uv run python loop.py --risk moderate  # ¼ kelly, ½ kelly, full kelly
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal

from curl_cffi import requests as cffi_requests
from dotenv import load_dotenv
from rich.console import Console
from web3 import Web3
from web3.exceptions import ContractLogicError

# Load .env BEFORE importing local modules — policy.py freezes MODEL_BY_TIER at
# import time based on GEMINI_API_KEY / BRAIN_PROVIDER, so the env must be
# present first or it silently falls back to the OpenRouter model set.
REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

from profiles import (
    AgentProfile,
    is_runnable,
    load_profiles,
    matches_market,
)
from db import insert_decision, assert_schema_compatible
from policy import (
    PortfolioRiskManager,
    PortfolioSnapshot,
    PositionSnapshot,
    entitlements_for_tier,
    policy_for_profile,
    model_for_profile,
    risk_bucket,
    strategy_context,
)
from notifier import notify_decision
from credits import (
    maybe_refill_free_credits,
    ensure_credits_row,
    ensure_subscription_row,
    credit_cost_for_run,
    deduct_credits,
    add_credits,
    can_trade_live,
    get_subscription_tier,
)
from circle_wallets import (
    get_wallet_usdc_balance,
    execute_contract_call,
    transfer_usdc,
    wait_for_transaction,
    compute_protocol_fee,
)
from x402 import (
    settle_reasoning_request,
    x402_payment_requirement,
    x402_pay_to_address,
    x402_reasoning_fee_usdc,
)
import nanopay

console = Console()

# ── Contract addresses & ABIs ──────────────────────────────────────────────
# Canonical v2 factory (role-separated, audit H-1/H-2 hardened) — all new
# markets are created here since the 2026-07-18 migration; this is where the
# agent trades. Overridable via env to track a future factory without a deploy.
FACTORY_V2 = Web3.to_checksum_address(
    os.environ.get("AGENT_FACTORY_ADDRESS", "0x7A31ED6d05D5B2C15f09dFca2bb69Df81f844ACd")
)
# v1 factory, read-only legacy: ~13.8k markets, almost all expired fast rounds.
# We include only its still-live markets (see discover_legacy_live) so the agent
# can trade/claim the handful that haven't resolved without probing the whole
# corpus every tick. Set AGENT_INCLUDE_LEGACY=0 to ignore v1 entirely.
FACTORY_LEGACY = Web3.to_checksum_address(
    os.environ.get("AGENT_FACTORY_LEGACY_ADDRESS", "0x722E79eF3F1Ba1D306033B8e505f29c59c199EBA")
)
USDC = Web3.to_checksum_address(
    os.environ.get("SETTLEMENT_TOKEN_ADDRESS", "0x75edC9335175Fc0552D51D48439F229c10420fe3")
)
MULTICALL3 = Web3.to_checksum_address("0xcA11bde05977b3631167028862bE2a173976CA11")

FACTORY_ABI = [
    {"type": "function", "name": "allMarkets", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address[]"}]},
]
MARKET_ABI = [
    {"type": "function", "name": "question", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "string"}]},
    {"type": "function", "name": "category", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "string"}]},
    {"type": "function", "name": "resolutionCriteria", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "string"}]},
    {"type": "function", "name": "deadline", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "priceYes", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "int256"}]},
    {"type": "function", "name": "totalLiquidity", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "resolved", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "outcome", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint8"}]},
    {"type": "function", "name": "previewBuy", "stateMutability": "view",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "previewSell", "stateMutability": "view",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "buy", "stateMutability": "nonpayable",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "sell", "stateMutability": "nonpayable",
     "inputs": [{"type": "uint8"}, {"type": "uint256"}, {"type": "uint256"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "claim", "stateMutability": "nonpayable",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "sharesYes", "stateMutability": "view",
     "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "sharesNo", "stateMutability": "view",
     "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
]
USDC_ABI = [
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "allowance", "stateMutability": "view",
     "inputs": [{"type": "address"}, {"type": "address"}],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"type": "address"}, {"type": "uint256"}],
     "outputs": [{"type": "bool"}]},
]
MULTICALL3_ABI = [
    {"type": "function", "name": "aggregate3", "stateMutability": "payable",
     "inputs": [{"name": "calls", "type": "tuple[]", "components": [
         {"name": "target", "type": "address"},
         {"name": "allowFailure", "type": "bool"},
         {"name": "callData", "type": "bytes"}]}],
     "outputs": [{"name": "returnData", "type": "tuple[]", "components": [
         {"name": "success", "type": "bool"},
         {"name": "returnData", "type": "bytes"}]}]},
]

SLIPPAGE_BPS = 200            # 2%
MAX_POSITION_FRACTION = 0.30  # never bet more than 30% of bankroll on one market
PROTOCOL_FEE_BUFFER = 0.003
AUTO_FAST_PREFIX = "AUTO_FAST:"
FAST_CATEGORIES = {"fast", "turbo", "speed"}
FAST_SYMBOL_TERMS = ("btc", "bitcoin", "eth", "ethereum", "sol", "solana")
FAST_TIMEFRAME_TERMS = ("15m", "15 min", "15min", "1h", "1 hour", "1hr")
FAST_DIRECTION_TERMS = ("up", "down", "higher", "lower", "above", "below")
# Event-hunting strategies treat any market resolving within this many hours as
# "near deadline" — scanned right after fast markets, ahead of longer-dated ones.
NEAR_DEADLINE_HOURS = 24.0

_LAST_RUN_BY_USER: dict[str, float] = {}
# Fast passes keep their own clock so the cheap short-horizon check is not
# throttled by the expensive full pass's tier cadence.
_LAST_FAST_RUN_BY_USER: dict[str, float] = {}

# Subscription tier changes rarely (only on a checkout/expiry) but the due-check
# reads it for every profile on every runner tick — including profiles that are
# still inside their cadence window and won't run. Cache it briefly so an idle
# tick does no per-user subscription read. A stale tier only delays a freshly
# upgraded user's new entitlements by at most the TTL.
_TIER_CACHE: dict[str, tuple[float, str]] = {}
TIER_CACHE_TTL_S = float(os.environ.get("AGENT_TIER_CACHE_TTL_S", "300"))


def cached_subscription_tier(user_addr: str) -> str:
    now = time.time()
    hit = _TIER_CACHE.get(user_addr)
    if hit is not None and now - hit[0] < TIER_CACHE_TTL_S:
        return hit[1]
    tier = get_subscription_tier(user_addr)
    _TIER_CACHE[user_addr] = (now, tier)
    return tier

DECISIONS_PATH = REPO_ROOT / "agent" / "decisions.jsonl"


# ── Data shapes ────────────────────────────────────────────────────────────
@dataclass
class MarketState:
    address: str
    question: str
    category: str
    resolution_criteria: str
    deadline: int
    price_yes: float        # 0..1
    total_liquidity: float  # USDC
    resolved: bool


@dataclass
class Estimate:
    probability: float
    confidence: float
    reasoning: str
    key_sources: list[str]
    watch_for: list[str]
    time_sensitivity: Literal["low", "medium", "high"]
    polymarket_prob: float | None
    polymarket_slug: str | None


@dataclass
class Decision:
    ts: str
    market: str
    question: str
    category: str
    market_prob: float
    polymarket_prob: float | None
    polymarket_slug: str | None
    ai_prob: float
    ai_confidence: float
    edge_pts: float                     # AI - market, signed
    kelly_fraction: float
    bankroll_usdc: float
    action: Literal["pass", "buy_yes", "buy_no"]
    pass_reason: str | None
    shares: int                          # 6-dec
    cost_usdc: float
    max_cost_usdc: float
    tx_hash: str | None
    paper: bool
    reasoning: str
    watch_for: list[str]
    time_sensitivity: str
    # Phase 4 — when set, this decision was made on behalf of a specific
    # user via their AgentAccount + session key, not the dev demo runner.
    user_addr: str | None = None
    agent_addr: str | None = None
    # Phase 5 — populated only when the Claude tool-use brain produced this
    # decision. Legacy single-shot path leaves these at defaults. The web
    # /agent page renders them so judges can replay the reasoning.
    news_summary: str = ""
    tool_trace: list[dict] = field(default_factory=list)
    brain_model: str | None = None
    brain_iterations: int | None = None
    prompt_hash: str | None = None
    tools_called: list[str] = field(default_factory=list)
    external_odds_snapshot: dict[str, Any] = field(default_factory=dict)
    policy_snapshot: dict[str, Any] = field(default_factory=dict)
    platform_fee_usdc: float = 0.0
    notification_status: str | None = None


# ── Web3 helpers ───────────────────────────────────────────────────────────
def get_rpc_urls() -> list[str]:
    urls: list[str] = []

    # Paid Arc RPC (Circle Nanopayments — Leg B) sits LAST by default: it is the
    # safety net for when every free endpoint is rate-limiting, not the hot path.
    #
    # Measured 2026-08-05 with it primary: a full discovery pass (6,654 markets,
    # incl. the 13,848-address legacy scan) cost 582 paid calls = $0.0582 and
    # took 320s, because every call is a payment round-trip. Free RPCs do the
    # same work in a fraction of that. So: free first for speed, paid to survive
    # the -32011 rate limits that keep breaking reads.
    #
    # `AGENT_NANOPAY_RPC_PRIMARY=1` puts it first — proven to work end to end,
    # and the honest configuration to demo "the agent buys its own infra".
    paid: str | None = None
    try:
        paid = nanopay.paid_rpc_url()
    except Exception:
        paid = None  # a payment rail must never break market reads

    if paid and os.environ.get("AGENT_NANOPAY_RPC_PRIMARY", "0") != "0":
        urls.append(paid)

    for key in ("ARC_TESTNET_RPC_URL", "ARC_TESTNET_RPC_URLS"):
        raw = os.environ.get(key, "")
        urls.extend(part.strip() for part in raw.split(",") if part.strip())

    if paid and os.environ.get("AGENT_NANOPAY_RPC_PRIMARY", "0") == "0":
        urls.append(paid)

    seen: set[str] = set()
    return [url for url in urls if not (url in seen or seen.add(url))]


def get_web3() -> Web3:
    urls = get_rpc_urls()
    if not urls:
        raise RuntimeError("ARC_TESTNET_RPC_URL is not set")

    paid_url = None
    try:
        paid_url = nanopay.paid_rpc_url()
    except Exception:
        pass

    last_error: Exception | None = None
    for url in urls:
        try:
            # The paid endpoint is local but each call is a purchase plus an
            # upstream round-trip, so it needs a longer timeout than a plain RPC.
            kwargs = (
                nanopay.rpc_request_kwargs()
                if paid_url and url == paid_url
                else {"timeout": 10}
            )
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs=kwargs))
            expected_chain_id = int(os.environ.get("BOTCHAIN_CHAIN_ID", "968"))
            if w3.is_connected() and int(w3.eth.chain_id) == expected_chain_id:
                if url != urls[0]:
                    console.print(f"[yellow]Arc RPC fallback active:[/yellow] {url}")
                return w3
        except Exception as e:
            last_error = e

    if last_error:
        console.print(f"[red]Arc RPC check failed:[/red] {last_error}")
    return Web3(Web3.HTTPProvider(urls[-1], request_kwargs={"timeout": 10}))


# ── Multicall3 batch reads ─────────────────────────────────────────────────
# Arc has Multicall3 at the canonical address, so we batch market reads instead
# of doing 7 sequential eth_calls per market (which made a full pass over a few
# thousand markets take many minutes). One `aggregate3` returns hundreds of
# results per round-trip.

# Resolved is a terminal state — once True it never flips back. Cache resolved
# addresses in-memory so subsequent passes don't re-read them. Rebuilt cheaply
# after a process restart.
_RESOLVED_CACHE: set[str] = set()


def _multicall(w3: Web3, calls: list[tuple[str, bytes]], chunk: int = 600) -> list[tuple[bool, bytes]]:
    """aggregate3 the (target, callData) pairs, allowing per-call failure."""
    mc = w3.eth.contract(address=MULTICALL3, abi=MULTICALL3_ABI)
    out: list[tuple[bool, bytes]] = []
    for i in range(0, len(calls), chunk):
        batch = [(t, True, cd) for (t, cd) in calls[i:i + chunk]]
        out.extend(mc.functions.aggregate3(batch).call())
    return out


def _mc_field(
    w3: Web3, addrs: list[str], fn_name: str, out_type: str,
    args: list | None = None, chunk: int = 600,
) -> list:
    """Read one MARKET_ABI view (`fn_name`) across many markets via Multicall3.
    Returns a value per address (None where the call failed/empty)."""
    if not addrs:
        return []
    # Calldata for a given fn+args is identical regardless of target address.
    dummy = w3.eth.contract(abi=MARKET_ABI)
    cd = Web3.to_bytes(hexstr=dummy.encode_abi(fn_name, args=args or []))
    calls = [(Web3.to_checksum_address(a), cd) for a in addrs]
    raw = _multicall(w3, calls, chunk)
    res: list = []
    for success, rd in raw:
        if not success or not rd:
            res.append(None)
            continue
        try:
            res.append(w3.codec.decode([out_type], rd)[0])
        except Exception:
            res.append(None)
    return res


def load_market_states(w3: Web3, addrs: list[str]) -> tuple[list[MarketState], list[str]]:
    """Pre-filter to *active* markets and full-read only those, via Multicall3.

    Returns (active_states, resolved_addrs). A market is active iff it is not
    resolved and its deadline is still in the future — expired-but-unresolved
    markets aren't tradeable, so they're dropped from evaluation (their payouts
    are still handled via claim_resolved_positions once they resolve).
    """
    # Phase 1 — cheap liveness probe (resolved + deadline) for every market not
    # already known-resolved.
    probe = [a for a in addrs if Web3.to_checksum_address(a) not in _RESOLVED_CACHE]
    resolved_list = _mc_field(w3, probe, "resolved", "bool")
    deadline_list = _mc_field(w3, probe, "deadline", "uint256")

    now = int(time.time())
    active_addrs: list[str] = []
    deadlines: dict[str, int] = {}
    for a, rsv, dl in zip(probe, resolved_list, deadline_list):
        ca = Web3.to_checksum_address(a)
        if rsv is True:
            _RESOLVED_CACHE.add(ca)
            continue
        if rsv is None or dl is None:
            continue  # unreadable this pass — skip rather than guess
        if int(dl) <= now:
            continue  # expired, awaiting resolution — not tradeable
        active_addrs.append(ca)
        deadlines[ca] = int(dl)

    resolved_addrs = sorted(_RESOLVED_CACHE)

    # Phase 2 — full read of the (much smaller) active set.
    q = _mc_field(w3, active_addrs, "question", "string")
    cat = _mc_field(w3, active_addrs, "category", "string")
    crit = _mc_field(w3, active_addrs, "resolutionCriteria", "string")
    py = _mc_field(w3, active_addrs, "priceYes", "int256")
    liq = _mc_field(w3, active_addrs, "totalLiquidity", "uint256")

    states: list[MarketState] = []
    for i, ca in enumerate(active_addrs):
        if None in (q[i], cat[i], crit[i], py[i], liq[i]):
            continue
        states.append(MarketState(
            address=ca,
            question=q[i],
            category=cat[i],
            resolution_criteria=crit[i],
            deadline=deadlines[ca],
            price_yes=int(py[i]) / 1e18,
            total_liquidity=int(liq[i]) / 1e6,
            resolved=False,
        ))
    return states, resolved_addrs


def build_portfolio_snapshot(
    w3: Web3,
    *,
    profile: AgentProfile,
    markets: list[MarketState],
    bankroll_usdc: float,
) -> PortfolioSnapshot:
    """Find the agent's open positions among `markets` via a batched read of
    sharesYes/sharesNo(owner) over all of them (Multicall3)."""
    owner = profile.agent_address
    positions: list[PositionSnapshot] = []
    if owner and markets:
        own = Web3.to_checksum_address(owner)
        addrs = [m.address for m in markets]
        yes = _mc_field(w3, addrs, "sharesYes", "uint256", args=[own])
        no = _mc_field(w3, addrs, "sharesNo", "uint256", args=[own])
        for i, m in enumerate(markets):
            y = (yes[i] or 0) / 1e6
            n = (no[i] or 0) / 1e6
            if y <= 0 and n <= 0:
                continue
            positions.append(PositionSnapshot(
                market=m.address,
                question=m.question,
                category=m.category,
                bucket=risk_bucket(m.category, m.question),
                yes_shares=y,
                no_shares=n,
                yes_price=m.price_yes,
            ))
    return PortfolioSnapshot(bankroll_usdc=bankroll_usdc, positions=positions)


def claim_resolved_positions(
    w3: Web3,
    *,
    profile: AgentProfile,
    resolved_addrs: list[str],
    live: bool,
) -> int:
    """Claim winning shares the agent holds in resolved markets (Circle wallets).

    Batches outcome + sharesYes/No(owner) across the resolved set via Multicall3,
    then issues a `claim()` only for the (rare) markets where the agent actually
    holds the winning side.
    """
    if not live or not profile.circle_wallet_id or not profile.agent_address:
        return 0
    if not resolved_addrs:
        return 0

    owner = Web3.to_checksum_address(profile.agent_address)
    outcomes = _mc_field(w3, resolved_addrs, "outcome", "uint8")
    yes = _mc_field(w3, resolved_addrs, "sharesYes", "uint256", args=[owner])
    no = _mc_field(w3, resolved_addrs, "sharesNo", "uint256", args=[owner])

    claimed = 0
    for i, addr in enumerate(resolved_addrs):
        oc = outcomes[i]
        if oc == 1:
            shares = yes[i] or 0
        elif oc == 2:
            shares = no[i] or 0
        else:
            continue
        if shares <= 0:
            continue
        try:
            tx_id = execute_contract_call(
                wallet_id=profile.circle_wallet_id,
                contract_address=addr,
                abi_function_signature="claim()",
                abi_parameters=[],
                idempotency_key=str(uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"claim-{addr}-{int(time.time()) // 3600}",
                )),
            )
            on_chain_hash = wait_for_transaction(tx_id, max_wait=60.0)
            console.print(
                f"  [dim]claimed {shares/1e6:.2f} winning shares "
                f"from {addr[:10]}… tx {on_chain_hash[:14]}…[/dim]"
            )
            claimed += 1
        except Exception as e:  # noqa: BLE001
            console.print(f"  [yellow]claim skipped for {addr[:10]}…: {e}[/yellow]")
    return claimed


# ── Legacy (v1) liveness scan ──────────────────────────────────────────────
# The v1 factory holds ~13.8k markets, almost all expired fast rounds. Probing
# every one each tick is wasteful, so we scan it once (gentle batches; deadlines
# are immutable) and cache only the unexpired-unresolved addresses. Mirrors the
# web catalog's legacy scan (web/lib/markets.ts). Long TTL; AGENT_INCLUDE_LEGACY=0
# skips v1 entirely.
INCLUDE_LEGACY = os.environ.get("AGENT_INCLUDE_LEGACY", "1") != "0"
LEGACY_SCAN_TTL_S = float(os.environ.get("AGENT_LEGACY_SCAN_TTL_S", "3600"))
LEGACY_PROBE_CHUNK = int(os.environ.get("AGENT_LEGACY_PROBE_CHUNK", "150"))
_LEGACY_LIVE_CACHE: dict[str, Any] = {"addrs": None, "scanned_at": 0.0}


def discover_legacy_live(w3: Web3) -> list[str]:
    """Unexpired, unresolved v1 markets only, cached on a long TTL.

    Returns [] when legacy inclusion is disabled or the scan fails (falling back
    to the last good cache if present) — the v2 set is always what matters most.
    """
    if not INCLUDE_LEGACY:
        return []
    now = time.time()
    cached = _LEGACY_LIVE_CACHE["addrs"]
    if cached is not None and now - float(_LEGACY_LIVE_CACHE["scanned_at"]) < LEGACY_SCAN_TTL_S:
        return cached  # type: ignore[return-value]
    try:
        legacy = w3.eth.contract(address=FACTORY_LEGACY, abi=FACTORY_ABI)
        all_v1 = [Web3.to_checksum_address(a) for a in legacy.functions.allMarkets().call()]
    except Exception as e:  # noqa: BLE001
        console.print(f"[dim]legacy factory scan skipped: {e}[/dim]")
        return cached or []
    resolved = _mc_field(w3, all_v1, "resolved", "bool", chunk=LEGACY_PROBE_CHUNK)
    deadline = _mc_field(w3, all_v1, "deadline", "uint256", chunk=LEGACY_PROBE_CHUNK)
    now_ts = int(now)
    live: list[str] = []
    for a, rsv, dl in zip(all_v1, resolved, deadline):
        if rsv is True or rsv is None or dl is None:
            continue  # resolved, or unreadable this pass
        if int(dl) <= now_ts:
            continue  # expired, awaiting resolution — not tradeable
        live.append(a)
    _LEGACY_LIVE_CACHE["addrs"] = live
    _LEGACY_LIVE_CACHE["scanned_at"] = now
    console.print(f"[dim]legacy v1 scan: {len(live)} live of {len(all_v1)}[/dim]")
    return live


def discover_markets(w3: Web3) -> list[str]:
    """All tradeable market addresses: the canonical v2 factory in full, plus
    the still-live markets from the read-only v1 factory (deduped, v2 first).

    Prior to 2026-07-21 this read the v1 factory ONLY — the agent traded against
    legacy markets and never saw any v2 market. Fixed to make v2 canonical.
    """
    v2 = w3.eth.contract(address=FACTORY_V2, abi=FACTORY_ABI).functions.allMarkets().call()
    combined = [Web3.to_checksum_address(a) for a in v2]
    seen = set(combined)
    for a in discover_legacy_live(w3):
        if a not in seen:
            seen.add(a)
            combined.append(a)
    return combined


# The factory's market set changes slowly relative to the runner's tick. Cache
# allMarkets() across passes so a tick where every profile is skipped (or one
# that fires a few minutes after the last) doesn't re-hit the RPC. TTL is short
# enough that newly created markets are picked up within a few minutes.
_MARKETS_CACHE: dict[str, Any] = {"addrs": None, "fetched_at": 0.0}
MARKETS_CACHE_TTL_S = float(os.environ.get("AGENT_MARKETS_CACHE_TTL_S", "300"))


def discover_markets_cached(w3: Web3) -> list[str]:
    now = time.time()
    cached = _MARKETS_CACHE["addrs"]
    if cached is not None and now - float(_MARKETS_CACHE["fetched_at"]) < MARKETS_CACHE_TTL_S:
        return cached  # type: ignore[return-value]
    addrs = discover_markets(w3)
    _MARKETS_CACHE["addrs"] = addrs
    _MARKETS_CACHE["fetched_at"] = now
    return addrs


# ── Polymarket crowd signal ────────────────────────────────────────────────
def polymarket_match(question: str) -> tuple[float | None, str | None]:
    """Fuzzy-match against the top high-volume Polymarket markets.
    Returns (yes_price, slug) if match found, else (None, None)."""
    base = os.environ.get("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com")
    try:
        r = cffi_requests.get(
            f"{base}/markets",
            params={"active": "true", "closed": "false", "limit": "100",
                    "order": "volume24hr", "ascending": "false"},
            impersonate="chrome",
            timeout=20,
        )
        r.raise_for_status()
        markets = r.json()
    except Exception as e:
        console.print(f"[dim]polymarket fetch failed: {e}[/dim]")
        return (None, None)

    q_lower = question.lower()
    best_ratio = 0.0
    best_market = None
    for m in markets:
        if not m.get("question") or not m.get("outcomePrices"):
            continue
        ratio = SequenceMatcher(None, q_lower, m["question"].lower()).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_market = m

    if best_market is None or best_ratio < 0.55:
        return (None, None)

    try:
        prices = best_market["outcomePrices"]
        if isinstance(prices, str):
            prices = json.loads(prices)
        return (float(prices[0]), best_market.get("slug"))
    except (json.JSONDecodeError, IndexError, ValueError, TypeError):
        return (None, None)


# ── (legacy single-shot `llm_estimate` retired 2026-07-21 — brain.py is the
#     sole probability estimator now; see `_pick_estimate`. `polymarket_match`
#     above stays: brain.py's fetch_polymarket_odds tool uses it.) ───────────


# ── Kelly sizing ───────────────────────────────────────────────────────────
def kelly_fraction(p: float, price: float) -> float:
    """Fraction of bankroll to bet at price `price` if true prob is `p`.
    Standard binary Kelly: f* = p - (1-p) * price / (1 - price)
    Simplifies to: f* = (p - price) / (1 - price)
    Returns 0 if negative EV.
    """
    if price >= 0.99 or price <= 0.01:
        return 0.0
    f = (p - price) / (1.0 - price)
    return max(0.0, f)


# ── Decision logic ─────────────────────────────────────────────────────────
def decide(m: MarketState, est: Estimate, bankroll_usdc: float,
           risk: dict) -> Decision:
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    edge_pts = (est.probability - m.price_yes) * 100  # signed YES-side edge

    base = dict(
        ts=now_iso, market=m.address, question=m.question, category=m.category,
        market_prob=m.price_yes, polymarket_prob=est.polymarket_prob,
        polymarket_slug=est.polymarket_slug, ai_prob=est.probability,
        ai_confidence=est.confidence, edge_pts=edge_pts,
        bankroll_usdc=bankroll_usdc, reasoning=est.reasoning,
        watch_for=est.watch_for, time_sensitivity=est.time_sensitivity,
    )

    def make_pass(reason: str) -> Decision:
        return Decision(**base, kelly_fraction=0.0, action="pass",
                        pass_reason=reason, shares=0, cost_usdc=0.0,
                        max_cost_usdc=0.0, tx_hash=None, paper=True)

    if m.resolved:
        return make_pass("market already resolved")
    if est.confidence < risk["min_confidence"]:
        return make_pass(f"confidence {est.confidence:.0%} < {risk['min_confidence']:.0%}")

    abs_edge = abs(est.probability - m.price_yes)
    fee_buffer = PROTOCOL_FEE_BUFFER + float(risk.get("slippage_buffer_bps", 0)) / 10_000
    uncertainty_buffer = (1.0 - est.confidence) * float(
        risk.get("uncertainty_buffer_mult", 0.0)
    )
    required_edge = (
        risk["edge_threshold"]
        + fee_buffer
        + float(risk.get("extra_edge_buffer", 0.0))
        + uncertainty_buffer
    )
    if abs_edge < required_edge:
        return make_pass(
            "net edge "
            f"{abs_edge*100:.1f}pt < required {required_edge*100:.1f}pt "
            f"(fees/slippage/uncertainty included)"
        )

    # Pick a side
    if est.probability > m.price_yes:
        side_name = "buy_yes"
        side_id = 1
        side_price = m.price_yes
        p = est.probability
    else:
        side_name = "buy_no"
        side_id = 2
        side_price = 1 - m.price_yes
        p = 1 - est.probability

    f_star = kelly_fraction(p, side_price) * risk["kelly_mult"]
    f_capped = min(f_star, MAX_POSITION_FRACTION)
    bet_usd = f_capped * bankroll_usdc

    if bet_usd < 0.10:  # below $0.10, not worth the gas
        return Decision(**base, kelly_fraction=f_star, action="pass",
                        pass_reason="bet size < $0.10", shares=0,
                        cost_usdc=0.0, max_cost_usdc=0.0, tx_hash=None,
                        paper=True)

    shares = int(bet_usd / side_price * 1e6)  # 6-dec
    return Decision(**base, kelly_fraction=f_star, action=side_name,  # type: ignore[arg-type]
                    pass_reason=None, shares=shares, cost_usdc=bet_usd,
                    max_cost_usdc=0.0, tx_hash=None, paper=True)


def apply_contract_preview_pricing(w3: Web3, m: MarketState, decision: Decision) -> None:
    """Use the LMSR contract preview as the source of truth before risk gates.

    `decide()` sizes from spot odds, which is intentionally cheap and fast.
    The AMM curve can make the real cost higher for larger orders, so this
    function shrinks shares to fit the intended spend and records the actual
    preview cost even for paper decisions.
    """
    if decision.action not in ("buy_yes", "buy_no") or decision.shares <= 0:
        return
    side_id = 1 if decision.action == "buy_yes" else 2
    market_contract = w3.eth.contract(
        address=Web3.to_checksum_address(m.address), abi=MARKET_ABI
    )
    target_usdc = max(float(decision.cost_usdc), 0.0)
    preview = int(market_contract.functions.previewBuy(side_id, decision.shares).call())
    preview_usdc = preview / 1e6

    if target_usdc > 0 and preview_usdc > target_usdc:
        ratio = max(0.0, min(1.0, target_usdc / preview_usdc))
        decision.shares = int(decision.shares * ratio)
        if decision.shares <= 0:
            decision.action = "pass"
            decision.pass_reason = "contract preview reduced shares to zero"
            decision.cost_usdc = 0.0
            decision.max_cost_usdc = 0.0
            return
        preview = int(market_contract.functions.previewBuy(side_id, decision.shares).call())
        preview_usdc = preview / 1e6

    max_cost = preview * (10_000 + SLIPPAGE_BPS) // 10_000
    decision.cost_usdc = preview_usdc
    decision.max_cost_usdc = max_cost / 1e6


def policy_pass(
    m: MarketState,
    *,
    bankroll_usdc: float,
    reason: str,
    user_addr: str | None,
    agent_addr: str | None,
    policy_snapshot: dict[str, Any],
) -> Decision:
    return Decision(
        ts=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        market=m.address,
        question=m.question,
        category=m.category,
        market_prob=m.price_yes,
        polymarket_prob=None,
        polymarket_slug=None,
        ai_prob=m.price_yes,
        ai_confidence=0.0,
        edge_pts=0.0,
        kelly_fraction=0.0,
        bankroll_usdc=bankroll_usdc,
        action="pass",
        pass_reason=reason,
        shares=0,
        cost_usdc=0.0,
        max_cost_usdc=0.0,
        tx_hash=None,
        paper=True,
        reasoning=f"Policy gate passed before model spend: {reason}.",
        watch_for=[],
        time_sensitivity="low",
        user_addr=user_addr,
        agent_addr=agent_addr,
        policy_snapshot=policy_snapshot,
    )


def x402_live_preflight_reason(profile: AgentProfile, *, live: bool) -> str | None:
    """Return a profile-level reason why paid live reasoning cannot run."""
    if not live:
        return None
    try:
        fee_usdc = x402_reasoning_fee_usdc()
    except Exception as e:  # noqa: BLE001
        return str(e)
    if fee_usdc <= 0:
        return None
    if not x402_pay_to_address():
        return "x402 pay-to address is not configured"
    if not profile.circle_wallet_id:
        return (
            "x402 reasoning fee "
            f"${fee_usdc:.2f} requires a Circle agent wallet "
            "(profile.circle_wallet_id is empty; set one or set "
            "AGENT_X402_REASONING_FEE_USDC=0 for legacy session-key profiles)"
        )
    return None


def is_fast_market_state(m: MarketState) -> bool:
    if m.category.strip().lower() in FAST_CATEGORIES:
        return True
    first_criteria_line = (m.resolution_criteria or "").split("\n", 1)[0].strip()
    if first_criteria_line.startswith(AUTO_FAST_PREFIX):
        return True
    question = m.question.lower()
    return (
        any(term in question for term in FAST_SYMBOL_TERMS)
        and any(term in question for term in FAST_TIMEFRAME_TERMS)
        and any(term in question for term in FAST_DIRECTION_TERMS)
    )


def market_priority_rank(m: MarketState, now_ts: int) -> tuple[int, float]:
    """Event-hunting priority tier for one market (lower sorts first):
        0 — fast market (short-window BTC/ETH/SOL round)
        1 — near deadline (resolves within NEAR_DEADLINE_HOURS)
        2 — everything longer-dated
    Within each tier, soonest-resolving markets come first. Far markets aren't
    dropped — they just queue behind fast + near-deadline ones, so they only
    reach the (capped) AI budget once the higher-priority work is scanned.
    """
    if is_fast_market_state(m):
        return (0, float(m.deadline))
    tte_hours = (m.deadline - now_ts) / 3600.0
    if tte_hours <= NEAR_DEADLINE_HOURS:
        return (1, float(m.deadline))
    return (2, float(m.deadline))


def prefers_short_timeframes(profile: AgentProfile, policy) -> bool:
    """True when this profile is configured to trade on short horizons.

    Originally this was two hardcoded names, which meant a user who explicitly
    configured a short-horizon strategy still had fast markets buried behind
    thousands of long-dated ones. Now the profile's own settings decide:
    an upper time-to-expiry bound inside `AGENT_SHORT_TF_HOURS`, or a scan
    cadence fast enough that it is plainly meant for short rounds.
    """
    if profile.pattern == "event_hunter" or policy.preset == "news_trader":
        return True
    short_tf_hours = float(os.environ.get("AGENT_SHORT_TF_HOURS", "6"))
    if profile.max_tte_hours is not None and profile.max_tte_hours <= short_tf_hours:
        return True
    short_cadence = int(os.environ.get("AGENT_SHORT_TF_CADENCE_MIN", "30"))
    return profile.cadence_minutes <= short_cadence


def prioritize_markets_for_profile(
    markets: list[MarketState],
    profile: AgentProfile,
    policy,
) -> list[MarketState]:
    """Short-horizon strategies spend scarce scan slots on fast markets first,
    then markets close to resolution, then everything else."""
    if not prefers_short_timeframes(profile, policy):
        return markets

    now_ts = int(time.time())
    return sorted(markets, key=lambda m: market_priority_rank(m, now_ts))


# ── On-chain execution ─────────────────────────────────────────────────────
# All trade execution goes through Circle Developer-Controlled wallets — see the
# Circle branch in run_for_user(). USDC approve + buy() are submitted via the
# Circle Wallets API (circle_wallets.execute_contract_call).


# ── Logging ────────────────────────────────────────────────────────────────
def append_decision(d: Decision) -> None:
    """Persist a decision to Postgres (agent_decisions). On DB failure,
    fall back to the legacy JSONL file so we don't drop the call entirely
    (file lives at agent/decisions.jsonl, kept for emergency dump only)."""
    try:
        insert_decision(d)
    except Exception as e:
        console.print(f"[red]DB write failed, falling back to JSONL: {e}[/red]")
        DECISIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with DECISIONS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(d)) + "\n")


def drain_pending_jsonl() -> None:
    """If a previous run left rows in decisions.jsonl (DB was unreachable),
    push them into Postgres now and truncate the file. Idempotent — failures
    leave the JSONL intact so we can retry next startup."""
    if not DECISIONS_PATH.exists():
        return
    try:
        lines = DECISIONS_PATH.read_text(encoding="utf-8").splitlines()
    except Exception as e:
        console.print(f"[dim]jsonl drain: read failed: {e}[/dim]")
        return
    pending = [ln for ln in lines if ln.strip()]
    if not pending:
        return

    console.print(f"[dim]draining {len(pending)} pending decision(s) from jsonl…[/dim]")
    drained = 0
    leftovers: list[str] = []
    for ln in pending:
        try:
            row = json.loads(ln)
            insert_decision(row)
            drained += 1
        except Exception as e:
            console.print(f"[red]jsonl drain: row failed ({e}), keeping[/red]")
            leftovers.append(ln)

    # Rewrite (or unlink) so we don't re-import what we just drained.
    try:
        if leftovers:
            DECISIONS_PATH.write_text("\n".join(leftovers) + "\n", encoding="utf-8")
        else:
            DECISIONS_PATH.unlink(missing_ok=True)
        console.print(f"[dim]jsonl drain: {drained} imported, {len(leftovers)} kept[/dim]")
    except Exception as e:
        console.print(f"[red]jsonl drain: cleanup failed: {e}[/red]")


def render(d: Decision) -> None:
    short = d.market[:10] + "…"
    color = {
        "buy_yes": "yes",  # we'll map at print time
        "buy_no": "no",
        "pass": "dim",
    }[d.action]

    if d.action == "pass":
        console.print(
            f"  [{color}]pass[/]  {short}  edge {d.edge_pts:+.1f}pt  "
            f"conf {d.ai_confidence:.0%}  [dim]({d.pass_reason})[/dim]"
        )
    else:
        side = "YES" if d.action == "buy_yes" else "NO"
        side_color = "green" if d.action == "buy_yes" else "red"
        console.print(
            f"  [bold {side_color}]{side}[/]   {short}  "
            f"shares={d.shares/1e6:.2f}  cost≈${d.cost_usdc:.2f}  "
            f"edge {d.edge_pts:+.1f}pt  conf {d.ai_confidence:.0%}"
            f"  [dim]{('tx ' + d.tx_hash[:14] + '…') if d.tx_hash else '(paper)'}[/dim]"
        )


# ── Estimate dispatcher (Phase 5) ──────────────────────────────────────────
def _pick_estimate(
    m: MarketState,
    profile: AgentProfile,
    bankroll_usdc: float,
    policy,
    tier: str,
    allowed_tools: tuple[str, ...],
) -> tuple["Estimate | None", "Any"]:
    """Pick the best available probability estimator for this market.

    Uses the multi-step tool-use brain (agent/brain.py, OpenRouter) — the
    path judges replay via the /agent page tool trace. Requires a provider key
    (OPENROUTER_API_KEY, or GEMINI_API_KEY for the fallback provider); returns
    (None, None) when none is configured or the brain can't run, so the caller
    skips the market. Honours BRAIN_MODEL (orchestrator) and BRAIN_SEARCH_MODEL
    (web-search delegate).

    Returns (estimate, brain_result_or_none). brain_result_or_none is the
    full BrainResult when the brain ran, so the caller can copy tool_trace
    and news_summary into the Decision.
    """
    # Fast markets are priced, not forecast. The brain has never returned
    # anything but 0.50/0.10 on them — the honest answer to "predict a
    # 15-minute candle" — so the agent never traded one. Everything needed is
    # observable instead: the start price is in the market's own metadata, spot
    # is an API call, and the time left is arithmetic. Measure it.
    #
    # This runs BEFORE the brain deliberately: it is more accurate here, it is
    # free, and it does not consume the (scarce) model quota.
    if os.environ.get("AGENT_FAST_SIGNAL", "1") != "0":
        try:
            from fast_signal import estimate_fast_market

            fe = estimate_fast_market(
                resolution_criteria=m.resolution_criteria,
                deadline_unix=m.deadline,
            )
        except Exception as e:  # noqa: BLE001
            console.print(f"  [yellow]fast signal unavailable: {e}[/yellow]")
            fe = None
        if fe is not None:
            return (
                Estimate(
                    probability=fe.prob_yes,
                    confidence=fe.confidence,
                    reasoning=fe.rationale,
                    key_sources=["binance:spot", "binance:klines-1m"],
                    watch_for=[],
                    time_sensitivity="high",
                    polymarket_prob=None,
                    polymarket_slug=None,
                ),
                None,
            )

    if not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("GEMINI_API_KEY")):
        return (None, None)
    try:
        from brain import estimate as brain_estimate
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]brain import failed: {e} — skipping market[/red]")
        return (None, None)

    br = brain_estimate(
        question=m.question,
        category=m.category,
        resolution_criteria=m.resolution_criteria,
        deadline_unix=m.deadline,
        amm_yes_price=m.price_yes,
        bankroll_usdc=bankroll_usdc,
        kelly_mult=policy.kelly_mult,
        strategy_context=strategy_context(profile, policy),
        model=model_for_profile(profile, tier),
        allowed_tools=allowed_tools,
    )
    if br is None:
        return (None, None)
    est = Estimate(
        probability=br.probability,
        confidence=br.confidence,
        reasoning=br.reasoning,
        key_sources=br.key_sources,
        watch_for=br.watch_for,
        time_sensitivity=br.time_sensitivity,
        polymarket_prob=br.polymarket_prob,
        polymarket_slug=br.polymarket_slug,
    )
    return (est, br)


# ── Per-user runner (Phase 4) ──────────────────────────────────────────────
def run_for_user(
    w3: Web3,
    profile: AgentProfile,
    addrs: list[str],
    *,
    live: bool,
    fast_only: bool = False,
) -> list[Decision]:
    """One pass over the user's in-scope markets, executing buys via the
    user's Circle Developer-Controlled wallet when the runner is in --live mode."""
    try:
        ensure_subscription_row(profile.user_addr)
        ensure_credits_row(profile.user_addr)
    except Exception as _e:
        console.print(f"  [dim]account economics setup skipped: {_e}[/dim]")

    # Refill the daily included scan quota if the refill date has passed.
    try:
        maybe_refill_free_credits(profile.user_addr)
    except Exception as _e:
        console.print(f"  [dim]credit refill skipped: {_e}[/dim]")

    tier = get_subscription_tier(profile.user_addr)
    entitlements = entitlements_for_tier(tier)
    policy = policy_for_profile(profile)
    risk = {
        "kelly_mult": policy.kelly_mult,
        "edge_threshold": policy.edge_threshold,
        "min_confidence": policy.min_confidence,
        "extra_edge_buffer": entitlements.extra_edge_buffer,
        "uncertainty_buffer_mult": entitlements.uncertainty_buffer_mult,
        "slippage_buffer_bps": entitlements.slippage_buffer_bps,
    }

    # Bankroll: USDC in the user's Circle wallet, via the Circle Wallets API.
    bankroll = get_wallet_usdc_balance(profile.circle_wallet_id)
    agent_label = profile.agent_address[:10] + "…" if profile.agent_address else "(circle)"

    console.print(
        f"[bold cyan]· user[/bold cyan] {profile.user_addr[:10]}…  "
        f"agent={agent_label}  "
        f"tier={tier}  model={model_for_profile(profile, tier)}  "
        f"preset={policy.preset}  bankroll=${bankroll:.4f}"
    )

    out: list[Decision] = []
    x402_preflight = x402_live_preflight_reason(profile, live=live)
    if x402_preflight:
        console.print(f"  [yellow]skip live reasoning: {x402_preflight}[/yellow]")
        return out

    states, resolved_addrs = load_market_states(w3, addrs)
    if fast_only:
        # The fast pass exists to catch short rounds inside their decisive
        # final minutes, which a 4-hour cadence structurally cannot. It is
        # cheap precisely because it looks at ~6 markets and needs no model
        # call — fast_signal prices these from spot vs. the embedded start
        # price. Keep it that way: no planner, no brain, no long-dated work.
        states = [m for m in states if is_fast_market_state(m)]
    console.print(
        f"  [dim]{len(states)} active markets "
        f"({len(resolved_addrs)} resolved skipped)"
        f"{' · fast-only pass' if fast_only else ''}[/dim]"
    )

    if claim_resolved_positions(
        w3, profile=profile, resolved_addrs=resolved_addrs, live=live
    ):
        if profile.circle_wallet_id:
            bankroll = get_wallet_usdc_balance(profile.circle_wallet_id)
            console.print(f"  [dim]bankroll after claims: ${bankroll:.4f}[/dim]")

    if profile.pattern == "event_hunter" or policy.preset == "news_trader":
        now_ts = int(time.time())
        fast_count = sum(1 for m in states if is_fast_market_state(m))
        near_count = sum(
            1
            for m in states
            if not is_fast_market_state(m)
            and (m.deadline - now_ts) / 3600.0 <= NEAR_DEADLINE_HOURS
        )
        far_count = len(states) - fast_count - near_count
        states = prioritize_markets_for_profile(states, profile, policy)
        console.print(
            f"  [dim]event hunter priority: {fast_count} fast → "
            f"{near_count} near-deadline (≤{NEAR_DEADLINE_HOURS:.0f}h) → "
            f"{far_count} longer-dated[/dim]"
        )

    portfolio = build_portfolio_snapshot(
        w3,
        profile=profile,
        markets=states,
        bankroll_usdc=bankroll,
    )
    day_start = int(time.time()) - 86400
    try:
        from db import user_spent_since, user_traded_markets_since
        from db import user_live_trade_count_since, user_brain_run_count_since

        spent_day = user_spent_since(profile.user_addr, day_start)
        live_trades_today = user_live_trade_count_since(profile.user_addr, day_start)
        brain_runs_today = user_brain_run_count_since(profile.user_addr, day_start)
        recent_markets = user_traded_markets_since(
            profile.user_addr,
            int(time.time()) - policy.repeat_cooldown_hours * 3600,
        )
    except Exception as e:  # noqa: BLE001
        # Fail CLOSED on risk-context load failure. Without today's spend,
        # trade/brain counts, and the recent-market set we cannot enforce the
        # daily spend cap, live-trade cap, or repeat cooldown — so trading now
        # would silently bypass those limits (and the DB hiccup that broke this
        # read, e.g. Neon dropping the connection, is exactly when that's most
        # dangerous). In live mode, skip this user's pass entirely. Paper mode
        # moves no money, so fall back to zeros to keep scan visibility.
        console.print(f"  [yellow]policy DB context unavailable: {e}[/yellow]")
        if live:
            console.print(
                "  [red]skipping live pass for this user — refusing to trade "
                "without risk context[/red]"
            )
            return out
        spent_day = 0.0
        live_trades_today = 0
        brain_runs_today = 0
        recent_markets = set()

    risk_manager = PortfolioRiskManager(
        profile=profile,
        policy=policy,
        entitlements=entitlements,
        portfolio=portfolio,
        spent_day_usdc=spent_day,
        live_trades_today=live_trades_today,
        brain_runs_today=brain_runs_today,
        recent_markets=recent_markets,
    )

    # ── Agent v2 planner (opt-in via AGENT_PLANNER=1) ──────────────────────
    # Reviews theses + portfolio + the prioritized shortlist, updates memory,
    # and narrows the (paid) scoring pass to the markets worth a deep look.
    # Fail-safe: any planner error leaves `states` untouched, so the existing
    # deterministic scan still runs.
    agent_ctx = None
    if os.environ.get("AGENT_PLANNER", "0") != "0" and states and not fast_only:
        try:
            from agent_core import plan_pass
            from tools import ToolContext

            agent_ctx = ToolContext(
                user_addr=profile.user_addr,
                trigger="autonomous",
                profile=profile,
                policy=policy,
                entitlements=entitlements,
                risk_manager=risk_manager,
                portfolio=portfolio,
                markets=list(states),
                bankroll_usdc=bankroll,
                tier=tier,
                live=live,
            )
            plan = plan_pass(
                agent_ctx, shortlist=states, model=model_for_profile(profile, tier)
            )
            if plan.deep_dive:
                order = {a.lower(): i for i, a in enumerate(plan.deep_dive)}
                chosen = sorted(
                    (m for m in states if m.address.lower() in order),
                    key=lambda m: order[m.address.lower()],
                )
                console.print(
                    f"  [dim]planner selected {len(chosen)}/{len(states)} "
                    f"market(s) to deep-dive[/dim]"
                )
                states = chosen
        except Exception as e:  # noqa: BLE001
            console.print(f"  [yellow]planner skipped: {e}[/yellow]")

    # ── Concurrent pre-scoring ─────────────────────────────────────────────
    # The brain call is the slow part of a pass (network-bound, seconds each).
    # We run it for the filter-passing candidates concurrently, then the serial
    # loop below consumes the cached estimates. ONLY the read-only scoring is
    # parallel — every risk-gate mutation, x402 fee, credit debit, and Circle
    # execution stays in the single serial loop, so budget accounting and the
    # agent wallet's tx ordering are never raced. AGENT_SCORE_CONCURRENCY=1
    # disables it (identical to the old inline behavior).
    prescored: dict[str, tuple] = {}
    concurrency = int(os.environ.get("AGENT_SCORE_CONCURRENCY", "4"))
    if concurrency > 1 and states:
        # Cap by the remaining daily brain budget so we never score more than the
        # tier allows, and by a per-run ceiling so a huge unplanned scope can't
        # fan out unbounded. Candidates replicate the loop's pre-brain filters so
        # we don't pay for a scoring call the loop would have skipped.
        budget_left = max(0, entitlements.max_brain_runs_per_day - brain_runs_today)
        max_scored = int(os.environ.get("AGENT_MAX_SCORED_PER_RUN", "6"))
        cap = min(max_scored, budget_left)
        candidates: list[MarketState] = []
        now_ts0 = int(time.time())
        for m in states:
            if len(candidates) >= cap:
                break
            if m.resolved:
                continue
            if not matches_market(profile, m.address, m.category):
                continue
            if m.total_liquidity < profile.min_liquidity_usdc:
                continue
            tte_h = (m.deadline - now_ts0) / 3600.0
            if tte_h <= 0:
                continue
            if profile.min_tte_hours is not None and tte_h < profile.min_tte_hours:
                continue
            if profile.max_tte_hours is not None and tte_h > profile.max_tte_hours:
                continue
            if not (profile.odds_range_min <= m.price_yes <= profile.odds_range_max):
                continue
            if risk_manager.pre_market_pass_reason(m) is not None:
                continue
            candidates.append(m)
        if candidates:
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=min(concurrency, len(candidates))) as ex:
                futures = {
                    ex.submit(
                        _pick_estimate, m, profile, bankroll, policy, tier,
                        entitlements.allowed_tools,
                    ): m
                    for m in candidates
                }
                for fut, m in futures.items():
                    try:
                        prescored[m.address] = fut.result()
                    except Exception as e:  # noqa: BLE001
                        console.print(
                            f"  [dim]pre-score failed for {m.address[:10]}…: {e}[/dim]"
                        )
            console.print(
                f"  [dim]pre-scored {len(prescored)} of {len(candidates)} "
                f"candidate(s) concurrently (x{concurrency})[/dim]"
            )

    for idx, m in enumerate(states):

        if m.resolved:
            continue

        # Early exit: once this run can't place another buy (per-run trade cap
        # or tier daily cap reached), stop scanning. Continuing would pay an
        # x402 reasoning fee + burn a brain-budget slot on every remaining
        # market only to pass it with "max trades per run reached". Markets are
        # ordered best-first, so the skipped tail is the lowest-priority work.
        halt = risk_manager.trading_halted_for_run()
        if not halt.allowed:
            skipped = len(states) - idx
            console.print(
                f"  [dim]{halt.reason} — stopping scan early, {skipped} "
                "lower-priority market(s) skipped (no brain/x402 spend)[/dim]"
            )
            break

        if not matches_market(profile, m.address, m.category):
            continue

        # ── Market filters (from profile config) ─────────────────────────
        if m.total_liquidity < profile.min_liquidity_usdc:
            continue
        now_ts = int(time.time())
        tte_hours = (m.deadline - now_ts) / 3600.0
        if tte_hours <= 0:
            continue  # expired, awaiting resolution — never trade (defensive)
        if profile.min_tte_hours is not None and tte_hours < profile.min_tte_hours:
            continue
        if profile.max_tte_hours is not None and tte_hours > profile.max_tte_hours:
            continue
        if not (profile.odds_range_min <= m.price_yes <= profile.odds_range_max):
            continue

        base_policy_snapshot = {
            **risk_manager.snapshot(),
            "risk_bucket": risk_bucket(m.category, m.question),
        }
        pre_pass = risk_manager.pre_market_pass_reason(m)
        if pre_pass:
            decision = policy_pass(
                m,
                bankroll_usdc=bankroll,
                reason=pre_pass,
                user_addr=profile.user_addr,
                agent_addr=profile.agent_address,
                policy_snapshot=base_policy_snapshot,
            )
            decision.notification_status = notify_decision(profile.user_addr, decision)
            append_decision(decision)
            render(decision)
            out.append(decision)
            continue

        brain_gate = risk_manager.can_spend_brain_call()
        if not brain_gate.allowed:
            decision = policy_pass(
                m,
                bankroll_usdc=bankroll,
                reason=brain_gate.reason or "AI scan budget exhausted",
                user_addr=profile.user_addr,
                agent_addr=profile.agent_address,
                policy_snapshot=base_policy_snapshot,
            )
            decision.notification_status = notify_decision(profile.user_addr, decision)
            append_decision(decision)
            render(decision)
            out.append(decision)
            continue

        # Run the brain FIRST so a failed/empty estimate costs nothing. Only a
        # successful reasoning call consumes the scan credit, x402 fee, and
        # brain-budget slot. (Previously the fee was paid and credits debited
        # before the call, so a model error — e.g. a provider 404 — silently
        # bled USDC + quota on every market scanned.)
        # Prefer the concurrently pre-scored estimate; fall back to an inline
        # call for anything not prefetched (e.g. beyond the pre-score cap).
        cached = prescored.pop(m.address, None)
        if cached is not None:
            est, brain_result = cached
        else:
            est, brain_result = _pick_estimate(
                m,
                profile,
                bankroll,
                policy,
                tier,
                entitlements.allowed_tools,
            )
        if est is None:
            continue

        # Estimate succeeded — the brain actually ran, so meter it now.
        risk_manager.reserve_brain_call()

        credit_cost = 0
        credits_debited = False
        if live:
            credit_cost = credit_cost_for_run(entitlements.model_tier)
            if not deduct_credits(profile.user_addr, credit_cost):
                decision = policy_pass(
                    m,
                    bankroll_usdc=bankroll,
                    reason=f"insufficient AI credits for scan (need {credit_cost})",
                    user_addr=profile.user_addr,
                    agent_addr=profile.agent_address,
                    policy_snapshot=base_policy_snapshot,
                )
                decision.notification_status = notify_decision(profile.user_addr, decision)
                append_decision(decision)
                render(decision)
                out.append(decision)
                continue
            credits_debited = True

        x402_receipt = None
        if live:
            x402_fee_usdc = x402_reasoning_fee_usdc()
            model_name = model_for_profile(profile, tier)
            if bankroll < x402_fee_usdc:
                if credits_debited and credit_cost > 0:
                    add_credits(profile.user_addr, credit_cost)
                requirement = x402_payment_requirement(
                    user_addr=profile.user_addr,
                    market_addr=m.address,
                    model=model_name,
                )
                decision = policy_pass(
                    m,
                    bankroll_usdc=bankroll,
                    reason=(
                        f"insufficient USDC for x402 reasoning fee "
                        f"(${x402_fee_usdc:.2f})"
                    ),
                    user_addr=profile.user_addr,
                    agent_addr=profile.agent_address,
                    policy_snapshot={
                        **base_policy_snapshot,
                        "x402": requirement.as_policy_snapshot(),
                    },
                )
                decision.notification_status = notify_decision(profile.user_addr, decision)
                append_decision(decision)
                render(decision)
                out.append(decision)
                continue
            try:
                x402_receipt = settle_reasoning_request(
                    wallet_id=profile.circle_wallet_id,
                    user_addr=profile.user_addr,
                    market_addr=m.address,
                    model=model_name,
                    # Preferred: a real nanopayment from the user's own
                    # payments EOA. Falls back to the legacy transfer when the
                    # profile has no payments wallet or the rail is down.
                    payments_wallet_id=profile.payments_wallet_id,
                    payments_address=profile.payments_address,
                )
                bankroll = max(0.0, bankroll - x402_fee_usdc)
                console.print(
                    f"  [dim]x402 ${x402_fee_usdc:.2f} USDC -> reasoning "
                    f"({(x402_receipt.tx_hash or x402_receipt.circle_tx_id or '')[:14]}...)[/dim]"
                )
            except Exception as e:  # noqa: BLE001
                if credits_debited and credit_cost > 0:
                    add_credits(profile.user_addr, credit_cost)
                requirement = x402_payment_requirement(
                    user_addr=profile.user_addr,
                    market_addr=m.address,
                    model=model_name,
                )
                decision = policy_pass(
                    m,
                    bankroll_usdc=bankroll,
                    reason=str(e),
                    user_addr=profile.user_addr,
                    agent_addr=profile.agent_address,
                    policy_snapshot={
                        **base_policy_snapshot,
                        "x402": requirement.as_policy_snapshot(),
                    },
                )
                decision.notification_status = notify_decision(profile.user_addr, decision)
                append_decision(decision)
                render(decision)
                out.append(decision)
                continue

        decision = decide(m, est, bankroll, risk)
        decision.user_addr = profile.user_addr
        decision.agent_addr = profile.agent_address
        if brain_result is not None:
            decision.news_summary = brain_result.news_summary
            decision.tool_trace = brain_result.tool_trace
            decision.brain_model = brain_result.model
            decision.brain_iterations = brain_result.iterations
            decision.prompt_hash = brain_result.prompt_hash
            decision.tools_called = [
                str(step.get("name"))
                for step in brain_result.tool_trace
                if isinstance(step, dict) and step.get("name")
            ]
        decision.external_odds_snapshot = {
            "polymarket": {
                "yes_probability": decision.polymarket_prob,
                "slug": decision.polymarket_slug,
            }
        }
        decision.policy_snapshot = {
            **risk_manager.snapshot(),
            "risk_bucket": risk_bucket(m.category, m.question),
        }
        if x402_receipt is not None:
            decision.policy_snapshot["x402"] = x402_receipt.as_policy_snapshot()
        if decision.action in ("buy_yes", "buy_no"):
            try:
                apply_contract_preview_pricing(w3, m, decision)
            except Exception as e:  # noqa: BLE001
                decision.action = "pass"
                decision.pass_reason = f"contract preview failed: {str(e)[:80]}"
                decision.shares = 0
                decision.cost_usdc = 0.0
                decision.max_cost_usdc = 0.0

        gate = risk_manager.gate_trade(decision=decision, market=m)
        if not gate.allowed:
            decision.action = "pass"
            decision.pass_reason = gate.reason
            decision.shares = 0
            decision.cost_usdc = 0.0
        elif gate.scale_to_usdc is not None and decision.cost_usdc > 0:
            ratio = gate.scale_to_usdc / decision.cost_usdc
            decision.shares = int(decision.shares * ratio)
            decision.cost_usdc = decision.cost_usdc * ratio
            decision.pass_reason = gate.reason
            try:
                apply_contract_preview_pricing(w3, m, decision)
            except Exception as e:  # noqa: BLE001
                decision.action = "pass"
                decision.pass_reason = f"contract preview failed after rescale: {str(e)[:80]}"
                decision.shares = 0
                decision.cost_usdc = 0.0
                decision.max_cost_usdc = 0.0
            console.print(
                f"  [dim]policy rescaled to ${decision.cost_usdc:.2f} "
                f"({gate.reason})[/dim]"
            )
        if decision.action in ("buy_yes", "buy_no"):
            decision.policy_snapshot["approved_cost_usdc"] = round(decision.cost_usdc, 4)

        # ── Live execution ─────────────────────────────────────────────────
        # Gate 1: tier permits live trading. Free is allowed; policy caps do
        # the limiting so the product remains real from day one.
        if live and decision.action in ("buy_yes", "buy_no"):
            if not entitlements.live_trading or not can_trade_live(profile.user_addr):
                decision.action = "pass"
                decision.pass_reason = "tier does not permit live trading"
                decision.shares = 0
                decision.cost_usdc = 0.0

        if decision.action in ("buy_yes", "buy_no"):
            risk_manager.reserve(decision=decision, market=m)

        # Gate 2: actual execution via Circle wallet or legacy session key.
        if live and decision.action in ("buy_yes", "buy_no"):
            try:
                side_id = 1 if decision.action == "buy_yes" else 2
                market_contract = w3.eth.contract(
                    address=Web3.to_checksum_address(m.address), abi=MARKET_ABI
                )
                preview = market_contract.functions.previewBuy(side_id, decision.shares).call()
                max_cost = preview * (10_000 + SLIPPAGE_BPS) // 10_000
                approved_cost = float(
                    decision.policy_snapshot.get("approved_cost_usdc")
                    or decision.cost_usdc
                    or 0
                )
                if approved_cost > 0 and preview / 1e6 > approved_cost + 0.02:
                    raise RuntimeError(
                        "contract preview exceeded policy-approved cost "
                        f"({preview/1e6:.4f} > {approved_cost:.4f})"
                    )
                decision.max_cost_usdc = max_cost / 1e6
                decision.cost_usdc = preview / 1e6

                # ── Circle Developer-Controlled Wallet execution ──
                treasury = os.environ.get("TREASURY_ADDRESS", "")

                # Step 1: Deduct protocol fee → treasury.
                if treasury:
                    fee_micro = compute_protocol_fee(int(preview))
                    decision.platform_fee_usdc = fee_micro / 1e6
                    try:
                        fee_tx_id = transfer_usdc(
                            wallet_id=profile.circle_wallet_id,
                            destination_address=treasury,
                            amount_micro=fee_micro,
                            idempotency_key=str(uuid.uuid5(
                                uuid.NAMESPACE_URL,
                                f"fee-{decision.ts}-{m.address}",
                            )),
                        )
                        # Non-blocking: don't wait for fee confirmation before
                        # submitting the buy — Arc is fast enough that they
                        # settle in the same block window.
                        console.print(
                            f"  [dim]fee ${fee_micro/1e6:.4f} USDC → "
                            f"treasury (circle tx {fee_tx_id[:12]}…)[/dim]"
                        )
                    except Exception as fee_err:
                        # Fee failure is non-fatal — log and continue.
                        console.print(f"  [yellow]fee transfer failed: {fee_err}[/yellow]")

                # Step 2: USDC approve (a separate contractExecution tx, since the
                # Circle wallet must approve the market before buy() pulls USDC).
                approve_tx_id = execute_contract_call(
                    wallet_id=profile.circle_wallet_id,
                    contract_address=USDC,
                    abi_function_signature="approve(address,uint256)",
                    abi_parameters=[m.address, str(max_cost)],
                    idempotency_key=str(uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"approve-{decision.ts}-{m.address}",
                    )),
                )
                wait_for_transaction(approve_tx_id, max_wait=60.0)

                # Step 3: buy().
                buy_tx_id = execute_contract_call(
                    wallet_id=profile.circle_wallet_id,
                    contract_address=m.address,
                    abi_function_signature="buy(uint8,uint256,uint256)",
                    abi_parameters=[side_id, str(decision.shares), str(max_cost)],
                    idempotency_key=str(uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"buy-{decision.ts}-{m.address}",
                    )),
                )
                on_chain_hash = wait_for_transaction(buy_tx_id, max_wait=90.0)
                decision.tx_hash = (
                    on_chain_hash
                    if on_chain_hash.startswith("0x")
                    else "0x" + on_chain_hash
                )
                decision.paper = False

            except (ContractLogicError, Exception) as e:
                console.print(f"  [red]execute failed: {e}[/red]")
                decision.action = "pass"
                decision.pass_reason = f"execute failed: {str(e)[:80]}"
                decision.shares = 0
                decision.cost_usdc = 0.0
                decision.max_cost_usdc = 0.0
        decision.notification_status = notify_decision(profile.user_addr, decision)
        append_decision(decision)
        render(decision)
        out.append(decision)
        time.sleep(0.3)

    # ── Agent v2 reflect (runs only when the planner ran this pass) ─────────
    if agent_ctx is not None:
        try:
            from agent_core import reflect_pass

            reflect_pass(agent_ctx, decisions=out, model=model_for_profile(profile, tier))
        except Exception as e:  # noqa: BLE001
            console.print(f"  [dim]reflect skipped: {e}[/dim]")

    return out


def main_per_user(args) -> int:
    """Per-user run path — iterates the profiles store, runs each runnable
    profile once (or in a loop with --watch)."""
    try:
        assert_schema_compatible()
    except Exception as e:
        console.print(f"[red]{e}[/red]")
        return 1

    w3 = get_web3()
    if not w3.is_connected():
        console.print("[red]not connected to Arc[/red]")
        return 1

    # Best-effort import of anything written to the JSONL fallback by a
    # previous run when the DB was unreachable. Idempotent.
    try:
        drain_pending_jsonl()
    except Exception as e:
        console.print(f"[dim]jsonl drain skipped: {e}[/dim]")

    last_run = _LAST_RUN_BY_USER
    # Fast passes are gated separately: the tier cadence governs the expensive
    # full pass, but a 15-minute market cannot be traded on a 4-hour clock.
    fast_only = bool(getattr(args, "fast_only", False))
    fast_cadence_s = float(os.environ.get("AGENT_FAST_CADENCE_SECONDS", "60"))

    def one_pass() -> int:
        profiles = load_profiles()
        runnable = [p for p in profiles if is_runnable(p)]
        if args.user:
            runnable = [p for p in runnable if p.user_addr.lower() == args.user.lower()]
        if not runnable:
            console.print("[dim]no runnable profiles[/dim]")
            return 0

        # Decide who is due BEFORE touching the chain. A tick where every
        # profile is still inside its cadence window does zero RPC.
        now = time.time()
        due: list[AgentProfile] = []
        for p in runnable:
            if fast_only:
                # Only profiles configured for short horizons take the fast
                # path — it would be wrong to start scalping 15-minute rounds
                # on behalf of someone who asked for a slow strategy.
                if not prefers_short_timeframes(p, policy_for_profile(p)):
                    continue
                due_at = _LAST_FAST_RUN_BY_USER.get(p.user_addr, 0) + fast_cadence_s
                if now < due_at:
                    continue
                due.append(p)
                continue
            p_tier = cached_subscription_tier(p.user_addr)
            p_entitlements = entitlements_for_tier(p_tier)
            cadence_minutes = max(p.cadence_minutes, p_entitlements.min_cadence_minutes)
            due_at = last_run.get(p.user_addr, 0) + cadence_minutes * 60
            if now < due_at:
                wait_s = int(due_at - now)
                console.print(
                    f"  [dim]skip {p.user_addr[:10]}… — next run in {wait_s}s "
                    f"(tier cadence {cadence_minutes}m)[/dim]"
                )
                continue
            due.append(p)

        if not due:
            return 0

        addrs = discover_markets_cached(w3)
        if fast_only:
            # Reading all ~8,000 markets to find the ~6 live fast rounds would
            # cost more RPC per minute than the entire rest of the agent. Fast
            # markets are minted continuously and expire within the hour, so
            # they are always among the newest addresses — scan only the tail.
            tail = int(os.environ.get("AGENT_FAST_SCAN_ADDRS", "60"))
            addrs = addrs[-tail:]
        console.print(
            f"[dim]factory has {len(addrs)} markets"
            f"{' (fast tail)' if fast_only else ''}[/dim]"
        )

        worked = 0
        for p in due:
            console.rule(f"user {p.user_addr[:10]}… · {p.pattern}")
            run_for_user(w3, p, addrs, live=args.live, fast_only=fast_only)
            # Stamp the clock this pass belongs to — a fast pass must not
            # satisfy (and so postpone) the full pass, or the agent would stop
            # looking at everything that isn't a 15-minute crypto round.
            if fast_only:
                _LAST_FAST_RUN_BY_USER[p.user_addr] = time.time()
            else:
                last_run[p.user_addr] = time.time()
            worked += 1
        return worked

    if not args.watch:
        one_pass()
        return 0

    console.rule("watch mode · ctrl-C to stop")
    try:
        while True:
            one_pass()
            time.sleep(args.watch_interval)
    except KeyboardInterrupt:
        console.print("\n[dim]stopped[/dim]")
        return 0


# ── Main ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true",
                    help="broadcast trades via each user's Circle wallet")
    ap.add_argument("--user", type=str, default=None,
                    help="only run for this user address")
    ap.add_argument("--fast-only", action="store_true", dest="fast_only",
                    help="score only fast markets, using the deterministic "
                         "spot-vs-start estimator (no model calls)")
    ap.add_argument("--watch", action="store_true",
                    help="loop forever, respecting each profile's cadence")
    ap.add_argument("--watch-interval", type=int, default=30,
                    help="seconds between watch-mode passes")
    args = ap.parse_args()

    return main_per_user(args)


if __name__ == "__main__":
    sys.exit(main())
