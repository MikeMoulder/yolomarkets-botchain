"""Circle Developer-Controlled Wallets client for the YOLO Markets agent.

Developer-Controlled wallets are the right choice for the autonomous agent:
  · User is offline when the agent executes — no PIN challenge possible
  · The server holds the signing authority via Circle's MPC, authenticated
    with the entity secret (same credential used in the web side)
  · On Arc the wallet pays its own gas out of its USDC balance, because USDC
    IS the gas token. Gas Station is NOT used and is not needed here.

Wallet lifecycle per user:
  1. create_agent_wallet(user_addr) → wallet_id + address, stored in DB
  2. execute_contract_call(wallet_id, ...) → Circle broadcasts the tx
  3. get_wallet_balance(wallet_id) → USDC balance for bankroll calculations

All Circle API calls are authenticated with:
  · CIRCLE_API_KEY  — Bearer token
  · entitySecretCiphertext — entity secret encrypted with Circle's project
    RSA public key; recomputed per request (Circle rotates it server-side)

The same entity secret is used here as in web/lib/circle.ts — one secret
covers all Circle operations for the project.

Environment variables required:
  CIRCLE_API_KEY       — from console.circle.com
  CIRCLE_ENTITY_SECRET — 64 hex chars; see CIRCLE_SETUP.md
  CIRCLE_WALLET_SET_ID — Developer-Controlled Wallets wallet set ID
  CIRCLE_BLOCKCHAIN    — defaults to ARC-TESTNET
  CIRCLE_GAS_STATION_POLICY — optional; policy ID for Gas Station sponsorship
  TREASURY_ADDRESS     — platform treasury EOA for fee collection
"""

from __future__ import annotations

import base64
import os
import uuid
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

CIRCLE_BASE = "https://api.circle.com/v1/w3s"

# Scan quota consumed per brain run. Must match economics.md.
BRAIN_CREDITS: dict[str, int] = {
    "economy": 1,
    "standard": 1,
    "premium": 1,
}

# Protocol fee charged per trade (0.3%, expressed as a fraction).
PROTOCOL_FEE_RATE = 0.003
# Minimum fee in USDC 6-dec units ($0.01).
PROTOCOL_FEE_MIN_MICRO = 10_000  # $0.01

# Monthly subscription prices in USDC 6-dec units.
SUBSCRIPTION_PRICE: dict[str, int] = {
    "free": 0,
    "pro": 5_000_000,      # $5.00
    "plus": 20_000_000,    # $20.00
}

# Daily included scan quota per tier.
FREE_CREDITS_PER_TIER: dict[str, int] = {
    "free": 100,
    "pro": 200,
    "plus": 500,
}


# ── Entity-secret helpers (mirrors web/lib/circle.ts) ─────────────────────

_project_public_key: str | None = None


def _get_project_public_key(api_key: str) -> str:
    global _project_public_key
    if _project_public_key:
        return _project_public_key
    resp = httpx.get(
        f"{CIRCLE_BASE}/config/entity/publicKey",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=15,
    )
    resp.raise_for_status()
    pem: str = resp.json()["data"]["publicKey"]
    _project_public_key = pem
    return pem


