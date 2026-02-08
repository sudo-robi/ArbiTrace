// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../src/contracts/RetryableIncidentRegistry.sol";
import "forge-std/Script.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        RetryableIncidentRegistry registry = new RetryableIncidentRegistry();

        vm.stopBroadcast();

        console.log("RetryableIncidentRegistry deployed at:", address(registry));
    }
}
