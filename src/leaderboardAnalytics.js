/**
 * leaderboardAnalytics.js
 * 
 * Contract failure analytics and leaderboard generation.
 * Uses pattern archive data to rank contracts by risk, failure rate, and impact.
 * 
 * Features:
 * - Contract risk scoring (combines multiple factors)
 * - Failure leaderboards (worst performers)
 * - Category breakdowns (by failure type)
 * - Trend analysis (recent vs historical)
 * - Developer guidance (recommendations by contract)
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(__dirname, '../data/sessions.db')

let db

/**
 * Initialize analytics module (shares session database)
 */
export function initLeaderboardAnalytics() {
  try {
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    console.log('✅ Leaderboard analytics initialized')
    return true
  } catch (error) {
    console.error('❌ Failed to initialize leaderboard analytics:', error)
    return false
  }
}

/**
 * Get contract risk score (0-100)
 * Combines: failure rate, recent trend, severity distribution, impact
 * 
 * @param {string} contractAddressHash - SHA256 hash of contract address
 * @returns {Object} Risk analysis
 */
export function getContractRiskScore(contractAddressHash) {
  try {
    // Get pattern data for this contract
    const pattern = db.prepare(`
      SELECT * FROM failure_patterns 
      WHERE contract_address_hash = ?
    `).get(contractAddressHash)

    if (!pattern) {
      return {
        contractHash: contractAddressHash,
        riskScore: 0,
        failureCount: 0,
        successRate: 100,
        riskLevel: 'UNKNOWN',
        recommendation: 'No data available for this contract',
        factors: {}
      }
    }

    // Parse failure distribution
    let failureDistribution = {}
    try {
      failureDistribution = JSON.parse(pattern.failure_distribution || '{}')
    } catch (e) {
      failureDistribution = {}
    }

    // Calculate base risk from failure rate
    const failureCount = pattern.total_failures || 0
    const totalAttempts = failureCount + pattern.success_count || 1
    const failureRate = (failureCount / totalAttempts) * 100

    // Risk factor 1: Failure rate (0-40 points)
    const failureRateRisk = Math.min(40, (failureRate / 100) * 40)

    // Risk factor 2: Severity distribution (0-30 points)
    const severityRisk = calculateSeverityRisk(failureDistribution)

    // Risk factor 3: Frequency/recency (0-20 points)
    const frequencyRisk = calculateFrequencyRisk(pattern)

    // Risk factor 4: Concentration (0-10 points)
    // If 80%+ of failures are one type, contract has known issue
    const concentrationRisk = calculateConcentrationRisk(failureDistribution)

    // Total risk score (0-100)
    const totalRisk = Math.min(100, 
      failureRateRisk + severityRisk + frequencyRisk + concentrationRisk
    )

    // Determine risk level
    let riskLevel
    if (totalRisk >= 80) riskLevel = 'CRITICAL'
    else if (totalRisk >= 60) riskLevel = 'HIGH'
    else if (totalRisk >= 40) riskLevel = 'MEDIUM'
    else if (totalRisk >= 20) riskLevel = 'LOW'
    else riskLevel = 'MINIMAL'

    // Generate recommendation
    const recommendation = generateContractRecommendation(
      riskLevel,
      failureDistribution,
      pattern
    )

    return {
      contractHash: contractAddressHash,
      riskScore: Math.round(totalRisk),
      riskLevel,
      failureCount,
      totalAttempts,
      successRate: Math.round(((totalAttempts - failureCount) / totalAttempts) * 100),
      failureRate: Math.round(failureRate),
      recommendation,
      factors: {
        failureRateRisk: Math.round(failureRateRisk),
        severityRisk: Math.round(severityRisk),
        frequencyRisk: Math.round(frequencyRisk),
        concentrationRisk: Math.round(concentrationRisk)
      },
      failureDistribution,
      lastSeen: pattern.last_failure_time,
      totalViewers: pattern.total_viewers || 0,
      averageRating: pattern.average_rating || 0
    }
  } catch (error) {
    console.error('❌ Failed to calculate risk score:', error)
    return { error: error.message }
  }
}

/**
 * Calculate severity risk factor
 * OUT_OF_GAS and REVERT are most severe, others less so
 */
function calculateSeverityRisk(distribution) {
  let risk = 0

  // OUT_OF_GAS is worst (10 points)
  risk += (distribution.OUT_OF_GAS || 0) * 0.1

  // REVERT is bad (8 points)
  risk += (distribution.REVERT || 0) * 0.08

  // TIME_LIMIT is moderate (6 points)
  risk += (distribution.TIME_LIMIT || 0) * 0.06

  // INVALID_CALLDATA is moderate (5 points)
  risk += (distribution.INVALID_CALLDATA || 0) * 0.05

  // LOW_GAS_LIMIT_PRECOMPILE is moderate (5 points)
  risk += (distribution.LOW_GAS_LIMIT_PRECOMPILE || 0) * 0.05

  // Other failures (2 points each)
  const otherFailures = Object.values(distribution).reduce((sum, count) => sum + count, 0) -
    (distribution.OUT_OF_GAS || 0) -
    (distribution.REVERT || 0) -
    (distribution.TIME_LIMIT || 0) -
    (distribution.INVALID_CALLDATA || 0) -
    (distribution.LOW_GAS_LIMIT_PRECOMPILE || 0)

  risk += Math.min(10, otherFailures * 0.02)

  return Math.min(30, risk)
}

