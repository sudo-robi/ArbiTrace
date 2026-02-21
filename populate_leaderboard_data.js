/**
 * Populate failure_patterns into sessions.db for leaderboard analytics
 * The leaderboard module expects failure_patterns in sessions.db
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sessionsDbPath = path.join(__dirname, 'data', 'sessions.db')

const db = new Database(sessionsDbPath)
db.pragma('journal_mode = WAL')

console.log('🔧 Creating failure_patterns table in sessions.db...')

// Create the failure_patterns table matching leaderboard expectations
db.exec(`
  CREATE TABLE IF NOT EXISTS failure_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_address_hash TEXT UNIQUE,
    total_failures INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_distribution TEXT DEFAULT '{}',
    last_failure_time INTEGER,
    total_viewers INTEGER DEFAULT 0,
    average_rating REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`)

// Sample contract data
const sampleContracts = [
  {
    hash: createHash('sha256').update('0x1234567890123456789012345678901234567890').digest('hex').slice(0, 16),
    name: 'DEX Router',
    failures: 10,
    distribution: { 'OUT_OF_GAS': 4, 'LOW_GAS_LIMIT': 3, 'LOW_GAS_PRICE': 2, 'LOGIC_REVERT': 1 }
  },
  {
    hash: createHash('sha256').update('0xabcdefabcdefabcdefabcdefabcdefabcdefab12').digest('hex').slice(0, 16),
    name: 'Bridge',
    failures: 4,
    distribution: { 'LOW_GAS_PRICE': 2, 'LOGIC_REVERT': 1, 'LOW_SUBMISSION_COST': 1 }
  },
  {
    hash: createHash('sha256').update('0x9876543210987654321098765432109876543210').digest('hex').slice(0, 16),
    name: 'Vault',
    failures: 1,
    distribution: { 'LOGIC_REVERT': 1 }
  },
  {
    hash: createHash('sha256').update('0x1111111111111111111111111111111111111111').digest('hex').slice(0, 16),
    name: 'AMM Pool',
    failures: 6,
    distribution: { 'OUT_OF_GAS': 6 }
  },
  {
    hash: createHash('sha256').update('0x2222222222222222222222222222222222222222').digest('hex').slice(0, 16),
    name: 'Staking (Stylus)',
    failures: 2,
    distribution: { 'LOGIC_REVERT': 2 }
  }
]

console.log('📊 Populating failure_patterns...')

const now = Math.floor(Date.now() / 1000)

for (const contract of sampleContracts) {
  // Calculate reasonable success count (failure rate 20-60%)
  const successCount = Math.ceil(contract.failures / (0.2 + Math.random() * 0.4))
  
  db.prepare(`
    INSERT OR REPLACE INTO failure_patterns (
      contract_address_hash,
      total_failures,
      success_count,
      failure_distribution,
      last_failure_time,
      total_viewers,
      average_rating
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    contract.hash,
    contract.failures,
    successCount,
    JSON.stringify(contract.distribution),
    now - Math.random() * 7 * 24 * 60 * 60, // Within last week
    Math.floor(Math.random() * 100) + 5,
    Math.random() * 5
  )
}

console.log(`✅ Added ${sampleContracts.length} contracts to failure_patterns`)

// Verify the data
const count = db.prepare('SELECT COUNT(*) as cnt FROM failure_patterns').get()
console.log(`✅ Total patterns in database: ${count.cnt}`)

// Show sample data
const samples = db.prepare('SELECT * FROM failure_patterns LIMIT 3').all()
console.log('\n📋 Sample data:')
samples.forEach(s => {
  console.log(`  • ${s.contract_address_hash}: ${s.total_failures} failures, ${s.success_count} successes`)
})

db.close()

console.log('\n✅ Leaderboard data population complete!')
console.log('Now test: curl http://localhost:3000/leaderboard/stats')
