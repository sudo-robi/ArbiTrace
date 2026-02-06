/**
 * Smart Gas Estimation Engine (Task 8)
 * Uses machine learning and historical data from pattern archive
 * to make intelligent gas limit recommendations
 * 
 * Features:
 * - Learn from contract history
 * - Contract-type detection
 * - Safe gas recommendations
 * - ML-ready feature matrix
 */

import Database from 'better-sqlite3';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Database reference (initialized by sessionManager)
let db;

/**
 * Initialize gas estimation engine
 */
export function initGasEstimation(database) {
  db = database;
  console.log('✅ Gas estimation engine initialized');
}

/**
 * Task 8.1: Analyze contract bytecode to detect type
 * Returns: contract type (ERC20, ERC721, DEX, Bridge, Custom, etc.)
 */
export function detectContractType(bytecode) {
  if (!bytecode) return 'UNKNOWN';

  // ERC20: transfer, approve, balanceOf signatures
  if (
    bytecode.includes('a9059cbb') && // transfer(address,uint256)
    bytecode.includes('095ea7b3') && // approve(address,uint256)
    bytecode.includes('70a08231')    // balanceOf(address)
  ) {
    return 'ERC20';
  }

  // ERC721: transferFrom, safeTransferFrom, ownerOf
  if (
    bytecode.includes('23b872dd') && // transferFrom
    bytecode.includes('42842e0e') && // safeTransferFrom
    bytecode.includes('6352211e')    // ownerOf
  ) {
    return 'ERC721';
  }

  // DEX: swap functions, router patterns
  if (
    bytecode.includes('38ed1739') || // swapExactTokensForTokens
    bytecode.includes('8803dbee')    // swapTokensForExactTokens
  ) {
    return 'DEX';
  }

  // Bridge: mint/burn patterns, cross-chain markers
  if (
    bytecode.includes('40c10f19') || // mint(address,uint256)
    bytecode.includes('42966c68')    // burn(uint256)
  ) {
    return 'BRIDGE';
  }

  return 'CUSTOM';
}

/**
 * Task 8.2: Get historical gas data for contract
 * Returns: array of {gasUsed, txType, success, timestamp}
 */
export function getContractGasHistory(contractAddress) {
  try {
    const stmt = db.prepare(`
      SELECT 
        gas_used,
        failure_type,
        created_at,
        parameters
      FROM failures 
      WHERE contract_address = ?
      ORDER BY created_at DESC
      LIMIT 100
    `);
    
    const results = stmt.all(contractAddress);
    
    return results.map(r => ({
      gasUsed: parseInt(r.gas_used) || 0,
      failureType: r.failure_type,
      timestamp: r.created_at,
      params: JSON.parse(r.parameters || '{}')
    }));
  } catch (error) {
    console.error('❌ Error getting gas history:', error.message);
    return [];
  }
}

/**
 * Task 8.3: Calculate statistical gas metrics
 * Returns: {min, max, avg, p25, p50, p75, p95, p99}
 */
export function calculateGasStatistics(gasHistory) {
  if (!gasHistory || gasHistory.length === 0) {
    return null;
  }

  // Extract just the gas values
  const gasValues = gasHistory
    .map(h => h.gasUsed)
    .filter(g => g > 0)
    .sort((a, b) => a - b);

  if (gasValues.length === 0) return null;

  const n = gasValues.length;
  const sum = gasValues.reduce((a, b) => a + b, 0);
  const avg = sum / n;

  // Percentiles
  const percentile = (p) => {
    const index = Math.ceil((p / 100) * n) - 1;
    return gasValues[Math.max(0, index)];
  };

  return {
    min: gasValues[0],
    max: gasValues[n - 1],
    avg: Math.round(avg),
    p25: percentile(25),
    p50: percentile(50),
    p75: percentile(75),
    p95: percentile(95),
    p99: percentile(99),
    samples: n
  };
}

/**
 * Task 8.4: Identify failed vs successful patterns
 * Returns: {failureRate, outOfGasRate, revertRate, timeLimitRate}
 */
export function analyzeFailurePatterns(gasHistory) {
  if (!gasHistory || gasHistory.length === 0) {
    return {
      failureRate: 0,
      outOfGasRate: 0,
      revertRate: 0,
      timeLimitRate: 0
    };
  }

  const total = gasHistory.length;
  const failures = gasHistory.filter(h => h.failureType !== 'SUCCESS');
  const outOfGas = gasHistory.filter(h => h.failureType === 'OUT_OF_GAS');
  const reverts = gasHistory.filter(h => h.failureType === 'REVERT');
  const timeouts = gasHistory.filter(h => h.failureType === 'TIME_LIMIT');

  return {
    failureRate: (failures.length / total) * 100,
    outOfGasRate: (outOfGas.length / total) * 100,
    revertRate: (reverts.length / total) * 100,
    timeLimitRate: (timeouts.length / total) * 100,
    sampleSize: total
  };
}

