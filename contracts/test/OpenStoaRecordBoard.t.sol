// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OpenStoaRecordBoard.sol";

contract OpenStoaRecordBoardTest is Test {
    OpenStoaRecordBoard public board;

    uint256 internal servicePk = 0xA11CE;
    address internal serviceAddr;
    address internal owner = address(this);
    address internal user1 = address(0x1);

    bytes32 internal postIdHash = keccak256("post-1");
    bytes32 internal contentHash = keccak256("content-body");
    bytes32 internal authorNullifier = bytes32(uint256(0xAA));
    bytes32 internal recorderNullifier = bytes32(uint256(0xBB));

    function setUp() public {
        serviceAddr = vm.addr(servicePk);
        board = new OpenStoaRecordBoard(serviceAddr);
    }

    // -------------------------------------------------------
    // 1. test_record_success
    // -------------------------------------------------------
    function test_record_success() public {
        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);

        assertEq(board.getRecordCount(postIdHash), 1);
        assertEq(board.totalRecords(), 1);

        OpenStoaRecordBoard.Record[] memory records = board.getRecords(postIdHash);
        assertEq(records[0].contentHash, contentHash);
        assertEq(records[0].authorNullifier, authorNullifier);
        assertEq(records[0].recorderNullifier, recorderNullifier);
    }

    // -------------------------------------------------------
    // 2. test_record_onlyService
    // -------------------------------------------------------
    function test_record_onlyService() public {
        vm.prank(user1);
        vm.expectRevert(OpenStoaRecordBoard.NotAuthorized.selector);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);
    }

    // -------------------------------------------------------
    // 3. test_record_duplicatePrevention
    // -------------------------------------------------------
    function test_record_duplicatePrevention() public {
        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);

        vm.prank(serviceAddr);
        vm.expectRevert(OpenStoaRecordBoard.AlreadyRecorded.selector);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);
    }

    // -------------------------------------------------------
    // 4. test_record_selfRecordPrevention
    // -------------------------------------------------------
    function test_record_selfRecordPrevention() public {
        vm.prank(serviceAddr);
        vm.expectRevert(OpenStoaRecordBoard.CannotRecordOwnPost.selector);
        board.record(postIdHash, contentHash, authorNullifier, authorNullifier);
    }

    // -------------------------------------------------------
    // 5. test_recordDirect_success
    // -------------------------------------------------------
    function test_recordDirect_success() public {
        uint256 expiry = block.timestamp + 1 hours;

        bytes32 digest = keccak256(abi.encode(
            postIdHash, contentHash, authorNullifier, recorderNullifier, expiry
        ));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(servicePk, ethSignedHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(user1);
        board.recordDirect(
            postIdHash, contentHash, authorNullifier, recorderNullifier, expiry, signature
        );

        assertEq(board.getRecordCount(postIdHash), 1);
        assertEq(board.totalRecords(), 1);
    }

    // -------------------------------------------------------
    // 6. test_recordDirect_expiredSignature
    // -------------------------------------------------------
    function test_recordDirect_expiredSignature() public {
        uint256 expiry = block.timestamp + 1 hours;

        bytes32 digest = keccak256(abi.encode(
            postIdHash, contentHash, authorNullifier, recorderNullifier, expiry
        ));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(servicePk, ethSignedHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Warp past expiry
        vm.warp(expiry + 1);

        vm.prank(user1);
        vm.expectRevert(OpenStoaRecordBoard.SignatureExpired.selector);
        board.recordDirect(
            postIdHash, contentHash, authorNullifier, recorderNullifier, expiry, signature
        );
    }

    // -------------------------------------------------------
    // 7. test_recordDirect_invalidSignature
    // -------------------------------------------------------
    function test_recordDirect_invalidSignature() public {
        uint256 fakePk = 0xBAD;
        uint256 expiry = block.timestamp + 1 hours;

        bytes32 digest = keccak256(abi.encode(
            postIdHash, contentHash, authorNullifier, recorderNullifier, expiry
        ));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(fakePk, ethSignedHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(user1);
        vm.expectRevert(OpenStoaRecordBoard.InvalidServiceSignature.selector);
        board.recordDirect(
            postIdHash, contentHash, authorNullifier, recorderNullifier, expiry, signature
        );
    }

    // -------------------------------------------------------
    // 8. test_getRecordCount
    // -------------------------------------------------------
    function test_getRecordCount() public {
        assertEq(board.getRecordCount(postIdHash), 0);

        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);

        assertEq(board.getRecordCount(postIdHash), 1);
    }

    // -------------------------------------------------------
    // 9. test_getRecords
    // -------------------------------------------------------
    function test_getRecords() public {
        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);

        OpenStoaRecordBoard.Record[] memory records = board.getRecords(postIdHash);
        assertEq(records.length, 1);
        assertEq(records[0].contentHash, contentHash);
        assertEq(records[0].authorNullifier, authorNullifier);
        assertEq(records[0].recorderNullifier, recorderNullifier);
        assertGt(records[0].timestamp, 0);
    }

    // -------------------------------------------------------
    // 10. test_multipleRecordsSamePost
    // -------------------------------------------------------
    function test_multipleRecordsSamePost() public {
        bytes32 recorder2 = bytes32(uint256(0xCC));
        bytes32 recorder3 = bytes32(uint256(0xDD));

        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);

        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorder2);

        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorder3);

        assertEq(board.getRecordCount(postIdHash), 3);
        assertEq(board.totalRecords(), 3);

        OpenStoaRecordBoard.Record[] memory records = board.getRecords(postIdHash);
        assertEq(records[0].recorderNullifier, recorderNullifier);
        assertEq(records[1].recorderNullifier, recorder2);
        assertEq(records[2].recorderNullifier, recorder3);
    }

    // -------------------------------------------------------
    // 11. test_pause_unpause
    // -------------------------------------------------------
    function test_pause_unpause() public {
        board.pause();

        vm.prank(serviceAddr);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);

        board.unpause();

        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);
        assertEq(board.getRecordCount(postIdHash), 1);
    }

    // -------------------------------------------------------
    // 12. test_setService
    // -------------------------------------------------------
    function test_setService() public {
        address newService = address(0x999);

        board.setService(newService);
        assertEq(board.service(), newService);

        // Old service can no longer record
        vm.prank(serviceAddr);
        vm.expectRevert(OpenStoaRecordBoard.NotAuthorized.selector);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);

        // New service can record
        vm.prank(newService);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);
        assertEq(board.getRecordCount(postIdHash), 1);
    }

    function test_setService_onlyOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user1));
        board.setService(address(0x999));
    }

    // -------------------------------------------------------
    // 13. test_totalRecords
    // -------------------------------------------------------
    function test_totalRecords() public {
        assertEq(board.totalRecords(), 0);

        bytes32 post2 = keccak256("post-2");

        vm.prank(serviceAddr);
        board.record(postIdHash, contentHash, authorNullifier, recorderNullifier);
        assertEq(board.totalRecords(), 1);

        vm.prank(serviceAddr);
        board.record(post2, contentHash, authorNullifier, recorderNullifier);
        assertEq(board.totalRecords(), 2);
    }
}
