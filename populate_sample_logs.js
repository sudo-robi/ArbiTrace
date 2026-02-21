/**
 * Populate sample transaction logs into the database
 * This adds realistic L1 and L2 logs for demo/test analysis
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const patternsDbPath = path.join(__dirname, 'data', 'patterns.db')
const db = new Database(patternsDbPath)

console.log('🔧 Adding sample logs and trace data...')

// Create logs table for storing sample transaction logs
db.exec(`
  CREATE TABLE IF NOT EXISTS transaction_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash_prefix TEXT UNIQUE,
    is_l1 BOOLEAN DEFAULT 0,
    logs TEXT,
    gas_price_history TEXT,
    trace_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`)

// Sample L1 logs (RetryableTicketCreated events)
const sampleL1Logs = [
  {
    txHash: '0x1234567890abcdef',
    isL1: true,
    logs: JSON.stringify([
      {
        logIndex: 0,
        address: '0x1100000000000000000000000000000000000011',
        topics: [
          '0x6895c13664aa4ec07a8cb63d2461fa21c84edf81640cf9a7ceae7e534d30e10a',
          '0x000000000000000000000000abcd1234567890abcd1234567890abcd12345678',
          '0x0000000000000000000000001111111111111111111111111111111111111111'
        ],
        data: '0x00000000000000000000000000000000000000000000000000000000000186a000000000000000000000000000000000000000000000000000b1a2bc2ec50000'
      },
      {
        logIndex: 1,
        address: '0x1100000000000000000000000000000000000011',
        topics: [
          '0x5e3c1311ea442664e8b1611bfabef659120ea7a0c3dd7def57f629971dc37a02'
        ],
        data: '0x000000000000000000000000cafe000000000000000000000000000000000001'
      }
    ]),
    gasPriceHistory: JSON.stringify({
      history: [
        { blockNumber: 19500000, baseFeePerGas: '45000000000', timestamp: 1700000000, gasUsed: '15000000', gasLimit: '30000000' },
        { blockNumber: 19500001, baseFeePerGas: '48000000000', timestamp: 1700000012, gasUsed: '14500000', gasLimit: '30000000' }
      ],
      range: { start: 19499999, latest: 19500001, count: 2 }
    }),
    traceData: JSON.stringify({ availableOnL1: false })
  }
]

// Sample L2 logs (Contract execution logs)
const sampleL2Logs = [
  {
    txHash: '0xabcdef1234567890',
    isL1: false,
    logs: JSON.stringify([
      {
        logIndex: 0,
        address: '0x0000000000000000000000000000000000000001',
        topics: ['0x000000000000000000000000000000000000000000000000000000000000dead'],
        data: '0x',
        removed: false
      },
      {
        logIndex: 1,
        address: '0x0000000000000000000000000000000000000002',
        topics: ['0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe'],
        data: '0x0000000000000000000000000000000000000000000000000000000000000001',
        removed: false
      }
    ]),
    gasPriceHistory: JSON.stringify({
      history: [
        { blockNumber: 200000000, baseFeePerGas: '2500000000', timestamp: 1700000100, gasUsed: '25000000', gasLimit: '30000000' }
      ],
      range: { start: 199999999, latest: 200000000, count: 1 }
    }),
    traceData: JSON.stringify({
      memoryAccesses: [
        { offset: 0, size: 32, type: 'MLOAD' },
        { offset: 32, size: 32, type: 'MSTORE' }
      ],
      storageAccesses: [
        { address: '0x0000000000000000000000000000000000000001', slot: '0x0', type: 'SLOAD', value: '0x0' }
      ]
    })
  }
]

// Sample Stylus/WASM logs
const sampleStylusLogs = [
  {
    txHash: '0x9876543210fedcba',
    isL1: false,
    logs: JSON.stringify([
      {
        logIndex: 0,
        address: '0x0000000000000000000000000000000000000071',
        topics: ['0x1234567890abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef'],
        data: '0x4e487b7100000000000000000000000000000000000000000000000000000011'
      },
      {
        logIndex: 1,
        address: '0x0000000000000000000000000000000000000071',
        topics: ['0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'],
        data: '0x'
      },
      {
        logIndex: 2,
        address: '0x0000000000000000000000000000000000000071',
        topics: ['0x9999999999999999999999999999999999999999999999999999999999999999'],
        data: '0x0000000000000000000000000000000000000000000000000000000000000011'
      }
    ]),
    gasPriceHistory: JSON.stringify({
      history: [
        { blockNumber: 200000099, baseFeePerGas: '2300000000', timestamp: 1700000200, gasUsed: '28000000', gasLimit: '30000000' },
        { blockNumber: 200000100, baseFeePerGas: '2450000000', timestamp: 1700000212, gasUsed: '25500000', gasLimit: '30000000' }
      ],
      range: { start: 200000099, latest: 200000100, count: 2 }
    }),
    traceData: JSON.stringify({
      memoryAccesses: [
        { offset: 0, size: 32, type: 'MLOAD' },
        { offset: 32, size: 32, type: 'MSTORE' },
        { offset: 64, size: 64, type: 'MLOAD' }
      ],
      storageAccesses: [
        { address: '0x0000000000000000000000000000000000000071', slot: '0x0', type: 'SLOAD', value: '0x0' },
        { address: '0x0000000000000000000000000000000000000071', slot: '0x1', type: 'SSTORE', value: '0x1' }
      ]
    })
  }
]

// Insert all sample logs
const allSamples = [...sampleL1Logs, ...sampleL2Logs, ...sampleStylusLogs]

for (const sample of allSamples) {
  db.prepare(`
    INSERT OR REPLACE INTO transaction_logs (
      tx_hash_prefix,
      is_l1,
      logs,
      gas_price_history,
      trace_data
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    sample.txHash,
    sample.isL1 ? 1 : 0,
    sample.logs,
    sample.gasPriceHistory,
    sample.traceData
  )
}

console.log(`✅ Added ${allSamples.length} sample log entries`)

// Verify
const count = db.prepare('SELECT COUNT(*) as cnt FROM transaction_logs').get()
console.log(`✅ Total transaction logs in database: ${count.cnt}`)

db.close()

console.log('\n✅ Sample logs population complete!')
console.log('Logs are now available for demo/test analysis.')
