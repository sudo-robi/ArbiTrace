import dotenv from 'dotenv'
import { ethers } from 'ethers'

dotenv.config()

const NETWORK_CONFIG = {
  arbitrum: {
    name: 'Arbitrum One',
    l1: 'https://eth.llamarpc.com',
    l2: 'https://arb1.arbitrum.io/rpc'
  },
  nova: {
    name: 'Arbitrum Nova',
    l1: 'https://eth.llamarpc.com',
    l2: 'https://nova.arbitrum.io/rpc'
  },
  sepolia: {
    name: 'Arbitrum Sepolia',
    l1: process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io',
    l2: process.env.ARBITRUM_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'
  }
}

// Internal cache for providers to avoid re-instantiating
const providerCache = new Map()

export function getProviders(networkId = 'sepolia', custom = null) {
  let l1Url, l2Url

  if (networkId === 'custom' && custom) {
    l1Url = custom.l1Rpc
    l2Url = custom.l2Rpc
  } else {
    const config = NETWORK_CONFIG[networkId] || NETWORK_CONFIG.sepolia
    l1Url = config.l1
    l2Url = config.l2
  }

  const cacheKey = `${l1Url}|${l2Url}`
  if (providerCache.has(cacheKey)) return providerCache.get(cacheKey)

  const providers = {
    l1Provider: new ethers.JsonRpcProvider(l1Url),
    l2Provider: new ethers.JsonRpcProvider(l2Url),
    l2DebugProvider: process.env.DEBUG_RPC_URL ? new ethers.JsonRpcProvider(process.env.DEBUG_RPC_URL) : null
  }

  providerCache.set(cacheKey, providers)
  return providers
}

// Arbitrum Inbox contract ABI fragment for RetryableTicketCreated event
export const INBOX_ABI = [
  'event RetryableTicketCreated(uint256 indexed ticketId, address indexed from, address to, uint256 l2CallValue, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes data)'
]

// Arbitrum L2 ArbRetryableTx precompile ABI fragment
const ARB_RETRYABLE_ABI = [
  'event TicketCreated(bytes32 indexed ticketId)',
  'event Redeemed(bytes32 indexed ticketId)',
  'event Canceled(bytes32 indexed ticketId)',
  'event LifetimeExtended(bytes32 indexed ticketId, uint256 newTimeout)'
]

// SequencerInbox / Bridge ABI fragments (useful L1 logs)
export const SEQUENCER_INBOX_ABI = [
  'event SequencerBatchDelivered(uint256 indexed batchIndex, bytes data)',
]

export const BRIDGE_ABI = [
  'event OutboxEntryCreated(bytes32 indexed batchHash, uint256 outboxIndex)'
]

// Export the ARB_RETRYABLE_ABI for other modules
export { ARB_RETRYABLE_ABI }

const inboxInterface = new ethers.Interface(INBOX_ABI)
const arbRetryableInterface = new ethers.Interface(ARB_RETRYABLE_ABI)

// getProviders is now dynamic (defined above)

// Helper to race a promise against a timeout
export async function callWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ])
}

export async function findTxOnProviders(txHash, networkId = 'sepolia', custom = null) {
  const { l1Provider, l2Provider } = getProviders(networkId, custom)
  const out = {
    txHash,
    foundOn: null,
    l1Receipt: null,
    l2Receipt: null,
    errors: []
  }

  const RPC_TIMEOUT_MS = 5000

  try {
    // fetch L1 and L2 receipts in parallel to reduce latency, with timeouts
    const [r1, r2] = await Promise.allSettled([
      callWithTimeout(l1Provider.getTransactionReceipt(txHash), RPC_TIMEOUT_MS),
      callWithTimeout(l2Provider.getTransactionReceipt(txHash), RPC_TIMEOUT_MS)
    ])
    if (r1.status === 'fulfilled' && r1.value) {
      out.l1Receipt = r1.value
      out.foundOn = out.foundOn ? 'both' : 'L1'
    } else if (r1.status === 'rejected') {
      out.errors.push({ provider: 'L1', message: r1.reason && r1.reason.message ? r1.reason.message : String(r1.reason) })
    }
    if (r2.status === 'fulfilled' && r2.value) {
      out.l2Receipt = r2.value
      out.foundOn = out.foundOn ? 'both' : 'L2'
    } else if (r2.status === 'rejected') {
      out.errors.push({ provider: 'L2', message: r2.reason && r2.reason.message ? r2.reason.message : String(r2.reason) })
    }
  } catch (e) {
    // if the Promise.allSettled wrapper itself throws, capture generic error
    out.errors.push({ provider: 'findTxOnProviders', message: e.message || String(e) })
  }

  if (!out.foundOn) out.foundOn = 'unknown'
  return out
}

