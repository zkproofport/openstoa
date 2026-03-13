// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract OpenStoaRecordBoard is Ownable, Pausable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    struct Record {
        bytes32 contentHash;
        bytes32 authorNullifier;
        bytes32 recorderNullifier;
        uint256 timestamp;
    }

    address public service;

    // bytes32(keccak256(postId)) => Record[]
    mapping(bytes32 => Record[]) internal _records;

    // keccak256(postIdHash, recorderNullifier) => recorded
    mapping(bytes32 => bool) public hasRecorded;

    uint256 public totalRecords;

    event ContentRecorded(
        bytes32 indexed postIdHash,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier,
        uint256 timestamp
    );
    event ServiceUpdated(address indexed oldService, address indexed newService);

    error NotAuthorized();
    error AlreadyRecorded();
    error CannotRecordOwnPost();
    error SignatureExpired();
    error InvalidServiceSignature();

    modifier onlyService() {
        if (msg.sender != service) revert NotAuthorized();
        _;
    }

    constructor(address _service) Ownable(msg.sender) {
        service = _service;
    }

    /// @notice Update the service wallet address (owner only)
    function setService(address _newService) external onlyOwner {
        address old = service;
        service = _newService;
        emit ServiceUpdated(old, _newService);
    }

    /// @notice Service-proxied recording (free for user)
    function record(
        bytes32 postIdHash,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier
    ) external onlyService whenNotPaused {
        _record(postIdHash, contentHash, authorNullifier, recorderNullifier);
    }

    /// @notice User-direct recording with service signature
    function recordDirect(
        bytes32 postIdHash,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier,
        uint256 expiry,
        bytes calldata serviceSignature
    ) external whenNotPaused {
        if (block.timestamp > expiry) revert SignatureExpired();

        bytes32 digest = keccak256(abi.encode(
            postIdHash, contentHash, authorNullifier, recorderNullifier, expiry
        ));
        bytes32 ethSignedHash = digest.toEthSignedMessageHash();
        address signer = ethSignedHash.recover(serviceSignature);
        if (signer != service) revert InvalidServiceSignature();

        _record(postIdHash, contentHash, authorNullifier, recorderNullifier);
    }

    function _record(
        bytes32 postIdHash,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier
    ) internal {
        // Duplicate prevention: same person + same post
        bytes32 key = keccak256(abi.encodePacked(postIdHash, recorderNullifier));
        if (hasRecorded[key]) revert AlreadyRecorded();
        hasRecorded[key] = true;

        // Self-record prevention
        if (authorNullifier == recorderNullifier) revert CannotRecordOwnPost();

        _records[postIdHash].push(Record({
            contentHash: contentHash,
            authorNullifier: authorNullifier,
            recorderNullifier: recorderNullifier,
            timestamp: block.timestamp
        }));

        totalRecords++;

        emit ContentRecorded(
            postIdHash, contentHash, authorNullifier, recorderNullifier, block.timestamp
        );
    }

    /// @notice Get the number of records for a post
    function getRecordCount(bytes32 postIdHash) external view returns (uint256) {
        return _records[postIdHash].length;
    }

    /// @notice Get all records for a post
    function getRecords(bytes32 postIdHash) external view returns (Record[] memory) {
        return _records[postIdHash];
    }

    /// @notice Pause recording (owner only)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause recording (owner only)
    function unpause() external onlyOwner {
        _unpause();
    }
}
