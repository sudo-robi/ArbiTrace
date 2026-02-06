import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import { body, validationResult } from 'express-validator'
import os from 'os'
import bodyParser from 'body-parser'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { findTxOnProviders, fetchL1Logs, findRetryableCreationLogs, findL2TransactionFromRetryable, fetchL2TraceInfo, getProviders, findRetryableLifecycle, debugTraceTransaction, findRetryableLifecycleViaIndexer, computeL2BaseFeeAverage, fetchL2GasPriceHistory, extractMemoryStorageAccess } from './arbitrum.js'
import { analyzeCrossChainCausality, computeCausalGraph } from './causalityAnalyzer.js'
import { resolveSelector } from './abiResolver.js'
import abiCache from './abiCache.js'
import { WebSocketProvider } from 'ethers'
import { normalizeTrace, buildTimeline } from './traceNormalizer.js'
import { detectStylusExecution, decodeStylusPanic, extractWasmExecutionContext, classifyStylusFailure, getStylusTimelineNode } from './stylusParser.js'
import indexer from './indexer.js'
import { cacheGet, cacheSet } from './cache.js'
import { initPatternArchive, recordFailure, findSimilarFailures, getFailurePattern, addUserTag, getTopRiskyContracts, getArchiveStats } from './patternArchive.js'
import { validatePreSubmission, estimateGasLimit, getDetailedRecommendations } from './preSubmissionValidator.js'
import { createHash } from 'crypto'
import { WebSocketServer } from 'ws'
import http from 'http'
import { initSessionManager, createSession, getSession, subscribeToSession, unsubscribeFromSession, removeClient, recordEvent, broadcastToSession, getShareUrl, getShareId, listActiveSessions, archiveSession, getSessionStats, startSessionCleanupInterval } from './sessionManager.js'
import auth from './auth.js'
import { initLeaderboardAnalytics, getContractRiskScore, getTopRiskyContracts as getTopRiskyContractsAnalytics, getFailureTypeStats, getTrendAnalysis, getSeverityDistribution, getLeaderboardStats } from './leaderboardAnalytics.js'
import { initGasEstimation, estimateOptimalGas, getGasOptimizationTips, buildMLFeatureMatrix, detectContractType, getContractGasHistory, calculateGasStatistics, analyzeFailurePatterns } from './smartGasEstimation.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

const app = express()

// If running behind a proxy/load balancer, trust the proxy headers
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1)

// Helmet with stricter defaults: defer CSP configuration to deploy-time
app.use(helmet({ contentSecurityPolicy: false }))

// CORS: allow restricting origins via CORS_ORIGINS env (comma-separated).
// If CORS_ORIGINS is not set, keep existing permissive behavior for dev.
const rawCors = process.env.CORS_ORIGINS || ''
const allowedOrigins = rawCors.split(',').map(s => s.trim()).filter(Boolean)
if (allowedOrigins.length > 0) {
  app.use(cors({ origin: (origin, cb) => {
    // allow requests with no origin (e.g. mobile apps, curl)
    if (!origin) return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  }}))
} else {
  // no explicit allow list configured — preserve permissive default
  app.use(cors())
}
app.use(bodyParser.json())
app.use(express.static(path.join(__dirname, '../public')))

// Global rate limiter (per-IP); fairly permissive but prevents basic abuse
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false
})
app.use(globalLimiter)

// Enforce HTTPS in production (if not terminated by proxy)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next()
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)
  })
}

const PORT = process.env.PORT || 3000

// Initialize pattern archive on startup
initPatternArchive()
initLeaderboardAnalytics()
// Initialize auth DB (creates data/auth.db and optional admin user)
auth.initAuth()

// Initialize gas estimation using the same pattern DB used by patternArchive
try {
  const patternsDbPath = path.join(__dirname, '..', 'data', 'patterns.db')
  const patternsDb = require('better-sqlite3')(patternsDbPath)
  initGasEstimation(patternsDb)
} catch (err) {
  console.error('❌ Failed to initialize gas estimation DB:', err.message)
}

/*
╔════════════════════════════════════════════════════════════════════════════╗
║                    OPERATIONAL CONSTRAINTS DOCUMENT                        ║
║               These are not bugs. They are intentional design limits.      ║
╚════════════════════════════════════════════════════════════════════════════╝

CONSTRAINT 1: Revert Reasons May Be Unavailable
════════════════════════════════════════════════════════════════════════════════
What we DO:
  ✅ Decode Error(string) revert reasons from trace
  ✅ Show raw hex if revert data present but not decodable
  ✅ Classify as "LOGIC_REVERT" even if reason unknown

What we DON'T support (by design):
  ❌ Custom error types (require contract ABI we don't have)
  ❌ Panic codes from EVM (arithmetic, division by zero, out of bounds)
  ❌ Low-level calls that don't bubble up reason
  ❌ Contract-specific error context

Reasoning: Decoding custom errors requires the contract ABI. Users can provide
ABIs via POST /abi/upload for better decoding, but we never assume ABI availability.

Fallback: Users get hex data + raw trace for manual inspection.


CONSTRAINT 2: Stylus (WASM) Support is Best-Effort Only
════════════════════════════════════════════════════════════════════════════════
What we DO:
  ✅ Detect WASM execution via precompile 0x71
  ✅ Decode standard panic codes (overflow, division by zero, out of bounds)
  ✅ Extract bytecode hash and mark transaction as Stylus execution
  ✅ Show WASM panic in failure classification

What we DON'T do (intentionally out of scope):
  ❌ Step through WASM bytecode opcode-by-opcode
  ❌ Decode custom/non-standard panic codes
  ❌ Analyze Rust source code or intermediate representation
  ❌ Show WASM memory state or local variables
  ❌ Provide Rust-level debugging

Reasoning: Full WASM debugging requires complete execution trace with memory
dumps + Rust debug info (not available on-chain) + standard formats (don't exist yet).

Scope: We help identify WASM failures. Full debugging requires off-chain tools.


CONSTRAINT 3: Historical Data Depends on Indexing Depth
════════════════════════════════════════════════════════════════════════════════
What we DO:
  ✅ Search indexed retryable tickets (if indexer was run)
  ✅ Query L1 Inbox events for recent blocks
  ✅ Query L2 ArbRetryable events for recent blocks
  ✅ Fall back to real-time RPC log scanning if indexer unavailable

What we DON'T provide (by design):
  ❌ Data older than indexing depth (default: ~500 blocks)
  ❌ Pruned or archived blocks from RPC
  ❌ Data from before indexing was started
  ❌ Multi-year transaction history

Reasoning: We're designed for real-time debugging, not archival. Optional
indexer provides performance for recent data.

Fallback: indexer.findByL1Tx() → findRetryableLifecycle() via RPC logs


CONSTRAINT 4: This is Debugging, NOT Design Consulting
════════════════════════════════════════════════════════════════════════════════
What we DO:
  ✅ Explain why your transaction failed (facts from trace/logs)
  ✅ Show timeline of events that occurred
  ✅ Provide causality analysis (L1→L2 correlation)
  ✅ Suggest numeric changes ("increase maxGas to 150000")

What we DON'T do (intentionally out of scope):
  ❌ Suggest architectural redesigns
  ❌ Recommend design patterns
  ❌ Perform security audits or vulnerability detection
  ❌ Provide gas optimization suggestions
  ❌ Offer "best practices" advice
  ❌ Suggest rewriting contract logic

Reasoning: Design decisions are context-specific. We explain what happened.
You decide what to do about it.

Scope: Debugging = "What happened?". Not auditing = "Is this secure?".
Not consulting = "How should you redesign?"

*/

// In-memory ABI storage for contract verification
const abiStorage = new Map()

/**
 * Comprehensive failure classifier that returns structured attribution.
 * 
 * CONSTRAINT 1 - Revert Reasons May Be Unavailable:
 *   This function decodes Error(string) reverts from the trace. However, not all
 *   revert types can be decoded:
 *   - Custom error types require the contract ABI (not always available)
 *   - Panic codes (arithmetic, bounds) are logged but not fully interpreted
 *   - Low-level calls that don't bubble revert reason appear as failed calls
 *   
 *   Fallback: Raw hex data is provided for manual inspection. Users can upload
 *   contract ABIs via POST /abi/upload for better custom error decoding.
 * 
 * CONSTRAINT 4 - Debugging Not Design:
 *   This function explains WHY the transaction failed (causality analysis only).
 *   It does NOT provide:
 *   - Architectural redesign suggestions
 *   - Gas optimization advice
 *   - Security audit findings
 *   - "Best practices" recommendations
 *   
 *   Scope: Answer "What happened?" not "How should I redesign?"
 */