/**
 * Calculate frequency/recency risk factor
 * Recent failures are more concerning than old ones
 */
function calculateFrequencyRisk(pattern) {
  const now = Math.floor(Date.now() / 1000)
  const lastFailure = pattern.last_failure_time || 0
  const daysSinceFailure = (now - lastFailure) / 86400

  let risk = 0

  // Recent failures (last 24h): 20 points
  if (daysSinceFailure < 1) return 20

  // Recent failures (last 7 days): 15 points
  if (daysSinceFailure < 7) return 15

  // Recent failures (last 30 days): 10 points
  if (daysSinceFailure < 30) return 10

  // Older failures: 3 points
  return 3
}

/**
 * Calculate concentration risk factor
 * If 80%+ of failures are one type, contract has a known issue
 */
function calculateConcentrationRisk(distribution) {
  const total = Object.values(distribution).reduce((sum, count) => sum + count, 0)
  if (total === 0) return 0

  // Find max failure type percentage
  const maxFailureType = Math.max(...Object.values(distribution).map(count => count / total))

  // If 80%+ of failures are one type, contract has concentrated problem
  if (maxFailureType >= 0.8) return 10
  if (maxFailureType >= 0.6) return 6
  if (maxFailureType >= 0.4) return 3
  return 0
}

/**
 * Generate actionable recommendation for contract
 */
function generateContractRecommendation(riskLevel, distribution, pattern) {
  const topFailure = Object.entries(distribution)
    .sort(([, a], [, b]) => b - a)[0]

  if (!topFailure) {
    return 'Contract status unknown'
  }

  const [failureType, count] = topFailure

  if (riskLevel === 'CRITICAL') {
    return `⚠️ CRITICAL: ${failureType} issues in ${count} transactions. Investigate contract logic immediately.`
  }

  if (riskLevel === 'HIGH') {
    return `⚠️ HIGH: Common failure type: ${failureType}. Review gas estimation and parameters.`
  }

  if (riskLevel === 'MEDIUM') {
    return `⚡ MEDIUM: Some ${failureType} occurrences. Monitor carefully on next attempt.`
  }

  if (riskLevel === 'LOW') {
    return `✅ LOW: Occasional ${failureType}. Generally safe with proper parameters.`
  }

  return `✅ MINIMAL: Few failures recorded. Contract appears stable.`
}

/**
 * Get top N risky contracts (leaderboard)
 * 
 * @param {number} limit - Number of contracts to return
 * @param {Object} options - Filter options
 * @param {string} options.riskLevel - Filter by level (CRITICAL|HIGH|MEDIUM)
 * @param {number} options.minFailures - Minimum failure count
 * @param {string} options.sortBy - Sort key (risk|failures|recent)
 * @returns {Array} Contracts ranked by risk
 */
export function getTopRiskyContracts(limit = 50, options = {}) {
  try {
    const {
      riskLevel = null,
      minFailures = 1,
      sortBy = 'risk'
    } = options

    // Get all contracts with patterns
    let patterns
    if (sortBy === 'recent') {
      patterns = db.prepare(`
        SELECT 
          contract_address_hash,
          total_failures,
          success_count,
          failure_distribution,
          last_failure_time,
          total_viewers,
          average_rating
        FROM failure_patterns
        WHERE total_failures >= ?
        ORDER BY last_failure_time DESC
        LIMIT ?
      `).all(minFailures, limit * 2)
    } else {
      patterns = db.prepare(`
        SELECT 
          contract_address_hash,
          total_failures,
          success_count,
          failure_distribution,
          last_failure_time,
          total_viewers,
          average_rating
        FROM failure_patterns
        WHERE total_failures >= ?
        ORDER BY total_failures DESC
        LIMIT ?
      `).all(minFailures, limit * 2)
    }

    // Calculate risk scores and filter
    const leaderboard = patterns
      .map(p => {
        const risk = getContractRiskScore(p.contract_address_hash)
        return {
          ...risk,
          viewers: p.total_viewers || 0,
          rating: p.average_rating || 0
        }
      })
      .filter(r => !riskLevel || r.riskLevel === riskLevel)
      .sort((a, b) => {
        if (sortBy === 'recent') {
          return (b.lastSeen || 0) - (a.lastSeen || 0)
        }
        return b.riskScore - a.riskScore
      })
      .slice(0, limit)

    return {
      ok: true,
      limit,
      count: leaderboard.length,
      leaderboard,
      timestamp: Math.floor(Date.now() / 1000)
    }
  } catch (error) {
    console.error('❌ Failed to get risky contracts:', error)
    return { ok: false, error: error.message }
  }
}

