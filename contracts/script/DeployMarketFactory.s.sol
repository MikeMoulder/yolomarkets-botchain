// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";

contract DeployMarketFactory is Script {
    function run() external returns (MarketFactory factory) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("SETTLEMENT_TOKEN_ADDRESS");
        address resolver = vm.envOr("RESOLVER_ADDRESS", deployer);

        vm.startBroadcast(pk);
        factory = new MarketFactory(IERC20(usdc), deployer, resolver);
        vm.stopBroadcast();

        console2.log("MarketFactory deployed to:", address(factory));
        console2.log("Settlement token:", usdc);
        console2.log("Admin:", deployer);
        console2.log("Resolver:", resolver);
    }
}
