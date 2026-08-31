// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CloneableMarketFactory } from "../src/CloneableMarketFactory.sol";

/// @notice Creates disposable testnet markets through an explicitly supplied
/// clone factory. This script intentionally requires the factory address so it
/// cannot target the production factory by accident.
contract CreateCloneableTestMarkets is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address factoryAddress = vm.envAddress("CLONE_FACTORY_ADDRESS");
        address token = vm.envAddress("SETTLEMENT_TOKEN_ADDRESS");
        CloneableMarketFactory factory = CloneableMarketFactory(factoryAddress);

        uint256 seed = vm.envOr("CLONE_TEST_SEED", uint256(100_000));
        uint256 deadline = block.timestamp + 7 days;

        vm.startBroadcast(pk);
        IERC20(token).approve(factoryAddress, type(uint256).max);
        address btc = factory.createMarket(
            "Clone test: will BTC be higher in 1 hour?",
            "Fast",
            "Test-only clone market",
            deadline,
            seed
        );
        address eth = factory.createMarket(
            "Clone test: will ETH be higher in 1 hour?",
            "Fast",
            "Test-only clone market",
            deadline + 1,
            seed
        );
        vm.stopBroadcast();

        console2.log("BTC clone market:", btc);
        console2.log("ETH clone market:", eth);
        console2.log("Factory count:", factory.marketCount());
    }
}
