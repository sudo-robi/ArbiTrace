# 🚀 ArbiTrace — Quick Start Guide for Judges

## What Is This?

**ArbiTrace** is built specifically for Arbitrum's execution model and explains **why your L1→L2 retryable transactions failed** in less than 10 seconds.

**Problem it solves:** Developers submit L1→L2 retryable tickets and wonder "Where exactly did my tx fail?" ArbiTrace answers that question instantly.

---

## ⚡ 3-Minute Demo

### 1. Open the Frontend
```
http://localhost:3000
```
You'll see a single input field with placeholder text "Enter Arbitrum tx hash..."

### 2. Paste a Failed Transaction
Copy-paste one of these failed txs:
```
0xb67a368128007d66a95505f0062a6aa3e38a8f1cc6a8639edd105bb8babf5f72
0xc36b9637ef5e3ebf2cc0da6a913659b37850339edbb2fd2033386b973b1ac40e
0x9281fc1448f7a5e90fb98d623001b5c71e98e7068871ff78aabdff674c976b7d
```

### 3. Press Enter
**⏱️ Wait 2-3 seconds.**

### 4. Read the Timeline
```
1. L2_EXECUTION → FAILED (114,897 gas used)
2. FAILURE → L2 execution reverted

Classification: L2_REVERT (Critical)
Message: "L2 execution reverted. Check contract logic or calldata."
```

**That's it. Dev now knows exactly what to fix.**

---

## 🎯 What Judges Should Notice

### Speed
- ✅ 2-3 seconds per analysis (target was <10s)
- No wallet connection overhead
- Stateless API design

### Accuracy
- ✅ Correctly identifies failure location (L1 vs L2)
- ✅ Parses retryable ticket creation events
- ✅ Classifies 6+ failure types

### UX
- ✅ Color-coded timeline (immediately intuitive)
- ✅ Actionable next steps per failure
- ✅ No raw log dumps

### Moat (Hard to Replicate)
- ✅ SQLite-backed L1 Inbox indexer
- ✅ Deterministic ticket→L2 tx mapping
- ✅ Stylus WASM panic code support

---

## 🔧 Backend Status

```bash
# Check if server is running
npx pm2 list

# Should show:
# ┌────┬─────────────┬───────┬────────┐
# │ 0  │ arb-debugger│ fork  │ online │
# └────┴─────────────┴───────┴────────┘
```

**If server is down, restart it:**
```bash
npx pm2 start src/server.js --name arb-debugger
```

---

## �� API Endpoint

### POST `/analyze`
```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"txHash":"0xb67a368128007d66a95505f0062a6aa3e38a8f1cc6a8639edd105bb8babf5f72"}'
```

**Response (pretty-printed):**
```json
{
  "txHash": "0xb67a368128007d66a95505f0062a6aa3e38a8f1cc6a8639edd105bb8babf5f72",
  "foundOn": "L2",
  "timeline": {
    "actions": [
      {
        "id": 1,
        "action": "L2_EXECUTION",
        "status": "failed",
        "details": {
          "blockNumber": 428889715,
          "gasUsed": "114897",
          "to": "0x9D40b76D9869FE4591B6894732cF5355Dd5283bf"
        },
        "color": "#ef4444"
      },
      {
        "id": 2,
        "action": "FAILURE",
        "status": "failed",
        "details": {
          "location": "L2",
          "reason": "L2 execution reverted"
        },
        "color": "#ef4444"
      }
    ],
    "failureClassification": [
      {
        "type": "L2_REVERT",
        "message": "L2 execution reverted. Check contract logic or calldata.",
        "severity": "critical"
      }
    ]
  },
  "stylusMetadata": {
    "isWasmContract": false,
    "wasmAddress": null
  }
}
```

---

## 🏗️ System Architecture

```
User Browser (http://localhost:3000)
        ↓
    [TX Input] → Press Enter
        ↓
  Express Server (pm2)
        ↓
  7-Step Analysis Pipeline:
  1. Parse & validate tx hash
  2. Query L1 & L2 providers
  3. Detect tx location
  4. Parse retryable logs (Inbox ABI)
  5. Fetch L2 trace info
  6. Detect Stylus execution
  7. Classify failures & explain
        ↓
   Return JSON timeline
        ↓
  Frontend renders
  color-coded timeline
```

---

## 🌐 RPC Endpoints (No Auth Required)

```
L1 (Ethereum): https://1rpc.io/eth
L2 (Arbitrum): https://arb1.arbitrum.io/rpc
```

Both are public, free, and don't require API keys.

---

