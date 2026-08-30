// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";

/// 6-decimal mock USDC, matching Arc's ERC-20 interface.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract PredictionMarketTest is Test {
    MockUSDC internal usdc;
    PredictionMarket internal mkt;

    address internal admin = address(0xA);
    address internal treasury = address(0xB);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256 internal constant SEED = 100e6; // 100 USDC initial liquidity
    uint256 internal constant DEADLINE_OFFSET = 7 days;
    uint256 internal deadline;

    function setUp() public {
        usdc = new MockUSDC();
        deadline = block.timestamp + DEADLINE_OFFSET;

        // treasury seeds the market with 100 USDC
        usdc.mint(treasury, SEED);
        vm.prank(treasury);
        usdc.approve(_predictAddress(treasury), SEED);

        vm.prank(treasury);
        mkt = new PredictionMarket(
            usdc,
            admin,
            deadline,
            SEED,
            "Will it rain tomorrow?",
            "Weather",
            "Resolves YES if NWS reports >= 0.01in precipitation."
        );

        // Give Alice and Bob plenty of USDC to trade with
        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(mkt), type(uint256).max);
    }

    /// Predicts the address of a contract deployed next by `who` (nonce-based).
    /// Required because the market pulls USDC from msg.sender in its constructor.
    function _predictAddress(address who) internal view returns (address) {
        return vm.computeCreateAddress(who, vm.getNonce(who));
    }

    // ── State ────────────────────────────────────────────────────────────────

    function test_initialState() public view {
        assertEq(
            uint8(mkt.outcome()),
            uint8(PredictionMarket.Outcome.Unresolved)
        );
        assertFalse(mkt.resolved());
        assertEq(mkt.initialLiquidity(), SEED);
        assertEq(mkt.totalLiquidity(), SEED);
        // p(YES) = 0.5 with qY = qN = 0
        int256 p = mkt.priceYes();
        assertApproxEqAbs(p, 0.5e18, 1e6);
    }

    // ── Buy ──────────────────────────────────────────────────────────────────

    function test_buyYesMovesPriceUp() public {
        vm.prank(alice);
        uint256 cost = mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);

        assertGt(cost, 0);
        assertLt(cost, 10e6); // can't pay more than payout per share
        assertGt(mkt.priceYes(), 0.5e18);
        assertEq(mkt.sharesYes(alice), 10e6);
        assertEq(mkt.totalSharesYes(), 10e6);
        assertEq(mkt.tradeCount(), 1);
    }

    function test_buyNoMovesPriceDown() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.No, 10e6, 10e6);
        assertLt(mkt.priceYes(), 0.5e18);
        assertEq(mkt.sharesNo(alice), 10e6);
    }

    function test_symmetricBuysHaveSymmetricCost() public {
        vm.prank(alice);
        uint256 costYes = mkt.buy(PredictionMarket.Outcome.Yes, 5e6, 5e6);
        // reset state by selling
        vm.prank(alice);
        mkt.sell(PredictionMarket.Outcome.Yes, 5e6, 0);

        vm.prank(bob);
        uint256 costNo = mkt.buy(PredictionMarket.Outcome.No, 5e6, 5e6);
        assertApproxEqAbs(costYes, costNo, 2); // within 2 micro-USDC rounding
    }

    function test_previewMatchesBuy() public {
        uint256 preview = mkt.previewBuy(PredictionMarket.Outcome.Yes, 7e6);
        vm.prank(alice);
        uint256 actual = mkt.buy(PredictionMarket.Outcome.Yes, 7e6, preview);
        assertEq(actual, preview);
    }

    function test_slippageBlocksBuy() public {
        uint256 preview = mkt.previewBuy(PredictionMarket.Outcome.Yes, 10e6);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.Slippage.selector);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, preview - 1);
    }

    function test_buyZeroSharesReverts() public {
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.ZeroShares.selector);
        mkt.buy(PredictionMarket.Outcome.Yes, 0, 0);
    }

    function test_buyAfterDeadlineReverts() public {
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.PastDeadline.selector);
        mkt.buy(PredictionMarket.Outcome.Yes, 1e6, 1e6);
    }

    // ── Sell ─────────────────────────────────────────────────────────────────

    function test_sellReversesPrice() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);
        int256 pAfterBuy = mkt.priceYes();

        vm.prank(alice);
        mkt.sell(PredictionMarket.Outcome.Yes, 10e6, 0);
        int256 pAfterSell = mkt.priceYes();

        assertGt(pAfterBuy, 0.5e18);
        assertApproxEqAbs(pAfterSell, 0.5e18, 1e6);
    }

    function test_previewMatchesSell() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);

        uint256 preview = mkt.previewSell(PredictionMarket.Outcome.Yes, 5e6);
        vm.prank(alice);
        uint256 actual = mkt.sell(PredictionMarket.Outcome.Yes, 5e6, preview);
        assertEq(actual, preview);
        assertEq(mkt.tradeCount(), 2);
    }

    function test_sellInsufficientReverts() public {
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.InsufficientShares.selector);
        mkt.sell(PredictionMarket.Outcome.Yes, 1, 0);
    }

    function test_sellSlippageReverts() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);
        uint256 preview = mkt.previewSell(PredictionMarket.Outcome.Yes, 5e6);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.Slippage.selector);
        mkt.sell(PredictionMarket.Outcome.Yes, 5e6, preview + 1);
    }

    // ── Resolve ──────────────────────────────────────────────────────────────

    function test_resolveOnlyByAdmin() public {
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NotAdmin.selector);
        mkt.resolve(PredictionMarket.Outcome.Yes);
    }

    function test_resolveBeforeDeadlineReverts() public {
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.BeforeDeadline.selector);
        mkt.resolve(PredictionMarket.Outcome.Yes);
    }

    function test_resolveTwiceReverts() public {
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Yes);
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.AlreadyResolved.selector);
        mkt.resolve(PredictionMarket.Outcome.No);
    }

    function test_resolveUnresolvedOutcomeReverts() public {
        vm.warp(deadline + 1);
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.BadOutcome.selector);
        mkt.resolve(PredictionMarket.Outcome.Unresolved);
    }

    function test_rolloverNoTradeKeepsSeedAndMarketLive() public {
        uint256 oldDeadline = mkt.deadline();
        uint256 nextDeadline = oldDeadline + 1 days;

        vm.warp(oldDeadline + 1);
        vm.prank(admin);
        mkt.rollover(
            nextDeadline,
            "Will it rain in the next round?",
            "Weather",
            "Resolves YES if NWS reports precipitation."
        );

        assertFalse(mkt.resolved());
        assertEq(mkt.roundId(), 2);
        assertEq(mkt.deadline(), nextDeadline);
        assertEq(mkt.question(), "Will it rain in the next round?");
        assertEq(mkt.totalLiquidity(), SEED);
        assertEq(mkt.tradeCount(), 0);
    }

    function test_rolloverAfterTradeReverts() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 1e6, 1e6);

        vm.warp(deadline + 1);
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.HasTradingActivity.selector);
        mkt.rollover(
            deadline + 1 days,
            "Overwritten?",
            "Weather",
            "Must not be accepted."
        );
    }

    function test_resolveCancelledOutcomeOk() public {
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Cancelled);

        assertTrue(mkt.resolved());
        assertEq(
            uint8(mkt.outcome()),
            uint8(PredictionMarket.Outcome.Cancelled)
        );
        assertEq(mkt.reserveRequired(), 0);
        assertEq(mkt.treasuryWithdrawable(), SEED);
    }

    function test_buyAfterResolveReverts() public {
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Yes);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.AlreadyResolved.selector);
        mkt.buy(PredictionMarket.Outcome.Yes, 1e6, 1e6);
    }

    // ── Treasury ─────────────────────────────────────────────────────────────

    function test_withdrawTreasuryBeforeResolveReverts() public {
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.NotResolved.selector);
        mkt.withdrawTreasury(admin, 1);
    }

    function test_withdrawTreasuryAfterCancelledResolveOk() public {
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Cancelled);

        uint256 adminBalBefore = usdc.balanceOf(admin);
        vm.prank(admin);
        mkt.withdrawTreasury(admin, SEED);

        assertEq(usdc.balanceOf(admin) - adminBalBefore, SEED);
        assertEq(mkt.totalLiquidity(), 0);
    }

    // ── Claim ────────────────────────────────────────────────────────────────

    function test_winningShareholdersClaim() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);
        vm.prank(bob);
        mkt.buy(PredictionMarket.Outcome.No, 10e6, 10e6);

        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Yes);

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 claimed = mkt.claim();
        assertEq(claimed, 10e6);
        assertEq(usdc.balanceOf(alice) - aliceBalBefore, 10e6);

        // Bob has nothing to claim
        vm.prank(bob);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        mkt.claim();
    }

    function test_claimBeforeResolveReverts() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 1e6, 1e6);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NotResolved.selector);
        mkt.claim();
    }

    function test_claimOnCancelledMarketReverts() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 5e6, 5e6);
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Cancelled);

        vm.prank(alice);
        vm.expectRevert(PredictionMarket.MarketCancelled.selector);
        mkt.claim();
    }

    function test_claimTwiceReverts() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 5e6, 5e6);
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Yes);

        vm.prank(alice);
        mkt.claim();
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        mkt.claim();
    }

    // ── Cancellation refunds (audit H-2) ──────────────────────────────────────

    /// After a Cancelled resolution, traders recover their net at-risk USDC and
    /// the admin can only take the seed + fees — never user principal.
    function test_cancelRefundsTradersAndProtectsPrincipal() public {
        uint256 aliceCost;
        uint256 bobCost;
        vm.prank(alice);
        aliceCost = mkt.buy(PredictionMarket.Outcome.Yes, 30e6, 100e6);
        vm.prank(bob);
        bobCost = mkt.buy(PredictionMarket.Outcome.No, 20e6, 100e6);

        assertEq(mkt.costBasis(alice), aliceCost);
        assertEq(mkt.costBasis(bob), bobCost);
        assertEq(mkt.totalCostBasis(), aliceCost + bobCost);

        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Cancelled);

        // Treasury is fenced off from user principal: only the surplus above
        // outstanding refunds (here the seed) is withdrawable.
        assertEq(mkt.treasuryWithdrawable(), SEED);

        // Each trader recovers exactly what they put in.
        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 aRefund = mkt.claimRefund();
        assertEq(aRefund, aliceCost);
        assertEq(usdc.balanceOf(alice) - aBefore, aliceCost);

        uint256 bBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        uint256 bRefund = mkt.claimRefund();
        assertEq(bRefund, bobCost);
        assertEq(usdc.balanceOf(bob) - bBefore, bobCost);

        assertEq(mkt.totalCostBasis(), 0);
        // Admin recovers the seed, contract fully drained.
        vm.prank(admin);
        mkt.withdrawTreasury(admin, SEED);
        assertEq(mkt.totalLiquidity(), 0);
    }

    /// The admin cannot withdraw user principal on a cancelled market.
    function test_cancelTreasuryCannotSeizePrincipal() public {
        vm.prank(alice);
        uint256 cost = mkt.buy(PredictionMarket.Outcome.Yes, 40e6, 100e6);

        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Cancelled);

        // Balance = seed + alice's cost; only `seed` is withdrawable.
        assertEq(mkt.treasuryWithdrawable(), SEED);
        assertEq(mkt.totalLiquidity(), SEED + cost);

        // Trying to take the whole balance (incl. principal) reverts.
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.InsufficientReserves.selector);
        mkt.withdrawTreasury(admin, SEED + cost);

        // Even one micro-USDC above the surplus reverts.
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.InsufficientReserves.selector);
        mkt.withdrawTreasury(admin, SEED + 1);
    }

    /// Selling reduces refundable basis; a profitable exit leaves nothing owed.
    function test_sellReducesRefundBasis() public {
        vm.prank(alice);
        uint256 cost = mkt.buy(PredictionMarket.Outcome.Yes, 20e6, 100e6);
        vm.prank(alice);
        uint256 received = mkt.sell(PredictionMarket.Outcome.Yes, 10e6, 0);
        // Sold at a loss vs. half the basis is not guaranteed; basis drops by
        // exactly the proceeds (clamped at 0).
        uint256 expectedBasis = received < cost ? cost - received : 0;
        assertEq(mkt.costBasis(alice), expectedBasis);
        assertEq(mkt.totalCostBasis(), expectedBasis);
    }

    function test_claimRefundOnNonCancelledReverts() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 5e6, 100e6);
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Yes);

        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NotCancelled.selector);
        mkt.claimRefund();
    }

    function test_claimRefundTwiceReverts() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 5e6, 100e6);
        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Cancelled);

        vm.prank(alice);
        mkt.claimRefund();
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NothingToRefund.selector);
        mkt.claimRefund();
    }

    // ── Solvency invariant ───────────────────────────────────────────────────

    /// After resolution, contract must hold at least total winning shares in USDC.
    function test_solvency_yesWins() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);
        vm.prank(bob);
        mkt.buy(PredictionMarket.Outcome.No, 8e6, 8e6);
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 4e6, 4e6);

        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.Yes);

        assertGe(
            mkt.totalLiquidity(),
            mkt.totalSharesYes(),
            "insolvent vs YES"
        );
    }

    function test_solvency_noWins() public {
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);
        vm.prank(bob);
        mkt.buy(PredictionMarket.Outcome.No, 25e6, 25e6);

        vm.warp(deadline + 1);
        vm.prank(admin);
        mkt.resolve(PredictionMarket.Outcome.No);

        assertGe(mkt.totalLiquidity(), mkt.totalSharesNo(), "insolvent vs NO");
    }

    function test_priceBandRejectsBuyThatWouldReachExtreme() public {
        // A single oversized order must fail atomically instead of moving the
        // thin market to an apparent 100% probability.
        vm.expectRevert();
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 1_000e6, type(uint256).max);

        assertEq(mkt.priceYes(), 0.5e18);
        assertEq(mkt.tradeCount(), 0);
        assertEq(mkt.totalSharesYes(), 0);
    }

    function test_priceBandRejectsBuyThatWouldReachZero() public {
        vm.expectRevert();
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.No, 1_000e6, type(uint256).max);

        assertEq(mkt.priceYes(), 0.5e18);
        assertEq(mkt.tradeCount(), 0);
        assertEq(mkt.totalSharesNo(), 0);
    }

    // ── Fuzz ─────────────────────────────────────────────────────────────────

    /// Random buys keep price strictly in (0, 1e18).
    function testFuzz_priceBounded(uint96 yShares, uint96 nShares) public {
        // Bound to avoid exp() overflow: qYes/b < 100 → shares < 100*b/1e12 ≈ 14kUSDC
        yShares = uint96(bound(uint256(yShares), 0, 20e6));
        nShares = uint96(bound(uint256(nShares), 0, 20e6));

        usdc.mint(alice, 10_000e6);

        if (yShares > 0) {
            uint256 c = mkt.previewBuy(PredictionMarket.Outcome.Yes, yShares);
            vm.assume(c < usdc.balanceOf(alice));
            vm.prank(alice);
            mkt.buy(PredictionMarket.Outcome.Yes, yShares, c);
        }
        if (nShares > 0) {
            uint256 c = mkt.previewBuy(PredictionMarket.Outcome.No, nShares);
            vm.assume(c < usdc.balanceOf(alice));
            vm.prank(alice);
            mkt.buy(PredictionMarket.Outcome.No, nShares, c);
        }

        int256 p = mkt.priceYes();
        assertGe(p, mkt.MIN_PRICE_YES());
        assertLe(p, mkt.MAX_PRICE_YES());
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    function test_constructorRejectsPastDeadline() public {
        usdc.mint(treasury, SEED);
        vm.startPrank(treasury);
        usdc.approve(_predictAddress(treasury), SEED);
        vm.expectRevert(bytes("deadline in past"));
        new PredictionMarket(
            usdc,
            admin,
            block.timestamp,
            SEED,
            "Q?",
            "C",
            "R"
        );
        vm.stopPrank();
    }

    function test_constructorRejectsZeroLiquidity() public {
        vm.startPrank(treasury);
        vm.expectRevert(bytes("no liquidity"));
        new PredictionMarket(
            usdc,
            admin,
            block.timestamp + 1 days,
            0,
            "Q?",
            "C",
            "R"
        );
        vm.stopPrank();
    }
}
