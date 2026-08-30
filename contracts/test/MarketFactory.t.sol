// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract MarketFactoryTest is Test {
    MockUSDC internal usdc;
    MarketFactory internal factory;

    address internal admin = address(0xA);
    address internal resolver = address(0xC);
    address internal stranger = address(0xB0B);

    uint256 internal constant SEED = 100e6;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new MarketFactory(usdc, admin, resolver);

        // Admin holds plenty of USDC and pre-approves the factory.
        usdc.mint(admin, 10_000e6);
        vm.prank(admin);
        usdc.approve(address(factory), type(uint256).max);
    }

    // ── Create ──────────────────────────────────────────────────────────────

    function _create(
        string memory q,
        uint256 horizon
    ) internal returns (address) {
        uint256 deadline = block.timestamp + horizon;
        vm.prank(admin);
        return
            factory.createMarket(
                q,
                "Crypto",
                "Resolves YES iff ...",
                deadline,
                SEED
            );
    }

    function test_createMarketDeploysAndRegisters() public {
        address m = _create("Q1?", 7 days);
        assertTrue(m != address(0));
        assertTrue(factory.isMarket(m));
        assertEq(factory.marketCount(), 1);
        assertEq(factory.markets(0), m);
        assertEq(factory.marketIndex(m), 1);
    }

    function test_createMarketSeedsCorrectly() public {
        address m = _create("Q2?", 5 days);
        PredictionMarket mkt = PredictionMarket(m);

        assertEq(mkt.initialLiquidity(), SEED);
        assertEq(mkt.totalLiquidity(), SEED);
        assertEq(usdc.balanceOf(m), SEED);
        assertEq(mkt.admin(), address(factory)); // factory is market admin
        assertEq(mkt.question(), "Q2?");
        // Price at qY=qN=0 is 0.5
        assertApproxEqAbs(mkt.priceYes(), 0.5e18, 1e6);
    }

    function test_predictMarketMatchesActual() public {
        uint256 deadline = block.timestamp + 3 days;
        address predicted = factory.predictMarket(
            "Q3?",
            "Tech",
            "criteria",
            deadline,
            SEED
        );
        vm.prank(admin);
        address actual = factory.createMarket(
            "Q3?",
            "Tech",
            "criteria",
            deadline,
            SEED
        );
        assertEq(actual, predicted);
    }

    function test_createMarketByStrangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.createMarket("Q?", "C", "R", block.timestamp + 1 days, SEED);
    }

    function test_duplicateQuestionAndDeadlineReverts() public {
        // Same (question, deadline) → same CREATE2 salt → collision
        uint256 deadline = block.timestamp + 2 days;
        vm.prank(admin);
        factory.createMarket("Same Q?", "C", "R", deadline, SEED);
        vm.prank(admin);
        vm.expectRevert(); // Create2 reverts on collision
        factory.createMarket("Same Q?", "C", "R", deadline, SEED);
    }

    function test_sameQuestionDifferentDeadlineOk() public {
        vm.startPrank(admin);
        factory.createMarket("Q?", "C", "R", block.timestamp + 1 days, SEED);
        factory.createMarket("Q?", "C", "R", block.timestamp + 2 days, SEED);
        vm.stopPrank();
        assertEq(factory.marketCount(), 2);
    }

    // ── Resolve ─────────────────────────────────────────────────────────────

    function test_factoryResolvesMarket() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(resolver);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);

        PredictionMarket mkt = PredictionMarket(m);
        assertTrue(mkt.resolved());
        assertEq(uint8(mkt.outcome()), uint8(PredictionMarket.Outcome.Yes));
    }

    function test_resolveByStrangerReverts() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(stranger);
        vm.expectRevert(MarketFactory.NotResolver.selector);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);
    }

    /// Admin holds funds but is NOT the resolver — it cannot settle markets.
    function test_resolveByAdminReverts() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(admin);
        vm.expectRevert(MarketFactory.NotResolver.selector);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);
    }

    /// Resolver settles markets but cannot move funds or create markets.
    function test_resolverCannotTouchFunds() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(resolver);
        factory.resolveMarket(m, PredictionMarket.Outcome.Cancelled);

        vm.prank(resolver);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.withdrawMarketTreasury(m, resolver, SEED);

        vm.prank(resolver);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.createMarket("X?", "C", "R", block.timestamp + 1 days, SEED);
    }

    function test_factoryCancelsMarket() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(resolver);
        factory.resolveMarket(m, PredictionMarket.Outcome.Cancelled);

        PredictionMarket mkt = PredictionMarket(m);
        assertTrue(mkt.resolved());
        assertEq(
            uint8(mkt.outcome()),
            uint8(PredictionMarket.Outcome.Cancelled)
        );
        assertEq(mkt.treasuryWithdrawable(), SEED);
    }

    function test_factoryRollsOverNoTradeWithoutMovingSeed() public {
        address m = _create("Q?", 1 days);
        uint256 nextDeadline = block.timestamp + 2 days;
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(resolver);
        factory.rolloverMarket(
            m,
            "Next Q?",
            "Crypto",
            "Next criteria",
            nextDeadline
        );

        PredictionMarket mkt = PredictionMarket(m);
        assertFalse(mkt.resolved());
        assertEq(mkt.roundId(), 2);
        assertEq(mkt.deadline(), nextDeadline);
        assertEq(mkt.question(), "Next Q?");
        assertEq(usdc.balanceOf(m), SEED);
        assertEq(factory.marketCount(), 1);
    }

    function test_factoryCannotRolloverAfterTrade() public {
        address m = _create("Q?", 1 days);
        address alice = address(0xA11CE);
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(m, type(uint256).max);
        vm.prank(alice);
        PredictionMarket(m).buy(PredictionMarket.Outcome.Yes, 1e6, 1e6);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(resolver);
        vm.expectRevert(PredictionMarket.HasTradingActivity.selector);
        factory.rolloverMarket(
            m,
            "Overwritten?",
            "Crypto",
            "Must not be accepted.",
            block.timestamp + 2 days
        );
    }

    function test_rolloverByAdminReverts() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(admin);
        vm.expectRevert(MarketFactory.NotResolver.selector);
        factory.rolloverMarket(
            m,
            "Next Q?",
            "Crypto",
            "Next criteria",
            block.timestamp + 2 days
        );
    }

    function test_withdrawMarketTreasuryBeforeResolveReverts() public {
        address m = _create("Q?", 1 days);

        vm.prank(admin);
        vm.expectRevert(PredictionMarket.NotResolved.selector);
        factory.withdrawMarketTreasury(m, admin, 1);
    }

    function test_resolveUnknownMarketReverts() public {
        vm.warp(block.timestamp + 1 days);
        vm.prank(resolver);
        vm.expectRevert(MarketFactory.UnknownMarket.selector);
        factory.resolveMarket(address(0xdead), PredictionMarket.Outcome.Yes);
    }

    function test_directMarketResolveByStrangerReverts() public {
        // Market admin is the factory now — even the factory's admin can't
        // call market.resolve() directly.
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.NotAdmin.selector);
        PredictionMarket(m).resolve(PredictionMarket.Outcome.Yes);
    }

    // ── Admin transfer (two-step) ─────────────────────────────────────────────

    function test_twoStepAdminTransfer() public {
        vm.prank(admin);
        factory.transferAdmin(stranger);
        // Not yet effective — admin unchanged until acceptance.
        assertEq(factory.admin(), admin);
        assertEq(factory.pendingAdmin(), stranger);

        vm.prank(stranger);
        factory.acceptAdmin();
        assertEq(factory.admin(), stranger);
        assertEq(factory.pendingAdmin(), address(0));

        // New admin can now create markets (with their own USDC + approval)
        usdc.mint(stranger, SEED);
        vm.prank(stranger);
        usdc.approve(address(factory), type(uint256).max);
        vm.prank(stranger);
        factory.createMarket("New?", "C", "R", block.timestamp + 1 days, SEED);
        assertEq(factory.marketCount(), 1);
    }

    function test_acceptAdminByNonPendingReverts() public {
        vm.prank(admin);
        factory.transferAdmin(stranger);
        vm.prank(address(0xDEAD));
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.acceptAdmin();
    }

    function test_transferAdminRejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(bytes("zero admin"));
        factory.transferAdmin(address(0));
    }

    function test_transferAdminByStrangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.transferAdmin(stranger);
    }

    // ── Resolver rotation ─────────────────────────────────────────────────────

    function test_setResolver() public {
        vm.prank(admin);
        factory.setResolver(stranger);
        assertEq(factory.resolver(), stranger);

        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        // Old resolver can no longer settle.
        vm.prank(resolver);
        vm.expectRevert(MarketFactory.NotResolver.selector);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);
        // New resolver can.
        vm.prank(stranger);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);
        assertTrue(PredictionMarket(m).resolved());
    }

    function test_setResolverByStrangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.setResolver(stranger);
    }

    // ── End-to-end ──────────────────────────────────────────────────────────

    function test_e2e_createBuyResolveClaim() public {
        address m = _create("BTC > 100k?", 1 days);
        PredictionMarket mkt = PredictionMarket(m);

        // Alice buys 10 USDC of YES
        address alice = address(0xA11CE);
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(m, type(uint256).max);
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);

        // Time passes; resolver settles via factory
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(resolver);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);

        // Alice claims 10 USDC
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 claimed = mkt.claim();
        assertEq(claimed, 10e6);
        assertEq(usdc.balanceOf(alice) - balBefore, 10e6);
    }
}