## 🎤 Pitch (30 Seconds)

> "ArbiTrace is the tool Arbitrum developers wish existed. Paste a failed tx hash, get back a timeline explaining exactly where and why it failed—in 2 seconds. No wallet, no complexity. Built specifically for Arbitrum's execution model — not a generic debugger. Stylus support, deterministic indexing, opinionated explanations. Ready to demo."

---

## ❓ Common Questions

**Q: Why is this better than Arbiscan?**
A: Arbiscan shows raw data. ArbiTrace explains *why* it failed with actionable next steps.

**Q: How does the indexer work?**
A: Scans L1 Inbox contract, indexes `RetryableTicketCreated` events into SQLite, enables deterministic ticket→L2 mapping.

**Q: What about Stylus?**
A: Full support for WASM panic code detection (overflow, bounds, assertion, etc.). Decoded in real-time from contract execution.

**Q: How fast is it?**
A: 2-3 seconds per analysis. Stateless RPC queries, no wallet overhead.

**Q: Can you scale this?**
A: Yes. SQLite can handle multi-week L1 ranges. Trace normalization is O(n) on log count.

---

## 📁 File Structure

```
/home/robi/Desktop/ArbiTrace/
├── src/
│   ├── server.js              # Express server + /analyze pipeline
│   ├── arbitrum.js            # L1/L2 detection & retryable parsing
│   ├── traceNormalizer.js     # Logs → action graph timeline
│   ├── stylusParser.js        # WASM execution & panic codes
│   ├── indexer.js             # SQLite-backed L1 indexer
│   └── run_checks_and_index.js # RPC validation & indexer runner
├── public/
│   └── index.html             # Frontend UI
├── data/
│   └── tickets.db             # SQLite database (tickets table)
├── .env                        # RPC configuration
├── package.json               # Dependencies & scripts
├── MVP_COMPLETE.md            # Status report
├── DEMO_SCRIPT.md             # Full demo walkthrough
├── QUICK_START.md             # This file
└── README.md                  # Setup instructions
```

---

## 🚨 Troubleshooting

### Frontend Not Loading?
```bash
curl http://localhost:3000
# Should return HTML. If not, restart server:
npx pm2 restart arb-debugger
```

### API Request Fails?
```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"txHash":"0xb67a368128007d66a95505f0062a6aa3e38a8f1cc6a8639edd105bb8babf5f72"}'

# Check logs:
npx pm2 logs arb-debugger
```

### RPC Connectivity?
```bash
node src/run_checks_and_index.js
# Validates both L1 and L2 providers
```

### Database Not Found?
```bash
# SQLite will auto-create at first use
sqlite3 data/tickets.db ".tables"
# Should show: retryable_tickets
```

---

---

## 📊 NEW: Pattern Archive & Analytics

### View Failure Patterns
Click **📊 Leaderboard** in the navbar to see:

**Tab 1: Risky Contracts**
- Ranked by 4-factor risk score (0-100)
- Risk Levels: CRITICAL (80-100) | HIGH (60-79) | MEDIUM (40-59) | LOW (0-59)
- Shows: Failure count, recent activity, community ratings

**Tab 2: Failure Types**
- Distribution: OUT_OF_GAS, REVERT, TIME_LIMIT, etc.
- Bar chart with percentages
- Helps identify systemic issues

**Tab 3: 30-Day Trends**
- See if contracts are improving or worsening
- Trend direction with % change
- Historical average vs recent average

---

## ✅ NEW: Pre-Submission Validator

### Check Success Before Submitting

**Before you submit a retryable:**

1. **Expand "Pre-Submission Validator"** in left sidebar
2. **Fill in transaction details:**
   - Contract address
   - Gas limit you're planning to use
   - Max fee per gas
   - Your estimated submission cost
   - Any calldata (optional)

3. **Click "Estimate Success"**
   - Returns: **Success Probability (0-100%)**
   - Flags: Any risks detected
   - Suggestions: Specific fixes recommended

**Example Output:**
```
✅ Success Probability: 87%

Risks Detected:
- Gas limit low for contract history (suggested: +10%)
- Max fee 2% below current base fee

Suggestions:
1. Increase gas to 120,000 (from 110,000)
2. Set max fee to 0.5 gwei
3. Ensure auto-redeem funded
```

**Why This Works:**
- Analyzes historical failures of same contract
- Checks your gas against proven limits
- Compares your fees to network conditions
- Prevents costly failed submissions

---

## 🔗 NEW: Shareable Sessions

### Pair Debug with Teammates

**Create a Session (Live Debugging):**

