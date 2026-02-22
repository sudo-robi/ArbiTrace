/**
 * Populate sample data into ArbiTrace databases
 * This script creates realistic failure patterns and leaderboard data
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Initialize databases
const patternsDbPath = path.join(__dirname, 'data', 'patterns.db')
const sessionsDbPath = path.join(__dirname, 'data', 'sessions.db')

const patternsDb = new Database(patternsDbPath)
const sessionsDb = new Database(sessionsDbPath)

patternsDb.pragma('journal_mode = WAL')
sessionsDb.pragma('journal_mode = WAL')

// Initialize pattern archive tables (using actual schema from patternArchive.js)
console.log('🔧 Initializing pattern archive tables...')
patternsDb.exec(`
  CREATE TABLE IF NOT EXISTS failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    l1_tx_hash_prefix TEXT,
    l2_tx_hash_prefix TEXT,
    contract_address_hash TEXT,
    failure_at TEXT,
    failure_reason TEXT,
    gas_limit INTEGER,
    max_fee_per_gas INTEGER,
    submission_cost INTEGER,
    call_data_length INTEGER,
    actual_gas_used INTEGER,
    l2_base_fee INTEGER,
    block_number_l2 INTEGER,
    revert_reason TEXT,
    trace_hash TEXT,
    network TEXT DEFAULT 'arbitrum-one',
    is_stylus BOOLEAN DEFAULT 0,
    panic_code TEXT,
    UNIQUE(l1_tx_hash_prefix, l2_tx_hash_prefix)
  );

  CREATE TABLE IF NOT EXISTS failure_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_bytecode_hash TEXT UNIQUE,
    total_failures INTEGER DEFAULT 0,
    unique_contracts INTEGER DEFAULT 1,
    most_recent_at DATETIME,
    failures_out_of_gas INTEGER DEFAULT 0,
    failures_logic_revert INTEGER DEFAULT 0,
    failures_low_submission_cost INTEGER DEFAULT 0,
    failures_low_gas_limit INTEGER DEFAULT 0,
    failures_low_gas_price INTEGER DEFAULT 0,
    failures_timeout INTEGER DEFAULT 0,
    avg_gas_limit INTEGER,
    avg_max_fee_per_gas INTEGER,
    avg_submission_cost INTEGER,
    avg_call_data_length INTEGER,
    risk_score INTEGER DEFAULT 0,
    top_fix TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    failure_id INTEGER NOT NULL,
    tag_type TEXT,
    tag_value TEXT,
    user_hash TEXT,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    is_verified BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(failure_id) REFERENCES failures(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pattern_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_failure_id INTEGER,
    similar_failure_ids TEXT,
    match_score REAL,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(source_failure_id) REFERENCES failures(id) ON DELETE CASCADE
  );
`)

// Helper functions for realistic random values
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomGasLimit(baseLimit) {
  // Vary by ±30% with realistic fluctuation
  return baseLimit + randomInt(-baseLimit * 0.3, baseLimit * 0.3)
}

function randomMaxFeePerGas(baseFee) {
  // Gwei values fluctuate 0.5-5 range with randomness
  const variation = randomInt(-baseFee * 0.4, baseFee * 0.4)
  return Math.max(500000000, baseFee + variation) // Min 0.5 Gwei
}

function randomSubmissionCost(baseCost) {
  // Submission costs vary by ±25%
  return baseCost + randomInt(-baseCost * 0.25, baseCost * 0.25)
}

function randomCallDataLength() {
  // Call data length typically 32-256 bytes
  return randomInt(32, 256)
}

function randomActualGasUsed(gasLimit) {
  // Typically 60-95% of the gas limit when successful
  return Math.floor(gasLimit * (0.6 + Math.random() * 0.35))
}

// Sample failure data (realistic scenarios with varied parameters)
const sampleFailures = [
  // Contract 1: DEX (high failure rate, needs more gas)
  {
    contract: '0x1234567890123456789012345678901234567890',
    baseGasLimit: 150000,
    baseMaxFee: 5500000000,
    baseSubmissionCost: 75000,
    failures: [
      { reason: 'LOW_GAS_LIMIT' },
      { reason: 'LOW_GAS_LIMIT' },
      { reason: 'OUT_OF_GAS' },
      { reason: 'LOW_GAS_PRICE' },
      { reason: 'LOGIC_REVERT' },
      { reason: 'OUT_OF_GAS' },
      { reason: 'LOW_GAS_LIMIT' },
      { reason: 'LOW_SUBMISSION_COST' },
      { reason: 'LOW_GAS_PRICE' },
      { reason: 'OUT_OF_GAS' }
    ]
  },
  // Contract 2: Bridge (medium failure rate)
  {
    contract: '0xabcdefabcdefabcdefabcdefabcdefabcdefab12',
    baseGasLimit: 200000,
    baseMaxFee: 4800000000,
    baseSubmissionCost: 120000,
    failures: [
      { reason: 'LOW_GAS_PRICE' },
      { reason: 'LOGIC_REVERT' },
      { reason: 'LOW_SUBMISSION_COST' },
      { reason: 'OUT_OF_GAS' }
    ]
  },
  // Contract 3: Vault (low failure rate)
  {
    contract: '0x9876543210987654321098765432109876543210',
    baseGasLimit: 100000,
    baseMaxFee: 5200000000,
    baseSubmissionCost: 60000,
    failures: [
      { reason: 'LOGIC_REVERT' }
    ]
  },
  // Contract 4: AMM (high gas usage)
  {
    contract: '0x1111111111111111111111111111111111111111',
    baseGasLimit: 250000,
    baseMaxFee: 5800000000,
    baseSubmissionCost: 100000,
    failures: [
      { reason: 'OUT_OF_GAS' },
      { reason: 'OUT_OF_GAS' },
      { reason: 'OUT_OF_GAS' },
      { reason: 'LOW_GAS_LIMIT' },
      { reason: 'OUT_OF_GAS' },
      { reason: 'OUT_OF_GAS' }
    ]
  },
  // Contract 5: Staking (stylus, panic codes)
  {
    contract: '0x2222222222222222222222222222222222222222',
    baseGasLimit: 180000,
    baseMaxFee: 5300000000,
    baseSubmissionCost: 85000,
    failures: [
      { reason: 'LOGIC_REVERT', isStylus: true, panic: '0x11' },
      { reason: 'LOGIC_REVERT', isStylus: true, panic: '0x51' }
    ]
  }
]

console.log('📊 Adding sample failure data...')
let totalFailures = 0

for (const { contract, baseGasLimit, baseMaxFee, baseSubmissionCost, failures } of sampleFailures) {
  const contractHash = createHash('sha256').update(contract).digest('hex').slice(0, 16)

  // Add individual failures with randomized parameters
  for (let i = 0; i < failures.length; i++) {
    const f = failures[i]
    const gasLimit = randomGasLimit(baseGasLimit)
    const maxFee = randomMaxFeePerGas(baseMaxFee)
    const submissionCost = randomSubmissionCost(baseSubmissionCost)
    const callDataLength = randomCallDataLength()
    const actualGasUsed = randomActualGasUsed(gasLimit)

    patternsDb.prepare(`
      INSERT OR IGNORE INTO failures (
        l1_tx_hash_prefix, l2_tx_hash_prefix, contract_address_hash,
        failure_at, failure_reason, gas_limit, max_fee_per_gas, submission_cost,
        call_data_length, actual_gas_used, l2_base_fee, block_number_l2,
        revert_reason, is_stylus, panic_code, network
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '0x' + Math.random().toString(16).slice(2, 10),
      '0x' + Math.random().toString(16).slice(2, 10),
      contractHash,
      'L2_EXECUTION',
      f.reason,
      gasLimit,
      maxFee,
      submissionCost,
      callDataLength,
      actualGasUsed,
      3000000000 + randomInt(-500000000, 500000000),
      Math.floor(1000000 + Math.random() * 100000),
      f.reason === 'LOGIC_REVERT' ? 'Execution reverted' : null,
      f.isStylus ? 1 : 0,
      f.panic || null,
      'arbitrum-one'
    )
    totalFailures++
  }

  // Add pattern aggregates
  const failureCount = failures.length
  const totalAttempts = Math.ceil(failureCount / (0.2 + Math.random() * 0.4)) // 20-60% failure rate

  const reasonCounts = {}
  for (const f of failures) {
    reasonCounts[f.reason] = (reasonCounts[f.reason] || 0) + 1
  }
  const mostCommon = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0][0]

  const riskScores = {
    'OUT_OF_GAS': 80,
    'LOW_GAS_LIMIT': 75,
    'LOW_GAS_PRICE': 70,
    'LOW_SUBMISSION_COST': 65,
    'LOGIC_REVERT': 60,
    'TIMEOUT': 85
  }

  const baseRisk = riskScores[mostCommon] || 50
  const failureRate = Math.round((failureCount / totalAttempts) * 100)
  const riskScore = Math.min(100, baseRisk + failureRate / 2)

  patternsDb.prepare(`
    INSERT OR REPLACE INTO failure_patterns (
      contract_bytecode_hash, total_failures, unique_contracts,
      failures_out_of_gas, failures_logic_revert, failures_low_submission_cost,
      failures_low_gas_limit, failures_low_gas_price,
      avg_gas_limit, avg_max_fee_per_gas, avg_submission_cost,
      risk_score, top_fix, most_recent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    contractHash,
    failureCount,
    1,
    reasonCounts['OUT_OF_GAS'] || 0,
    reasonCounts['LOGIC_REVERT'] || 0,
    reasonCounts['LOW_SUBMISSION_COST'] || 0,
    reasonCounts['LOW_GAS_LIMIT'] || 0,
    reasonCounts['LOW_GAS_PRICE'] || 0,
    Math.round(Math.random() * 50000 + 100000),
    5000000000,
    50000,
    Math.round(riskScore),
    generateFix(mostCommon),
    new Date().toISOString()
  )
}

console.log(`✅ Added ${totalFailures} sample failures`)

// Add session data for leaderboard stats
console.log('📝 Creating session tables...')
sessionsDb.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    creator_address TEXT,
    contract_address TEXT,
    transaction_hash TEXT,
    status TEXT DEFAULT 'active',
    viewer_count INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    created_ts DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    UNIQUE(session_id, timestamp, event_type)
  );

  CREATE TABLE IF NOT EXISTS session_viewers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    viewer_id TEXT,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_session_viewers_session_id ON session_viewers(session_id);
`)

// Add some sample sessions
const sampleSessionIds = ['sess_001', 'sess_002', 'sess_003', 'sess_004', 'sess_005']
const now = Math.floor(Date.now() / 1000)
const expiresIn = 24 * 60 * 60 // 24 hours

for (const sessionId of sampleSessionIds) {
  sessionsDb.prepare(`
    INSERT OR IGNORE INTO sessions (id, created_at, expires_at, status, event_count, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    now,
    now + expiresIn,
    'completed',
    Math.floor(Math.random() * 10),
    JSON.stringify({
      txHash: '0x' + Math.random().toString(16).slice(2, 66),
      failureReason: ['OUT_OF_GAS', 'LOGIC_REVERT', 'LOW_GAS_PRICE'][Math.floor(Math.random() * 3)]
    })
  )
}

console.log(`✅ Added ${sampleSessionIds.length} sample sessions`)

// Close databases
patternsDb.close()
sessionsDb.close()

console.log('✅ Sample data population complete!')
console.log('\nDatabase Summary:')
console.log(`  • Failures recorded: ${totalFailures}`)
console.log(`  • Contracts analyzed: ${sampleFailures.length}`)
console.log(`  • Sample sessions: ${sampleSessionIds.length}`)
console.log('\nYou can now run: npm run dev')
console.log('Then visit: http://localhost:3000')
console.log('Click the leaderboard button (📊) to see the data!')

function generateRecommendation(reason, failureRate) {
  const recommendations = {
    'OUT_OF_GAS': `Increase gasLimit by at least 30%. Current failure rate: ${failureRate}%`,
    'LOW_GAS_LIMIT': `Set gasLimit to 200000 or higher. Current failure rate: ${failureRate}%`,
    'LOW_GAS_PRICE': `Increase maxFeePerGas to 5000000000 Wei or higher`,
    'LOW_SUBMISSION_COST': `Increase submission cost to at least 100000 Wei`,
    'LOGIC_REVERT': `Check contract logic and calldata parameters`,
    'TIMEOUT': `Increase retry timeout or submit during lower congestion`
  }
  return recommendations[reason] || `Monitor and increase parameters. Current failure rate: ${failureRate}%`
}

function generateFix(reason) {
  const fixes = {
    'OUT_OF_GAS': 'Increase gasLimit',
    'LOW_GAS_LIMIT': 'Increase gasLimit to 200000+',
    'LOW_GAS_PRICE': 'Increase maxFeePerGas',
    'LOW_SUBMISSION_COST': 'Increase submission cost',
    'LOGIC_REVERT': 'Verify contract logic and calldata',
    'TIMEOUT': 'Increase retry timeout'
  }
  return fixes[reason] || 'Monitor execution metrics'
}
