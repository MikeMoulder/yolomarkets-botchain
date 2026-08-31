# YOLO Markets — Agent Handoff

Updated: 2026-08-31
Workspace: `C:\Users\DELL\Documents\Projects\yolomarkets`

## Mainnet bootstrap update

The isolated BOT Chain mainnet bootstrap remains separate from the other VPS PM2 applications. The original full-contract prototype is retained as a legacy, read-only deployment; the requested production rollout is being prepared against a fresh clone factory.

- Chain: BOT Chain mainnet, chain ID `677`
- RPC: `https://rpc.botchain.ai`
- Explorer: `https://scan.botchain.ai`
- Settlement token: BOT mainnet USDT, `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C`
- Legacy full mainnet factory: `0x0104ADA9fb323D47966d2fF2205aA41D068C09Df`
- Factory admin: mainnet deployer `0x1Fc0a56Ead92760eE9f09C748F7B8cA0E9Eb45c9`
- Factory resolver: `0x85B5124e1f677Ba8FE858f43B2A955903a62B5Da`

Legacy market: `0x106d8a2b00d6a4D5b689172b6B5cCd84c80b3BCE`, seeded with `$0.10`.

The legacy market is unresolved and has a 2027-07-01 deadline. Its deployed contract has no pre-deadline cancellation or withdrawal path, so it cannot be scrapped or withdrawn now; attempting it would only waste gas.

Requested clone rollout:

- 15 current eligible testnet mirror markets, excluding the legacy Brooklyn question to avoid a duplicate, seeded with `$0.10` each
- BTC 1h and ETH 1h fast markets, seeded with `$0.50` each
- Total seed allocation: `$2.50`
- Fresh clone factory and clone markets; existing factories and unrelated PM2 processes remain untouched

The mainnet deployer started with `0.34946948 BOT` and `3.929614` settlement-token units. The clone factory was deployed at `0x78b9d155c15907a2dc0cddc090d68bb31021B730`; its deployment used `3,840,136` gas. One mirror was then created successfully at `0x6E35071D77A6aD41Cd3A4000a409848190b306D8`, seeded with `$0.10`. Its long metadata used `1,618,454` gas, so the remaining rollout needs more BOT than the short-criteria testnet estimate.

Current balances are `0.09783872 BOT` and `2.529614` settlement-token units. The two priority fast markets are live:

- BTC 1h: `0x61fb56BaBD028038af1d616B69315a4274da6fE8`, `$0.50` seed
- ETH 1h: `0xf7f7eB21b0dcF0B3E1654d184580fa98110E124f`, `$0.50` seed

The clone factory currently contains 6 markets: 4 mirrors (Clippers, Tottenham, Fed decrease, and Fed increase) plus the 2 fast markets. The Israel/Iran mirror was skipped because its `createMarket` simulation consistently reverts even with a 3,000,000 gas cap. The remaining mirror creations cannot safely fit in the current native balance; pause further mirror broadcasts until the deployer is topped up by approximately `0.35 BOT` to leave a retry/operations buffer.

The migration supports `MIGRATION_GAS_LIMIT` and `MIGRATION_EXCLUDE_QUESTIONS`. After the clone factory is deployed, the intended command is `npm run markets:migrate:testnet -- --live --limit 15 --seed-usdc 0.1` with the Brooklyn question excluded. Do not start the mainnet PM2 apps until the factory address is supplied to `YOLO_MAINNET_FACTORY_ADDRESS`. The isolated PM2 config is `scripts/vps/ecosystem.yolomarkets-mainnet.config.cjs`; its names are `yolomarkets-mainnet-web`, `yolomarkets-mainnet-fast-keeper`, and `yolomarkets-mainnet-polymarket-resolver`. A mainnet catalog indexer is intentionally not configured against the shared testnet database.

## Minimal-proxy testnet experiment

An isolated ERC-1167 clone implementation was deployed and exercised on Bohr testnet. The existing factories were not changed.

- Current experimental clone factory: `0x898054039BC6D40763279340a5111D5C9a0A65e3`
- Shared implementation: `0x45Faa1B1C0a4dCa2690cF31Ce1a120D5c01eCe9c`
- Current test clone markets: `0x62eA1Ae3cc88a7769E1B806dac2e77bb67Ff6C36` and `0x0D5c4C8Ea05db411e14772053b16B562F0AA1042`
- Previous experimental factory `0x5C09829Bf2894244c5C78f97cF6D2fd3628816fD` and its two test markets remain on testnet but are superseded.
- Both were initialized with `0.1` test USDT and verified on-chain.
- Clone creation used `483,186` and `466,086` gas versus approximately `3.9M` gas for the full-contract mainnet creation.
- The fast-market keeper ran against the current clone factory, created BTC 1h and ETH 1h markets, completed its 2/2 live-set check, and ran the residual scan.
- The web viem path approved, bought, and sold 10,000 shares on `0x1719dFB87abB5E977F03312fF943c54a50dB355D`; the market remains live with `tradeCount=2` and `totalLiquidity=100101` raw test USDT units.
- A testnet-built Next.js market route rendered the live clone question with HTTP 200.

The implementation and factory have unit coverage for initialization protection, deterministic addresses, trading, resolution, and role separation. The clone path has also passed live testnet keeper creation, web catalog/detail reads, and buy/sell smoke testing. Mainnet clone deployment has begun with one mirror and the two priority fast markets live. The isolated mainnet fast keeper is the only production service currently intended to run; the remaining mirror rollout and broader PM2 launch await funding.

Local web development is now configured for the mainnet clone factory in `web/.env.local` (chain `677`, mainnet token, legacy catalog disabled). Vercel has not been changed. A non-secret deployment template is available at `web/vercel-mainnet.env.example`; set its values in the Vercel project before a mainnet redeploy. The on-demand wallet insight fee is configured as `0.2 USDT` per query in both client and server paths.

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
- Clone experiment: 9 dedicated tests; full Solidity suite now 75 passed
- `npm run lint`: 0 errors; 3 pre-existing warnings
- `npx tsc --noEmit`: passed
- Mainnet production build: passed with the mainnet network configuration
- Live clone factory and market reads: passed through the existing `listMarkets`, `getMarket`, and direct revenue-read paths
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
7. ~~Replace hardcoded `scan.bohr.life` links with the active network explorer.~~ Completed; UI links now use the active chain.
8. ~~Verify/update the mainnet Multicall3 address; direct-read fallbacks should remain available.~~ Completed; mainnet uses BOT's deployed Multicall3 and Bohr revenue reads now have a direct-read fallback.
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