/**
 * Task 8.5: Get contract-type specific gas ranges
 * Based on Ethereum gas costs + buffer for retryables
 */
export function getContractTypeGasRanges(contractType) {
  const ranges = {
    ERC20: {
      transfer: { min: 60000, typical: 65000, safe: 75000, max: 100000 },
      approve: { min: 45000, typical: 50000, safe: 60000, max: 80000 },
      transferFrom: { min: 70000, typical: 80000, safe: 95000, max: 120000 }
    },
    ERC721: {
      mint: { min: 90000, typical: 120000, safe: 150000, max: 200000 },
      transfer: { min: 60000, typical: 80000, safe: 100000, max: 150000 },
      setApprovalForAll: { min: 45000, typical: 60000, safe: 75000, max: 100000 }
    },
    DEX: {
      swap: { min: 150000, typical: 250000, safe: 300000, max: 500000 },
      addLiquidity: { min: 200000, typical: 350000, safe: 450000, max: 600000 },
      removeLiquidity: { min: 150000, typical: 250000, safe: 350000, max: 500000 }
    },
    BRIDGE: {
      deposit: { min: 200000, typical: 300000, safe: 400000, max: 600000 },
      withdraw: { min: 200000, typical: 300000, safe: 400000, max: 600000 },
      mint: { min: 150000, typical: 250000, safe: 350000, max: 500000 }
    },
    CUSTOM: {
      generic: { min: 100000, typical: 150000, safe: 200000, max: 300000 }
    },
    UNKNOWN: {
      default: { min: 100000, typical: 150000, safe: 200000, max: 300000 }
    }
  };

  return ranges[contractType] || ranges.UNKNOWN;
}

/**
 * Task 8.6: Main gas estimation function
 * Combines multiple signals to make safe recommendation
 * 
 * Returns: {
 *   recommended: number,
 *   confidence: 'HIGH' | 'MEDIUM' | 'LOW',
 *   reasoning: string[],
 *   range: {min, max},
 *   factors: {...}
 * }
 */
export function estimateOptimalGas(options = {}) {
  const {
    contractAddress,
    contractType = 'UNKNOWN',
    bytecode = '',
    calldata = '',
    networkBaseFee = 1,
    gasUsedInFailure = null
  } = options;

  const reasoning = [];
  const factors = {};

  // Factor 1: Detect contract type if not provided
  if (!contractType || contractType === 'UNKNOWN') {
    const detected = detectContractType(bytecode);
    factors.detectedType = detected;
    reasoning.push(`Detected contract type: ${detected}`);
  } else {
    factors.detectedType = contractType;
  }

  // Factor 2: Get gas history from archive
  let gasRecommendation = null;
  let confidence = 'LOW';
  let confidence_score = 0;

  if (contractAddress) {
    const history = getContractGasHistory(contractAddress);
    const stats = calculateGasStatistics(history);
    const patterns = analyzeFailurePatterns(history);

    if (stats) {
      factors.historical = stats;
      confidence_score += 40; // History gives high confidence

      // Recommend based on statistics
      // Safe = P95 + 10% buffer (accounts for variance)
      gasRecommendation = Math.ceil(stats.p95 * 1.1);
      reasoning.push(`Historical P95: ${stats.p95} → Recommended: ${gasRecommendation}`);

      // Check failure patterns
      if (patterns.outOfGasRate > 10) {
        gasRecommendation = Math.ceil(gasRecommendation * 1.2);
        reasoning.push(`⚠️ OUT_OF_GAS failures detected (${patterns.outOfGasRate.toFixed(1)}%) - increasing recommendation by 20%`);
      }

      factors.failurePatterns = patterns;
    }
  }

  // Factor 3: Estimate from calldata length if no history
  if (!gasRecommendation) {
    const calldataLength = calldata.length / 2; // hex string to bytes
    const calldataGas = Math.ceil(calldataLength * 16); // 16 gas per byte
    const baseGas = 21000; // Transaction base cost
    const executionEstimate = baseGas + calldataGas + 50000; // Buffer for execution

    gasRecommendation = executionEstimate;
    confidence_score += 15; // Calldata analysis gives lower confidence
    reasoning.push(`Estimated from calldata: ${calldataLength} bytes → ${executionEstimate} gas`);

    factors.calldataGas = calldataGas;
  }

  // Factor 4: Contract type safe ranges
  const typeRanges = getContractTypeGasRanges(factors.detectedType);
  let typeRange = typeRanges.generic || typeRanges.default;

  if (calldata.includes('transfer') && typeRanges.transfer) {
    typeRange = typeRanges.transfer;
  } else if (calldata.includes('swap') && typeRanges.swap) {
    typeRange = typeRanges.swap;
  }

  factors.typeRange = typeRange;
  confidence_score += 25; // Type-based range gives moderate confidence

  // Ensure recommendation is within safe range
  const minGas = typeRange.min;
  const maxGas = typeRange.safe;

  if (gasRecommendation < minGas) {
    gasRecommendation = minGas;
    reasoning.push(`Increased to minimum safe for type: ${minGas}`);
  } else if (gasRecommendation > maxGas) {
    reasoning.push(`⚠️ Recommendation ${gasRecommendation} exceeds typical range ${maxGas} - check for loops`);
  }

  // Factor 5: If we saw an out-of-gas failure, use that as baseline
  if (gasUsedInFailure && gasUsedInFailure > 0) {
    const suggestedFromFailure = Math.ceil(gasUsedInFailure * 1.25); // Add 25% buffer
    gasRecommendation = Math.max(gasRecommendation, suggestedFromFailure);
    confidence_score += 20; // Failure data is very reliable
    reasoning.push(`Adjusted for previous OUT_OF_GAS: ${gasUsedInFailure} → ${suggestedFromFailure}`);
  }

  // Determine confidence level
  if (confidence_score >= 70) {
    confidence = 'HIGH';
  } else if (confidence_score >= 40) {
    confidence = 'MEDIUM';
  } else {
    confidence = 'LOW';
  }

  factors.confidenceScore = confidence_score;

  return {
    recommended: gasRecommendation,
    confidence,
    reasoning,
    range: {
      min: typeRange.min,
      typical: typeRange.typical,
      safe: typeRange.safe,
      max: typeRange.max
    },
    factors,
    algorithm_version: '1.0'
  };
}