/**
 * Get failure type breakdown across all contracts
 * Shows which failure types are most common
 */
export function getFailureTypeStats() {
  try {
    const patterns = db.prepare(`
      SELECT failure_distribution FROM failure_patterns
      WHERE total_failures > 0
    `).all()

    let typeStats = {}
    let totalFailures = 0

    for (const { failure_distribution } of patterns) {
      let dist = {}
      try {
        dist = JSON.parse(failure_distribution || '{}')
      } catch (e) {}

      for (const [type, count] of Object.entries(dist)) {
        typeStats[type] = (typeStats[type] || 0) + count
        totalFailures += count
      }
    }

    // Convert to percentage and sort
    const stats = Object.entries(typeStats)
      .map(([type, count]) => ({
        type,
        count,
        percentage: Math.round((count / totalFailures) * 100)
      }))
      .sort((a, b) => b.count - a.count)

    return {
      ok: true,
      totalFailures,
      typeStats: stats,
      timestamp: Math.floor(Date.now() / 1000)
    }
  } catch (error) {
    console.error('❌ Failed to get failure type stats:', error)
    return { ok: false, error: error.message }
  }
}

/**
 * Get trend analysis (failures over time)
 * Shows if situation improving or worsening
 */
export function getTrendAnalysis(days = 30) {
  try {
    const now = Math.floor(Date.now() / 1000)
    const cutoff = now - (days * 86400)

    // Get failures in time periods
    const periods = []

    for (let i = 0; i < days; i++) {
      const periodStart = now - ((i + 1) * 86400)
      const periodEnd = now - (i * 86400)

      const count = db.prepare(`
        SELECT COUNT(*) as count FROM failure_patterns
        WHERE last_failure_time BETWEEN ? AND ?
      `).get(periodStart, periodEnd).count

      periods.push({
        day: i,
        timestamp: periodEnd,
        failureCount: count
      })
    }

    // Calculate trend
    const recentAvg = periods.slice(0, 7).reduce((sum, p) => sum + p.failureCount, 0) / 7
    const olderAvg = periods.slice(7, 30).reduce((sum, p) => sum + p.failureCount, 0) / 23

    const trend = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0

    return {
      ok: true,
      days,
      periods: periods.reverse(),
      recentAverage: Math.round(recentAvg),
      olderAverage: Math.round(olderAvg),
      trendPercent: Math.round(trend),
      trendDirection: trend > 5 ? 'WORSENING' : trend < -5 ? 'IMPROVING' : 'STABLE',
      timestamp: Math.floor(Date.now() / 1000)
    }
  } catch (error) {
    console.error('❌ Failed to get trend analysis:', error)
    return { ok: false, error: error.message }
  }
}

/**
 * Get severity distribution across all failures
 */
export function getSeverityDistribution() {
  try {
    const patterns = db.prepare(`
      SELECT failure_distribution FROM failure_patterns
    `).all()

    let distribution = {}

    for (const { failure_distribution } of patterns) {
      let dist = {}
      try {
        dist = JSON.parse(failure_distribution || '{}')
      } catch (e) {}

      for (const [type, count] of Object.entries(dist)) {
        distribution[type] = (distribution[type] || 0) + count
      }
    }

    // Sort by count
    const sorted = Object.entries(distribution)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)

    // Calculate percentages
    const total = sorted.reduce((sum, item) => sum + item.count, 0)

    return {
      ok: true,
      total,
      distribution: sorted.map(item => ({
        ...item,
        percentage: Math.round((item.count / total) * 100)
      })),
      timestamp: Math.floor(Date.now() / 1000)
    }
  } catch (error) {
    console.error('❌ Failed to get severity distribution:', error)
    return { ok: false, error: error.message }
  }
}

/**
 * Get leaderboard statistics summary
 */
export function getLeaderboardStats() {
  try {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_contracts,
        SUM(total_failures) as total_failures,
        SUM(success_count) as total_successes,
        MAX(total_failures) as max_failures,
        MAX(average_rating) as highest_rating,
        MIN(average_rating) as lowest_rating
      FROM failure_patterns
    `).get()

    return {
      ok: true,
      stats: {
        totalContracts: stats.total_contracts || 0,
        totalFailures: stats.total_failures || 0,
        totalSuccesses: stats.total_successes || 0,
        maxFailuresPerContract: stats.max_failures || 0,
        highestRating: stats.highest_rating || 0,
        lowestRating: stats.lowest_rating || 0,
        overallSuccessRate: stats.total_successes && (stats.total_successes + stats.total_failures) > 0
          ? Math.round((stats.total_successes / (stats.total_successes + stats.total_failures)) * 100)
          : 0
      },
      timestamp: Math.floor(Date.now() / 1000)
    }
  } catch (error) {
    console.error('❌ Failed to get leaderboard stats:', error)
    return { ok: false, error: error.message }
  }
}

export default {
  initLeaderboardAnalytics,
  getContractRiskScore,
  getTopRiskyContracts,
  getFailureTypeStats,
  getTrendAnalysis,
  getSeverityDistribution,
  getLeaderboardStats
}