// Removed duplicate export (now at module level)

export async function fetchL1Logs(receipt) {
  if (!receipt) return null
  return receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex }))
}

// Parse L1 logs for RetryableTicketCreated events and extract parameters
export function findRetryableCreationLogs(logs, receipt) {
  if (!logs || !receipt) return []

  const retryables = []

  for (const log of logs) {
    try {
      const parsed = inboxInterface.parseLog(log)
      if (parsed && parsed.name === 'RetryableTicketCreated') {
        retryables.push({
          eventName: 'RetryableTicketCreated',
          ticketId: parsed.args.ticketId.toString(),
          from: parsed.args.from,
          to: parsed.args.to,
          l2CallValue: parsed.args.l2CallValue.toString(),
          excessFeeRefundAddress: parsed.args.excessFeeRefundAddress,
          callValueRefundAddress: parsed.args.callValueRefundAddress,
          gasLimit: parsed.args.gasLimit.toString(),
          maxFeePerGas: parsed.args.maxFeePerGas.toString(),
          data: parsed.args.data,
          logIndex: log.logIndex,
          blockNumber: receipt.blockNumber,
          transactionHash: receipt.transactionHash
        })
      }
    } catch (e) {
      // Log is not a RetryableTicketCreated event, skip
    }
  }

  return retryables
}

// Scan recent L2 blocks to find a transaction with matching calldata / destination
export async function findL2TransactionFromRetryable(retryable, lookbackBlocks = 100, networkId = 'sepolia', custom = null) {
  const { l2Provider } = getProviders(networkId, custom)
  try {
    const latestBlock = await l2Provider.getBlockNumber()
    const startBlock = Math.max(0, latestBlock - lookbackBlocks)

    // Build a filter for transactions to the target address
    const toAddress = retryable.to

    // Query L2 logs or trace blocks for transactions matching the ticket's destination
    const filter = {
      address: toAddress,
      fromBlock: startBlock,
      toBlock: 'latest'
    }

    // Attempt to find logs emitted to this address
    // This is a heuristic; we're looking for recent activity on the destination contract
    const logs = await l2Provider.getLogs(filter).catch(() => [])

    if (logs && logs.length > 0) {
      return {
        found: true,
        blockRange: { startBlock, latestBlock },
        logsFound: logs.length,
        sampleLog: logs[0]
      }
    }

    return { found: false, blockRange: { startBlock, latestBlock } }
  } catch (e) {
    return { error: e.message, blockRange: null }
  }
}