/**
 * Task 8.7: Generate smart recommendations
 * Returns actionable advice to optimize gas
 */
export function getGasOptimizationTips(estimation) {
  const tips = [];

  if (estimation.factors.detectedType === 'UNKNOWN') {
    tips.push('💡 Unable to detect contract type - using conservative estimate');
  }

  if (estimation.confidence === 'LOW') {
    tips.push('⚠️ Low confidence - recommend testing with smaller amount first');
  }

  const { failurePatterns } = estimation.factors;
  if (failurePatterns) {
    if (failurePatterns.outOfGasRate > 20) {
      tips.push('🔥 High out-of-gas rate detected - consider batch operations or optimize contract');
    }
    if (failurePatterns.revertRate > 30) {
      tips.push('💥 High revert rate - check input validation and contract logic');
    }
  }

  if (estimation.reasoning.some(r => r.includes('loops'))) {
    tips.push('⚠️ Potential loop detected - may need dynamic gas adjustment');
  }

  return tips;
}

/**
 * Task 8.8: Export ML feature matrix for future training
 * Prepares data for machine learning pipeline
 */
export function buildMLFeatureMatrix(contractAddress) {
  try {
    const history = getContractGasHistory(contractAddress);
    const stats = calculateGasStatistics(history);
    const patterns = analyzeFailurePatterns(history);

    if (!stats) return null;

    // Build feature vector for ML models
    return {
      contractAddress,
      features: {
        // Statistical features
        avgGas: stats.avg,
        p95Gas: stats.p95,
        gasVariance: stats.max - stats.min,
        
        // Failure features
        failureRate: patterns.failureRate,
        outOfGasRate: patterns.outOfGasRate,
        revertRate: patterns.revertRate,
        
        // Pattern features
        historySize: stats.samples,
        recentFailures: history.filter(h => {
          const age = Date.now() - new Date(h.timestamp).getTime();
          return age < 7 * 24 * 60 * 60 * 1000; // Last 7 days
        }).length,
        
        // Derived features
        reliability: 1 - (patterns.failureRate / 100),
        volatility: stats.max / Math.max(stats.avg, 1)
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('❌ Error building ML features:', error.message);
    return null;
  }
}

export default {
  initGasEstimation,
  detectContractType,
  getContractGasHistory,
  calculateGasStatistics,
  analyzeFailurePatterns,
  getContractTypeGasRanges,
  estimateOptimalGas,
  getGasOptimizationTips,
  buildMLFeatureMatrix
};
