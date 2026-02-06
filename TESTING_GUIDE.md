# ArbiTrace Testing Guide: L1 → Retryable → L2 Success Flow

## Quick Start

1. **Start the server**:
   ```bash
   npm start
   ```
   Server runs on http://localhost:3000

2. **Open the UI**:
   - Go to http://localhost:3000 in your browser
   - You should see the ArbiTrace debugger interface

3. **Find a test transaction**:
   - Go to https://arbiscan.io
   - Search for recent transactions with retryable tickets

## How to Identify Retryable Transactions on Arbiscan

### L1 (Ethereum Mainnet)
1. Look for transactions calling the **Arbitrum Inbox** contract
2. Event: **RetryableTicketCreated**
3. Parameters visible:
   - **ticketId**: Unique identifier for the ticket
   - **from**: Sender address
   - **to**: L2 recipient
   - **gasLimit**: Max gas for L2 execution
   - **maxFeePerGas**: Max gas price on L2
   - **l2CallValue**: Submission cost

### L2 (Arbitrum One)
1. Look for transactions from **ArbRetryable** precompile (0x0000...0064)
2. Event: **TicketCreated** or **Redeemed**
3. References the **ticketId** from L1

## Test Scenarios

### Scenario 1: Successful Retryable (No Failure)
**What to look for**:
- ✅ L1 transaction succeeded (green checkmark)
- ✅ L2 transaction found with matching ticketId
- ✅ L2 transaction succeeded (gas used < gas limit)

**Expected ArbiTrace Output**:
```
foundOn: "both"
failureAt: "UNKNOWN"
failureReason: "UNKNOWN"
explanation: "Transaction completed successfully"

timeline:
- L1_TX_SUBMITTED (confirmed)
- RETRYABLE_CREATED (confirmed)
- AUTO_REDEEM_ATTEMPT (confirmed)
- L2_EXECUTION (confirmed)

Status: ✅ Success (green badge)
```

### Scenario 2: Insufficient Gas (OUT_OF_GAS)
**What to look for**:
- ✅ L1 transaction succeeded
- ✅ L2 transaction found
- ❌ L2 transaction reverted with OUT_OF_GAS
- Gas used ≈ gas limit

**Expected ArbiTrace Output**:
```
failureAt: "L2_EXECUTION"
failureReason: "OUT_OF_GAS"
explanation: "Your retryable ticket likely failed because L1 maxGas was set to 
[X], but L2 execution consumed [Y] gas; increase maxGas by ~[Z]% (suggested: [W])."

humanMessage: Same as above
Status: ❌ Failed (red badge)
```

### Scenario 3: Low Submission Cost
**What to look for**:
- ✅ L1 transaction succeeded
- ❌ No L2 auto-redeem found
- ❌ Submission cost (l2CallValue) too low

**Expected ArbiTrace Output**:
```
failureAt: "AUTO_REDEEM"
failureReason: "LOW_SUBMISSION_COST"
explanation: "Submission cost was insufficient..."

Status: ❌ Failed (red badge)
```

### Scenario 4: Low Gas Price Bid
**What to look for**:
- ✅ L1 transaction succeeded
- ❌ L2 execution failed due to low maxFeePerGas
- Current L2 baseFee > maxFeePerGas

**Expected ArbiTrace Output**:
```
failureAt: "L2_EXECUTION" or "AUTO_REDEEM"
failureReason: "LOW_GAS_PRICE"
explanation: "maxFeePerGas was too low for current L2 congestion..."

Status: ❌ Failed (red badge)
```

## Testing Checklist

For each transaction you test:

### ✅ Response Structure
- [ ] Response arrives in <1000ms
- [ ] All fields present (txHash, foundOn, failureAt, etc.)
- [ ] Timeline has actions array
- [ ] Causality analysis included

### ✅ UI Rendering
- [ ] No console errors (F12 → Console)
- [ ] Timeline renders correctly
- [ ] Timeline nodes show proper status colors:
  - Green: confirmed
  - Red: failed
  - Orange: pending
- [ ] Gas chart displays (if gas data available)
- [ ] Causality card shows humanMessage
- [ ] Copy button works (shows toast)

