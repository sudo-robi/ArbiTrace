# Arbitrum Debugger MVP — Demo & Testing Guide

## Quick Demo (10 seconds)

### Option 1: Web UI

1. Open **http://localhost:3000** in browser.
2. Go to **https://arbiscan.io/**.
3. Find a failed transaction (click "Transactions" → Filter "Status = Failed").
4. Copy the tx hash.
5. Paste into the debugger and click **Analyze**.

**Result:** See the transaction flow, failure reason, and timeline in 10 seconds.

### Option 2: CLI Test Runner

```bash
# Run the test CLI against a real tx
node src/testRunner.js 0x<tx_hash>

# Example with a scenario
node src/testRunner.js 0x<tx_hash> --scenario LOW_GAS_EXAMPLE
```

**Output:** Detailed timeline, failure analysis, and validation results.

---

## What to Test

### Scenario 1: Low Gas Limit Failure

**What to look for:**
- L1 retryable ticket creation
- maxGas parameter < 100k
- Auto-redeem attempt failure
- ❌ Failure message: "maxGas may be insufficient"

**Where to find examples:**
Go to Arbiscan → Search for recent failed transactions where retryable tickets were created.

### Scenario 2: L2 Execution Revert

**What to look for:**
- L2 receipt with status = 0
- Contract logic failure
- Gas usage details
- ❌ Failure message: "L2 execution reverted"

**Test with any L2 failed tx from Arbiscan.**

### Scenario 3: Stylus (WASM) Panic

**What to look for:**
- L2 tx to Arbitrum WASM precompile (0x71)
- Panic code detected
- WASM-specific error (assertion, arithmetic, etc.)
- ❌ Failure message: "WASM Panic: [reason]"

---

## API Usage

### POST /analyze

**Request:**
```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"txHash":"0x..."}'
```

**Response:**
```json
{
  "txHash": "0x...",
  "foundOn": "L1" | "L2" | "both",
  "timeline": {
    "actions": [
      {
        "id": 1,
        "action": "L1_TX_SUBMITTED",
        "status": "confirmed",
        "details": {...}
      },
      ...
    ],
    "failureClassification": [
      {
        "type": "LOW_GAS_LIMIT",
        "message": "maxGas may be insufficient...",
        "severity": "warning"
      },
      ...
    ],
    "summary": {
      "totalSteps": 4,
      "successCount": 2,
      "failureCount": 1
    }
  },
  "stylusMetadata": {...},
  "rawData": {...}
}
```

---

## Sample Responses

See `src/sampleResponses.js` for example outputs:

- `SAMPLE_RESPONSE_LOW_GAS` — Retryable with insufficient maxGas
- `SAMPLE_RESPONSE_L2_REVERT` — L2 contract execution failure
- `SAMPLE_RESPONSE_STYLUS_PANIC` — WASM panic with panic code

---

## Interpreting Results

### Timeline Colors

- 🟢 **Green (Confirmed)** — Step succeeded
- 🔴 **Red (Failed)** — Failure detected
- 🟡 **Yellow (Pending)** — Status unknown
- ⚫ **Gray (Unknown)** — Data not available

### Failure Types

| Type | Meaning | Action |
|------|---------|--------|
| `LOW_GAS_LIMIT` | maxGas insufficient for execution | Increase maxGas parameter |
| `LOW_SUBMISSION_COST` | Submission cost too low | Increase l2CallValue |
| `L1_FAILURE` | L1 transaction reverted | Check L1 tx for error |
| `L2_REVERT` | L2 execution reverted | Debug contract logic |
| `WASM_PANIC` | WASM assertion/arithmetic error | Fix WASM code |
| `WASM_OUT_OF_GAS` | WASM ran out of gas | Increase gas limit |

---

## Real-World Testing Steps

1. **Prepare**: Have the dev server running on http://localhost:3000

2. **Find a failed tx**:
   - https://arbiscan.io/ → Transactions → Status: Failed
   - Pick one involving retryables or Stylus contracts

3. **Test via Web UI**:
   - Copy tx hash
   - Paste into http://localhost:3000
   - Click "Analyze"
   - Verify timeline appears and failures are classified

4. **Test via CLI**:
   ```bash
   node src/testRunner.js 0x<tx_hash>
   ```
   - Check output for timeline and failure classification
   - Verify no errors

5. **Validate Results**:
   - Do the failures make sense?
   - Is the timeline accurate?
   - Do the explanations help?

---

## Debugging

### Server not responding?

```bash
# Check if running
lsof -i :3000

# Restart
pkill -f "npm run dev"
npm run dev
```

### Bad RPC errors?

Make sure `.env` has valid RPC URLs:

```bash
cat .env
# Should show:
# L1_RPC_URL=https://...
# ARBITRUM_RPC_URL=https://rpc.ankr.com/arbitrum
```

### Missing dependencies?

```bash
npm install
```

---

## MVP Success Criteria

Your debugger is working if:

✅ Paste a failed tx hash → Get timeline in < 10 seconds
✅ Failures are classified accurately
✅ Explanations are actionable ("maxGas is too low — increase to X")
✅ No wallet required
✅ No login required
✅ Mobile-friendly UI

---

## Next Steps (Post-MVP)

- Real-time polling for pending retryables
- Opinionated fix suggestions
- Multi-chain support (Optimism, Polygon)
- Advanced gas analytics
- Integration with Tenderly for deeper tracing

---

**Questions?** Check the source:
- `/src/arbitrum.js` — L1/L2 detection
- `/src/traceNormalizer.js` — Timeline building
- `/src/stylusParser.js` — WASM detection
- `/public/index.html` — Frontend
