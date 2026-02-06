import dotenv from 'dotenv'
import { ethers } from 'ethers'

dotenv.config()

const {
  L1_RPC_URL = process.env.L1_RPC_URL,
  ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL
} = process.env

const l1Provider = new ethers.JsonRpcProvider(L1_RPC_URL)
const l2Provider = new ethers.JsonRpcProvider(ARBITRUM_RPC_URL)

// Arbitrum Inbox contract ABI fragment for RetryableTicketCreated event
export const INBOX_ABI = [
  'event RetryableTicketCreated(uint256 indexed ticketId, address indexed from, address to, uint256 l2CallValue, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes data)'
]

// Arbitrum L2 ArbRetryableTx precompile ABI fragment
const ARB_RETRYABLE_ABI = [
  'event TicketCreated(uint256 indexed ticketId)',
  'event Redeemed(uint256 indexed ticketId)',
  'event LifetimeExtended(uint256 indexed ticketId, uint256 newTimeout)'
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

export function getProviders() {
  return { l1Provider, l2Provider }
}

// Helper to race a promise against a timeout
export async function callWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ])
}

export async function findTxOnProviders(txHash) {
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
export async function findL2TransactionFromRetryable(retryable, lookbackBlocks = 100) {
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
export async function findRetryableLifecycle(ticketId, lookbackBlocks = 500) {
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
export async function computeL2BaseFeeAverage(count = 10, blocks = null) {
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
export async function fetchL2TraceInfo(txHash) {
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
export async function debugTraceTransaction(txHash) {
  try {
    // First try with call tracer (default)
    const res = await l2Provider.send('debug_traceTransaction', [txHash, {}])
    
    // If successful, attempt to get more detailed trace with storage access
    if (res && !res.error) {
      try {
        // Try with callTracer to capture storage access patterns
        const detailedTrace = await l2Provider.send('debug_traceTransaction', [
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
export async function fetchL2GasPriceHistory(blockCount = 100) {
  try {
    const latest = await l2Provider.getBlockNumber()
    const start = Math.max(0, latest - blockCount + 1)
    const history = []
    
    for (let b = start; b <= latest; b++) {
      try {
        const block = await callWithTimeout(l2Provider.getBlock(b), 3000)
        if (block) {
          history.push({
            blockNumber: block.number,
            baseFeePerGas: block.baseFeePerGas ? block.baseFeePerGas.toString() : null,
            timestamp: block.timestamp,
            gasUsed: block.gasUsed ? block.gasUsed.toString() : null,
            gasLimit: block.gasLimit ? block.gasLimit.toString() : null
          })
        }
      } catch (e) {
        // ignore block fetch error
      }
    }
    
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
