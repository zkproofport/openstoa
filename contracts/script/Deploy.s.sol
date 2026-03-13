// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OpenStoaRecordBoard.sol";

contract DeployOpenStoaRecordBoard is Script {
    function run() external {
        address serviceWallet = vm.envAddress("SERVICE_WALLET_ADDRESS");

        vm.startBroadcast();

        OpenStoaRecordBoard board = new OpenStoaRecordBoard(serviceWallet);

        vm.stopBroadcast();

        console.log("OpenStoaRecordBoard deployed at:", address(board));
        console.log("Service wallet:", serviceWallet);
        console.log("Owner:", board.owner());
    }
}
