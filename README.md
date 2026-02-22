# Arbitrum Transaction Debugger — Single-purpose MVP

Single-purpose tool: input one Arbitrum-related tx hash (L1 or L2) and receive an exact, opinionated failure explanation. Built specifically for Arbitrum's retryable L1→L2 execution model.

Goals:
- Accept a single Arbitrum-related tx hash (L1 or L2).
- Detect whether the hash exists on L1 or L2.
- Return receipts/logs and minimal hints so we can build the trace normalization and failure classification next.

Quick start

1. Copy `.env.example` to `.env` and populate RPC endpoints:

```bash
cp .env.example .env
# Edit .env to add L1_RPC_URL and ARBITRUM_RPC_URL
```

2. Install dependencies and start server:

```bash
npm install
npm run dev
```

3. Open browser at `http://localhost:3000` and paste a tx hash.

Or POST JSON to `/analyze` with `{ "txHash": "0x..." }`.

Demo: Test with a real Arbitrum tx

1. Go to **https://arbiscan.io/** and find a failed transaction (filter by Status = Failed).
2. Copy the tx hash.
3. Paste into the web interface at **http://localhost:3000** and click "Analyze".

> [!IMPORTANT]
> Always ensure you are using a transaction hash or contract address from the specific network you have selected (e.g., Arbitrum Sepolia, Arbitrum Nova, etc.). The analysis will fail if you attempt to analyze a transaction hash from one network while the debugger is pointing to another.

Example using curl:

```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"txHash":"0x..."}'
```

Or use the test CLI:

```bash
npm install
node src/testRunner.js 0x... [--scenario LOW_GAS_EXAMPLE]
```

MVP Features

✅ L1 → L2 Transaction Flow
- Detects L1 vs L2 transactions
- Parses retryable ticket creation logs from L1

✅ Retryable Ticket Lifecycle
- Extracts ticket ID, maxGas, gasPriceBid, submissionCost
- Tracks auto-redeem and manual redeem status

✅ Failure Classification (Human-Readable)
- Insufficient submission cost
- maxGas too low
- gasPriceBid too low
- L1/L2 revert detection
- WASM panic detection (Stylus)

✅ Linear Timeline Visualization
- Color-coded nodes (green = confirmed, red = failed, yellow = pending)
- One-click raw data toggle

✅ Stylus (WASM) Execution Detection
- Identifies WASM contract execution on Arbitrum
- Detects panic codes and revert reasons

✅ Onchain Incident Registry (Arbitrum Sepolia)
- Minimal smart contract for anchoring retryable/Stylus failures
- Emits canonical `RetryableIncidentReported` events
- Provides read-only aggregation view (top failure types)
- No heavy storage; event-driven and L2-friendly

What's next

- Opinionated failure explanations ("Your retryable failed because maxGas was too low...")
- Real-time transaction polling
- Multi-chain support (other L2s)
- Advanced trace analytics

## Onchain Incident Registry

### Deployment Summary

The `RetryableIncidentRegistry` smart contract has been deployed on **Arbitrum Sepolia testnet**.

| Item | Value |
|------|-------|
| ✅ **Status** | Successfully deployed and verified |
| **Contract Address** | `0x915cC86fE0871835e750E93e025080FFf9927A3f` |
| **Chain** | Arbitrum Sepolia (Testnet) |
| **Transaction Hash** | `0xd352104258fa7cfadff4f682cfe9aef57e36d5195af5643c502a9c190103428a` |
| **Block** | 240859932 |
| **Gas Used** | 549,092 gas @ 0.02 gwei |
| **Cost** | 0.00001098184 ETH |
| **Verification** | ✅ Source code publicly verified on [Arbiscan](https://sepolia.arbiscan.io/address/0x915cc86fe0871835e750e93e025080fff9927a3f) |

### What It Does

- **Accepts developer-submitted incident reports** for retryable + Stylus failures
- **Canonicalizes failures** via structured enums and onchain fingerprints
- **Emits `RetryableIncidentReported` events** indexed by reporter and tx hash
- **Provides read-only aggregation** (top failure types by count)
- **Minimal storage**: one anchored incident per L2 txHash + small counters

### Failure Types Supported

```solidity
enum FailureType {
    InsufficientSubmissionCost,  // 0
    MaxGasTooLow,                // 1
    GasPriceBidTooLow,           // 2
    L1Revert,                    // 3
    L2Revert,                    // 4
    WASMPanic                    // 5
}
```

### Integration

See [ONCHAIN_INTEGRATION.md](./ONCHAIN_INTEGRATION.md) for:
- How to initialize the event listener
- REST endpoints for querying incidents
- Example: reporting an incident from your debugger
- Database schema

### View on Explorer

- **Arbiscan**: https://sepolia.arbiscan.io/address/0x915cc86fe0871835e750e93e025080fff9927a3f
- **Contract Code**: [src/contracts/RetryableIncidentRegistry.sol](./src/contracts/RetryableIncidentRegistry.sol)

What's next

- Opinionated failure explanations ("Your retryable failed because maxGas was too low...")
- Real-time transaction polling
- Multi-chain support (other L2s)
- Advanced trace analytics

Architecture

```
/src
  ├── server.js              # Express server + /analyze endpoint
  ├── arbitrum.js            # L1/L2 tx detection, log parsing
  ├── traceNormalizer.js     # Converts raw logs → action graph
  ├── stylusParser.js        # WASM execution metadata
  ├── testScenarios.js       # Known failure scenarios
  └── testRunner.js          # CLI test harness
/public
  └── index.html             # Single-page frontend
```

What's next

- Implement parsing of L1 logs to find retryable ticket creation and extract parameters
- Fetch Arbitrum L2 traces and normalize to an action graph
- Add failure classification rules and a simple single-input frontend
