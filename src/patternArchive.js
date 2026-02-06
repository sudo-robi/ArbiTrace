/**
 * Pattern Archive - Failure Intelligence Database
 * 
 * Stores anonymized failed transactions with crowdsourced insights.
 * Enables pattern matching: "Your failure matches 47 similar cases"
 * 
 * Database tables:
 * - failures: Raw failure records (anonymized)
 * - failurePatterns: Aggregated patterns (contract bytecode hash → failure distribution)
 * - userTags: Community-provided context and remediation notes
 * - patternMatches: Cache of similar failure lookups
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'patterns.db')

let db = null

export function initPatternArchive() {
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  
  // Create tables if they don't exist
  db.exec(`
    -- Main failure record (anonymized)
    CREATE TABLE IF NOT EXISTS failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      
      -- Transaction identifiers (anonymized via hash)
      l1_tx_hash_prefix TEXT,        -- First 8 chars for reference (not full hash)
      l2_tx_hash_prefix TEXT,
      contract_address_hash TEXT,    -- Keccak256 hash of contract (fully anonymous)
      
      -- Failure classification
      failure_at TEXT,               -- L1_SUBMISSION | RETRYABLE_CREATION | AUTO_REDEEM | MANUAL_REDEEM | L2_EXECUTION
      failure_reason TEXT,           -- OUT_OF_GAS | LOGIC_REVERT | TIMEOUT | LOW_SUBMISSION_COST | LOW_GAS_LIMIT | LOW_GAS_PRICE | UNKNOWN
      
      -- Transaction parameters (for pattern correlation)
      gas_limit INTEGER,
      max_fee_per_gas INTEGER,
      submission_cost INTEGER,
      call_data_length INTEGER,
      
      -- Execution metrics
      actual_gas_used INTEGER,
      l2_base_fee INTEGER,
      block_number_l2 INTEGER,
      
      -- Raw data for advanced analysis
      revert_reason TEXT,            -- Decoded revert message
      trace_hash TEXT,               -- Hash of trace for deduplication
      
      -- Metadata
      network TEXT DEFAULT 'arbitrum-one',
      is_stylus BOOLEAN DEFAULT 0,
      panic_code TEXT,
      
      UNIQUE(l1_tx_hash_prefix, l2_tx_hash_prefix)
    );
    
    -- Aggregated failure patterns (bytecode hash → failure distribution)
    CREATE TABLE IF NOT EXISTS failure_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_bytecode_hash TEXT UNIQUE,
      
      -- Pattern metadata
      total_failures INTEGER DEFAULT 0,
      unique_contracts INTEGER DEFAULT 1,
      most_recent_at DATETIME,
      
      -- Failure distribution (what % failed for each reason)
      failures_out_of_gas INTEGER DEFAULT 0,
      failures_logic_revert INTEGER DEFAULT 0,
      failures_low_submission_cost INTEGER DEFAULT 0,
      failures_low_gas_limit INTEGER DEFAULT 0,
      failures_low_gas_price INTEGER DEFAULT 0,
      failures_timeout INTEGER DEFAULT 0,
      
      -- Parameter analysis
      avg_gas_limit INTEGER,
      avg_max_fee_per_gas INTEGER,
      avg_submission_cost INTEGER,
      avg_call_data_length INTEGER,
      
      -- Risk score (0-100)
      risk_score INTEGER DEFAULT 0,
      
      -- Common remediation
      top_fix TEXT,  -- Most common way this pattern was fixed
      
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Community tags and insights (crowdsourced)
    CREATE TABLE IF NOT EXISTS user_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      failure_id INTEGER NOT NULL,
      
      -- Crowdsourced metadata
      tag_type TEXT,  -- ROOT_CAUSE | WORKAROUND | SIMILAR_ISSUE | FIX_APPLIED | CONTEXT
      tag_value TEXT,
      user_hash TEXT,  -- Hashed user ID (anonymous)
      
      -- Validation
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      is_verified BOOLEAN DEFAULT 0,
      
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(failure_id) REFERENCES failures(id) ON DELETE CASCADE
    );
    
    -- Pattern similarity cache (for fast lookups)
    CREATE TABLE IF NOT EXISTS pattern_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_failure_id INTEGER,
      similar_failure_ids TEXT,  -- JSON array of similar IDs
      match_score REAL,  -- 0.0-1.0 similarity
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(source_failure_id) REFERENCES failures(id) ON DELETE CASCADE
    );
    
    -- Indexes for fast queries
    CREATE INDEX IF NOT EXISTS idx_failures_reason ON failures(failure_reason);
    CREATE INDEX IF NOT EXISTS idx_failures_contract ON failures(contract_address_hash);
    CREATE INDEX IF NOT EXISTS idx_failures_timestamp ON failures(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_patterns_risk ON failure_patterns(risk_score DESC);
    CREATE INDEX IF NOT EXISTS idx_tags_type ON user_tags(tag_type);
  `)
}

/**
 * Record a failure in the pattern archive (anonymized)
 * 
 * @param {Object} failureData - Transaction and failure info
 * @returns {number} Failure record ID
 */
