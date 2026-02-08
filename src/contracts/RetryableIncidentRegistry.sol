// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title RetryableIncidentRegistry
 * @notice Minimal onchain registry for retryable + Stylus failures on Arbitrum.
 * - Accepts developer-submitted incident reports
 * - Canonicalizes retryable + Stylus failures via an offchain fingerprint
 * - Emits structured events; stores only small anchors and counters
 *
 * Design goals followed:
 * - No heavy storage (only a single incident record per txHash + small counters)
 * - Event-driven and L2-friendly
 * - Read-only aggregation view for top failure types
 */
contract RetryableIncidentRegistry {
    enum FailureType {
        InsufficientSubmissionCost,
        MaxGasTooLow,
        GasPriceBidTooLow,
        L1Revert,
        L2Revert,
        WASMPanic
    }

    event RetryableIncidentReported(
        address indexed reporter,
        bytes32 indexed txHash,
        FailureType failureType,
        bytes32 fingerprint,
        uint256 timestamp
    );

    struct Incident {
        address reporter;
        FailureType failureType;
        bytes32 fingerprint; // offchain computed
        uint256 timestamp;
    }

    // Minimal onchain anchoring: one incident per L2 txHash
    mapping(bytes32 => Incident) public incidents;

    // Small storage of aggregated counts per FailureType (6 enum members)
    uint256[6] private failureCounts;

    /// @notice Report an incident observed offchain for a retryable/stylus failure
    /// @dev Reporter must supply the txHash, an offchain-computed FailureType and fingerprint
    /// @param txHash L2 transaction hash that failed (anchored key)
    /// @param failureType One of the FailureType enum values
    /// @param fingerprint Offchain canonical fingerprint (panic code, revert selector, or param-bucket)
    function reportIncident(
        bytes32 txHash,
        FailureType failureType,
        bytes32 fingerprint
    ) external {
        require(txHash != bytes32(0), "txHash-zero");

        // Anchor only the first report for a given txHash to avoid redundant storage
        require(incidents[txHash].timestamp == 0, "already-reported");

        incidents[txHash] = Incident({
            reporter: msg.sender,
            failureType: failureType,
            fingerprint: fingerprint,
            timestamp: block.timestamp
        });

        failureCounts[uint256(failureType)] += 1;

        emit RetryableIncidentReported(msg.sender, txHash, failureType, fingerprint, block.timestamp);
    }

    /// @notice Returns raw counts for each FailureType enum index (0..5)
    function getFailureCounts() external view returns (uint256[6] memory) {
        return failureCounts;
    }

    /// @notice Return the top `n` failure types (by count) as enum indices and their counts
    /// @dev Sorting is done in-memory for the small fixed enum size; gas cost is reasonable for view calls
    /// @param n Number of top entries to return (capped to 6)
    function topFailures(uint256 n) external view returns (uint8[] memory types_, uint256[] memory counts_) {
        if (n > 6) n = 6;

        // copy counts to an expandable memory array
        uint256[] memory counts = new uint256[](6);
        for (uint256 i = 0; i < 6; i++) counts[i] = failureCounts[i];

        types_ = new uint8[](n);
        counts_ = new uint256[](n);

        bool[] memory taken = new bool[](6);

        for (uint256 k = 0; k < n; k++) {
            uint256 maxIdx = 0;
            uint256 maxVal = 0;
            for (uint256 i = 0; i < 6; i++) {
                if (!taken[i] && counts[i] > maxVal) {
                    maxVal = counts[i];
                    maxIdx = i;
                }
            }
            types_[k] = uint8(maxIdx);
            counts_[k] = maxVal;
            taken[maxIdx] = true;
        }
    }

    /// @notice Read an anchored incident for a transaction hash
    function getIncident(bytes32 txHash)
        external
        view
        returns (
            address reporter,
            FailureType failureType,
            bytes32 fingerprint,
            uint256 timestamp
        )
    {
        Incident memory it = incidents[txHash];
        return (it.reporter, it.failureType, it.fingerprint, it.timestamp);
    }
}