def _encrypt_entity_secret(api_key: str) -> str:
    """RSA-OAEP-SHA256 encrypt the 32-byte entity secret; return base64."""
    secret_hex = os.environ.get("CIRCLE_ENTITY_SECRET", "")
    if len(secret_hex) != 64:
        raise RuntimeError(
            "CIRCLE_ENTITY_SECRET must be 64 hex chars — see CIRCLE_SETUP.md"
        )
    plain = bytes.fromhex(secret_hex)
    pem = _get_project_public_key(api_key)
    pub_key = serialization.load_pem_public_key(pem.encode())
    ciphertext = pub_key.encrypt(  # type: ignore[union-attr]
        plain,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return base64.b64encode(ciphertext).decode()


def _api_key() -> str:
    k = os.environ.get("CIRCLE_API_KEY", "")
    if not k:
        raise RuntimeError("CIRCLE_API_KEY not set — see CIRCLE_SETUP.md")
    return k


def _blockchain() -> str:
    return os.environ.get("CIRCLE_BLOCKCHAIN", "BOTCHAIN-TESTNET")


def _wallet_set_id() -> str:
    wallet_set_id = os.environ.get("CIRCLE_WALLET_SET_ID", "").strip()
    if not wallet_set_id:
        raise RuntimeError(
            "CIRCLE_WALLET_SET_ID not set — create/copy a Developer Wallets "
            "wallet set ID in Circle Console"
        )
    return wallet_set_id


# ── Low-level HTTP helpers ─────────────────────────────────────────────────

def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    api_key = _api_key()
    resp = httpx.post(
        f"{CIRCLE_BASE}{path}",
        json=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        timeout=30,
    )
    if not resp.is_success:
        raise RuntimeError(
            f"Circle POST {path} → {resp.status_code}: {resp.text[:300]}"
        )
    return resp.json()


def _get(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    resp = httpx.get(
        f"{CIRCLE_BASE}{path}",
        params=params,
        headers={"Authorization": f"Bearer {_api_key()}"},
        timeout=15,
    )
    if not resp.is_success:
        raise RuntimeError(
            f"Circle GET {path} → {resp.status_code}: {resp.text[:300]}"
        )
    return resp.json()


# ── Developer-Controlled Wallet operations ────────────────────────────────

def create_agent_wallet(user_addr: str) -> dict[str, str]:
    """Provision a new Developer-Controlled wallet on Arc for `user_addr`.

    Returns:
        {"wallet_id": str, "address": str}

    The caller must persist both values in agent_profiles:
        · circle_wallet_id  → used for all subsequent Circle API calls
        · agent_address     → the on-chain address for USDC transfers / reads
    """
    api_key = _api_key()
    body = {
        "idempotencyKey": str(uuid.uuid5(uuid.NAMESPACE_DNS, f"agent-{user_addr.lower()}")),
        "walletSetId": _wallet_set_id(),
        "blockchains": [_blockchain()],
        # entitySecretCiphertext is required on all state-changing calls.
        "entitySecretCiphertext": _encrypt_entity_secret(api_key),
        # SCA (Smart Contract Account) is kept for the TRADING wallet because
        # it holds open market positions and account type is fixed at creation.
        #
        # Be aware of what it costs: an SCA cannot produce an EIP-3009
        # signature, so it can never pay Circle Nanopayments. That is why each
        # profile also carries a separate EOA payments wallet (migration 0012).
        # SCA was originally chosen for Gas Station support, which this project
        # does not use — on Arc the wallet pays its own gas in USDC.
        "accountType": "SCA",
        # Metadata tag helps identify wallets in the Circle Console.
        "metadata": [{"name": "yolo_user", "value": user_addr.lower()}],
        "count": 1,
    }
    data = _post("/developer/wallets", body)
    wallets: list[dict] = data["data"]["wallets"]
    if not wallets:
        raise RuntimeError("Circle returned empty wallets list on creation")
    w = wallets[0]
    return {"wallet_id": w["id"], "address": w["address"]}


def get_wallet(wallet_id: str) -> dict[str, Any]:
    """Fetch wallet details (address, state, blockchain) by wallet ID."""
    data = _get(f"/wallets/{wallet_id}")
    return data["data"]["wallet"]


def get_wallet_usdc_balance(wallet_id: str) -> float:
    """Return the USDC balance of the wallet as a float (6-dec → human).

    Returns 0.0 on any error so the runner can gracefully paper-trade
    rather than crashing when Circle is unreachable.
    """
    try:
        data = _get(f"/wallets/{wallet_id}/balances")
        for token in data.get("data", {}).get("tokenBalances", []):
            symbol: str = (
                token.get("token", {}).get("symbol", "")
                or token.get("token", {}).get("name", "")
            ).upper()
            if "USDC" in symbol:
                return float(token["amount"])
        return 0.0
    except Exception:
        return 0.0


def execute_contract_call(
    *,
    wallet_id: str,
    contract_address: str,
    abi_function_signature: str,
    abi_parameters: list[Any],
    idempotency_key: str | None = None,
    fee_level: str = "MEDIUM",
) -> str:
    """Send a contract-execution transaction from a Developer-Controlled wallet.

    Gas Station sponsorship is applied automatically when
    CIRCLE_GAS_STATION_POLICY is set (developer Console policy ID).

    Returns the Circle transaction ID (not the on-chain hash — poll
    get_transaction_status() to obtain the hash once mined).
    """
    api_key = _api_key()
    body: dict[str, Any] = {
        "idempotencyKey": idempotency_key or str(uuid.uuid4()),
        "walletId": wallet_id,
        "contractAddress": contract_address,
        "abiFunctionSignature": abi_function_signature,
        "abiParameters": abi_parameters,
        "feeLevel": fee_level,
        "entitySecretCiphertext": _encrypt_entity_secret(api_key),
    }
    policy_id = os.environ.get("CIRCLE_GAS_STATION_POLICY")
    if policy_id:
        body["feePayerPolicyId"] = policy_id

    data = _post("/developer/transactions/contractExecution", body)
    tx_id: str = data["data"]["id"]
    return tx_id


def transfer_usdc(
    *,
    wallet_id: str,
    destination_address: str,
    amount_micro: int,
    idempotency_key: str | None = None,
) -> str:
    """Transfer `amount_micro` USDC (6-dec units) from wallet to an address.

    Used for:
      · Protocol fee → treasury
      · Subscription auto-renewal → treasury
    Returns Circle transaction ID.
    """
    api_key = _api_key()
    # amount is a decimal string in "human" units (not micro) per Circle docs.
    amount_human = f"{amount_micro / 1_000_000:.6f}"
    body: dict[str, Any] = {
        "idempotencyKey": idempotency_key or str(uuid.uuid4()),
        "walletId": wallet_id,
        "destinationAddress": destination_address,
        "amounts": [amount_human],
        # USDC token address on Arc.
        "tokenAddress": os.environ.get(
            "USDC_ADDRESS", "0x3600000000000000000000000000000000000000"
        ),
        "blockchain": _blockchain(),
        "feeLevel": "MEDIUM",
        "entitySecretCiphertext": _encrypt_entity_secret(api_key),
    }
    policy_id = os.environ.get("CIRCLE_GAS_STATION_POLICY")
    if policy_id:
        body["feePayerPolicyId"] = policy_id

    data = _post("/developer/transactions/transfer", body)
    return data["data"]["id"]


def get_transaction_status(tx_id: str) -> dict[str, Any]:
    """Poll transaction status.  Returns the full transaction object.

    Relevant fields: state (INITIATED|PENDING_RISK_SCREENING|SENT|CONFIRMED|
    FAILED|CANCELLED), txHash (once CONFIRMED).
    """
    data = _get(f"/transactions/{tx_id}")
    return data["data"]["transaction"]


def wait_for_transaction(tx_id: str, poll_interval: float = 2.0, max_wait: float = 120.0) -> str:
    """Block until tx is CONFIRMED and return the on-chain hash.

    Raises RuntimeError if the tx FAILED, CANCELLED, or times out.
    """
    import time
    elapsed = 0.0
    terminal = {"CONFIRMED", "FAILED", "CANCELLED", "COMPLETE"}
    while elapsed < max_wait:
        tx = get_transaction_status(tx_id)
        state: str = tx.get("state", "")
        if state in terminal:
            if state not in ("CONFIRMED", "COMPLETE"):
                raise RuntimeError(
                    f"Circle tx {tx_id} ended in state {state}: {tx}"
                )
            return tx.get("txHash") or tx_id
        time.sleep(poll_interval)
        elapsed += poll_interval
    raise RuntimeError(f"Circle tx {tx_id} not confirmed after {max_wait}s")


# ── Fee helpers ────────────────────────────────────────────────────────────

def compute_protocol_fee(trade_amount_micro: int) -> int:
    """Return the platform protocol fee in USDC 6-dec units.

    0.3% of trade_amount_micro, floored at PROTOCOL_FEE_MIN_MICRO ($0.01).
    """
    fee = int(trade_amount_micro * PROTOCOL_FEE_RATE)
    return max(fee, PROTOCOL_FEE_MIN_MICRO)
