/**
 * Pre-Submission Validator
 * 
 * Predicts whether a retryable submission will succeed BEFORE the user submits it.
 * Takes proposed parameters and returns:
 * - Success probability (0-100%)
 * - Risk factors identified
 * - Specific suggestions to increase success
 * 
 * Uses:
 * - Pattern archive historical data
 * - Network conditions (base fee trends)
 * - Contract complexity heuristics
 */

import { getFailurePattern, getArchiveStats } from './patternArchive.js'
import { computeL2BaseFeeAverage } from './arbitrum.js'

/**
 * Validate retryable parameters and predict success
 * 
 * @param {Object} params - Proposed retryable parameters
 * @returns {Object} Validation result with success probability
 */
export async function validatePreSubmission(params) {
  const {
    contractAddress,
    contractBytecodeHash,
    gasLimit,
    maxFeePerGas,
    submissionCost,
    callDataLength = 0,
    functionName = 'unknown'
  } = params

  const result = {
    successProbability: 75, // Start optimistic
    risks: [],
    suggestions: [],
    factors: {},
    warnings: [],
    networkConditions: null
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════════════
    // FACTOR 1: Contract History Analysis
    // ═══════════════════════════════════════════════════════════════════════════════
    
    if (contractBytecodeHash) {
      const pattern = getFailurePattern(contractBytecodeHash)
      if (pattern && pattern.total_failures > 0) {
        // This contract has failure history - adjust probability
        const successRate = 1 - (pattern.total_failures / (pattern.total_failures + 50)) // normalize
        const baseFailureRate = 100 - (successRate * 100)
        result.factors.contractHistoricalFailureRate = baseFailureRate.toFixed(1) + '%'
        
        result.successProbability -= Math.min(30, baseFailureRate / 2) // Max -30 points
        
        // Add specific risk from pattern distribution
        if (pattern.distribution) {
          if (pattern.distribution.lowGasLimit > 50) {
            result.risks.push({
              type: 'LOW_GAS_LIMIT_PATTERN',
              severity: 'critical',
              message: `This contract fails LOW_GAS_LIMIT ${pattern.distribution.lowGasLimit}% of the time`,
              dataPoint: pattern.distribution.lowGasLimit + '%'
            })
          }
          if (pattern.distribution.lowGasPrice > 50) {
            result.risks.push({
              type: 'LOW_GAS_PRICE_PATTERN',
              severity: 'warning',
              message: `This contract fails LOW_GAS_PRICE ${pattern.distribution.lowGasPrice}% of the time`,
              dataPoint: pattern.distribution.lowGasPrice + '%'
            })
          }
          if (pattern.distribution.logicRevert > 40) {
            result.risks.push({
              type: 'LOGIC_REVERT_PATTERN',
              severity: 'info',
              message: `This contract has logic reverts in ${pattern.distribution.logicRevert}% of failures`,
              dataPoint: pattern.distribution.logicRevert + '%'
            })
          }
        }
        
        // Risk score incorporation
        if (pattern.risk_score && pattern.risk_score > 70) {
          result.risks.push({
            type: 'HIGH_RISK_CONTRACT',
            severity: 'critical',
            message: `This contract has HIGH RISK score (${pattern.risk_score}/100). Design issues detected.`,
            dataPoint: pattern.risk_score + '/100'
          })
          result.successProbability -= 20
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FACTOR 2: Gas Limit Analysis
    // ═══════════════════════════════════════════════════════════════════════════════
    
    const gasLimitNum = parseInt(gasLimit)
    result.factors.gasLimit = gasLimitNum
    
    if (gasLimitNum < 50000) {
      result.risks.push({
        type: 'CRITICALLY_LOW_GAS_LIMIT',
        severity: 'critical',
        message: `Gas limit ${gasLimitNum} is too low. Minimum recommended: 75,000`,
        dataPoint: gasLimitNum
      })
      result.successProbability -= 40
      result.suggestions.push({
        type: 'INCREASE_GAS_LIMIT',
        current: gasLimitNum,
        suggested: 75000,
        reasoning: 'Very low gas limits almost always fail. 75k-150k is typical for standard calls.'
      })
    } else if (gasLimitNum < 75000) {
      result.risks.push({
        type: 'LOW_GAS_LIMIT',
        severity: 'warning',
        message: `Gas limit ${gasLimitNum} is below typical range (75k-150k)`,
        dataPoint: gasLimitNum
      })
      result.successProbability -= 15
      result.suggestions.push({
        type: 'INCREASE_GAS_LIMIT',
        current: gasLimitNum,
        suggested: 100000,
        reasoning: 'Many contracts need 90k+ gas. Consider 100k for safety.'
      })
    } else if (gasLimitNum > 1000000) {
      result.warnings.push('Gas limit is very high - you may be overpaying')
    }

    // Estimate gas from calldata length (rough heuristic)
    const estimatedGasFromCalldata = Math.max(21000, callDataLength * 16) // 16 gas per byte
    if (gasLimitNum < estimatedGasFromCalldata + 50000) {
      result.risks.push({
        type: 'GAS_LIMIT_VS_CALLDATA_MISMATCH',
        severity: 'warning',
        message: `Gas limit (${gasLimitNum}) may not cover calldata (est: ${estimatedGasFromCalldata}) + execution`,
        dataPoint: `${gasLimitNum} vs ${estimatedGasFromCalldata}`
      })
      result.successProbability -= 10
      result.suggestions.push({
        type: 'INCREASE_GAS_LIMIT_FOR_CALLDATA',
        current: gasLimitNum,
        suggested: estimatedGasFromCalldata + 80000,
        reasoning: `Calldata is ${callDataLength} bytes (≈${estimatedGasFromCalldata} gas). Add 80k for execution.`
      })
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FACTOR 3: Max Fee Per Gas Analysis
    // ═══════════════════════════════════════════════════════════════════════════════
    
    const maxFeePerGasNum = parseInt(maxFeePerGas)
    result.factors.maxFeePerGas = maxFeePerGasNum
    
    // Get current network conditions
    try {
      const currentBaseFee = await computeL2BaseFeeAverage(10)
      if (currentBaseFee) {
        result.networkConditions = {
          avgBaseFeePerGas: currentBaseFee.toString(),
          timestamp: new Date().toISOString()
        }
        
        const currentBaseFeeNum = BigInt(currentBaseFee)
        const userFee = BigInt(maxFeePerGasNum)
        
        // Check if fee is sufficient (should be at least equal to base fee)
        if (userFee < currentBaseFeeNum) {
          result.risks.push({
            type: 'INSUFFICIENT_MAX_FEE',
            severity: 'critical',
            message: `Max fee (${maxFeePerGasNum}) is BELOW current base fee (${currentBaseFeeNum.toString()}). Will definitely fail auto-redeem.`,
            dataPoint: `User: ${maxFeePerGasNum}, Base: ${currentBaseFeeNum.toString()}`
          })
          result.successProbability -= 50
          result.suggestions.push({
            type: 'INCREASE_MAX_FEE_PER_GAS',
            current: maxFeePerGasNum,
            suggested: Math.ceil(Number(currentBaseFeeNum) * 1.3),
            reasoning: `Current base fee is ${currentBaseFeeNum.toString()}. Use at least +30% buffer.`
          })
        } else if (userFee < currentBaseFeeNum * 12n / 10n) {
          // Less than 20% above base fee
          result.risks.push({
            type: 'LOW_MAX_FEE_BUFFER',
            severity: 'warning',
            message: `Max fee has low buffer above base fee (${Math.round(Number((userFee / currentBaseFeeNum - 1n) * 100n))}% buffer)`,
            dataPoint: `Buffer: ${Math.round(Number((userFee / currentBaseFeeNum - 1n) * 100n))}%`
          })
          result.successProbability -= 10
          result.suggestions.push({
            type: 'INCREASE_MAX_FEE_BUFFER',
            current: maxFeePerGasNum,
            suggested: Math.ceil(Number(currentBaseFeeNum) * 1.5),
            reasoning: 'Gas prices are volatile. Keep 50% buffer above current base fee for safety.'
          })
        } else {
          result.factors.maxFeeStatus = 'GOOD'
          result.successProbability += 10 // Bonus for good fee
        }
      }
    } catch (e) {
      result.warnings.push(`Could not check current network conditions: ${e.message}`)
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FACTOR 4: Submission Cost Analysis
    // ═══════════════════════════════════════════════════════════════════════════════
    
    const submissionCostNum = parseInt(submissionCost)
    result.factors.submissionCost = submissionCostNum
    
    if (submissionCostNum < 100) {
      result.risks.push({
        type: 'CRITICALLY_LOW_SUBMISSION_COST',
        severity: 'critical',
        message: `Submission cost ${submissionCostNum} Wei is too low. Minimum: 1000 Wei`,
        dataPoint: submissionCostNum
      })
      result.successProbability -= 45
      result.suggestions.push({
        type: 'INCREASE_SUBMISSION_COST',
        current: submissionCostNum,
        suggested: 10000,
        reasoning: 'Submission cost must exceed base fee for auto-redeem. Use 10k+ Wei.'
      })
    } else if (submissionCostNum < 1000) {
      result.risks.push({
        type: 'LOW_SUBMISSION_COST',
        severity: 'warning',
        message: `Submission cost ${submissionCostNum} may be insufficient for auto-redeem`,
        dataPoint: submissionCostNum
      })
      result.successProbability -= 20
      result.suggestions.push({
        type: 'INCREASE_SUBMISSION_COST',
        current: submissionCostNum,
        suggested: 5000,
        reasoning: 'Increase to ensure auto-redeem succeeds without requiring manual redemption.'
      })
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FACTOR 5: Parameter Consistency
    // ═══════════════════════════════════════════════════════════════════════════════
    
    // Check for obviously mismatched parameters
    const totalGasCost = gasLimitNum * maxFeePerGasNum
    if (totalGasCost > 1e18) {
      result.warnings.push(`Gas cost is extremely high (${totalGasCost} Wei). Double-check parameters.`)
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FACTOR 6: Archive-wide Statistics
    // ═══════════════════════════════════════════════════════════════════════════════
    
    try {
      const archiveStats = getArchiveStats()
      if (archiveStats) {
        const globalSuccessRate = archiveStats.total_failures > 0 
          ? Math.round((1 - (archiveStats.total_failures / (archiveStats.total_failures + 100))) * 100)
          : 80
        
        result.factors.globalSuccessRate = globalSuccessRate + '%'
        
        // Adjust based on global stats if no contract-specific data
        if (!contractBytecodeHash || !getFailurePattern(contractBytecodeHash)) {
          result.successProbability = (result.successProbability + globalSuccessRate) / 2
        }
      }
    } catch (e) {
      // Archive empty or not initialized
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FINAL PROBABILITY CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════════
    
    // Clamp to 0-100
    result.successProbability = Math.max(0, Math.min(100, Math.round(result.successProbability)))

    // Determine confidence level
    if (result.risks.filter(r => r.severity === 'critical').length > 0) {
      result.confidence = 'LOW'
      result.recommendation = 'CRITICAL ISSUES: Fix these before submitting'
    } else if (result.risks.filter(r => r.severity === 'warning').length > 2) {
      result.confidence = 'MEDIUM'
      result.recommendation = 'MULTIPLE WARNINGS: Consider the suggested changes'
    } else if (result.risks.length === 0) {
      result.confidence = 'HIGH'
      result.recommendation = 'Parameters look good. Ready to submit.'
    } else {
      result.confidence = 'MEDIUM'
      result.recommendation = 'Some warnings detected. Review suggestions.'
    }

    // Add scoring breakdown
    result.scoreBreakdown = {
      baseScore: 75,
      contractHistoryAdjustment: (result.factors.contractHistoricalFailureRate ? -Math.min(30, parseFloat(result.factors.contractHistoricalFailureRate)) / 2 : 0),
      gasLimitAdjustment: calculateGasAdjustment(gasLimitNum),
      feeAdjustment: (result.factors.maxFeeStatus === 'GOOD' ? 10 : -15),
      submissionCostAdjustment: calculateSubmissionCostAdjustment(submissionCostNum),
      finalScore: result.successProbability
    }

  } catch (e) {
    console.error('Error in pre-submission validation:', e)
    result.error = e.message
    result.successProbability = 50 // Unknown state = medium probability
  }

  return result
}

/**
 * Estimate ideal gas limit for a transaction
 * 
 * Uses calldata length + function complexity heuristics
 * 
 * @param {Object} params - {callDataLength, contractType}
 * @returns {Object} Gas estimation with ranges
 */
export function estimateGasLimit(params) {
  const { callDataLength = 0, contractType = 'generic', isSafeMint = false } = params

  // Base gas costs
  const baseCost = 21000 // Standard tx
  const calldataCost = callDataLength * 16 // 16 gas per byte
  const executionCost = (() => {
    switch (contractType) {
      case 'erc20_transfer': return 25000
      case 'erc20_mint': return 45000
      case 'erc721_mint': return isSafeMint ? 75000 : 60000
      case 'uniswap_swap': return 120000
      case 'bridge': return 200000
      case 'staking': return 150000
      default: return 50000 // Generic contract execution
    }
  })()

  const estimatedMin = baseCost + calldataCost + executionCost
  const recommendedSafe = Math.ceil(estimatedMin * 1.3) // 30% buffer
  const conservativeMax = Math.ceil(estimatedMin * 1.5) // 50% buffer

  return {
    estimated: estimatedMin,
    recommended: recommendedSafe,
    conservative: conservativeMax,
    breakdown: {
      base: baseCost,
      calldata: calldataCost,
      execution: executionCost
    }
  }
}

/**
 * Helper: Calculate gas limit adjustment to success probability
 */
function calculateGasAdjustment(gasLimit) {
  if (gasLimit < 50000) return -40
  if (gasLimit < 75000) return -15
  if (gasLimit > 1000000) return -5
  return 5 // Good range
}

/**
 * Helper: Calculate submission cost adjustment
 */
function calculateSubmissionCostAdjustment(cost) {
  if (cost < 100) return -45
  if (cost < 1000) return -20
  return 5 // Good
}

/**
 * Get recommendations for improvement
 * 
 * @param {Object} validationResult - Result from validatePreSubmission
 * @returns {Array} Array of actionable suggestions
 */
export function getDetailedRecommendations(validationResult) {
  const recommendations = []

  // Critical fixes first
  const criticalRisks = validationResult.risks.filter(r => r.severity === 'critical')
  if (criticalRisks.length > 0) {
    recommendations.push({
      priority: 'CRITICAL',
      title: 'Critical Issues Must Be Fixed',
      items: criticalRisks.map(r => ({
        issue: r.message,
        fix: findMatchingSuggestion(validationResult.suggestions, r.type)
      }))
    })
  }

  // Warnings
  const warnings = validationResult.risks.filter(r => r.severity === 'warning')
  if (warnings.length > 0) {
    recommendations.push({
      priority: 'WARNING',
      title: 'Recommended Improvements',
      items: warnings.map(w => ({
        issue: w.message,
        fix: findMatchingSuggestion(validationResult.suggestions, w.type)
      }))
    })
  }

  // All suggestions
  if (validationResult.suggestions.length > 0) {
    recommendations.push({
      priority: 'SUGGESTIONS',
      title: 'Parameter Adjustments',
      items: validationResult.suggestions.map(s => ({
        type: s.type,
        current: s.current,
        suggested: s.suggested,
        reasoning: s.reasoning
      }))
    })
  }

  return recommendations
}

function findMatchingSuggestion(suggestions, riskType) {
  const mapping = {
    'LOW_GAS_LIMIT': 'INCREASE_GAS_LIMIT',
    'CRITICALLY_LOW_GAS_LIMIT': 'INCREASE_GAS_LIMIT',
    'LOW_SUBMISSION_COST': 'INCREASE_SUBMISSION_COST',
    'CRITICALLY_LOW_SUBMISSION_COST': 'INCREASE_SUBMISSION_COST',
    'INSUFFICIENT_MAX_FEE': 'INCREASE_MAX_FEE_PER_GAS'
  }
  const suggestType = mapping[riskType]
  return suggestions.find(s => s.type === suggestType) || null
}

export default {
  validatePreSubmission,
  estimateGasLimit,
  getDetailedRecommendations
}
