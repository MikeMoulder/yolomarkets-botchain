"""Shared tool belt for the YOLO agent core (Agent v2 · M1).

One registry of capabilities that every agent turn draws from — the autonomous
planner/reflect turns today, and the chat handler in M2/M3. Each tool is an
OpenAI-style function schema plus a handler(ctx, **args) -> JSON-serializable
dict. `run_agent_turn` (agent_core.py) filters the schemas by an allowed-set and
dispatches calls through `dispatch()`.

The deterministic risk gate is exposed here as the `check_trade` tool
(policy-as-tool): the model may *ask* whether a trade would pass and at what
size, but it cannot widen a cap — the verdict comes straight from
PortfolioRiskManager.gate_trade, the same code the executor uses.

Handlers use lazy imports (like brain.py) so this module stays import-cheap and
free of cycles with loop.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable


# ── Runtime context threaded into every handler ────────────────────────────
@dataclass
class ToolContext:
    """What tools need at call time. Fields are optional so a lightweight
    (e.g. chat-read) context can omit trading handles it will never use."""

    user_addr: str
    trigger: str = "autonomous"          # autonomous | chat | trade | reflect
    profile: Any = None
    policy: Any = None
    entitlements: Any = None
    risk_manager: Any = None             # PortfolioRiskManager
    portfolio: Any = None                # policy.PortfolioSnapshot (autonomous path)
    markets: list[Any] = field(default_factory=list)   # in-scope MarketState list
    bankroll_usdc: float = 0.0
    tier: str = "free"
    live: bool = False
    # Chat path: no pre-built portfolio — read positions on-chain across the
    # user's own wallet + their Circle agent wallet.
    w3: Any = None
    user_addresses: list[str] = field(default_factory=list)
    agent_address: str | None = None
    # Populated by handlers as a side-effect record for the caller.
    theses_written: list[str] = field(default_factory=list)
    journal_ids: list[int] = field(default_factory=list)

    def market_by_addr(self, addr: str) -> Any | None:
        want = (addr or "").lower()
        for m in self.markets:
            if m.address.lower() == want:
                return m
        return None


# ── Handlers ───────────────────────────────────────────────────────────────

_PLATFORM_FACTS = {
    "overview": (
        "YOLO Markets is a prediction-market platform on Arc (a Circle L1 "
        "testnet), settled in USDC. You trade YES/NO shares on real-world "
        "questions; an optional autonomous agent can also trade on your behalf."
    ),
    "navigation": (
        "Main pages — Markets (home, '/'): browse and trade all markets. Fast "
        "('/markets/fast'): short-window rounds. Portfolio ('/portfolio'): your "
        "positions, value, P&L, and claimable winnings. Agent ('/agent'): set up "
        "and watch the autonomous agent. Links are in the top nav and the footer."
    ),
    "trading": (
        "To trade: open a market from Markets, choose YES or NO, enter a USDC "
        "amount, and confirm in your wallet (an approve then a buy). Prices come "
        "from an on-chain LMSR AMM — priceYes is the implied probability; the "
        "winning side redeems for 1 USDC at resolution. You can also just ask me "
        "here to prepare a trade for you to confirm."
    ),
    "portfolio": (
        "Portfolio ('/portfolio') shows your open positions across your connected "
        "wallet and (if set up) your agent wallet, their current value, and any "
        "resolved markets where you can claim winnings."
    ),
    "agent": (
        "The autonomous agent (set up at '/agent/setup') funds a Circle agent "
        "wallet and trades a strategy you pick (e.g. quant, contrarian, news) on a "
        "cadence, sizing by Kelly. Its trades and reasoning appear on '/agent'. "
        "Separately, you can trade yourself right here in chat."
    ),
    "wallet": (
        "Connect a wallet from the top-right of the app — either an external "
        "wallet (e.g. MetaMask) or Circle email/OTP sign-in — on the Arc testnet. "
        "The autonomous agent trades from its own funded Circle wallet; your "
        "chat/manual trades use your connected wallet and you approve each one."
    ),
    "get_usdc": (
        "USDC is both the currency and the gas token on Arc testnet. Get free "
        "testnet USDC from the Circle faucet: https://faucet.circle.com."
    ),
    "fees": "Protocol fee is 0.3% of trade size, floored at $0.01. Gas is paid in USDC.",
    "chain": "Bohr testnet, BOT Chain id 968; tBOT pays gas and canonical USDT is the settlement token.",
    "resources": (
        "Footer links: Arc block explorer https://testnet.arcscan.app (look up "
        "any transaction), the USDC faucet https://faucet.circle.com, and legal "
        "pages under '/legal' (terms, privacy, risk disclosure, attribution)."
    ),
    "support": (
        "This is a testnet app — there is no public support desk, Discord, or "
        "email listed, so don't point people to one. For anything about the "
        "platform, your account, or a trade, the best channel is right here: I "
        "can explain how things work, look up markets and your positions, explain "
        "the agent's decisions, and prepare trades. Policy/terms are under '/legal'."
    ),
    "this_chat": (
        "In this chat I can: explain the platform and how to navigate it, search "
        "and look up markets, read your portfolio across both wallets, explain "
        "trades the agent made, and prepare a buy you confirm in your own wallet. "
        "I can't change account settings from chat yet."
    ),
}


def _h_read_platform_facts(ctx: ToolContext, topic: str | None = None) -> dict[str, Any]:
    if topic and topic in _PLATFORM_FACTS:
        return {topic: _PLATFORM_FACTS[topic]}
    return dict(_PLATFORM_FACTS)


def _h_read_theses(ctx: ToolContext, status: str | None = "active") -> dict[str, Any]:
    from datetime import datetime, timezone
    from db import get_theses

    now = datetime.now(timezone.utc)
    rows = get_theses(ctx.user_addr, status=status)
    theses = [
        {
            "scope": r["scope"],
            "subject": r["subject"],
            "stance": r["stance"],
            "conviction": float(r["conviction"]),
            "rationale": r["rationale"],
            "status": r["status"],
            "revisit_at": r["revisit_at"].isoformat() if r["revisit_at"] else None,
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            # True → the agent flagged this view for reconsideration and that time
            # has passed; re-examine it and update or close it this run.
            "due_for_revisit": bool(r["revisit_at"] and r["revisit_at"] <= now),
        }
        for r in rows
    ]
    due = sum(1 for t in theses if t["due_for_revisit"])
    return {"count": len(theses), "due_for_revisit": due, "theses": theses}


def _h_read_portfolio(ctx: ToolContext) -> dict[str, Any]:
    # Autonomous path: summarize the pre-built snapshot (agent Circle book only).
    if ctx.portfolio is not None:
        positions: list[dict[str, Any]] = []
        exposure: dict[str, float] = {}
        for p in ctx.portfolio.positions:
            if not p.is_open:
                continue
            positions.append(
                {
                    "market": p.market,
                    "question": p.question[:120],
                    "bucket": p.bucket,
                    "yes_shares": round(p.yes_shares, 4),
                    "no_shares": round(p.no_shares, 4),
                    "value_usdc": round(p.value_usdc, 4),
                }
            )
            exposure[p.bucket] = round(exposure.get(p.bucket, 0.0) + p.value_usdc, 4)
        return {
            "bankroll_usdc": round(ctx.bankroll_usdc, 4),
            "open_positions": len(positions),
            "positions": positions,
            "exposure_by_bucket_usdc": exposure,
            "note": "Agent's own (Circle-wallet) book only.",
        }
    # Chat path: scan the user's wallets on-chain against the active catalog.
    if ctx.w3 is not None and ctx.user_addresses:
        return _scan_chat_portfolio(ctx)
    return {"open_positions": 0, "positions": [], "note": "portfolio unavailable here"}


def _scan_chat_portfolio(ctx: ToolContext) -> dict[str, Any]:
    """Unified read across the user's connected wallet + Circle agent wallet,
    over the unresolved catalog. Bounded (active markets only) and best-effort."""
    from web3 import Web3
    from loop import _mc_field
    from policy import risk_bucket
    from db import active_market_rows

    rows = active_market_rows(limit=300)
    if not rows:
        return {"open_positions": 0, "positions": [], "note": "catalog unavailable"}
    addrs = [r["address"] for r in rows]
    info = {r["address"].lower(): r for r in rows}
    agent_lc = (ctx.agent_address or "").lower()

    positions: list[dict[str, Any]] = []
    exposure: dict[str, float] = {}
    total_value = 0.0
    for owner in ctx.user_addresses:
        if not owner:
            continue
        try:
            own = Web3.to_checksum_address(owner)
            yes = _mc_field(ctx.w3, addrs, "sharesYes", "uint256", args=[own])
            no = _mc_field(ctx.w3, addrs, "sharesNo", "uint256", args=[own])
        except Exception as e:  # noqa: BLE001
            return {"error": f"could not read positions on-chain: {e}"}
        source = "autonomous" if owner.lower() == agent_lc and agent_lc else "manual/chat"
        for i, a in enumerate(addrs):
            y = (yes[i] or 0) / 1e6
            n = (no[i] or 0) / 1e6
            if y <= 0 and n <= 0:
                continue
            row = info.get(a.lower(), {})
            price = float(row.get("price_yes") or 0) / 1e18
            value = y * price + n * (1.0 - price)
            total_value += value
            bucket = risk_bucket(row.get("category", ""), row.get("question", ""))
            exposure[bucket] = round(exposure.get(bucket, 0.0) + value, 4)
            positions.append(
                {
                    "market": a,
                    "question": (row.get("question") or "")[:120],
                    "source": source,
                    "bucket": bucket,
                    "yes_shares": round(y, 4),
                    "no_shares": round(n, 4),
                    "value_usdc": round(value, 4),
                }
            )
    positions.sort(key=lambda p: p["value_usdc"], reverse=True)
    return {
        "open_positions": len(positions),
        "total_position_value_usdc": round(total_value, 4),
        "positions": positions,
        "exposure_by_bucket_usdc": exposure,
        "scanned_addresses": ctx.user_addresses,
        "note": (
            "Unified across your connected wallet + Circle agent wallet, over "
            "currently-active markets. 'source' attributes each position."
        ),
    }


def _fmt_deadline(deadline: Any) -> dict[str, Any]:
    import time as _t

    try:
        dl = int(deadline)
    except (TypeError, ValueError):
        return {}
    return {"deadline_unix": dl, "tte_hours": round((dl - int(_t.time())) / 3600.0, 1)}


def _h_search_markets(ctx: ToolContext, query: str, limit: int = 8) -> dict[str, Any]:
    from db import search_market_index

    rows = search_market_index(query, limit=min(int(limit), 15))
    out = [
        {
            "address": r["address"],
            "question": r["question"],
            "category": r["category"],
            "yes_price": round(float(r["price_yes"] or 0) / 1e18, 4),
            "legacy": bool(r["legacy"]),
            **_fmt_deadline(r["deadline"]),
        }
        for r in rows
    ]
    return {"count": len(out), "markets": out}


def _h_get_market(ctx: ToolContext, address: str) -> dict[str, Any]:
    from db import get_market_index

    r = get_market_index(address)
    if not r:
        return {"error": f"no market found for {address}"}
    return {
        "address": r["address"],
        "question": r["question"],
        "category": r["category"],
        "yes_price": round(float(r["price_yes"] or 0) / 1e18, 4),
        "resolved": bool(r["resolved"]),
        "outcome": r.get("outcome"),
        "total_liquidity_usdc": round(float(r.get("total_liquidity") or 0), 2),
        "legacy": bool(r["legacy"]),
        **_fmt_deadline(r["deadline"]),
    }


def _h_read_journal(ctx: ToolContext, limit: int = 10) -> dict[str, Any]:
    from db import recent_journal

    rows = recent_journal(ctx.user_addr, limit=min(int(limit), 25))
    return {
        "count": len(rows),
        "entries": [
            {
                "ts": r["ts"].isoformat() if r["ts"] else None,
                "trigger": r["trigger"],
                "kind": r["kind"],
                "title": r["title"],
                "body": r["body"],
                "market": r["market"],
            }
            for r in rows
        ],
    }


def _h_propose_trade(
    ctx: ToolContext, market_address: str, side: str, size_usdc: float
) -> dict[str, Any]:
    """Prepare (NOT execute) a buy on the user's CONNECTED wallet. Sizes against
    the live LMSR curve and returns a structured order the UI renders as a
    confirm card. Execution happens client-side only after the user approves in
    their wallet — this tool signs nothing and moves no funds."""
    import os
    import time

    from web3 import Web3
    from loop import MARKET_ABI, USDC, USDC_ABI, SLIPPAGE_BPS
    from circle_wallets import compute_protocol_fee
    from db import get_market_index

    if ctx.w3 is None:
        return {"error": "no chain connection in this context"}
    s = (side or "").lower()
    if s in ("yes", "buy_yes", "1"):
        side_id = 1
    elif s in ("no", "buy_no", "2"):
        side_id = 2
    else:
        return {"error": "side must be 'yes' or 'no'"}
    try:
        size = float(size_usdc)
    except (TypeError, ValueError):
        return {"error": "size_usdc must be a number"}
    if size <= 0:
        return {"error": "size_usdc must be positive"}
    if size > 1000:
        return {"error": "size_usdc looks too large; ask the user to confirm the amount"}

    try:
        m = Web3.to_checksum_address(market_address)
        mc = ctx.w3.eth.contract(address=m, abi=MARKET_ABI)
        if bool(mc.functions.resolved().call()):
            return {"error": "market is already resolved — cannot trade"}
        # Never trade an expired market: past its deadline it is awaiting
        # resolution, not tradeable. A small buffer stops a trade from racing
        # expiry between proposal and the user confirming in their wallet.
        deadline = int(mc.functions.deadline().call())
        now = int(time.time())
        min_tte = int(os.environ.get("AGENT_CHAT_MIN_TTE_SECONDS", "120"))
        if deadline <= now:
            return {
                "error": (
                    "market has expired (past its deadline) and is awaiting "
                    "resolution — it cannot be traded"
                )
            }
        if deadline - now < min_tte:
            return {
                "error": (
                    f"market resolves in under {max(1, min_tte // 60)} min — too "
                    "close to expiry to trade safely"
                )
            }
        price_yes = int(mc.functions.priceYes().call()) / 1e18
        side_price = price_yes if side_id == 1 else (1.0 - price_yes)
        if not (0.01 < side_price < 0.99):
            return {"error": f"{'YES' if side_id == 1 else 'NO'} price {side_price:.2f} too extreme to size safely"}
        shares = int(size / side_price * 1e6)
        if shares <= 0:
            return {"error": "size too small to buy any shares"}
        preview = int(mc.functions.previewBuy(side_id, shares).call())
        # LMSR: larger orders cost more than spot — shrink to fit the target spend.
        if preview / 1e6 > size and preview > 0:
            shares = int(shares * (size / (preview / 1e6)))
            if shares <= 0:
                return {"error": "size too small after curve adjustment"}
            preview = int(mc.functions.previewBuy(side_id, shares).call())
        usdc = ctx.w3.eth.contract(address=USDC, abi=USDC_ABI)
        balance = int(usdc.functions.balanceOf(Web3.to_checksum_address(ctx.user_addr)).call())
    except Exception as e:  # noqa: BLE001
        return {"error": f"could not price the order on-chain: {e}"}

    max_cost = preview * (10_000 + SLIPPAGE_BPS) // 10_000
    fee_micro = compute_protocol_fee(preview)
    row = get_market_index(market_address)
    question = (row or {}).get("question") if row else None
    if not question:
        try:
            question = mc.functions.question().call()
        except Exception:  # noqa: BLE001
            question = market_address

    return {
        "proposal": {
            "market": m,
            "question": question,
            "side": "YES" if side_id == 1 else "NO",
            "side_id": side_id,
            "shares": str(shares),                       # 6-dec, bigint-safe string
            "shares_human": round(shares / 1e6, 2),
            "est_cost_usdc": round(preview / 1e6, 4),
            "max_cost": str(max_cost),                   # 6-dec, for buy()/approve()
            "max_cost_usdc": round(max_cost / 1e6, 4),
            "fee_usdc": round(fee_micro / 1e6, 4),
            "yes_price": round(price_yes, 4),
            "side_price": round(side_price, 4),
            "wallet": ctx.user_addr,
            "wallet_balance_usdc": round(balance / 1e6, 4),
            "sufficient_balance": balance >= max_cost,
            "slippage_bps": SLIPPAGE_BPS,
        },
        "note": (
            "Order prepared for the user's connected wallet. It is NOT executed — "
            "the user must confirm and approve in their wallet. Tell them what "
            "you've prepared and that they can confirm below."
        ),
    }


def _h_read_my_trades(ctx: ToolContext, limit: int = 10) -> dict[str, Any]:
    from db import recent_decisions

    rows = recent_decisions(ctx.user_addr, limit=min(int(limit), 25))
    return {
        "count": len(rows),
        "decisions": [
            {
                "ts": r["ts"].isoformat() if r["ts"] else None,
                "market": r["market"],
                "question": (r["question"] or "")[:100],
                "action": r["action"],
                "pass_reason": r["pass_reason"],
                "cost_usdc": float(r["cost_usdc"] or 0),
                "ai_prob": float(r["ai_prob"] or 0),
                "ai_confidence": float(r["ai_confidence"] or 0),
                "edge_pts": float(r["edge_pts"] or 0),
                "paper": bool(r["paper"]),
                "tx_hash": r["tx_hash"],
                "reasoning": (r["reasoning"] or "")[:280],
            }
            for r in rows
        ],
    }


def _h_fetch_polymarket_odds(ctx: ToolContext, question: str) -> dict[str, Any]:
    from brain import _tool_fetch_polymarket

    return _tool_fetch_polymarket(question)


def _h_compute_kelly(
    ctx: ToolContext,
    probability: float,
    market_price: float,
    bankroll_usdc: float | None = None,
    kelly_mult: float | None = None,
) -> dict[str, Any]:
    from brain import _tool_compute_kelly

    bankroll = ctx.bankroll_usdc if bankroll_usdc is None else bankroll_usdc
    km = kelly_mult
    if km is None:
        km = float(getattr(ctx.policy, "kelly_mult", 0.5)) if ctx.policy else 0.5
    return _tool_compute_kelly(
        probability=probability,
        market_price=market_price,
        bankroll_usdc=bankroll,
        kelly_mult=km,
    )


def _h_web_search(ctx: ToolContext, query: str) -> dict[str, Any]:
    from brain import _tool_web_search

    return _tool_web_search(query)


def _h_check_trade(
    ctx: ToolContext,
    market_address: str,
    side: str,
    cost_usdc: float,
) -> dict[str, Any]:
    """Policy-as-tool: ask the deterministic risk gate whether a hypothetical
    buy would be allowed and at what size. Read-only — reserves nothing."""
    if ctx.risk_manager is None:
        return {"error": "no risk manager in this context (read-only turn)"}
    m = ctx.market_by_addr(market_address)
    if m is None:
        return {"error": f"market {market_address} is not in scope this pass"}
    side_norm = (side or "").lower()
    if side_norm in ("yes", "buy_yes", "1"):
        action = "buy_yes"
    elif side_norm in ("no", "buy_no", "2"):
        action = "buy_no"
    else:
        return {"error": "side must be 'yes' or 'no'"}

    hypo = SimpleNamespace(
        action=action,
        cost_usdc=float(cost_usdc),
        bankroll_usdc=float(ctx.bankroll_usdc),
    )
    gate = ctx.risk_manager.gate_trade(decision=hypo, market=m)
    return {
        "allowed": bool(gate.allowed),
        "reason": gate.reason,
        "scale_to_usdc": (
            round(gate.scale_to_usdc, 4) if gate.scale_to_usdc is not None else None
        ),
        "requested_cost_usdc": round(float(cost_usdc), 4),
        "note": (
            "Deterministic verdict from the risk gate. 'scale_to_usdc' set means "
            "the trade is allowed only if shrunk to that spend."
        ),
    }


def _h_write_thesis(
    ctx: ToolContext,
    scope: str,
    subject: str,
    stance: str,
    conviction: float,
    rationale: str = "",
    evidence: list[str] | None = None,
    status: str = "active",
    market: str | None = None,
    bucket: str | None = None,
    revisit_hours: float | None = None,
) -> dict[str, Any]:
    from datetime import datetime, timedelta, timezone
    from db import upsert_thesis

    revisit_at = None
    if revisit_hours is not None:
        revisit_at = datetime.now(timezone.utc) + timedelta(hours=float(revisit_hours))
    tid = upsert_thesis(
        user_addr=ctx.user_addr,
        scope=scope,
        subject=subject,
        stance=stance,
        conviction=max(0.0, min(1.0, float(conviction))),
        rationale=rationale,
        evidence=list(evidence or []),
        status=status,
        market=market,
        bucket=bucket,
        revisit_at=revisit_at,
    )
    ctx.theses_written.append(scope)
    return {"ok": True, "id": tid, "scope": scope, "status": status}


def _h_write_journal(
    ctx: ToolContext,
    body: str,
    kind: str = "note",
    title: str = "",
    market: str | None = None,
) -> dict[str, Any]:
    from db import insert_journal

    jid = insert_journal(
        user_addr=ctx.user_addr,
        trigger=ctx.trigger,
        body=body,
        kind=kind,
        title=title,
        market=market,
    )
    ctx.journal_ids.append(jid)
    return {"ok": True, "id": jid}


# ── Registry: schema + handler per tool ────────────────────────────────────
def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


TOOLS: dict[str, dict[str, Any]] = {
    "read_platform_facts": {
        "schema": _fn(
            "read_platform_facts",
            "Get factual info about the YOLO Markets platform (chain, USDC, how "
            "markets/fees/tiers/wallets work). Optional 'topic' narrows it.",
            {"topic": {"type": "string", "enum": list(_PLATFORM_FACTS.keys())}},
            [],
        ),
        "handler": _h_read_platform_facts,
    },
    "read_theses": {
        "schema": _fn(
            "read_theses",
            "Read the agent's stored theses for this user — the current view per "
            "market/bucket carried across runs. Start here to recall past reasoning.",
            {"status": {"type": "string", "enum": ["active", "closed", "expired"]}},
            [],
        ),
        "handler": _h_read_theses,
    },
    "read_portfolio": {
        "schema": _fn(
            "read_portfolio",
            "Read the agent's own open positions, bankroll, and exposure by risk "
            "bucket (its Circle-wallet book only).",
            {},
            [],
        ),
        "handler": _h_read_portfolio,
    },
    "fetch_polymarket_odds": {
        "schema": _fn(
            "fetch_polymarket_odds",
            "Fuzzy-match a question against active Polymarket markets and return "
            "the crowd's YES probability if a close match exists (a prior, not truth).",
            {"question": {"type": "string"}},
            ["question"],
        ),
        "handler": _h_fetch_polymarket_odds,
    },
    "compute_kelly": {
        "schema": _fn(
            "compute_kelly",
            "Deterministic fractional-Kelly position size given your probability, "
            "the side's AMM price, and (optionally) bankroll/kelly_mult; defaults "
            "come from this user's context.",
            {
                "probability": {"type": "number"},
                "market_price": {"type": "number"},
                "bankroll_usdc": {"type": "number"},
                "kelly_mult": {"type": "number"},
            },
            ["probability", "market_price"],
        ),
        "handler": _h_compute_kelly,
    },
    "web_search": {
        "schema": _fn(
            "web_search",
            "Search the live web for recent facts about a market. Returns a short "
            "summary plus source URLs. Be specific: dates, names, the resolution rule.",
            {"query": {"type": "string"}},
            ["query"],
        ),
        "handler": _h_web_search,
    },
    "check_trade": {
        "schema": _fn(
            "check_trade",
            "Ask the deterministic risk gate whether a buy would be allowed and at "
            "what size. You cannot override it — use it to size within policy.",
            {
                "market_address": {"type": "string"},
                "side": {"type": "string", "enum": ["yes", "no"]},
                "cost_usdc": {"type": "number"},
            },
            ["market_address", "side", "cost_usdc"],
        ),
        "handler": _h_check_trade,
    },
    "write_thesis": {
        "schema": _fn(
            "write_thesis",
            "Record or update your view on a market or bucket so future runs start "
            "from it. scope is the lower-cased market address, or 'bucket:<name>'.",
            {
                "scope": {"type": "string"},
                "subject": {"type": "string", "description": "human label"},
                "stance": {
                    "type": "string",
                    "enum": ["long_yes", "long_no", "watch", "avoid"],
                },
                "conviction": {"type": "number", "description": "0..1"},
                "rationale": {"type": "string"},
                "evidence": {"type": "array", "items": {"type": "string"}},
                "status": {
                    "type": "string",
                    "enum": ["active", "closed", "expired"],
                },
                "market": {"type": "string"},
                "bucket": {"type": "string"},
                "revisit_hours": {"type": "number"},
            },
            ["scope", "subject", "stance", "conviction"],
        ),
        "handler": _h_write_thesis,
    },
    "write_journal": {
        "schema": _fn(
            "write_journal",
            "Append a short first-person journal entry (what you're doing/thinking "
            "and why). Tagged automatically with this run's trigger.",
            {
                "body": {"type": "string"},
                "kind": {
                    "type": "string",
                    "enum": ["plan", "decision", "reflection", "trade", "message", "note"],
                },
                "title": {"type": "string"},
                "market": {"type": "string"},
            },
            ["body"],
        ),
        "handler": _h_write_journal,
    },
    "search_markets": {
        "schema": _fn(
            "search_markets",
            "Search the market catalog by keywords in the question. Returns "
            "matching markets with address, current YES price, and time to expiry.",
            {
                "query": {"type": "string"},
                "limit": {"type": "integer", "description": "max results (<=15)"},
            },
            ["query"],
        ),
        "handler": _h_search_markets,
    },
    "get_market": {
        "schema": _fn(
            "get_market",
            "Get details for one market by its address: question, YES price, "
            "liquidity, deadline, resolved/outcome.",
            {"address": {"type": "string"}},
            ["address"],
        ),
        "handler": _h_get_market,
    },
    "read_journal": {
        "schema": _fn(
            "read_journal",
            "Read your recent first-person journal entries for this user (plans, "
            "reflections, trade notes) — use to explain what you did and why.",
            {"limit": {"type": "integer"}},
            [],
        ),
        "handler": _h_read_journal,
    },
    "read_my_trades": {
        "schema": _fn(
            "read_my_trades",
            "Read this user's recent decisions (trades placed and markets passed, "
            "with reasons, edge, confidence). Use to answer 'what did you trade'.",
            {"limit": {"type": "integer"}},
            [],
        ),
        "handler": _h_read_my_trades,
    },
    "propose_trade": {
        "schema": _fn(
            "propose_trade",
            "Prepare a buy for the user to confirm — sizes it against the live "
            "market and shows them a confirm card. This does NOT execute: the user "
            "reviews and approves in their own wallet. Use when the user asks to "
            "buy/take a position. Confirm the market and amount first if unclear.",
            {
                "market_address": {"type": "string"},
                "side": {"type": "string", "enum": ["yes", "no"]},
                "size_usdc": {"type": "number", "description": "USDC the user wants to spend"},
            },
            ["market_address", "side", "size_usdc"],
        ),
        "handler": _h_propose_trade,
    },
}


# Tool sets per phase (kept small so the model stays focused).
PLAN_TOOLS: tuple[str, ...] = (
    "read_platform_facts",
    "read_theses",
    "read_portfolio",
    "fetch_polymarket_odds",
    "check_trade",
    "write_thesis",
    "write_journal",
)
REFLECT_TOOLS: tuple[str, ...] = (
    "read_theses",
    "read_portfolio",
    "write_thesis",
    "write_journal",
)
# Chat set. Read tools + propose_trade (M3). propose_trade only PREPARES an
# order the user confirms in their own wallet — no execute tool exists here, so
# the agent can never move funds directly.
CHAT_TOOLS: tuple[str, ...] = (
    "read_platform_facts",
    "search_markets",
    "get_market",
    "read_portfolio",
    "read_theses",
    "read_journal",
    "read_my_trades",
    "fetch_polymarket_odds",
    "web_search",
    "propose_trade",
)


def tool_schemas(names: tuple[str, ...] | list[str]) -> list[dict[str, Any]]:
    return [TOOLS[n]["schema"] for n in names if n in TOOLS]


def dispatch(ctx: ToolContext, name: str, args: dict[str, Any]) -> tuple[Any, bool]:
    """Run tool `name` with `args`. Returns (result, is_error)."""
    spec = TOOLS.get(name)
    if spec is None:
        return {"error": f"unknown tool: {name}"}, True
    handler: Callable[..., dict[str, Any]] = spec["handler"]
    try:
        result = handler(ctx, **(args or {}))
        is_error = bool(isinstance(result, dict) and result.get("error"))
        return result, is_error
    except TypeError as e:
        return {"error": f"bad arguments for {name}: {e}"}, True
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}, True