async function classifyFailureDetailed(detection, retryable, l2TraceInfo, retryableLifecycle, timings = null) {
  const hints = []
  let debugTrace = null // Store trace for later use in rawData
  const result = {
    failureAt: 'UNKNOWN', // L1_SUBMISSION | RETRYABLE_CREATION | AUTO_REDEEM | MANUAL_REDEEM | L2_EXECUTION | UNKNOWN
    failureReason: 'UNKNOWN', // OUT_OF_GAS | LOGIC_REVERT | TIMEOUT | LOW_SUBMISSION_COST | LOW_GAS_LIMIT | UNKNOWN
    hints: []
  }

  // L1 failure takes precedence
  if (detection.l1Receipt && detection.l1Receipt.status === 0) {
    result.failureAt = 'L1_SUBMISSION'
    result.failureReason = 'LOGIC_REVERT'
    hints.push({ type: 'L1_FAILURE', message: 'L1 transaction reverted', severity: 'critical' })
  }

  // Retryable heuristics
  if (retryable) {
    try {
      const gasLimit = BigInt(retryable.gasLimit || '0')
      const submissionCost = BigInt(retryable.l2CallValue || '0')

      if (gasLimit > 0 && gasLimit < 100000n) {
        hints.push({ type: 'LOW_GAS_LIMIT', message: `maxGas (${retryable.gasLimit}) may be insufficient.`, severity: 'warning' })
        if (result.failureAt === 'UNKNOWN') result.failureReason = 'LOW_GAS_LIMIT'
      }
      if (submissionCost > 0 && submissionCost < 1000n) {
        hints.push({ type: 'LOW_SUBMISSION_COST', message: 'Submission cost appears low. Retryable may fail to auto-redeem.', severity: 'warning' })
        if (result.failureAt === 'UNKNOWN') result.failureReason = 'LOW_SUBMISSION_COST'
      }
      // Heuristic: gas price bid (maxFeePerGas) too low relative to recent L2 base fee
      try {
        const maxFeePerGas = BigInt(retryable.maxFeePerGas || '0')
        if (maxFeePerGas > 0n) {
            try {
            // Use recent average base fee instead of a single-block snapshot
            const t_avg = Date.now()
            const avgBaseFee = await computeL2BaseFeeAverage(10)
            if (timings) timings.computeL2BaseFeeAverageMs = Date.now() - t_avg
            if (avgBaseFee && avgBaseFee > 0n) {
              // threshold = avgBaseFee * 1.2
              const threshold = avgBaseFee * 12n / 10n
              if (maxFeePerGas < threshold) {
                hints.push({ type: 'LOW_GAS_PRICE', message: `maxFeePerGas (${retryable.maxFeePerGas}) appears low relative to recent L2 base fee (avg ${avgBaseFee.toString()}).`, severity: 'warning' })
                if (result.failureAt === 'UNKNOWN') result.failureReason = 'LOW_GAS_PRICE'
              }
            }
          } catch (e) {
            // ignore provider errors
          }
        }
      } catch (e) {}
    } catch (e) {}
  }

  // If there's lifecycle info for the retryable ticket, use it
  if (retryableLifecycle && Array.isArray(retryableLifecycle.events) && retryableLifecycle.events.length > 0) {
    // Find Redeemed events
    const redeemed = retryableLifecycle.events.filter(e => e.name === 'Redeemed')
    if (redeemed.length > 0) {
      // Determine whether auto or manual by proximity to creation block
      const created = retryableLifecycle.events.find(e => e.name === 'TicketCreated')
      if (created) {
        const createdBlock = Number(created.blockNumber)
        const firstRedeemBlock = Number(redeemed[0].blockNumber)
        const delta = Math.abs(firstRedeemBlock - createdBlock)
        if (delta <= 50) {
          result.failureAt = 'AUTO_REDEEM'
        } else {
          result.failureAt = 'MANUAL_REDEEM'
        }
      } else {
        result.failureAt = 'MANUAL_REDEEM'
      }
      // If a redeem transaction exists, try to determine its status
      // We can attempt to fetch the tx receipt
      try {
        const { l2Provider } = getProviders()
        const txr = await l2Provider.getTransactionReceipt(redeemed[0].transactionHash)
        if (txr && txr.status === 0) {
          result.failureReason = 'LOGIC_REVERT'
          hints.push({ type: 'REDEEM_FAILED', message: 'Redeem transaction reverted on L2', severity: 'critical' })
        } else {
          // Redeem succeeded; if original l2 execution failed, attribute accordingly
          if (detection.l2Receipt && detection.l2Receipt.status === 0) {
            result.failureAt = 'L2_EXECUTION'
            result.failureReason = 'LOGIC_REVERT'
          } else {
            // If everything succeeded, mark unknown
            if (result.failureAt === 'UNKNOWN') result.failureAt = 'UNKNOWN'
          }
        }
      } catch (e) {
        // ignore
      }
    }
  }

    // L2 receipt indicates execution failure
  if (detection.l2Receipt && detection.l2Receipt.status === 0) {
    result.failureAt = 'L2_EXECUTION'
    hints.push({ type: 'L2_REVERT', message: 'L2 execution reverted. Check contract logic or calldata.', severity: 'critical' })

    // Prefer debug trace output when available to determine exact cause
    try {
      const t_debug = Date.now()
      debugTrace = await debugTraceTransaction(detection.l2Receipt.transactionHash)
      if (t_debug && timings) timings.debugTraceTransactionMs = Date.now() - t_debug
      if (debugTrace) {
        // If RPC returned an error field
        if (debugTrace.error) {
          const em = String(debugTrace.error).toLowerCase()
          hints.push({ type: 'TRACE_ERROR', message: String(debugTrace.error), severity: 'critical' })
          if (em.includes('out of gas')) result.failureReason = 'OUT_OF_GAS'
          else if (em.includes('revert')) result.failureReason = 'LOGIC_REVERT'
        }

        // Check common return value fields for revert signature (0x08c379a0)
        const raw = debugTrace.returnValue || (debugTrace.result && debugTrace.result.returnValue) || debugTrace.output || (debugTrace.result && debugTrace.result.output) || null
        if (raw && String(raw).toLowerCase().includes('08c379a0')) {
          result.failureReason = 'LOGIC_REVERT'
          hints.push({ type: 'REVERT_RAW', message: `Revert data present (hex trimmed): ${String(raw).slice(0,200)}`, severity: 'critical' })
          try {
            // Check cache first
            const cacheKey = 'revert:' + (detection.l2Receipt && detection.l2Receipt.transactionHash ? detection.l2Receipt.transactionHash : '')
            const cached = cacheGet(cacheKey)
            if (cached) {
              result.failureMessage = cached
              hints.push({ type: 'REVERT_MESSAGE', message: result.failureMessage, severity: 'critical' })
            } else {
              // Attempt to decode Error(string) revert reason
              // CONSTRAINT: Only Error(string) reverts are decoded. Custom error types require
              // the contract ABI, which we don't always have. Panics and low-level failures
              // that don't bubble revert reason will show as hex data instead.
              const { AbiCoder } = await import('ethers')
              const abi = new AbiCoder()
              // strip selector (first 4 bytes -> 8 hex chars + '0x')
              const payload = '0x' + String(raw).replace(/^0x/, '').slice(8)
              const dec = abi.decode(['string'], payload)
              if (dec && dec[0]) {
                result.failureMessage = String(dec[0])
                hints.push({ type: 'REVERT_MESSAGE', message: result.failureMessage, severity: 'critical' })
                try { cacheSet(cacheKey, result.failureMessage, 1000 * 60 * 60) } catch (e) {}
              }
            }
          } catch (e) {
            // ignore decode failures
          }
        }
      }
    } catch (e) {
      // Ignore trace failures
    }

    // If trace didn't reveal cause, fall back to gas heuristics and provider.call
    if (result.failureReason === 'UNKNOWN') {
      try {
        const gasUsed = detection.l2Receipt.gasUsed ? BigInt(detection.l2Receipt.gasUsed) : null
        const gasLimit = detection.l2Receipt.gasLimit ? BigInt(detection.l2Receipt.gasLimit) : null
        if (gasUsed && gasLimit && gasLimit > 0n) {
          // More granular heuristic: if gasUsed is >= 99% of gasLimit, likely OOG
          const percentUsed = Number(gasUsed) / Number(gasLimit)
          if (percentUsed >= 0.99) result.failureReason = 'OUT_OF_GAS'
          else result.failureReason = 'LOGIC_REVERT'
        } else {
          try {
            const { l2Provider } = getProviders()
            const tx = await l2Provider.getTransaction(detection.l2Receipt.transactionHash)
            if (tx) {
              try {
                await l2Provider.call({ to: tx.to, data: tx.data })
              } catch (callErr) {
                const msg = (callErr && callErr.message) ? String(callErr.message) : ''
                if (msg.toLowerCase().includes('out of gas')) result.failureReason = 'OUT_OF_GAS'
                else if (msg.toLowerCase().includes('revert')) result.failureReason = 'LOGIC_REVERT'
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  // If still unknown but we had retryable and no L2 execution, mark potential auto redeem failure
  if (result.failureAt === 'UNKNOWN' && retryable) {
    result.failureAt = 'AUTO_REDEEM'
    if (result.failureReason === 'UNKNOWN') result.failureReason = 'LOW_SUBMISSION_COST'
    hints.push({ type: 'AUTO_REDEEM_MAYBE', message: 'No L2 execution found for the retryable ticket. It may have failed to auto-redeem.', severity: 'warning' })
  }

  result.hints = hints.length > 0 ? hints : [{ type: 'UNKNOWN', message: 'No failure detected', severity: 'info' }]
  return { result, debugTrace }
}

app.post('/analyze', async (req, res) => {
  try {
    const { txHash, sessionId } = req.body
    if (!txHash) return res.status(400).json({ error: 'txHash required' })

    const start = Date.now()
    const rpcTimings = {}

    // Notify session subscribers that analysis started
    if (sessionId) {
      recordEvent(sessionId, 'analysis_started', {
        txHash,
        timestamp: new Date().toISOString(),
        totalSteps: 8
      })
      broadcastToSession(sessionId, {
        type: 'analysis_started',
        txHash,
        totalSteps: 8
      })
    }

    // Step 1: Detect L1 vs L2
    const t_find = Date.now()
    const detection = await findTxOnProviders(txHash)
    rpcTimings.findTxOnProvidersMs = Date.now() - t_find

    if (sessionId) {
      recordEvent(sessionId, 'step_completed', { step: 1, description: 'Detected transaction location' })
      broadcastToSession(sessionId, {
        type: 'step_completed',
        step: 1,
        description: 'Detected transaction location',
        data: { isL1: !!detection.l1Receipt, isL2: !!detection.l2Receipt }
      })
    }

    // Step 2-4: Parallelize independent RPC calls with 5-second timeout per call
    const t_parallel = Date.now()
    
    // Setup parallel promises with timeout guards
    const timeoutPromise = (promise, ms, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms))
    ]).catch(err => {
      console.warn(`⚠️ ${label} failed or timed out:`, err.message)
      return null
    })

    const [l1Logs, l2TraceInfoResult, gasPriceHistoryResult] = await Promise.all([
      timeoutPromise(
        detection.l1Receipt ? fetchL1Logs(detection.l1Receipt) : Promise.resolve(null),
        5000,
        'fetchL1Logs'
      ),
      timeoutPromise(
        detection.l2Receipt ? fetchL2TraceInfo(detection.l2Receipt.transactionHash) : Promise.resolve(null),
        5000,
        'fetchL2TraceInfo'
      ),
      timeoutPromise(
        fetchL2GasPriceHistory(50), // Reduced from 100 to 50 blocks for speed
        3000,
        'fetchL2GasPriceHistory'
      )
    ])

    rpcTimings.parallelCallsMs = Date.now() - t_parallel
    const retryables = detection.l1Receipt && l1Logs ? findRetryableCreationLogs(l1Logs, detection.l1Receipt) : []
    const l2TraceInfo = l2TraceInfoResult
    const gasPriceHistory = gasPriceHistoryResult

    if (sessionId) {
      recordEvent(sessionId, 'step_completed', { step: 2, description: 'Fetched logs and trace data' })
      broadcastToSession(sessionId, {
        type: 'step_completed',
        step: 2,
        description: 'Fetched logs and trace data',
        data: { retryablesFound: retryables.length, hasTrace: !!l2TraceInfo }
      })
    }

    // Step 3: If we found a retryable, attempt to find L2 tx (parallelized with lifecycle lookup)
    let l2Search = null
    let retryableLifecycleNew = null
    const retryableForParallel = retryables[0] || null
    
    if (retryableForParallel) {
      const [l2SearchResult, lifecycleResult] = await Promise.all([
        timeoutPromise(
          findL2TransactionFromRetryable(retryableForParallel, 100),
          3000,
          'findL2TransactionFromRetryable'
        ),
        timeoutPromise(
          (async () => {
            try {
              const indexerResult = await findRetryableLifecycleViaIndexer(detection.txHash)
              if (indexerResult.ok && indexerResult.tickets && indexerResult.tickets.length > 0) {
                return { ok: true, events: [], indexerTickets: indexerResult.tickets }
              }
              return await findRetryableLifecycle(retryableForParallel.ticketId, 400)
            } catch (e) {
              return null
            }
          })(),
          4000,
          'findRetryableLifecycle'
        )
      ])
      l2Search = l2SearchResult
      retryableLifecycleNew = lifecycleResult

      if (sessionId) {
        recordEvent(sessionId, 'step_completed', { step: 3, description: 'Analyzed retryable ticket' })
        broadcastToSession(sessionId, {
          type: 'step_completed',
          step: 3,
          description: 'Analyzed retryable ticket',
          data: { found: !!l2Search?.found }
        })
      }
    }

    // Step 5: Classify failures (detailed)
    // Use already-fetched retryable and lifecycle from parallel execution in Step 3
    const retryable = retryables[0] || null
    // If parallel execution found lifecycle, use it; otherwise use null
    const retryableLifecycle = retryableLifecycleNew
    const failureDetailsObj = await classifyFailureDetailed(detection, retryable, l2TraceInfo, retryableLifecycle, rpcTimings)
    const failureDetails = failureDetailsObj.result
    const debugTrace = failureDetailsObj.debugTrace
    const failureHints = failureDetails.hints

    // Step 5b: Detect Stylus (WASM) execution
    const l2ReceiptForStylusDetection = detection.l2Receipt ? {
      to: detection.l2Receipt.to,
      status: detection.l2Receipt.status,
      gasUsed: detection.l2Receipt.gasUsed,
      gasLimit: detection.l2Receipt.gasLimit,
      contractAddress: detection.l2Receipt.contractAddress
    } : null
    const stylusMarkers = detectStylusExecution(l2ReceiptForStylusDetection, l1Logs)
    const stylusContext = extractWasmExecutionContext(l2ReceiptForStylusDetection, l1Logs)
    
    if (stylusMarkers && stylusMarkers.isWasmContract) {
      const stylusFails = classifyStylusFailure(stylusMarkers, null, l2ReceiptForStylusDetection)
      failureHints.push(...stylusFails)
    }

    // Step 6: Normalize trace into action graph
    const actionGraph = normalizeTrace(detection, retryables, l2TraceInfo)
    
    // Add Stylus node if applicable
    if (stylusMarkers && stylusMarkers.isWasmContract) {
      const stylusNode = getStylusTimelineNode(stylusMarkers, stylusContext)
      if (stylusNode) {
        actionGraph.push({
          id: actionGraph.length + 1,
          timestamp: null,
          action: stylusNode.action,
          status: stylusContext?.status === 'failure' ? 'failed' : 'confirmed',
          details: stylusNode.details
        })
      }
    }


    const timeline = buildTimeline(actionGraph, failureHints)

    // Step 7: Analyze cross-chain causality if we have both L1 and L2 data with a retryable
    let crossChainCausality = null
    let causalGraph = null
    if (retryable && detection.l2Receipt) {
      try {
        crossChainCausality = analyzeCrossChainCausality(
          detection,
          retryable,
          detection.l2Receipt,
          failureDetails.failureReason,
          failureDetails.failureMessage
        )
        causalGraph = computeCausalGraph(detection, retryables, detection.l2Receipt)
      } catch (e) {
        // Causality analysis is optional; don't fail the entire response
        console.error('Causality analysis error:', e.message)
      }
    }
      // Return analysis
      // Enrich receipts with block timestamps (parallelized with timeout)
      try {
        const { l1Provider, l2Provider } = getProviders()
        await Promise.all([
          (async () => {
            if (detection.l1Receipt && detection.l1Receipt.blockNumber) {
              try {
                const b1 = await timeoutPromise(
                  l1Provider.getBlock(detection.l1Receipt.blockNumber),
                  2000,
                  'L1 block fetch'
                )
                detection.l1Receipt.blockTimestamp = b1 ? b1.timestamp : null
              } catch (e) {
                // ignore
              }
            }
          })(),
          (async () => {
            if (detection.l2Receipt && detection.l2Receipt.blockNumber) {
              try {
                const b2 = await timeoutPromise(
                  l2Provider.getBlock(detection.l2Receipt.blockNumber),
                  2000,
                  'L2 block fetch'
                )
                detection.l2Receipt.blockTimestamp = b2 ? b2.timestamp : null
              } catch (e) {
                // ignore
              }
            }
          })()
        ])
      } catch (e) {
        // providers not available or error fetching blocks - continue
      }

    const responseData = {
      txHash: detection.txHash,
      foundOn: detection.foundOn,
      failureAt: failureDetails.failureAt,
      failureReason: failureDetails.failureReason,
      failureMessage: failureDetails.failureMessage || null,
      explanation: crossChainCausality && crossChainCausality.humanMessage ? crossChainCausality.humanMessage : (failureDetails.failureMessage || null),
      timeline: timeline,
      stylusMetadata: stylusMarkers,
      crossChainCausality: crossChainCausality,
      causalGraph: causalGraph,
      rawData: {
        // Full L1 Receipt (unfiltered)
        l1Receipt: detection.l1Receipt ? {
          transactionHash: detection.l1Receipt.transactionHash,
          status: detection.l1Receipt.status,
          blockNumber: detection.l1Receipt.blockNumber,
          blockTimestamp: detection.l1Receipt.blockTimestamp || null,
          // Extended fields for advanced verification
          gasUsed: detection.l1Receipt.gasUsed ? detection.l1Receipt.gasUsed.toString() : null,
          gasLimit: detection.l1Receipt.gasLimit ? detection.l1Receipt.gasLimit.toString() : null,
          from: detection.l1Receipt.from,
          to: detection.l1Receipt.to,
          value: detection.l1Receipt.value ? detection.l1Receipt.value.toString() : null,
          nonce: detection.l1Receipt.nonce,
          contractAddress: detection.l1Receipt.contractAddress,
          cumulativeGasUsed: detection.l1Receipt.cumulativeGasUsed ? detection.l1Receipt.cumulativeGasUsed.toString() : null,
          effectiveGasPrice: detection.l1Receipt.effectiveGasPrice ? detection.l1Receipt.effectiveGasPrice.toString() : null,
          logsCount: detection.l1Receipt.logs ? detection.l1Receipt.logs.length : 0,
          type: detection.l1Receipt.type
        } : null,
        // Full L2 Receipt (unfiltered)
        l2Receipt: detection.l2Receipt ? {
          transactionHash: detection.l2Receipt.transactionHash,
          status: detection.l2Receipt.status,
          blockNumber: detection.l2Receipt.blockNumber,
          blockTimestamp: detection.l2Receipt.blockTimestamp || null,
          // Extended fields for advanced verification
          gasUsed: detection.l2Receipt.gasUsed ? detection.l2Receipt.gasUsed.toString() : null,
          gasLimit: detection.l2Receipt.gasLimit ? detection.l2Receipt.gasLimit.toString() : null,
          from: detection.l2Receipt.from,
          to: detection.l2Receipt.to,
          value: detection.l2Receipt.value ? detection.l2Receipt.value.toString() : null,
          nonce: detection.l2Receipt.nonce,
          contractAddress: detection.l2Receipt.contractAddress,
          cumulativeGasUsed: detection.l2Receipt.cumulativeGasUsed ? detection.l2Receipt.cumulativeGasUsed.toString() : null,
          effectiveGasPrice: detection.l2Receipt.effectiveGasPrice ? detection.l2Receipt.effectiveGasPrice.toString() : null,
          logsCount: detection.l2Receipt.logs ? detection.l2Receipt.logs.length : 0,
          type: detection.l2Receipt.type
        } : null,
        // All L1 logs (not just retryable events)
        l1Logs: l1Logs ? l1Logs.map((log, idx) => ({
          logIndex: log.logIndex,
          address: log.address,
          topics: log.topics,
          data: log.data,
          transactionIndex: idx,
          removed: false
        })) : [],
        // All L2 logs (if available)
        l2Logs: detection.l2Receipt && detection.l2Receipt.logs ? detection.l2Receipt.logs.map((log) => ({
          logIndex: log.logIndex,
          address: log.address,
          topics: log.topics,
          data: log.data,
          removed: false,
          blockHash: detection.l2Receipt.blockHash
        })) : [],
        retryableTickets: retryables,
        l2TraceInfo: l2TraceInfo,
        // Debug trace if available
        l2DebugTrace: l2TraceInfo && l2TraceInfo._debugTrace ? l2TraceInfo._debugTrace : null,
        // Memory and storage access patterns from trace
        traceAnalysis: debugTrace ? extractMemoryStorageAccess(debugTrace) : null,
        // Historical gas price data for context
        gasPriceHistory: gasPriceHistory
      },
      errors: detection.errors
    }
    // attach timing info so callers can assert <10s requirement
    responseData.responseTimeMs = Date.now() - start
    
    // Record this analysis in pattern archive (async, don't block response)
    try {
      recordFailure({
        l1TxHashPrefix: detection.txHash ? String(detection.txHash).slice(0, 10) : null,
        l2TxHashPrefix: detection.l2Receipt ? String(detection.l2Receipt.transactionHash).slice(0, 10) : null,
        contractAddressHash: detection.l2Receipt && detection.l2Receipt.to ? createHash('sha256').update(detection.l2Receipt.to).digest('hex').slice(0, 16) : null,
        failureAt: failureDetails.failureAt,
        failureReason: failureDetails.failureReason,
        gasLimit: retryable ? parseInt(retryable.gasLimit) : null,
        maxFeePerGas: retryable ? parseInt(retryable.maxFeePerGas) : null,
        submissionCost: retryable ? parseInt(retryable.l2CallValue) : null,
        revertReason: failureDetails.failureMessage,
        isStylus: !!(stylusMarkers && stylusMarkers.isWasmContract),
        panicCode: stylusMarkers ? stylusMarkers.panicCode : null,
        callDataLength: retryable ? (retryable.data ? retryable.data.length : 0) : null
      })
    } catch (e) {
      console.error('Error recording pattern:', e.message)
      // Don't fail the main request
    }
    
    // Notify session subscribers of analysis completion
    if (sessionId) {
      recordEvent(sessionId, 'analysis_completed', {
        txHash,
        failureReason: failureDetails ? failureDetails.failureReason : null,
        responseTimeMs: Date.now() - start
      })
      broadcastToSession(sessionId, {
        type: 'analysis_completed',
        txHash,
        failureReason: failureDetails ? failureDetails.failureReason : null,
        responseTimeMs: Date.now() - start
      })
    }
    
    return res.json(responseData)
  } catch (e) {
    // Notify session of analysis error
    if (req.body && req.body.sessionId) {
      const sid = req.body.sessionId
      recordEvent(sid, 'analysis_error', { error: e.message })
      broadcastToSession(sid, {
        type: 'analysis_error',
        error: e.message
      })
    }
    return res.status(500).json({ error: e.message })
  }
})

app.get('/', (req, res) => res.send('Arbitrum Debugger MVP backend'))

// Endpoint to run indexer for a block range (optional)
app.post('/indexer/run', async (req, res) => {
  try {
    const { startBlock, endBlock } = req.body || {}
    if (typeof startBlock !== 'number' || typeof endBlock !== 'number') {
      return res.status(400).json({ error: 'startBlock and endBlock (numbers) required' })
    }
    const result = await indexer.indexRange(startBlock, endBlock)
    return res.json({ success: true, result })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Simple SSE mempool relay. Requires ARBITRUM_WS_URL in env to subscribe to pending
const sseClients = new Set()
let wsProvider = null
let wsConnected = false
let reconnectAttempt = 0
let reconnectTimer = null
let pendingHandler = null
const MAX_BACKOFF = 60000 // 60s
async function subscribePending(provider) {
  // remove previous handler if present
  if (pendingHandler && wsProvider && typeof wsProvider.off === 'function') {
    try { wsProvider.off('pending', pendingHandler) } catch (e) {}
  }

  pendingHandler = async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash)
      if (!tx) return
          const payload = JSON.stringify({ hash: txHash, from: tx.from, to: tx.to, data: tx.data || tx.input || null, gasPrice: tx.maxFeePerGas ? tx.maxFeePerGas.toString() : (tx.gasPrice ? tx.gasPrice.toString() : null), time: Date.now() })
      for (const res of sseClients) {
        try { res.write(`data: ${payload}\n\n`) } catch (e) { /* ignore broken client */ }
      }
    } catch (e) {
      // ignore per-tx errors
    }
  }

  try {
    provider.on('pending', pendingHandler)
  } catch (e) {
    // provider may not support .on
  }
}

function scheduleReconnect(url) {
  reconnectAttempt++
  const backoff = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), MAX_BACKOFF)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => connectWsProvider(url), backoff)
}

async function connectWsProvider(url) {
  if (!url) return
  try {
    if (wsProvider && typeof wsProvider.destroy === 'function') {
      try { wsProvider.removeAllListeners && wsProvider.removeAllListeners() } catch (e) {}
      try { wsProvider.destroy() } catch (e) {}
    }
  } catch (e) {}

  try {
    wsProvider = new WebSocketProvider(url)
    reconnectAttempt = 0

    // best-effort track underlying websocket open/close
    try {
      const w = wsProvider._websocket
      wsConnected = !!(w && w.readyState === 1)
      if (w && w.addEventListener) {
        w.addEventListener('open', () => { wsConnected = true })
        w.addEventListener('close', () => { wsConnected = false; scheduleReconnect(url) })
        w.addEventListener('error', () => { wsConnected = false; scheduleReconnect(url) })
      }
    } catch (e) {}

    await subscribePending(wsProvider)
  } catch (e) {
    console.warn('Failed to connect to ARBITRUM_WS_URL for mempool SSE:', e.message || e)
    wsProvider = null
    wsConnected = false
    scheduleReconnect(url)
  }
}

if (process.env.ARBITRUM_WS_URL) {
  connectWsProvider(process.env.ARBITRUM_WS_URL)
}

// SSE heartbeat to keep connections alive and remove closed clients
setInterval(() => {
  for (const res of Array.from(sseClients)) {
    try {
      // send comment ping
      res.write(': ping\n\n')
    } catch (e) {
      try { sseClients.delete(res) } catch (ee) {}
    }
  }
  // update wsConnected if possible
  try {
    const w = wsProvider && wsProvider._websocket
    wsConnected = !!(w && w.readyState === 1)
  } catch (e) {}
}, 15000)

app.get('/mempool/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.write('\n')
  sseClients.add(res)
  req.on('close', () => {
    sseClients.delete(res)
  })
})

