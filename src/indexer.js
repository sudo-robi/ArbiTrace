import { getDatabase } from './dbUtils.js'
import { ethers } from 'ethers'
import dotenv from 'dotenv'
import { INBOX_ABI } from './arbitrum.js'

dotenv.config()

const DB_NAME = 'tickets.db'
const db = getDatabase(DB_NAME)

// Initialize tables: retryable_tickets, ticket_to_l2tx, stylus_meta
db.exec(`
CREATE TABLE IF NOT EXISTS retryable_tickets (
  ticket_id TEXT PRIMARY KEY,
  l1_tx_hash TEXT,
  creator TEXT,
  to_address TEXT,
  l2_call_value TEXT,
  gas_limit TEXT,
  max_fee_per_gas TEXT,
  data TEXT,
  block_number INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS ticket_to_l2tx (
  ticket_id TEXT PRIMARY KEY,
  l2_tx_hash TEXT,
  l2_block_number INTEGER,
  indexed_at INTEGER
);

CREATE TABLE IF NOT EXISTS stylus_meta (
  tx_hash TEXT PRIMARY KEY,
  ticket_id TEXT,
  panic_code TEXT,
  panic_reason TEXT,
  gas_used TEXT,
  indexed_at INTEGER
);
`)

const insertStmt = db.prepare(`
INSERT OR IGNORE INTO retryable_tickets (ticket_id, l1_tx_hash, creator, to_address, l2_call_value, gas_limit, max_fee_per_gas, data, block_number, created_at)
VALUES (@ticket_id, @l1_tx_hash, @creator, @to_address, @l2_call_value, @gas_limit, @max_fee_per_gas, @data, @block_number, @created_at)
`)

const insertTicketToL2 = db.prepare(`
INSERT OR REPLACE INTO ticket_to_l2tx (ticket_id, l2_tx_hash, l2_block_number, indexed_at)
VALUES (@ticket_id, @l2_tx_hash, @l2_block_number, @indexed_at)
`)

const insertStylus = db.prepare(`
INSERT OR REPLACE INTO stylus_meta (tx_hash, ticket_id, panic_code, panic_reason, gas_used, indexed_at)
VALUES (@tx_hash, @ticket_id, @panic_code, @panic_reason, @gas_used, @indexed_at)
`)

// Expose helper functions for tests / other modules
export function insertMapping(ticketId, l2TxHash, blockNumber) {
  try {
    insertTicketToL2.run({ ticket_id: ticketId, l2_tx_hash: l2TxHash, l2_block_number: blockNumber, indexed_at: Date.now() })
    return true
  } catch (e) {
    return false
  }
}

export function upsertStylusMeta({ txHash, ticketId = null, panicCode = null, panicReason = null, gasUsed = null }) {
  try {
    insertStylus.run({ tx_hash: txHash, ticket_id: ticketId, panic_code: panicCode, panic_reason: panicReason, gas_used: gasUsed, indexed_at: Date.now() })
    return true
  } catch (e) {
    return false
  }
}

export function getStylusMeta(txHash) {
  try {
    return db.prepare('SELECT * FROM stylus_meta WHERE tx_hash = ?').get(txHash)
  } catch (e) {
    return null
  }
}

const { L1_RPC_URL } = process.env
const provider = new ethers.JsonRpcProvider(L1_RPC_URL)
const inboxInterface = new ethers.Interface(INBOX_ABI)

// lazy import of L2 provider from arbitrum module when needed
import { getProviders } from './arbitrum.js'
import { ARB_RETRYABLE_ABI } from './arbitrum.js'
const arbRetryableInterface = new ethers.Interface(ARB_RETRYABLE_ABI)

