// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CloneableMarketFactory } from "../src/CloneableMarketFactory.sol";

/// @notice Deploys the experimental clone factory. Keep this separate from
/// DeployMarketFactory so the production factory address cannot be replaced by
/// accident.
contract DeployCloneableMarketFactory is Script {
    function run() external returns (CloneableMarketFactory factory) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("SETTLEMENT_TOKEN_ADDRESS");
        address resolver = vm.envOr("RESOLVER_ADDRESS", deployer);

        vm.startBroadcast(pk);
        factory = new CloneableMarketFactory(IERC20(usdc), deployer, resolver);
        vm.stopBroadcast();

        console2.log("CloneableMarketFactory deployed to:", address(factory));
        console2.log("Implementation:", factory.implementation());
        console2.log("Settlement token:", usdc);
        console2.log("Admin:", deployer);
        console2.log("Resolver:", resolver);
    }
}