### ✅ Data Accuracy
- [ ] L1 block number matches Arbiscan
- [ ] L2 block number matches Arbiscan
- [ ] Gas values match actual transaction
- [ ] Failure reason matches actual error (if failed)
- [ ] Timeline order matches blockchain history

### ✅ Performance
- [ ] Response time <1000ms (shown at bottom)
- [ ] All 3 RPC calls parallelized (L1/L2 receipts)
- [ ] No hanging requests (Network tab clean)

## Example Real Transactions to Test

> **Note**: These are example patterns. Use Arbiscan to find current transactions.

### Pattern 1: Bridge Deposit
```
L1 Arbitrum Bridge → Retryable Ticket → L2 ERC20 mint
Expected: Usually succeeds quickly
```

### Pattern 2: Cross-Chain Message
```
L1 Contract call → Retryable with calldata → L2 Contract execution
Expected: May fail if contract logic reverts
```

### Pattern 3: Low Gas Scenario
```
L1 creates retryable with gasLimit=100000, but L2 needs 150000
Expected: OUT_OF_GAS failure with ~50% suggestion
```

## Debugging Tips

### If Timeline is Empty
- Check Network tab for failed RPC calls
- Verify L1/L2 RPC URLs are correct in .env
- Look for `errors` field in response

### If Gas Chart Missing
- Ensure L2 receipt was found (foundOn: "both")
- Check if gasUsed and gasLimit are populated

### If Causality Blank
- Verify both L1 and L2 receipts found
- Check if retryable creation logs were parsed
- See if ticketId was correctly extracted

### If Response Time >5s
- Check rpcTimings to identify slow calls
- May indicate RPC provider issues
- Try again (sometimes transient)

## UI Features to Verify

### 1. Input & Analysis
- [ ] Text input accepts tx hash (0x...)
- [ ] "Explain this failure" button works
- [ ] Loading spinner appears during analysis
- [ ] Results display after completion

### 2. Timeline
- [ ] Actions display in order
- [ ] Each action shows status (confirmed/failed/pending)
- [ ] Click expand button to see details
- [ ] Gas bar shows usage ratio

### 3. Right Panel
- [ ] Status badge shows (green/red/orange)
- [ ] Metrics section: Block, Gas Used, Time
- [ ] Failure card with explanation
- [ ] Causality section with humanMessage
- [ ] Copy button has working toast

### 4. Quick Actions
- [ ] Copy Hash → success toast
- [ ] Share → success toast
- [ ] View on Arbiscan → opens new tab
- [ ] Decode Calldata → modal opens
- [ ] Retryable Lifecycle → modal opens

### 5. Raw Data
- [ ] Toggle shows complete JSON response
- [ ] Pretty-printed and readable
- [ ] Shows all RPC responses

### 6. Dark Mode
- [ ] Toggle button works (🌙 ↔ ☀️)
- [ ] Colors adjust for readability
- [ ] Persists on page reload

## Toast Notifications Testing

All user actions should show smooth, non-blocking toasts:

| Action | Expected Toast | Color |
|--------|---|---|
| Copy hash | "Copied!" | Green |
| Share link | "Share link copied!" | Green |
| Copy explanation | "Explanation copied" | Green |
| Decode error | "Decoding failed: ..." | Red |
| No calldata | "No calldata available" | Orange |
| No tx selected | "No transaction selected" | Orange |
| CSV selected | (no toast needed) | N/A |

Toast features:
- ✅ Appears top-right corner
- ✅ Slides in smoothly
- ✅ Auto-dismisses after 3s
- ✅ Doesn't block interaction
- ✅ Multiple toasts stack

## Performance Baseline

Expected response times (empty cache):

| Call | Typical | Max |
|------|---------|-----|
| L1/L2 receipts | 200-400ms | 800ms |
| L1 logs | 100-200ms | 500ms |
| L2 trace | 300-600ms | 2000ms |
| BaseFee average | 50-150ms | 500ms |
| **Total** | **300-800ms** | **<10s** |

## Conclusion

✅ When all tests pass:
- ArbiTrace correctly identifies retryable tickets
- Timeline displays accurate blockchain history
- Failure analysis provides actionable insights
- UI is responsive and non-blocking
- Performance stays well under 10s SLO

The tool is ready for production use on Arbitrum mainnet!