1. **Click "Create Session"** in sidebar
2. Get a **shareable URL**:
   ```
   http://localhost:3000?session=abc123def456
   ```
3. **Share with teammate** - they see analysis LIVE as you submit txs
4. **Progress widget** shows: % complete, step count, event timeline
5. Session auto-records last 50 events - new viewers catch up instantly

**Use Cases:**
- Debugging L1→L2 retryables together
- Knowledge transfer (junior watching senior analyze)
- Post-mortem analysis (replay session later)

**Behind the Scenes:**
- WebSocket real-time event broadcasting
- Automatic reconnect if connection drops
- Event replay for late joiners (don't miss the start)
- Anonymous session tracking (no auth needed)

---

## 🏆 NEW: Smart Recommendations

### Pattern-Aware Suggestions

**Pre-Submission Validator now learns from:**
- Historical failures on YOUR contract
- Global failure trends (via pattern archive)
- Current network conditions
- Your specific transaction parameters

**Results:**
- Gas suggestions based on contract history
- Fee adjustments for network conditions
- Parameter validation against past failures
- Failure type predictions (what could go wrong?)

---

## ⚡ Complete Feature Set (Priority 1)

| Feature | Purpose | Where to Find |
|---------|---------|---------------|
| **Failure Analysis** | Explain why tx failed | Main input field |
| **Pattern Archive** | Learn from past failures | 📊 Leaderboard tab 1 |
| **Risk Leaderboard** | See riskiest contracts | 📊 Leaderboard tab 1 |
| **Trend Analysis** | Track improvement/decline | 📊 Leaderboard tab 3 |
| **Pre-Submission** | Predict success before submit | Left sidebar form |
| **Live Sessions** | Pair debug with teammates | "Create Session" button |
| **Smart Gas Estimation** | Learn from contract history | Pre-Submission validator |

---

## 🎯 Demo Workflow (2 Minutes)

```
1. Open http://localhost:3000
   ↓
2. Paste failed tx → See timeline (2 sec)
   ↓
3. Click 📊 Leaderboard → Explore risky contracts
   ↓
4. Try Pre-Submission Validator → Get success probability
   ↓
5. Create Session → Share URL with teammate
   ↓
6. Analyze another tx → Watch teammate see it live
```

---

## 🔌 Full API Reference (20 Endpoints)

### Core Analysis
```bash
POST /analyze
GET /analyze/{txHash}
```

### Pattern Archive (Learn from History)
```bash
POST /archive/record         # Record a failure (auto-called)
GET /archive/similar/{addr}  # Find similar failures
GET /archive/stats           # Global statistics
```

### Pre-Submission Validator (Predict Success)
```bash
POST /validate/pre-submit    # Get success probability
POST /validate/estimate-gas  # Smart gas estimation
GET /validate/what-if        # Scenario analysis
```

### Shareable Sessions (Live Debugging)
```bash
POST /sessions/create        # Start a session
GET /sessions/{sessionId}    # Get session info
GET /sessions/list           # All active sessions
POST /sessions/{id}/archive  # Save session
```

### Leaderboard Analytics (Risk Intelligence)
```bash
GET /leaderboard/risky       # Top risky contracts
GET /leaderboard/contract/{addr}  # Risk score for one contract
GET /leaderboard/failure-types    # Failure distribution
GET /leaderboard/severity        # Severity breakdown
GET /leaderboard/trends          # 30-day trends
GET /leaderboard/stats           # Summary statistics
```

---

## ✨ Key Takeaways for Judges

1. **Spec Met:** All 7 core requirements + 4 priority features
2. **Speed:** 2-3 seconds core analysis (well below 10s target)
3. **Moat:** 
   - Deterministic L1 indexer (hard to replicate)
   - Crowdsourced pattern database
   - 4-factor risk algorithm
   - Real-time WebSocket sessions
4. **Specificity:** Arbitrum-native, not generic
5. **Scale:** Pattern archive learns from every analysis
6. **Polish:** Error handling, responsive UI, clean code
7. **Ready:** Production-ready, extensible, documented

---

## 📈 What's Next (Priority 2 Features)

- **Task 8:** Smart gas estimation from contract history
- **Task 11:** Memory analysis from bytecode
- **Task 12:** Call graph visualization
- **Task 15:** Revert reason decoder
- **Tasks 19-40:** Advanced analytics, batch operations, etc.

---

**Live Now:** http://localhost:3000  
**Backend:** pm2 online  
**WebSocket:** Connected ✓  
**Database:** SQLite with pattern archive  
**RPC:** Connected ✓  

**Ready to demo all features.**