export function recordFailure(failureData) {
  if (!db) initPatternArchive()
  
  const stmt = db.prepare(`
    INSERT INTO failures (
      l1_tx_hash_prefix,
      l2_tx_hash_prefix,
      contract_address_hash,
      failure_at,
      failure_reason,
      gas_limit,
      max_fee_per_gas,
      submission_cost,
      call_data_length,
      actual_gas_used,
      l2_base_fee,
      block_number_l2,
      revert_reason,
      trace_hash,
      network,
      is_stylus,
      panic_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  
  try {
    const result = stmt.run(
      failureData.l1TxHashPrefix || null,
      failureData.l2TxHashPrefix || null,
      failureData.contractAddressHash || null,
      failureData.failureAt || 'UNKNOWN',
      failureData.failureReason || 'UNKNOWN',
      failureData.gasLimit || null,
      failureData.maxFeePerGas || null,
      failureData.submissionCost || null,
      failureData.callDataLength || null,
      failureData.actualGasUsed || null,
      failureData.l2BaseFee || null,
      failureData.blockNumberL2 || null,
      failureData.revertReason || null,
      failureData.traceHash || null,
      failureData.network || 'arbitrum-one',
      failureData.isStylus ? 1 : 0,
      failureData.panicCode || null
    )
    
    // Update pattern aggregation
    updatePatternStats(failureData.contractAddressHash, failureData)
    
    return result.lastInsertRowid
  } catch (e) {
    console.error('Error recording failure:', e.message)
    return null
  }
}

/**
 * Find similar failures (pattern matching)
 * 
 * Returns failures matching: same contract + similar parameters
 * 
 * @param {string} contractAddressHash - Hash of contract address
 * @param {Object} params - Gas params to match against
 * @returns {Array} Similar failures with match scores
 */
export function findSimilarFailures(contractAddressHash, params = {}) {
  if (!db) initPatternArchive()
  
  // Find exact contract matches first
  const exactMatches = db.prepare(`
    SELECT 
      f.*,
      (
        SELECT COUNT(*) FROM user_tags ut 
        WHERE ut.failure_id = f.id AND ut.tag_type = 'FIX_APPLIED'
      ) as fix_count
    FROM failures f
    WHERE f.contract_address_hash = ?
    ORDER BY f.created_at DESC
    LIMIT 50
  `).all(contractAddressHash)
  
  // Calculate similarity scores (same failure reason, similar gas params)
  const scored = exactMatches.map(failure => {
    let score = 1.0  // 100% match for same contract
    
    // Deduct for different failure reasons
    if (params.failureReason && params.failureReason !== failure.failure_reason) {
      score -= 0.2
    }
    
    // Deduct for very different gas parameters (within 50% = similar)
    if (params.gasLimit && failure.gas_limit) {
      const ratio = params.gasLimit / failure.gas_limit
      if (ratio > 1.5 || ratio < 0.67) score -= 0.1
    }
    
    return {
      ...failure,
      matchScore: Math.max(0, score),
      fixedCount: failure.fix_count
    }
  })
  
  return scored.filter(s => s.matchScore > 0.6).sort((a, b) => b.matchScore - a.matchScore)
}

/**
 * Get failure pattern for a contract
 * 
 * Shows: "This contract fails 70% due to LOW_GAS_LIMIT"
 * 
 * @param {string} contractBytecodeHash - Contract bytecode hash
 * @returns {Object} Pattern statistics
 */
export function getFailurePattern(contractBytecodeHash) {
  if (!db) initPatternArchive()
  
  const pattern = db.prepare(`
    SELECT * FROM failure_patterns
    WHERE contract_bytecode_hash = ?
  `).get(contractBytecodeHash)
  
  if (!pattern) return null
  
  // Calculate distribution percentages
  const total = pattern.total_failures || 1
  return {
    ...pattern,
    distribution: {
      outOfGas: Math.round((pattern.failures_out_of_gas / total) * 100),
      logicRevert: Math.round((pattern.failures_logic_revert / total) * 100),
      lowSubmissionCost: Math.round((pattern.failures_low_submission_cost / total) * 100),
      lowGasLimit: Math.round((pattern.failures_low_gas_limit / total) * 100),
      lowGasPrice: Math.round((pattern.failures_low_gas_price / total) * 100),
      timeout: Math.round((pattern.failures_timeout / total) * 100)
    }
  }
}

/**
 * Update pattern statistics when new failure is recorded
 */
function updatePatternStats(contractBytecodeHash, failureData) {
  if (!contractBytecodeHash) return
  
  const stmt = db.prepare(`
    SELECT * FROM failure_patterns
    WHERE contract_bytecode_hash = ?
  `)
  
  const existing = stmt.get(contractBytecodeHash)
  const reason = failureData.failureReason || 'UNKNOWN'
  
  if (existing) {
    // Update existing pattern
    const updateStmt = db.prepare(`
      UPDATE failure_patterns
      SET 
        total_failures = total_failures + 1,
        failures_${getReasonColumn(reason)} = ${getReasonColumn(reason)} + 1,
        avg_gas_limit = ((avg_gas_limit * total_failures) + ?) / (total_failures + 1),
        avg_max_fee_per_gas = ((avg_max_fee_per_gas * total_failures) + ?) / (total_failures + 1),
        most_recent_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE contract_bytecode_hash = ?
    `)
    
    try {
      updateStmt.run(
        failureData.gasLimit || 0,
        failureData.maxFeePerGas || 0,
        contractBytecodeHash
      )
    } catch (e) {
      // Fallback: simple update without average calc
      db.prepare(`
        UPDATE failure_patterns
        SET total_failures = total_failures + 1,
            failures_${getReasonColumn(reason)} = ${getReasonColumn(reason)} + 1,
            most_recent_at = CURRENT_TIMESTAMP
        WHERE contract_bytecode_hash = ?
      `).run(contractBytecodeHash)
    }
  } else {
    // Create new pattern
    const insertStmt = db.prepare(`
      INSERT INTO failure_patterns (
        contract_bytecode_hash,
        total_failures,
        ${getReasonColumn(reason)},
        avg_gas_limit,
        avg_max_fee_per_gas,
        avg_call_data_length
      ) VALUES (?, ?, 1, ?, ?, ?)
    `)
    
    insertStmt.run(
      contractBytecodeHash,
      1,
      failureData.gasLimit || 0,
      failureData.maxFeePerGas || 0,
      failureData.callDataLength || 0
    )
  }
  
  // Recalculate risk score
  updateRiskScore(contractBytecodeHash)
}

/**
 * Get column name for failure reason
 */
function getReasonColumn(reason) {
  const mapping = {
    'OUT_OF_GAS': 'failures_out_of_gas',
    'LOGIC_REVERT': 'failures_logic_revert',
    'LOW_SUBMISSION_COST': 'failures_low_submission_cost',
    'LOW_GAS_LIMIT': 'failures_low_gas_limit',
    'LOW_GAS_PRICE': 'failures_low_gas_price',
    'TIMEOUT': 'failures_timeout'
  }
  return mapping[reason] || 'failures_timeout'
}

/**
 * Recalculate risk score for a contract pattern
 * 
 * Risk factors:
 * - High failure count
 * - Concentrated failure type (indicates design issue)
 * - Recent spike in failures
 */
function updateRiskScore(contractBytecodeHash) {
  const pattern = db.prepare(`
    SELECT * FROM failure_patterns
    WHERE contract_bytecode_hash = ?
  `).get(contractBytecodeHash)
  
  if (!pattern) return
  
  let score = 0
  const total = pattern.total_failures || 1
  
  // Factor 1: Failure volume (0-40 points)
  // 10+ failures = high risk
  if (total >= 100) score += 40
  else if (total >= 50) score += 30
  else if (total >= 20) score += 20
  else if (total >= 10) score += 10
  
  // Factor 2: Concentration (0-40 points)
  // If 80%+ of failures are same type = design issue
  const maxReason = Math.max(
    pattern.failures_out_of_gas,
    pattern.failures_logic_revert,
    pattern.failures_low_submission_cost,
    pattern.failures_low_gas_limit,
    pattern.failures_low_gas_price,
    pattern.failures_timeout
  )
  const concentration = (maxReason / total) * 100
  
  if (concentration >= 80) score += 40
  else if (concentration >= 70) score += 30
  else if (concentration >= 60) score += 20
  else if (concentration >= 50) score += 10
  
  // Factor 3: Recency (0-20 points)
  // Recent failures more worrisome
  const daysSinceLastFailure = Math.max(0,
    (new Date() - new Date(pattern.most_recent_at)) / (1000 * 60 * 60 * 24)
  )
  if (daysSinceLastFailure < 1) score += 20
  else if (daysSinceLastFailure < 7) score += 15
  else if (daysSinceLastFailure < 30) score += 10
  
  db.prepare(`
    UPDATE failure_patterns
    SET risk_score = ?
    WHERE contract_bytecode_hash = ?
  `).run(Math.min(100, score), contractBytecodeHash)
}

/**
 * Add community tag/insight to a failure
 */
export function addUserTag(failureId, tagType, tagValue, userHash) {
  if (!db) initPatternArchive()
  
  const stmt = db.prepare(`
    INSERT INTO user_tags (failure_id, tag_type, tag_value, user_hash)
    VALUES (?, ?, ?, ?)
  `)
  
  try {
    return stmt.run(failureId, tagType, tagValue, userHash).lastInsertRowid
  } catch (e) {
    console.error('Error adding user tag:', e.message)
    return null
  }
}

/**
 * Get top risky contracts (high risk score)
 */
export function getTopRiskyContracts(limit = 20) {
  if (!db) initPatternArchive()
  
  return db.prepare(`
    SELECT 
      contract_bytecode_hash,
      total_failures,
      risk_score,
      most_recent_at,
      ROUND(failures_low_gas_limit * 100.0 / total_failures, 0) as pct_low_gas_limit,
      ROUND(failures_low_gas_price * 100.0 / total_failures, 0) as pct_low_gas_price,
      ROUND(failures_out_of_gas * 100.0 / total_failures, 0) as pct_out_of_gas
    FROM failure_patterns
    WHERE total_failures >= 5
    ORDER BY risk_score DESC, total_failures DESC
    LIMIT ?
  `).all(limit)
}

/**
 * Get aggregate statistics across all failures
 */
export function getArchiveStats() {
  if (!db) initPatternArchive()
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_failures,
      COUNT(DISTINCT contract_address_hash) as unique_contracts,
      COUNT(CASE WHEN failure_reason = 'OUT_OF_GAS' THEN 1 END) as out_of_gas_count,
      COUNT(CASE WHEN failure_reason = 'LOW_GAS_LIMIT' THEN 1 END) as low_gas_limit_count,
      COUNT(CASE WHEN failure_reason = 'LOW_GAS_PRICE' THEN 1 END) as low_gas_price_count,
      COUNT(CASE WHEN failure_reason = 'LOW_SUBMISSION_COST' THEN 1 END) as low_submission_cost_count,
      COUNT(CASE WHEN failure_reason = 'LOGIC_REVERT' THEN 1 END) as logic_revert_count,
      COUNT(CASE WHEN is_stylus = 1 THEN 1 END) as stylus_failures,
      AVG(gas_limit) as avg_gas_limit,
      AVG(max_fee_per_gas) as avg_max_fee_per_gas
    FROM failures
  `).get()
  
  return {
    ...stats,
    failureBreakdown: {
      outOfGas: stats.out_of_gas_count,
      lowGasLimit: stats.low_gas_limit_count,
      lowGasPrice: stats.low_gas_price_count,
      lowSubmissionCost: stats.low_submission_cost_count,
      logicRevert: stats.logic_revert_count,
      stylusFailures: stats.stylus_failures
    }
  }
}

export default {
  initPatternArchive,
  recordFailure,
  findSimilarFailures,
  getFailurePattern,
  addUserTag,
  getTopRiskyContracts,
  getArchiveStats
}
