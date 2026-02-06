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
