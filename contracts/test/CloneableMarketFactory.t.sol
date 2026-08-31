// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { CloneableMarketFactory } from "../src/CloneableMarketFactory.sol";
import { CloneablePredictionMarket } from "../src/CloneablePredictionMarket.sol";

contract CloneMockUSDC is ERC20 {
    constructor() ERC20("Clone Mock USDC", "cUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract CloneableMarketFactoryTest is Test {
    CloneMockUSDC internal usdc;
    CloneableMarketFactory internal factory;

    address internal admin = address(0xA);
    address internal resolver = address(0xC);
    address internal trader = address(0xB0B);

    uint256 internal constant SEED = 100e6;

    function setUp() public {
        usdc = new CloneMockUSDC();
        factory = new CloneableMarketFactory(usdc, admin, resolver);

        usdc.mint(admin, 10_000e6);
        vm.prank(admin);
        usdc.approve(address(factory), type(uint256).max);
    }

    function _create(string memory question) internal returns (address) {
        vm.prank(admin);
        return factory.createMarket(
            question, "Crypto", "Resolves YES iff ...", block.timestamp + 7 days, SEED
        );
    }

    function test_cloneFactoryDeploysAndInitializes() public {
        address market = _create("Will BTC rise?");
        CloneablePredictionMarket clone = CloneablePredictionMarket(market);

        assertTrue(factory.isMarket(market));
        assertEq(factory.marketCount(), 1);
        assertEq(address(clone.usdc()), address(usdc));
        assertEq(clone.admin(), address(factory));
        assertEq(clone.initialLiquidity(), SEED);
        assertEq(clone.totalLiquidity(), SEED);
        assertEq(clone.question(), "Will BTC rise?");
        assertEq(usdc.balanceOf(market), SEED);
        assertLt(market.code.length, 100);
    }

    function test_predictionMatchesClone() public {
        uint256 deadline = block.timestamp + 3 days;
        address predicted = factory.predictMarket("Q?", deadline);
        address compatiblePrediction = factory.predictMarket("Q?", "Crypto", "R", deadline, SEED);

        vm.prank(admin);
        address actual = factory.createMarket("Q?", "C", "R", deadline, SEED);

        assertEq(actual, predicted);
        assertEq(actual, compatiblePrediction);
    }

    function test_implementationCannotBeInitialized() public {
        CloneablePredictionMarket implementation =
            CloneablePredictionMarket(factory.implementation());

        vm.expectRevert(CloneablePredictionMarket.AlreadyInitialized.selector);
        implementation.initialize(
            usdc, address(factory), block.timestamp + 1 days, SEED, "Q?", "C", "R"
        );
    }

    function test_cloneCannotBeInitializedTwice() public {
        address market = _create("One-time initialization");
        vm.expectRevert(CloneablePredictionMarket.AlreadyInitialized.selector);
        CloneablePredictionMarket(market)
            .initialize(usdc, address(factory), block.timestamp + 1 days, SEED, "Changed", "C", "R");
    }

    function test_cloneStorageIsIsolated() public {
        address first = _create("First clone");
        address second = _create("Second clone");

        usdc.mint(trader, 100e6);
        vm.startPrank(trader);
        usdc.approve(first, type(uint256).max);
        CloneablePredictionMarket(first).buy(CloneablePredictionMarket.Outcome.Yes, 1e6, 100e6);
        vm.stopPrank();

        assertGt(
            CloneablePredictionMarket(first).totalSharesYes(),
            CloneablePredictionMarket(second).totalSharesYes()
        );
        assertEq(CloneablePredictionMarket(second).totalSharesYes(), 0);
        assertEq(CloneablePredictionMarket(second).question(), "Second clone");
        assertGt(CloneablePredictionMarket(first).totalLiquidity(), SEED);
        assertEq(CloneablePredictionMarket(second).totalLiquidity(), SEED);
    }

    function test_cloneRolloverRetainsSeed() public {
        address market = _create("Expired fast round");
        uint256 seedBefore = CloneablePredictionMarket(market).totalLiquidity();

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(resolver);
        factory.rolloverMarket(
            market, "New fast round", "Fast", "New criteria", block.timestamp + 1 hours
        );

        CloneablePredictionMarket clone = CloneablePredictionMarket(market);
        assertEq(clone.roundId(), 2);
        assertEq(clone.question(), "New fast round");
        assertEq(clone.totalLiquidity(), seedBefore);
        assertFalse(clone.resolved());
    }

    function test_cloneCancellationProtectsRefunds() public {
        address market = _create("Cancellation test");
        CloneablePredictionMarket clone = CloneablePredictionMarket(market);

        usdc.mint(trader, 100e6);
        vm.startPrank(trader);
        usdc.approve(market, type(uint256).max);
        clone.buy(CloneablePredictionMarket.Outcome.Yes, 10e6, 100e6);
        vm.stopPrank();

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(resolver);
        factory.resolveMarket(market, CloneablePredictionMarket.Outcome.Cancelled);

        uint256 refund = clone.costBasis(trader);
        assertGt(refund, 0);
        uint256 tooMuch = clone.treasuryWithdrawable() + 1;
        vm.startPrank(admin);
        vm.expectRevert(CloneablePredictionMarket.InsufficientReserves.selector);
        factory.withdrawMarketTreasury(market, admin, tooMuch);
        vm.stopPrank();

        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        clone.claimRefund();
        assertEq(usdc.balanceOf(trader), before + refund);
        assertEq(clone.costBasis(trader), 0);
    }

    function test_cloneCanTradeAndResolveThroughFactory() public {
        address market = _create("Will ETH rise?");
        CloneablePredictionMarket clone = CloneablePredictionMarket(market);

        usdc.mint(trader, 100e6);
        vm.startPrank(trader);
        usdc.approve(market, type(uint256).max);
        clone.buy(CloneablePredictionMarket.Outcome.Yes, 1e6, 100e6);
        vm.stopPrank();

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(resolver);
        factory.resolveMarket(market, CloneablePredictionMarket.Outcome.Yes);

        assertTrue(clone.resolved());
        assertEq(uint8(clone.outcome()), uint8(CloneablePredictionMarket.Outcome.Yes));
    }

    function test_cloneResolverAndAdminRolesAreSeparated() public {
        address market = _create("Q?");

        vm.prank(trader);
        vm.expectRevert(CloneableMarketFactory.NotResolver.selector);
        factory.resolveMarket(market, CloneablePredictionMarket.Outcome.Cancelled);
    }
}
