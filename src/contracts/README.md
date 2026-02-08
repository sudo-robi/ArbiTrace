RetryableIncidentRegistry
=========================

What
----

`RetryableIncidentRegistry.sol` is a minimal onchain registry to anchor developer-submitted incident reports for retryable + Stylus failures on Arbitrum.

Design
------
- Stores a single anchored incident per L2 `txHash` (reporter, fingerprint, timestamp).
- Keeps small aggregated counters per `FailureType` (6 enum values).
- Emits `RetryableIncidentReported` event for indexing and tooling.
- Avoids heavy storage or re-execution; fingerprints are computed offchain.

Key functions
-------------
- `reportIncident(bytes32 txHash, FailureType failureType, bytes32 fingerprint)` — main entrypoint, emits event and anchors minimal data.
- `getFailureCounts()` — returns counts for all `FailureType` values.
- `topFailures(uint256 n)` — view returning the top `n` failure types and counts.
- `getIncident(bytes32 txHash)` — read anchored incident data.

Usage
-----
Compile/deploy with your normal Solidity toolchain (Hardhat, Foundry, Truffle). Example (Hardhat):

1. Add the contract path to your Hardhat project (e.g., `src/contracts/RetryableIncidentRegistry.sol`).
2. Compile:

```bash
npx hardhat compile
```

3. Example `ethers.js` call to report an incident:

```js
const txHash = '0x...'; // L2 tx hash
const failureType = 3; // e.g., FailureType.L1Revert
const fingerprint = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('some-fingerprint'));
await contract.connect(reporter).reportIncident(txHash, failureType, fingerprint);
```

Notes
-----
- The contract is intentionally simple and non-authoritative. Its purpose is to provide a shared, permanent anchor and canonical events that offchain tooling (like the debugger) can consume.
- Do not store full traces onchain or attempt to re-run transactions within this contract.