export async function indexRange(startBlock, endBlock) {
  const results = { inserted: 0 }
  for (let b = startBlock; b <= endBlock; b++) {
    try {
      const block = await provider.getBlock(b, true)  // true = include full transactions
      if (!block || !block.transactions) continue
      for (const tx of block.transactions) {
        try {
          const receipt = await provider.getTransactionReceipt(tx.hash)
          if (!receipt || !receipt.logs) continue
          for (const log of receipt.logs) {
            // try parse with inbox interface
            try {
              const parsed = inboxInterface.parseLog(log)
              if (parsed && parsed.name === 'RetryableTicketCreated') {
                const ticketId = parsed.args.ticketId.toString()
                const row = {
                  ticket_id: ticketId,
                  l1_tx_hash: receipt.transactionHash,
                  creator: parsed.args.from,
                  to_address: parsed.args.to,
                  l2_call_value: parsed.args.l2CallValue.toString(),
                  gas_limit: parsed.args.gasLimit.toString(),
                  max_fee_per_gas: parsed.args.maxFeePerGas.toString(),
                  data: parsed.args.data,
                  block_number: receipt.blockNumber,
                  created_at: Date.now()
                }
                insertStmt.run(row)
                results.inserted += 1
              }
            } catch (e) {
              // not an Inbox event
            }
          }
        } catch (e) {
          // skip transaction errors
        }
      }
    } catch (e) {
      // skip block errors
    }
  }
  return results
}

// Index L2 range to find ticket -> l2Tx mappings and stylus meta
export async function indexL2Range(startBlock, endBlock) {
  const results = { mapped: 0, stylusIndexed: 0 }
  try {
    const { l2Provider } = getProviders()
    for (let b = startBlock; b <= endBlock; b++) {
      try {
        const block = await l2Provider.getBlockWithTransactions(b)
        if (!block || !block.transactions) continue
        for (const tx of block.transactions) {
          try {
            // fetch receipt
            const receipt = await l2Provider.getTransactionReceipt(tx.hash)
            if (!receipt) continue

            // parse logs for ArbRetryable events and map ticket->tx
            for (const log of receipt.logs) {
              try {
                const parsed = arbRetryableInterface.parseLog(log)
                if (parsed && parsed.name === 'TicketCreated') {
                  const ticketId = parsed.args[0] ? parsed.args[0].toString() : null
                  if (ticketId) {
                    insertTicketToL2.run({ ticket_id: ticketId, l2_tx_hash: receipt.transactionHash, l2_block_number: receipt.blockNumber, indexed_at: Date.now() })
                    results.mapped += 1
                  }
                }
                // Stylus panics may appear in revert logs; store basic stylus record if present
                if (parsed && parsed.name === 'Redeemed') {
                  // noop for now
                }
              } catch (e) {
                // not a retryable event
              }
            }

            // try simple Stylus detection via known precompile address in logs
            for (const l of receipt.logs) {
              try {
                const addr = (l.address || '').toLowerCase()
                if (addr === '0x0000000000000000000000000000000000000071') {
                  // store stylus meta (basic)
                  insertStylus.run({ tx_hash: receipt.transactionHash, ticket_id: null, panic_code: null, panic_reason: 'Stylus precompile touched', gas_used: receipt.gasUsed ? receipt.gasUsed.toString() : null, indexed_at: Date.now() })
                  results.stylusIndexed += 1
                }
              } catch (e) { }
            }

          } catch (e) {
            // skip per-tx errors
          }
        }
      } catch (e) {
        // skip block errors
      }
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
  return results
}

export function getTicket(ticketId) {
  return db.prepare('SELECT * FROM retryable_tickets WHERE ticket_id = ?').get(ticketId)
}

export function findByL1Tx(l1tx) {
  return db.prepare('SELECT * FROM retryable_tickets WHERE l1_tx_hash = ?').all(l1tx)
}

export function findL2ForTicket(ticketId) {
  return db.prepare('SELECT * FROM ticket_to_l2tx WHERE ticket_id = ?').get(ticketId)
}

export function listRecent(limit = 20) {
  return db.prepare('SELECT * FROM retryable_tickets ORDER BY block_number DESC LIMIT ?').all(limit)
}

export function stats() {
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt, MAX(block_number) as last_block FROM retryable_tickets').get()
    return { count: row ? row.cnt : 0, last_block: row ? row.last_block : null }
  } catch (e) {
    return { count: 0, last_block: null }
  }
}

export default { indexRange, indexL2Range, getTicket, findByL1Tx, findL2ForTicket, listRecent, stats }
