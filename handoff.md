# YOLO Markets — Agent Handoff

Updated: 2026-08-31
Workspace: `C:\Users\DELL\Documents\Projects\yolomarkets`

## Current state

The project is functional on Bohr/BOT testnet, not mainnet.

- Chain: Bohr Testnet, chain ID `968`
- RPC: `https://rpc.bohr.life`
- Explorer: `https://scan.bohr.life`
- Settlement token currently used: `0x75edC9335175Fc0552D51D48439F229c10420fe3`
- Primary protected factory: `0x4318E2D364Eec2146653c83E413d3eB81A699604`
- Original legacy factory: `0x32221b857E3D07294b44c80E01D292Df95C28f97`
- Intermediate rollover-only factory: `0x79b69e901DE7beCf09a2B660B9E23780155Ed22A`

The primary factory contains 24 markets:

- 2 active fast markets: BTC 15m and ETH 15m
- 20 Polymarket wrapper markets, created with `$0.20` seed each
- Former 1h fast markets were cancelled after configuration changed; `$2` seed was recovered

Current fast configuration in `.env`:

```env
FAST_MARKET_SEED_USDC=1
FAST_MARKET_SYMBOLS=BTC,ETH
FAST_MARKET_WINDOWS=15m
CATALOG_INCLUDE_LEGACY=1
```

The fast keeper was started with a 30-second poll interval. Verify that it is still running before assuming settlement automation is active.

## Implemented architecture

- `PredictionMarket.sol`
  - Empty expired rounds can be rolled over in-place.
  - Seed stays in the market during rollover, avoiding cancel/withdraw/redeploy gas.
  - Any trading activity prevents rollover.
  - Buy/sell price band is enforced at `2%–98%`; crossing orders revert atomically.
  - Treasury withdrawals are limited to balance minus required user reserves.
- `MarketFactory.sol`
  - Supports `rolloverMarket`.
  - Separates admin and resolver roles.
- `fast-market-keeper.ts`
  - Maintains only configured symbol/timeframe pairs.
  - Retires unconfigured empty fast markets as cancelled instead of rolling them forever.
  - Uses direct reads when Bohr lacks Multicall3.
- `polymarket-wrap.ts`
  - Wraps active binary Polymarket markets into new YoloMarkets LMSR markets.
  - Stores Polymarket slug/resolution metadata; it does not copy Polymarket odds.
  - Supports `--min-days-until` to avoid near-expiry candidates.
- UI
  - Displays precise prices such as `97.6¢`, avoiding misleading `100¢` rounding.
- Legacy catalog
  - `CATALOG_INCLUDE_LEGACY=1` exposes still-open legacy markets.
  - Legacy scan uses direct reads on Bohr.

## Wallets

`web/scripts/generate-mainnet-wallets.ts` was added and run through:

```bash
npm run wallets:mainnet:generate
```

It appended separate mainnet credentials to the ignored root `.env` without printing private keys.

Public addresses:

- Mainnet deployer/bootstrap: `0x1Fc0a56Ead92760eE9f09C748F7B8cA0E9Eb45c9`
- Mainnet resolver: `0x85B5124e1f677Ba8FE858f43B2A955903a62B5Da`
- `MAINNET_TREASURY_ADDRESS` is intentionally blank.

Never print or paste the `MAINNET_*_PRIVATE_KEY` values. The existing testnet `DEPLOYER_PRIVATE_KEY` was not overwritten.

Treasury should be a multisig/cold wallet address, not another hot private key.

## Verification completed

- `forge test`: 66 passed
- `npm run lint`: 0 errors; 3 pre-existing warnings
- TypeScript has pre-existing Drizzle declaration errors. Changed market/UI files had no new targeted errors.
- Protected factory was verified on-chain with four initial markets at 50% and constants:
  - `MIN_PRICE_YES = 2e16` (2%)
  - `MAX_PRICE_YES = 98e16` (98%)
- Polymarket wrapper deployment completed 20/20 transactions successfully.

## Mainnet blockers / next work

1. Select a production treasury/admin multisig and set `MAINNET_TREASURY_ADDRESS`.
2. Wire treasury withdrawals to `MAINNET_TREASURY_ADDRESS`; current admin UI still defaults to `DEPLOYER_ADDRESS`.
3. Confirm the official BOT Chain mainnet settlement token before using real funds. Do not reuse the Bohr token.
4. Prepare a network-specific mainnet env:

   ```env
   NEXT_PUBLIC_CHAIN_ID=677
   BOTCHAIN_RPC_URL=https://rpc.botchain.ai
   SETTLEMENT_TOKEN_ADDRESS=<verified-mainnet-token>
   NEXT_PUBLIC_SETTLEMENT_TOKEN_ADDRESS=<verified-mainnet-token>
   NEXT_PUBLIC_FACTORY_ADDRESS=<new-mainnet-factory>
   ```

5. Deploy a fresh mainnet factory. Do not reuse any testnet factory address.
6. Deploy with multisig admin and limited resolver role, or transfer admin immediately after bootstrap using the factory’s two-step admin transfer.
7. Replace hardcoded `scan.bohr.life` links with the active network explorer.
8. Verify/update the mainnet Multicall3 address; direct-read fallbacks should remain available.
9. Fix/verify `polymarket-resolution-keeper.ts` for Bohr/mainnet reads. It currently uses `multicall` for market-row reads and was not started because it can execute settlement transactions.
10. Initialize the Postgres catalog and run the indexer:

    ```bash
    cd web
    npm run markets:catalog:indexer -- --once
    npm run markets:catalog:indexer
    ```

11. Re-scan Polymarket immediately before launch; current candidate slugs are time-sensitive.
12. Run mainnet smoke tests: create, buy, sell, price-band rejection, resolution, claims, cancellation refunds, reserve protection, and treasury withdrawal.
13. Obtain legal/compliance review before enabling real-money public trading.

## Mainnet operational model

- Admin/multisig: creates markets, controls roles, withdraws only surplus.
- Resolver hot wallet: resolves markets only; cannot move treasury funds.
- Treasury multisig: receives withdrawable surplus.
- Fast keeper: recycles empty fast rounds; retires removed configurations.
- Polymarket resolver keeper: resolves mirrors only after Polymarket finality.
- Catalog indexer: keeps the web catalog fast and current.

Do not switch `NEXT_PUBLIC_CHAIN_ID` to `677` until the mainnet token, factory, roles, explorer links, resolver, and treasury are all configured and verified.