// Server status endpoint for admin/debug panel
app.get('/status', async (req, res) => {
  try {
    const indexerStats = (indexer && typeof indexer.stats === 'function') ? indexer.stats() : { count: 0, last_block: null }
    const abiStats = (abiCache && typeof abiCache.stats === 'function') ? abiCache.stats() : { count: 0 }
    return res.json({ ok: true, sseClientCount: sseClients.size, wsUrlPresent: !!process.env.ARBITRUM_WS_URL, wsConnected, indexer: indexerStats, abiCache: abiStats })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Indexer query endpoints
app.get('/indexer/ticket/:ticketId', async (req, res) => {
  try {
    const ticketId = req.params.ticketId
    if (!ticketId) return res.status(400).json({ ok: false, error: 'ticketId required' })
    const { default: indexerModule } = await import('./indexer.js')
    const ticket = indexerModule.getTicket ? indexerModule.getTicket(ticketId) : null
    const mapping = indexerModule.findL2ForTicket ? indexerModule.findL2ForTicket(ticketId) : null
    return res.json({ ok: true, ticket, mapping })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/indexer/stylus/:txHash', async (req, res) => {
  try {
    const tx = req.params.txHash
    if (!tx) return res.status(400).json({ ok: false, error: 'txHash required' })
    const { getStylusMeta } = await import('./indexer.js')
    const meta = getStylusMeta ? getStylusMeta(tx) : null
    return res.json({ ok: true, meta })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Persistent admin TODOs (simple JSON file)
const TODOS_PATH = path.join(process.cwd(), 'data', 'frontend_todos.json')

// Basic admin authentication middleware.
// Set `ADMIN_API_KEY` in environment to protect admin endpoints.
// Basic admin authentication middleware with logging for failed attempts.
// Set `ADMIN_API_KEY` in environment to protect admin endpoints.
function logFailedAdminAuth(req) {
  try {
    const logDir = path.join(process.cwd(), 'data')
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    const file = path.join(logDir, 'admin_auth.log')
    const entry = `${new Date().toISOString()}\t${req.ip || req.connection.remoteAddress}\t${req.method}\t${req.originalUrl}\tFAILED_ADMIN_AUTH${os.EOL}`
    fs.appendFileSync(file, entry, 'utf8')
  } catch (e) { }
}

function requireAdminWithLogging(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY
  if (!adminKey) {
    if (process.env.NODE_ENV === 'production') {
      logFailedAdminAuth(req)
      return res.status(403).json({ ok: false, error: 'Admin API key not configured' })
    }
    return next()
  }

  const headerKey = req.get('x-api-key') || (req.headers.authorization && String(req.headers.authorization).split(' ')[1]) || req.query.api_key
  if (!headerKey || headerKey !== adminKey) {
    logFailedAdminAuth(req)
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }
  return next()
}

// Rate limiters
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false
})

const createLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute for create endpoints
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
})

function readTodos() {
  try {
    if (!fs.existsSync(TODOS_PATH)) return []
    const raw = fs.readFileSync(TODOS_PATH, 'utf8')
    return JSON.parse(raw || '[]')
  } catch (e) {
    return []
  }
}

// Atomic safe write for JSON files: write to temp then rename
function safeWriteJSON(filePath, obj) {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, filePath)
    return true
  } catch (e) {
    return false
  }
}

function writeTodos(list) {
  try {
    if (!Array.isArray(list)) return false
    // Basic sanitization: only keep title and optional note for each todo
    const sanitized = list.map((t) => {
      if (!t || typeof t !== 'object') return null
      const title = t.title && typeof t.title === 'string' ? String(t.title).slice(0, 200) : ''
      const note = t.note && typeof t.note === 'string' ? String(t.note).slice(0, 2000) : ''
      return { title, note }
    }).filter(Boolean)
    return safeWriteJSON(TODOS_PATH, sanitized)
  } catch (e) {
    return false
  }
}

app.get('/admin/todos', requireAdminWithLogging, adminLimiter, (req, res) => {
  try {
    const todos = readTodos()
    return res.json({ ok: true, todos })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Deprecated: admin API key still supported if present, but prefer JWT.
// Provide login endpoint to obtain JWT: POST /admin/login { username, password }
app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {}
    if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' })
    const user = auth.verifyUser(username, password)
    if (!user) return res.status(401).json({ ok: false, error: 'invalid credentials' })
    const token = auth.generateToken(user)
    return res.json({ ok: true, token })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Middleware: require JWT (or fall back to ADMIN_API_KEY for migration)
function requireAuth(role = null) {
  return (req, res, next) => {
    try {
      const authHeader = req.get('authorization') || ''
      let token = null
      if (authHeader.toLowerCase().startsWith('bearer ')) token = authHeader.slice(7).trim()
      let payload = null
      if (token) payload = auth.verifyToken ? auth.verifyToken(token) : null
      // fallback to API key for migration compatibility
      if (!payload) {
        const adminKey = process.env.ADMIN_API_KEY
        const headerKey = req.get('x-api-key') || (req.headers.authorization && String(req.headers.authorization).split(' ')[1]) || req.query.api_key
        if (adminKey && headerKey && headerKey === adminKey) {
          payload = { username: 'legacy-admin', role: 'admin' }
        }
      }
      if (!payload) {
        logFailedAdminAuth(req)
        return res.status(401).json({ ok: false, error: 'Unauthorized' })
      }
      if (role && payload.role !== role) return res.status(403).json({ ok: false, error: 'Forbidden' })
      req.user = payload
      return next()
    } catch (e) {
      logFailedAdminAuth(req)
      return res.status(401).json({ ok: false, error: 'Unauthorized' })
    }
  }
}

// Admin user management endpoints
app.get('/admin/users', requireAuth('admin'), adminLimiter, (req, res) => {
  try {
    const users = auth.listUsers()
    return res.json({ ok: true, users })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/admin/users', requireAuth('admin'), adminLimiter, (req, res) => {
  try {
    const { username, password, role } = req.body || {}
    if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' })
    const created = auth.createUser(username, password, role || 'user')
    if (!created) return res.status(500).json({ ok: false, error: 'failed to create user (maybe exists)' })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Apply new auth middleware below: replace admin key usage with JWT-based auth where appropriate

app.post('/admin/todos', requireAuth('admin'), adminLimiter, (req, res) => {
  try {
    const { todos } = req.body || {}
    if (!Array.isArray(todos)) return res.status(400).json({ ok: false, error: 'todos array required' })

    // Validate each todo shape
    for (const t of todos) {
      if (!t || typeof t !== 'object' || typeof t.title !== 'string' || t.title.trim().length === 0) {
        return res.status(400).json({ ok: false, error: 'Each todo must be an object with a non-empty title' })
      }
    }

    const ok = writeTodos(todos)
    if (!ok) return res.status(500).json({ ok: false, error: 'failed to write todos' })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// ABI selector resolver endpoint
app.post('/abi/resolve', async (req, res) => {
  try {
    const { data } = req.body || {}
    if (!data || typeof data !== 'string' || data.length < 10) return res.status(400).json({ ok: false, error: 'data (calldata) required' })
    const selector = data.slice(0, 10)
    const result = await resolveSelector(selector)
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Server-side calldata decode endpoint
app.post('/abi/decode', async (req, res) => {
  try {
    const { data, signature } = req.body || {}
    if (!data || typeof data !== 'string' || data.length < 10) return res.status(400).json({ ok: false, error: 'data (calldata) required' })
    if (!signature || typeof signature !== 'string') return res.status(400).json({ ok: false, error: 'signature required (e.g. transfer(address,uint256))' })

    try {
      // Use ethers Interface to decode
      const { Interface } = await import('ethers')
      const iface = new Interface([`function ${signature}`])
      let decoded = null
      try {
        // Try by function name first
        const name = signature.split('(')[0]
        decoded = iface.decodeFunctionData(name, data)
      } catch (e) {
        try {
          decoded = iface.decodeFunctionData(signature, data)
        } catch (ee) {
          // final attempt: try decode by selector (may throw)
          decoded = null
        }
      }

      if (decoded === null) return res.json({ ok: false, error: 'Could not decode calldata with provided signature' })

      // Convert decoded (Result) to plain object
      const out = {}
      try {
        for (const k of Object.keys(decoded)) {
          if (!isNaN(Number(k))) continue
          out[k] = decoded[k]
        }
      } catch (e) {
        // fallback: stringify
      }

      return res.json({ ok: true, signature, decoded: out })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message })
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Compute retryable lifecycle details with educational information
function computeRetryableLifecycle(ticket, lifecycleEvents) {
  const createdAtMs = ticket ? (ticket.created_at || Date.now()) : Date.now()
  const createdAtSec = Math.floor(createdAtMs / 1000)
  const now = Math.floor(Date.now() / 1000)

  // Retryable auto-redeem window: ~1 hour (3600 seconds) after creation
  const autoRedeemWindowSec = 3600
  const autoRedeemDeadline = createdAtSec + autoRedeemWindowSec
  const autoRedeemExpired = now > autoRedeemDeadline

  // Manual redeem window: 7 days (604800 seconds) from creation
  const manualRedeemWindowSec = 7 * 86400
  const manualRedeemDeadline = createdAtSec + manualRedeemWindowSec
  const manualRedeemExpired = now > manualRedeemDeadline

  // Parse lifecycle events
  let autoRedeemAttempted = false
  let autoRedeemSucceeded = false
  let manualRedeemAttempted = false
  let manualRedeemSucceeded = false
  let extendedCount = 0

  if (lifecycleEvents && Array.isArray(lifecycleEvents.events)) {
    for (const event of lifecycleEvents.events) {
      if (event.name === 'Redeemed') {
        const blockDelta = event.blockNumber - (ticket ? ticket.block_number : 0)
        if (blockDelta <= 50) {
          autoRedeemAttempted = true
          autoRedeemSucceeded = true
        } else {
          manualRedeemAttempted = true
          manualRedeemSucceeded = true
        }
      }
      if (event.name === 'LifetimeExtended') {
        extendedCount++
      }
    }
  }

  return {
    createdAt: createdAtMs,
    autoRedeemWindowSec,
    autoRedeemDeadline,
    autoRedeemExpired,
    autoRedeemAttempted,
    autoRedeemSucceeded,
    manualRedeemWindowSec,
    manualRedeemDeadline,
    manualRedeemExpired,
    manualRedeemAttempted,
    manualRedeemSucceeded,
    lifetimeExtensions: extendedCount,
    status: manualRedeemExpired ? 'EXPIRED' : (manualRedeemSucceeded ? 'REDEEMED' : (autoRedeemSucceeded ? 'AUTO_REDEEMED' : 'PENDING')),
    educationalNotes: {
      autoRedeem: autoRedeemSucceeded ? '✅ Auto-redeem succeeded within 1 hour' : (autoRedeemExpired ? '❌ Auto-redeem window expired' : '⏳ Auto-redeem possible (within 1 hour)'),
      manualRedeem: manualRedeemSucceeded ? '✅ Manually redeemed' : (manualRedeemExpired ? '❌ Ticket expired - unclaimable' : '⏳ Can be manually redeemed (7 day window)'),
      whoCanRedeem: !manualRedeemSucceeded && !manualRedeemExpired ? 'Anyone (originally beneficiary address, then anyone after auto-redeem window)' : 'N/A',
      expiryWarning: manualRedeemExpired ? '⚠️ Ticket has expired. All funds lost unless refund address claimed within grace period.' : null
    }
  }
}

// Retryable ticket lookup by L1 tx hash with enhanced lifecycle details
app.get('/retryable/search', async (req, res) => {
  try {
    const tx = req.query.tx
    if (!tx) return res.status(400).json({ ok: false, error: 'tx query parameter required' })
    try {
      const indexerModule = indexer
      if (!indexerModule) return res.json({ ok: false, tickets: [] })
      const list = indexerModule.findByL1Tx ? indexerModule.findByL1Tx(tx) : []
      
      // Enhance each ticket with lifecycle details
      const enhanced = await Promise.all(list.map(async (ticket) => {
        try {
          const lifecycle = await findRetryableLifecycle(ticket.ticket_id, 800)
          const details = computeRetryableLifecycle(ticket, lifecycle)
          return { ...ticket, lifecycle: details }
        } catch (e) {
          return { ...ticket, lifecycle: { status: 'UNKNOWN', error: e.message } }
        }
      }))
      
      return res.json({ ok: true, tickets: enhanced })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message })
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// ============ ABI Management Endpoints ============

// Upload or update a contract ABI for an address
app.post('/abi/upload', (req, res) => {
  try {
    const { address, abi } = req.body
    if (!address || !abi) {
      return res.status(400).json({ error: 'address and abi (array) required' })
    }
    
    // Normalize address to lowercase
    const normalizedAddress = String(address).toLowerCase()
    
    // Validate that abi is an array
    if (!Array.isArray(abi)) {
      return res.status(400).json({ error: 'abi must be an array' })
    }
    
    // Store the ABI
    abiStorage.set(normalizedAddress, abi)
    
    return res.json({ 
      ok: true, 
      message: `ABI stored for address ${normalizedAddress}`,
      addressCount: abiStorage.size
    })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Retrieve a stored ABI for an address
app.get('/abi/:address', (req, res) => {
  try {
    const address = String(req.params.address).toLowerCase()
    const abi = abiStorage.get(address)
    
    if (!abi) {
      return res.status(404).json({ error: `No ABI found for address ${address}` })
    }
    
    return res.json({ ok: true, address, abi })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// List all stored ABIs (addresses only, not full ABIs)
app.get('/abi/list', (req, res) => {
  try {
    const addresses = Array.from(abiStorage.keys())
    return res.json({ 
      ok: true, 
      count: addresses.length,
      addresses: addresses
    })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Delete a stored ABI
app.delete('/abi/:address', (req, res) => {
  try {
    const address = String(req.params.address).toLowerCase()
    const existed = abiStorage.has(address)
    
    if (!existed) {
      return res.status(404).json({ error: `No ABI found for address ${address}` })
    }
    
    abiStorage.delete(address)
    
    return res.json({ 
      ok: true, 
      message: `ABI deleted for address ${address}`,
      addressCount: abiStorage.size
    })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

/*
═══════════════════════════════════════════════════════════════════════════════
                    PRE-SUBMISSION VALIDATOR API
        Predict success BEFORE submitting (prevents failures)
═══════════════════════════════════════════════════════════════════════════════
*/

/**
 * POST /validate/pre-submit
 * Validate retryable parameters and predict success probability
 * 
 * Input: {contractAddress, gasLimit, maxFeePerGas, submissionCost, callDataLength}
 * Output: Success probability + risks + suggestions
 */
app.post('/validate/pre-submit', async (req, res) => {
  try {
    const { contractAddress, contractBytecodeHash, gasLimit, maxFeePerGas, submissionCost, callDataLength, functionName } = req.body
    
    if (!gasLimit || !maxFeePerGas) {
      return res.status(400).json({ error: 'gasLimit and maxFeePerGas required' })
    }
    
    const validationResult = await validatePreSubmission({
      contractAddress,
      contractBytecodeHash,
      gasLimit: parseInt(gasLimit),
      maxFeePerGas: parseInt(maxFeePerGas),
      submissionCost: submissionCost ? parseInt(submissionCost) : 0,
      callDataLength: callDataLength ? parseInt(callDataLength) : 0,
      functionName: functionName || 'unknown'
    })
    
    return res.json({
      ok: true,
      validation: validationResult,
      recommendations: getDetailedRecommendations(validationResult)
    })
  } catch (e) {
    console.error('Error validating pre-submission:', e)
    return res.status(500).json({ error: e.message })
  }
})

/**
 * POST /validate/estimate-gas
 * Estimate safe gas limit for a transaction
 * 
 * Input: {callDataLength, contractType, isSafeMint}
 * Output: min/recommended/conservative gas estimates
 */
app.post('/validate/estimate-gas', (req, res) => {
  try {
    const { callDataLength = 0, contractType = 'generic', isSafeMint = false } = req.body
    
    const estimation = estimateGasLimit({
      callDataLength: parseInt(callDataLength),
      contractType,
      isSafeMint: !!isSafeMint
    })
    
    return res.json({
      ok: true,
      gasEstimate: estimation,
      guidance: {
        min: `Absolute minimum: ${estimation.estimated} gas`,
        recommended: `Recommended with buffer: ${estimation.recommended} gas`,
        conservative: `Safe conservative estimate: ${estimation.conservative} gas`,
        note: 'Use "recommended" for most transactions. Use "conservative" if contract behavior is uncertain.'
      }
    })
  } catch (e) {
    console.error('Error estimating gas:', e)
    return res.status(500).json({ error: e.message })
  }
})

/**
 * GET /validate/check-parameters
 * Quick validation of single parameter
 * 
 * Query: type (gas_limit|max_fee|submission_cost), value
 */
app.get('/validate/check-parameters', async (req, res) => {
  try {
    const { type, value } = req.query
    
    if (!type || !value) {
      return res.status(400).json({ error: 'type and value required' })
    }
    
    let assessment = { parameter: type, value: value, status: 'unknown' }
    
    switch (type.toLowerCase()) {
      case 'gas_limit':
        const gasNum = parseInt(value)
        if (gasNum < 50000) {
          assessment.status = 'CRITICAL'
          assessment.message = 'Too low - will likely fail'
          assessment.suggestion = 'Increase to at least 75,000'
        } else if (gasNum < 75000) {
          assessment.status = 'WARNING'
          assessment.message = 'Below typical range'
          assessment.suggestion = 'Consider increasing to 100,000+'
        } else if (gasNum > 500000) {
          assessment.status = 'INFO'
          assessment.message = 'Quite high - you may be overpaying'
        } else {
          assessment.status = 'GOOD'
          assessment.message = 'Within normal range'
        }
        break
        
      case 'max_fee':
        try {
          const feeNum = parseInt(value)
          const baseFee = await computeL2BaseFeeAverage(10)
          if (baseFee) {
            const baseFeeNum = BigInt(baseFee)
            const userFee = BigInt(feeNum)
            
            if (userFee < baseFeeNum) {
              assessment.status = 'CRITICAL'
              assessment.message = `Below current base fee (${baseFeeNum.toString()})`
              assessment.suggestion = `Increase to at least ${Math.ceil(Number(baseFeeNum) * 1.3)}`
            } else if (userFee < baseFeeNum * 12n / 10n) {
              assessment.status = 'WARNING'
              assessment.message = 'Low buffer above base fee'
              assessment.suggestion = `Increase to ${Math.ceil(Number(baseFeeNum) * 1.5)} for safety`
            } else {
              assessment.status = 'GOOD'
              assessment.message = `Good buffer above base fee (${baseFeeNum.toString()})`
            }
          }
        } catch (e) {
          assessment.status = 'INFO'
          assessment.message = 'Could not check current base fee'
        }
        break
        
      case 'submission_cost':
        const costNum = parseInt(value)
        if (costNum < 100) {
          assessment.status = 'CRITICAL'
          assessment.message = 'Way too low'
          assessment.suggestion = 'Increase to at least 10,000 Wei'
        } else if (costNum < 1000) {
          assessment.status = 'WARNING'
          assessment.message = 'May be insufficient'
          assessment.suggestion = 'Increase to 5,000+ Wei'
        } else {
          assessment.status = 'GOOD'
          assessment.message = 'Sufficient for auto-redeem'
        }
        break
    }
    
    return res.json({ ok: true, assessment })
  } catch (e) {
    console.error('Error checking parameters:', e)
    return res.status(500).json({ error: e.message })
  }
})

/**
 * GET /validate/what-if
 * Simulate parameter changes and see impact on success probability
 * 
 * Query: ?baseGasLimit=X&newGasLimit=Y&currentMaxFee=X&newMaxFee=Y
 */
app.get('/validate/what-if', async (req, res) => {
  try {
    const { baseGasLimit, newGasLimit, currentMaxFee, newMaxFee, submissionCost, contractBytecodeHash } = req.query
    
    // Validate baseline
    const baseline = await validatePreSubmission({
      gasLimit: parseInt(baseGasLimit),
      maxFeePerGas: parseInt(currentMaxFee),
      submissionCost: submissionCost ? parseInt(submissionCost) : 0,
      contractBytecodeHash
    })
    
    // Simulate new parameters
    const simulated = await validatePreSubmission({
      gasLimit: newGasLimit ? parseInt(newGasLimit) : parseInt(baseGasLimit),
      maxFeePerGas: newMaxFee ? parseInt(newMaxFee) : parseInt(currentMaxFee),
      submissionCost: submissionCost ? parseInt(submissionCost) : 0,
      contractBytecodeHash
    })
    
    const improvement = simulated.successProbability - baseline.successProbability
    
    return res.json({
      ok: true,
      comparison: {
        baseline: {
          probability: baseline.successProbability,
          confidence: baseline.confidence,
          criticalRisks: baseline.risks.filter(r => r.severity === 'critical').length
        },
        simulated: {
          probability: simulated.successProbability,
          confidence: simulated.confidence,
          criticalRisks: simulated.risks.filter(r => r.severity === 'critical').length
        },
        improvement: {
          probabilityDelta: improvement,
          direction: improvement > 0 ? 'BETTER' : improvement < 0 ? 'WORSE' : 'SAME',
          percentChange: improvement > 0 ? `+${improvement.toFixed(1)}%` : `${improvement.toFixed(1)}%`
        },
        insight: generateWhatIfInsight(baseline, simulated, improvement)
      }
    })
  } catch (e) {
    console.error('Error in what-if simulation:', e)
    return res.status(500).json({ error: e.message })
  }
})

function generateWhatIfInsight(baseline, simulated, improvement) {
  if (improvement > 20) return 'Significant improvement! These changes should help.'
  if (improvement > 5) return 'Modest improvement. Changes help, but more might be needed.'
  if (improvement === 0) return 'No change in probability. Other factors dominate.'
  if (improvement > -5) return 'Slight regression, but probably acceptable.'
  return 'These changes would make things worse. Keep current parameters.'
}

/*
═══════════════════════════════════════════════════════════════════════════════
                    FAILURE PATTERN ARCHIVE API
   Community Intelligence: Share failure patterns, find similar cases
═══════════════════════════════════════════════════════════════════════════════
*/

/**
 * POST /patterns/record
 * Record a failure in the pattern archive (anonymized)
 */
app.post('/patterns/record', createLimiter, (req, res) => {
  try {
    // Rate-limited & validated pattern recording
    const { txHash, failureReason, failureAt, gasLimit, maxFeePerGas, submissionCost, contractAddress, revertReason, isStylus, panicCode } = req.body || {}

    if (!txHash || typeof txHash !== 'string' || txHash.length < 3) {
      return res.status(400).json({ error: 'txHash required' })
    }
    if (!failureReason || typeof failureReason !== 'string') {
      return res.status(400).json({ error: 'failureReason required' })
    }

    // Basic sanitization/truncation to avoid excessive storage
    const safeTxHash = String(txHash).slice(0, 256)
    const safeFailureReason = String(failureReason).slice(0, 512)
    const safeFailureAt = failureAt ? String(failureAt).slice(0, 64) : null
    const safeContractAddress = contractAddress ? String(contractAddress).slice(0, 64) : null
    
    // Anonymize: store only hash prefix
    const l1HashPrefix = safeTxHash.slice(0, 10) // 0x + 8 chars
    const contractHash = safeContractAddress ? createHash('sha256').update(safeContractAddress).digest('hex').slice(0, 16) : null
    
    const recordId = recordFailure({
      l1TxHashPrefix: l1HashPrefix,
      contractAddressHash: contractHash,
      failureAt: safeFailureAt,
      failureReason: safeFailureReason,
      gasLimit: gasLimit ? parseInt(gasLimit) : null,
      maxFeePerGas: maxFeePerGas ? parseInt(maxFeePerGas) : null,
      submissionCost: submissionCost ? parseInt(submissionCost) : null,
      revertReason: revertReason ? String(revertReason).slice(0, 512) : null,
      isStylus: !!isStylus,
      panicCode: panicCode ? String(panicCode).slice(0, 128) : null,
      callDataLength: req.body.callDataLength ? parseInt(req.body.callDataLength) : null
    })
    
    return res.json({
      ok: true,
      message: 'Failure recorded in pattern archive',
      recordId,
      note: 'Data is anonymized. No tx hashes or addresses are logged.'
    })
  } catch (e) {
    console.error('Error recording failure:', e)
    return res.status(500).json({ error: e.message })
  }
})

// (createLimiter applied inline above)

/**
 * GET /patterns/similar/:contractAddress
 * Find similar failures (pattern matching)
 * 
 * Returns: "Your failure matches 47 similar cases"
 */
app.get('/patterns/similar/:contractAddress', (req, res) => {
  try {
    const { contractAddress } = req.params
    const { failureReason, gasLimit } = req.query
    
    const contractHash = createHash('sha256').update(contractAddress).digest('hex').slice(0, 16)
    
    const similar = findSimilarFailures(contractHash, {
      failureReason,
      gasLimit: gasLimit ? parseInt(gasLimit) : null
    })
    
    return res.json({
      ok: true,
      contract: contractAddress,
      matchCount: similar.length,
      similar: similar.map(s => ({
        failureReason: s.failure_reason,
        gasLimit: s.gas_limit,
        maxFeePerGas: s.max_fee_per_gas,
        revertReason: s.revert_reason,
        matchScore: (s.matchScore * 100).toFixed(1) + '%',
        fixedCount: s.fixedCount,
        recordedAt: s.created_at
      }))
    })
  } catch (e) {
    console.error('Error finding similar failures:', e)
    return res.status(500).json({ error: e.message })
  }
})

/**
 * GET /patterns/contract/:contractBytecodeHash
 * Get failure pattern for a contract
 * 
 * Shows: "This contract fails 70% due to LOW_GAS_LIMIT"
 */
app.get('/patterns/contract/:contractBytecodeHash', (req, res) => {
  try {
    const { contractBytecodeHash } = req.params
    
    const pattern = getFailurePattern(contractBytecodeHash)
    
    if (!pattern) {
      return res.json({
        ok: true,
        message: 'No pattern data available for this contract yet'
      })
    }
    
    return res.json({
      ok: true,
      contract: contractBytecodeHash,
      totalFailures: pattern.total_failures,
      uniqueContracts: pattern.unique_contracts,
      riskScore: pattern.risk_score,
      mostRecentFailure: pattern.most_recent_at,
      distribution: pattern.distribution,
      averageGasLimit: pattern.avg_gas_limit,
      averageMaxFeePerGas: pattern.avg_max_fee_per_gas,
      topFix: pattern.top_fix,
      insight: `This contract has failed ${pattern.total_failures} times. 
        Most common issue: ${getTopFailureReason(pattern.distribution)}% 
        of failures are ${getTopFailureType(pattern.distribution)}`
    })
  } catch (e) {
    console.error('Error getting contract pattern:', e)
    return res.status(500).json({ error: e.message })
  }
})

/**
 * GET /patterns/risky
 * Get top risky contracts (by risk score)
 */
app.get('/patterns/risky', (req, res) => {
  try {
    const { limit = 20 } = req.query
    
    const riskyContracts = getTopRiskyContracts(parseInt(limit))
    
    return res.json({
      ok: true,
      count: riskyContracts.length,
      insight: 'High-risk contracts (high failure volume + concentrated failure types)',
      contracts: riskyContracts.map(c => ({
        bytecodeHash: c.contract_bytecode_hash,
        totalFailures: c.total_failures,
        riskScore: c.risk_score,
        distribution: {
          lowGasLimit: c.pct_low_gas_limit + '%',
          lowGasPrice: c.pct_low_gas_price + '%',
          outOfGas: c.pct_out_of_gas + '%'
        },
        mostRecent: c.most_recent_at
      }))
    })
  } catch (e) {
    console.error('Error getting risky contracts:', e)
    return res.status(500).json({ error: e.message })
  }
})

/**
 * GET /patterns/stats
 * Get aggregate archive statistics
 */
app.get('/patterns/stats', (req, res) => {
  try {
    const stats = getArchiveStats()
    
    return res.json({
      ok: true,
      totalFailuresRecorded: stats.total_failures,
      uniqueContractsAffected: stats.unique_contracts,
      averageGasLimit: Math.round(stats.avg_gas_limit),
      averageMaxFeePerGas: Math.round(stats.avg_max_fee_per_gas),
      failureBreakdown: {
        outOfGas: stats.failureBreakdown.outOfGas,
        lowGasLimit: stats.failureBreakdown.lowGasLimit,
        lowGasPrice: stats.failureBreakdown.lowGasPrice,
        lowSubmissionCost: stats.failureBreakdown.lowSubmissionCost,
        logicRevert: stats.failureBreakdown.logicRevert,
        stylusFailures: stats.failureBreakdown.stylusFailures
      },
      insight: `Pattern archive has tracked ${stats.total_failures} failures across ${stats.unique_contracts} contracts. 
        Most common issue: ${getStatTopFailureType(stats.failureBreakdown)}`
    })
  } catch (e) {
    console.error('Error getting archive stats:', e)
    return res.status(500).json({ error: e.message })
  }
})

/**
 * POST /patterns/tag
 * Add community tag/insight to a failure (crowdsourced)
 */
app.post('/patterns/tag', (req, res) => {
  try {
    const { failureId, tagType, tagValue } = req.body
    
    if (!failureId || !tagType || !tagValue) {
      return res.status(400).json({ error: 'failureId, tagType, and tagValue required' })
    }
    
    // User hash (anonymous)
    const userHash = createHash('sha256').update(req.ip || 'unknown').digest('hex').slice(0, 16)
    
    const tagId = addUserTag(failureId, tagType, tagValue, userHash)
    
    return res.json({
      ok: true,
      message: 'Tag recorded',
      tagId,
      note: 'Your contribution helps the community learn from failures'
    })
  } catch (e) {
    console.error('Error adding tag:', e)
    return res.status(500).json({ error: e.message })
  }
})

// Helper functions for formatting
function getTopFailureReason(dist) {
  if (!dist) return 'unknown'
  const max = Math.max(...Object.values(dist))
  return max
}

function getTopFailureType(dist) {
  if (!dist) return 'unknown'
  const entries = Object.entries(dist)
  const [type] = entries.reduce((prev, curr) => curr[1] > prev[1] ? curr : prev)
  return type
}

function getStatTopFailureType(breakdown) {
  if (!breakdown) return 'unknown'
  const entries = Object.entries(breakdown)
  const [type] = entries.reduce((prev, curr) => curr[1] > prev[1] ? curr : prev)
  const humanized = {
    out_of_gas: 'OUT_OF_GAS',
    low_gas_limit: 'LOW_GAS_LIMIT',
    low_gas_price: 'LOW_GAS_PRICE',
    low_submission_cost: 'LOW_SUBMISSION_COST',
    logic_revert: 'LOGIC_REVERT'
  }
  return humanized[type] || type
}

// ============================================================================
// WebSocket Server Setup for Shareable Debug Sessions
// ============================================================================

// Create HTTP server for WebSocket integration
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

// Initialize session manager
initSessionManager()
startSessionCleanupInterval()

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const clientId = `client_${Math.random().toString(36).slice(2, 9)}`
  console.log(`✅ WebSocket client connected: ${clientId}`)

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data)
      const { type, sessionId, payload } = message

      switch (type) {
        case 'subscribe':
          // Subscribe to a session
          if (subscribeToSession(ws, sessionId)) {
            const session = getSession(sessionId)
            ws.send(JSON.stringify({
              type: 'subscribed',
              sessionId,
              session
            }))
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Failed to subscribe to session'
            }))
          }
          break

        case 'unsubscribe':
          // Unsubscribe from a session
          unsubscribeFromSession(ws, sessionId)
          ws.send(JSON.stringify({
            type: 'unsubscribed',
            sessionId
          }))
          break

        case 'get_session':
          // Request session details
          const session = getSession(sessionId)
          ws.send(JSON.stringify({
            type: 'session_data',
            session: session || { error: 'Session not found' }
          }))
          break

        case 'ping':
          // Keep-alive ping
          ws.send(JSON.stringify({ type: 'pong' }))
          break

        default:
          console.warn(`⚠️ Unknown message type: ${type}`)
      }
    } catch (error) {
      console.error('❌ WebSocket message error:', error)
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to process message'
      }))
    }
  })

  ws.on('close', () => {
    removeClient(ws)
    console.log(`✅ WebSocket client disconnected: ${clientId}`)
  })

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${clientId}:`, error)
  })
})

// ============================================================================
// Session Management API Endpoints
// ============================================================================

// Create a new shareable debug session
app.post('/sessions/create', (req, res) => {
  try {
    const { creatorAddress, contractAddress, transactionHash, ttl } = req.body

    const sessionId = createSession({
      creatorAddress: creatorAddress || 'anonymous',
      contractAddress,
      transactionHash,
      ttl: ttl || 3600
    })

    if (!sessionId) {
      return res.status(500).json({ ok: false, error: 'Failed to create session' })
    }

    const shareUrl = getShareUrl(sessionId, `${req.protocol}://${req.get('host')}`)
    const shareId = getShareId(sessionId)

    res.json({
      ok: true,
      sessionId,
      shareUrl,
      shareId,
      wsUrl: `ws${req.protocol === 'https' ? 's' : ''}://${req.get('host')}`
    })
  } catch (error) {
    console.error('❌ Failed to create session:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Get session details
app.get('/sessions/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params
    const session = getSession(sessionId)

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' })
    }

    res.json({ ok: true, session })
  } catch (error) {
    console.error('❌ Failed to get session:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// List all active sessions (admin view)
app.get('/sessions', (req, res) => {
  try {
    const sessions = listActiveSessions()
    const stats = getSessionStats()

    res.json({
      ok: true,
      sessions,
      stats
    })
  } catch (error) {
    console.error('❌ Failed to list sessions:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Archive a session
app.post('/sessions/:sessionId/archive', (req, res) => {
  try {
    const { sessionId } = req.params
    const success = archiveSession(sessionId)

    if (!success) {
      return res.status(500).json({ ok: false, error: 'Failed to archive session' })
    }

    res.json({ ok: true, message: 'Session archived' })
  } catch (error) {
    console.error('❌ Failed to archive session:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// ============================================================================
// Leaderboard & Contract Analytics Endpoints
// ============================================================================

// Get risk score for a specific contract
app.get('/leaderboard/contract/:contractHash', (req, res) => {
  try {
    const { contractHash } = req.params
    const riskScore = getContractRiskScore(contractHash)

    res.json({ ok: true, riskScore })
  } catch (error) {
    console.error('❌ Failed to get contract risk score:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Get top risky contracts leaderboard
app.get('/leaderboard/risky', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    const riskLevel = req.query.riskLevel || null
    const sortBy = req.query.sortBy || 'risk' // risk, failures, recent

    const result = getTopRiskyContractsAnalytics(limit, {
      riskLevel,
      minFailures: 1,
      sortBy
    })

    res.json(result)
  } catch (error) {
    console.error('❌ Failed to get risky contracts:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Get failure type statistics
app.get('/leaderboard/failure-types', (req, res) => {
  try {
    const result = getFailureTypeStats()
    res.json(result)
  } catch (error) {
    console.error('❌ Failed to get failure type stats:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Get severity distribution
app.get('/leaderboard/severity', (req, res) => {
  try {
    const result = getSeverityDistribution()
    res.json(result)
  } catch (error) {
    console.error('❌ Failed to get severity distribution:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Get trend analysis
app.get('/leaderboard/trends', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30
    const result = getTrendAnalysis(days)
    res.json(result)
  } catch (error) {
    console.error('❌ Failed to get trend analysis:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Get leaderboard statistics summary
app.get('/leaderboard/stats', (req, res) => {
  try {
    const result = getLeaderboardStats()
    res.json(result)
  } catch (error) {
    console.error('❌ Failed to get leaderboard stats:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  TASK 8: SMART GAS ESTIMATION ENDPOINTS
 * ════════════════════════════════════════════════════════════════════════════
 */

// Task 8.1: Estimate optimal gas using ML
app.post('/gas/estimate-optimal', (req, res) => {
  try {
    const {
      contractAddress,
      contractType,
      bytecode,
      calldata,
      networkBaseFee,
      gasUsedInFailure
    } = req.body

    if (!contractAddress) {
      return res.status(400).json({
        ok: false,
        error: 'contractAddress required'
      })
    }

    const estimation = estimateOptimalGas({
      contractAddress,
      contractType,
      bytecode,
      calldata,
      networkBaseFee: networkBaseFee || 1,
      gasUsedInFailure
    })

    const tips = getGasOptimizationTips(estimation)

    res.json({
      ok: true,
      ...estimation,
      tips
    })
  } catch (error) {
    console.error('❌ Failed to estimate gas:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Task 8.2: Get gas history for contract
app.get('/gas/history/:contractAddress', (req, res) => {
  try {
    const { contractAddress } = req.params

    const history = getContractGasHistory(contractAddress)
    const stats = calculateGasStatistics(history)
    const patterns = analyzeFailurePatterns(history)

    res.json({
      ok: true,
      contractAddress,
      history: history.slice(0, 50), // Last 50
      statistics: stats,
      patterns,
      sampleSize: history.length
    })
  } catch (error) {
    console.error('❌ Failed to get gas history:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Task 8.3: Detect contract type from bytecode
app.post('/gas/detect-type', (req, res) => {
  try {
    const { bytecode } = req.body

    if (!bytecode) {
      return res.status(400).json({
        ok: false,
        error: 'bytecode required'
      })
    }

    const type = detectContractType(bytecode)

    res.json({
      ok: true,
      detectedType: type
    })
  } catch (error) {
    console.error('❌ Failed to detect contract type:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Task 8.4: Get ML feature matrix for model training
app.get('/gas/ml-features/:contractAddress', (req, res) => {
  try {
    const { contractAddress } = req.params

    const features = buildMLFeatureMatrix(contractAddress)

    if (!features) {
      return res.status(404).json({
        ok: false,
        error: 'Insufficient history for contract'
      })
    }

    res.json({
      ok: true,
      ...features
    })
  } catch (error) {
    console.error('❌ Failed to build ML features:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Task 8.5: Batch gas estimation for multiple contracts
app.post('/gas/batch-estimate', (req, res) => {
  try {
    const { contracts } = req.body

    if (!Array.isArray(contracts)) {
      return res.status(400).json({
        ok: false,
        error: 'contracts array required'
      })
    }

    const results = contracts.map(contract => {
      try {
        const estimation = estimateOptimalGas(contract)
        return {
          ...contract,
          estimation,
          status: 'ok'
        }
      } catch (error) {
        return {
          ...contract,
          error: error.message,
          status: 'error'
        }
      }
    })

    res.json({
      ok: true,
      total: results.length,
      successful: results.filter(r => r.status === 'ok').length,
      results
    })
  } catch (error) {
    console.error('❌ Failed to estimate batch gas:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

// Start server with error handling and graceful shutdown
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} already in use. Waiting for it to free up...`)
    setTimeout(() => {
      server.listen(PORT)
    }, 2000)
  } else {
    console.error('❌ Server error:', err)
    process.exit(1)
  }
})

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`)
  console.log(`   HTTP: http://localhost:${PORT}`)
  console.log(`   WS: ws://localhost:${PORT}`)
})

// Graceful shutdown on signals
process.on('SIGTERM', () => {
  console.log('📨 SIGTERM received, shutting down gracefully...')
  server.close(() => {
    console.log('✅ Server closed')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('❌ Forced exit after 10 seconds')
    process.exit(1)
  }, 10000)
})

process.on('SIGINT', () => {
  console.log('📨 SIGINT received, shutting down gracefully...')
  server.close(() => {
    console.log('✅ Server closed')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('❌ Forced exit after 10 seconds')
    process.exit(1)
  }, 10000)
})

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err)
  process.exit(1)
})

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason)
  process.exit(1)
})