// Search L2 logs for retryable lifecycle events (Redeemed, TicketCreated, LifetimeExtended)
// CONSTRAINT 3 - Historical Data Depends on Indexing Depth:
//   This function searches recent L2 logs (default: last 500 blocks). It does NOT provide:
//   - Data older than lookbackBlocks parameter
//   - Pruned or archived blocks from RPC provider
//   - Data from before indexing started
//   
//   Fallback: findRetryableLifecycleViaIndexer() uses optional indexer for performance,
//   but falls back to this log scanning if indexer unavailable.
//   
//   Why limited: We're designed for real-time debugging, not archival. Optional
//   indexer provides performance boost for recent data only.
export async function findRetryableLifecycle(ticketId, lookbackBlocks = 500, networkId = 'sepolia', custom = null) {
  const { l2Provider } = getProviders(networkId, custom)
  try {
    const latestBlock = await l2Provider.getBlockNumber()
    const startBlock = Math.max(0, latestBlock - lookbackBlocks)

    // Query logs in the recent range and attempt to parse with arbRetryableInterface
    const logs = await l2Provider.getLogs({ fromBlock: startBlock, toBlock: 'latest' }).catch(() => [])
    const events = []
    for (const l of logs) {
      try {
        const parsed = arbRetryableInterface.parseLog(l)
        if (parsed) {
          const name = parsed.name
          if (name === 'Redeemed' || name === 'TicketCreated' || name === 'LifetimeExtended') {
            const args = parsed.args
            // ticket id may be BigInt or hex
            const id = args[0] ? args[0].toString() : null
            events.push({ name, ticketId: id, blockNumber: l.blockNumber, transactionHash: l.transactionHash })
          }
        }
      } catch (e) {
        // not a matching event, skip
      }
    }

    return { ok: true, events, range: { startBlock, latestBlock } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Compute average baseFeePerGas over recent blocks.
// If `blocks` array is provided (for tests), it should be an array of objects { baseFeePerGas: <BigInt|string|number> }
export async function computeL2BaseFeeAverage(count = 10, blocks = null, networkId = 'sepolia', custom = null) {
  const { l2Provider } = getProviders(networkId, custom)
  try {
    if (Array.isArray(blocks)) {
      const vals = blocks.map(b => BigInt(b.baseFeePerGas || b.baseFee || 0))
      if (vals.length === 0) return null
      const sum = vals.reduce((a, b) => a + b, 0n)
      return sum / BigInt(vals.length)
    }

    // Otherwise query provider for last `count` blocks
    const latest = await l2Provider.getBlockNumber()
    const start = Math.max(0, latest - count + 1)
    let sum = 0n
    for (let b = start; b <= latest; b++) {
      try {
        // use callWithTimeout to avoid long-hanging block fetches
        const block = await callWithTimeout(l2Provider.getBlock(b), 3000)
        if (block && block.baseFeePerGas) sum += BigInt(block.baseFeePerGas)
      } catch (e) {
        // ignore block fetch error or timeout
      }
    }
    const len = BigInt(Math.max(1, latest - start + 1))
    return sum / len
  } catch (e) {
    return null
  }
}

// Fetch trace / execution details for an L2 tx (returns minimal info for now)
export async function fetchL2TraceInfo(txHash, networkId = 'sepolia', custom = null) {
  const { l2Provider } = getProviders(networkId, custom)
  try {
    const receipt = await l2Provider.getTransactionReceipt(txHash)
    if (!receipt) return null
    // Fetch transaction to get calldata/input
    let tx = null
    try {
      tx = await l2Provider.getTransaction(txHash)
    } catch (e) {
      tx = null
    }

    return {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status,
      to: receipt.to,
      from: receipt.from,
      logs: receipt.logs.length,
      contractAddress: receipt.contractAddress,
      calldata: tx ? tx.data : null
    }
  } catch (e) {
    return null
  }
}

// Attempt to call debug_traceTransaction on the L2 provider. Returns trace result or { error }
// Optionally parses memory/storage access patterns if tracer supports it
export async function debugTraceTransaction(txHash, networkId = 'sepolia', custom = null) {
  if (!txHash) return { error: 'No transaction hash provided for trace' }
  const { l2Provider, l2DebugProvider } = getProviders(networkId, custom)
  // Use the debug provider if available, otherwise fall back to standard
  const provider = l2DebugProvider || l2Provider

  try {
    // First try with call tracer (default)
    const res = await provider.send('debug_traceTransaction', [txHash, {}])

    // If successful, attempt to get more detailed trace with storage access
    if (res && !res.error) {
      try {
        // Try with callTracer to capture storage access patterns
        const detailedTrace = await provider.send('debug_traceTransaction', [
          txHash,
          {
            tracer: 'callTracer',
            tracerConfig: { onlyTopCall: false }
          }
        ]).catch(() => null)

        // Merge detailed trace data if available
        if (detailedTrace) {
          return {
            ...res,
            detailedTrace: detailedTrace,
            hasStorageAccess: true
          }
        }
      } catch (e) {
        // Detailed tracer not available, just return basic trace
      }
    }

    return res
  } catch (e) {
    return { error: e.message }
  }
}

// Extract memory and storage access patterns from trace
export function extractMemoryStorageAccess(trace) {
  const memoryAccesses = []
  const storageAccesses = []

  try {
    if (!trace) return { memoryAccesses, storageAccesses }

    // Walk through trace structure if available
    if (trace.calls && Array.isArray(trace.calls)) {
      for (const call of trace.calls) {
        if (call.type === 'SSTORE') {
          storageAccesses.push({
            type: 'SSTORE',
            address: call.address,
            slot: call.key,
            value: call.value,
            gas: call.gas,
            gasUsed: call.gasUsed
          })
        } else if (call.type === 'SLOAD') {
          storageAccesses.push({
            type: 'SLOAD',
            address: call.address,
            slot: call.key,
            value: call.value,
            gas: call.gas,
            gasUsed: call.gasUsed
          })
        } else if (call.type === 'MLOAD' || call.type === 'MSTORE') {
          memoryAccesses.push({
            type: call.type,
            offset: call.offset,
            size: call.size || 32,
            gas: call.gas,
            gasUsed: call.gasUsed
          })
        }
      }
    }
  } catch (e) {
    // Trace parsing failed, return empty
  }

  return { memoryAccesses, storageAccesses }
}


// Fetch extended gas price history (last N blocks with full details)
export async function fetchL2GasPriceHistory(blockCount = 100, networkId = 'sepolia', custom = null) {
  const { l2Provider } = getProviders(networkId, custom)
  try {
    const latest = await l2Provider.getBlockNumber()
    const start = Math.max(0, latest - blockCount + 1)

    // Fetch blocks in parallel to avoid sequential timeout issues
    const blockPromises = []
    for (let b = start; b <= latest; b++) {
      blockPromises.push(
        callWithTimeout(l2Provider.getBlock(b), 4000)
          .catch(() => null)
      )
    }

    const blocks = await Promise.all(blockPromises)
    const history = blocks
      .filter(b => b !== null)
      .map(block => ({
        blockNumber: block.number,
        baseFeePerGas: block.baseFeePerGas ? block.baseFeePerGas.toString() : null,
        timestamp: block.timestamp,
        gasUsed: block.gasUsed ? block.gasUsed.toString() : null,
        gasLimit: block.gasLimit ? block.gasLimit.toString() : null
      }))

    return {
      history,
      range: { start, latest, count: history.length },
      average: history.length > 0
        ? (history.reduce((sum, b) => sum + BigInt(b.baseFeePerGas || 0), 0n) / BigInt(history.length)).toString()
        : null,
      min: history.length > 0
        ? history.reduce((min, b) => BigInt(b.baseFeePerGas || 0) < min ? BigInt(b.baseFeePerGas || 0) : min, BigInt(history[0]?.baseFeePerGas || 0)).toString()
        : null,
      max: history.length > 0
        ? history.reduce((max, b) => BigInt(b.baseFeePerGas || 0) > max ? BigInt(b.baseFeePerGas || 0) : max, BigInt(0)).toString()
        : null
    }
  } catch (e) {
    return { error: e.message, history: [] }
  }
}

// Query indexer for retryable lifecycle events by L1 tx hash
// CONSTRAINT 3 - Historical Data Depends on Indexing Depth:
//   If indexer is available, returns indexed tickets (performance boost).
//   Falls back to real-time log scanning if indexer unavailable.
//   Note: Indexing depth ≠ full blockchain history. Only indexed period is searchable.
export async function findRetryableLifecycleViaIndexer(l1TxHash) {
  try {
    const { default: indexer } = await import('./indexer.js')
    if (!indexer || typeof indexer.findByL1Tx !== 'function') return { ok: false, tickets: [] }
    const tickets = indexer.findByL1Tx(l1TxHash)
    // If we have tickets, try to enrich with L2 mapping
    const enriched = (tickets || []).map(t => {
      try {
        const map = indexer.findL2ForTicket ? indexer.findL2ForTicket(t.ticket_id) : null
        return { ...t, l2Mapping: map || null }
      } catch (e) {
        return { ...t, l2Mapping: null }
      }
    })
    return { ok: true, tickets: enriched }
  } catch (e) {
    return { ok: false, error: e.message, tickets: [] }
  }
}

/**
 * L1 Backtracing: Given an L2 transaction (likely a retryable redemption),
 * find its parent L1 transaction hash.
 */
export async function findParentL1ForL2Tx(l2Receipt, networkId = 'sepolia', custom = null) {
  if (!l2Receipt || !l2Receipt.logs) {
    return null
  }

  // 1. Extract ticketId from L2 logs (ArbRetryableTx.Redeemed or TicketCreated)
  let ticketId = null
  const TICKET_CREATED_TOPIC = '0x5ccd009502509cf28762c67858994d85b163bb6e451f5e9df7c5e18c9c2e123e'
  const REDEEMED_TOPIC = '0x82498456531a1065f689ba348ce20bda781238c424cf36748dd40bc282831e03'

  for (const log of l2Receipt.logs) {
    // Try structured parsing first
    try {
      const parsed = arbRetryableInterface.parseLog(log)
      if (parsed && (parsed.name === 'Redeemed' || parsed.name === 'TicketCreated' || parsed.name === 'Canceled')) {
        ticketId = parsed.args[0].toString()
        break
      }
    } catch (e) {
      // ignore
    }

    // Direct topic match fallback (0x6E precompile logs)
    if (!ticketId && log.address.toLowerCase() === '0x000000000000000000000000000000000000006e') {
      const t0 = log.topics[0]
      if (t0 === TICKET_CREATED_TOPIC || t0 === REDEEMED_TOPIC) {
        ticketId = log.topics[1]
        break
      }
    }
  }

  if (!ticketId) {
    return null
  }

  const hash = l2Receipt.hash || l2Receipt.transactionHash
  console.log(`[Backtrace] Starting for L2 tx ${hash} (ticketId: ${ticketId})`)

  // 2. Resolve L1 Tx Hash from ticketId
  try {
    // A. Check indexer first (performance)
    const { default: indexer } = await import('./indexer.js')
    if (indexer && typeof indexer.getTicket === 'function') {
      const ticket = indexer.getTicket(ticketId)
      if (ticket && ticket.l1_tx_hash) {
        console.log(`[Backtrace] RESOLVED via indexer: ${ticket.l1_tx_hash}`)
        return ticket.l1_tx_hash
      }
    }
    console.log('[Backtrace] Ticket not found in indexer, falling back to L1 log scan')

    // B. Fallback: RPC-based search for the L1 transaction
    // Scan recent L1 blocks for the RetryableTicketCreated event with the matching ticketId.
    const { l1Provider, l2Provider } = getProviders(networkId, custom)
    const latestL1 = await l1Provider.getBlockNumber()

    // Improved window: try to guess starting block from L2 timestamp if available
    let fromBlock = Math.max(0, latestL1 - 2000)
    const l2Block = await l2Provider.getBlock(l2Receipt.blockNumber)
    if (l2Block && l2Block.timestamp) {
      // On Sepolia, L1 blocks are ~12s. We look back ~2 hours from L2 time.
      // This is a rough heuristic.
      console.log(`[Backtrace] L2 Timestamp: ${l2Block.timestamp}, Latest L1: ${latestL1}`)
    }

    console.log(`[Backtrace] Scanning L1 blocks ${fromBlock} to ${latestL1} for RetryableTicketCreated in chunks...`)

    // Chunk size 10 to satisfy Alchemy free tier
    const CHUNK_SIZE = 10
    const topic1 = ticketId.length === 66 ? ticketId : ethers.zeroPadValue(ethers.toBeHex(ticketId), 32)

    // We scan backwards from latestL1 to find it faster
    for (let current = latestL1; current > fromBlock; current -= CHUNK_SIZE) {
      const start = Math.max(fromBlock, current - CHUNK_SIZE + 1)
      try {
        const logs = await l1Provider.getLogs({
          fromBlock: start,
          toBlock: current,
          topics: [
            '0xc4ead0e389ccdf68bf81807c89f6820029b15cb9f3d1e0e5b176bf0ceaa74b50', // RetryableTicketCreated topic
            topic1
          ]
        })

        if (logs && logs.length > 0) {
          console.log(`[Backtrace] RESOLVED via L1 log scan (at block ${logs[0].blockNumber}): ${logs[0].transactionHash}`)
          return logs[0].transactionHash
        }
      } catch (e) {
        if (e.message.indexOf('10 block range') !== -1) {
          // Fallback to even smaller or just log and continue if one fails
          console.warn(`[Backtrace] Chunk ${start}-${current} hit limit, continuing...`)
        } else {
          throw e
        }
      }
    }
    console.log('[Backtrace] No matching RetryableTicketCreated event found in L1 scan window')
  } catch (e) {
    console.warn(`[Backtrace] Error: ${e.message}`)
  }

  return null
}
