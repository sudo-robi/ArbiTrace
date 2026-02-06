/**
 * Cross-Chain Causality Analysis
 * Traces L1 parameters and their impact on L2 execution failures
 * Enables developers to understand: "Did my L2 tx fail because of L1?"
 */

export function analyzeCrossChainCausality(detection, retryable, l2Receipt, failureReason, failureMessage) {
  const causality = {
    chain: null,  // 'L1_CAUSED' | 'L2_CAUSED' | 'UNKNOWN'
    rootCause: null,  // human-readable root cause
    l1Params: {},  // L1 parameters that may have caused failure
    l2Impact: {},  // how those L1 params impacted L2 execution
    recommendations: [],
    causalityType: null  // 'PARAMETER_MISMATCH' | 'INSUFFICIENT_GAS' | 'LOW_SUBMISSION_COST' | 'LOGIC_ERROR' | 'UNKNOWN'
  }

  // If no L2 receipt, can't analyze causality yet
  if (!l2Receipt || l2Receipt.status !== 0) return causality

  // L2 execution failed. Check if L1 parameters are the culprit
  if (!retryable) return causality  // No retryable, can't trace causality

  try {
    const gasUsed = l2Receipt.gasUsed ? BigInt(l2Receipt.gasUsed) : null
    const gasLimit = l2Receipt.gasLimit ? BigInt(l2Receipt.gasLimit) : null
    const l1MaxGas = BigInt(retryable.gasLimit || '0')
    const l1GasPriceBid = BigInt(retryable.maxFeePerGas || '0')
    const l1SubmissionCost = BigInt(retryable.l2CallValue || '0')

    causality.l1Params = {
      maxGas: retryable.gasLimit,
      gasPriceBid: retryable.maxFeePerGas,
      submissionCost: retryable.l2CallValue,
      to: retryable.to,
      from: retryable.from,
      dataLength: retryable.data ? (retryable.data.length / 2 - 1) : 0
    }

    // ROOT CAUSE 1: Out of Gas on L2 (L1 maxGas too low)
    if (failureReason === 'OUT_OF_GAS') {
      causality.chain = 'L1_CAUSED'
      causality.causalityType = 'INSUFFICIENT_GAS'

      // Human-friendly numeric explanation
      try {
        const gasUsedStr = l2Receipt.gasUsed ? l2Receipt.gasUsed.toString() : 'N/A'
        const l1MaxStr = retryable.gasLimit || 'N/A'
        let suggestedMax = null
        let suggestedPct = null
        if (gasUsed && l1MaxGas && l1MaxGas > 0n) {
          const deficit = gasUsed - l1MaxGas
          // suggested max = actual gas used + 150k buffer
          suggestedMax = (gasUsed + 150000n).toString()
          // percent increase needed (rounded up)
          try {
            suggestedPct = Math.ceil((Number(deficit) / Number(l1MaxGas)) * 100)
          } catch (e) {
            suggestedPct = null
          }
        }

        causality.rootCause = suggestedPct !== null
          ? `Your retryable ticket likely failed because L1 maxGas was set to ${l1MaxStr}, but L2 execution consumed ${gasUsedStr} gas; increase maxGas by ~${suggestedPct}% (suggested: ${suggestedMax}).`
          : 'L1 maxGas parameter was insufficient for L2 execution'

        causality.l2Impact = {
          gasUsed: l2Receipt.gasUsed ? l2Receipt.gasUsed.toString() : 'N/A',
          gasLimit: l2Receipt.gasLimit ? l2Receipt.gasLimit.toString() : 'N/A',
          deficit: (gasUsed && l1MaxGas && gasUsed > l1MaxGas) ? (gasUsed - l1MaxGas).toString() : '0',
          explanation: 'Transaction ran out of gas before completion'
        }

        causality.recommendations.push({
          priority: 'CRITICAL',
          action: 'Increase L1 maxGas parameter',
          current: retryable.gasLimit,
          suggested: suggestedMax || String(Number(l1MaxGas) * 1.5),
          reasoning: suggestedPct !== null
            ? `Current maxGas (${l1MaxStr}) was too low relative to L2 consumption (${gasUsedStr}). Increase by ~${suggestedPct}% to cover execution plus buffer.`
            : 'Current maxGas appears insufficient. Increase maxGas to provide a safety buffer above observed L2 usage.'
        })

        causality.recommendations.push({
          priority: 'CRITICAL',
          action: 'Estimate actual gas needed (local run)',
          suggested: suggestedMax || String(Number(gasUsed) + 150000),
          reasoning: 'Run the same call locally on a fork or testnet to measure gas used, then add a ~150k buffer.'
        })
      } catch (e) {
        // fall back to conservative message
        causality.rootCause = 'L1 maxGas parameter insufficient for L2 execution'
      }
    }

    // ROOT CAUSE 2: Insufficient submission cost (L1 submissionCost too low)
    if (failureReason === 'LOW_SUBMISSION_COST') {
      causality.chain = 'L1_CAUSED'
      causality.causalityType = 'LOW_SUBMISSION_COST'

      try {
        const current = retryable.l2CallValue || '0'
        const suggested = l1SubmissionCost && l1SubmissionCost > 0n ? String(l1SubmissionCost * 2n) : String(Number(current) * 2)
        causality.rootCause = `Your retryable's L1 submission cost (l2CallValue=${current}) was too low for relayers to afford executing it on L2; increase submission cost (suggested: ${suggested}).`
        causality.l2Impact = {
          l1SubmissionCost: current,
          expectedCost: 'Depends on current L2 gas price',
          deficit: 'Relay could not afford to execute ticket'
        }
        causality.recommendations.push({
          priority: 'CRITICAL',
          action: 'Increase L1 submissionCost (l2CallValue)',
          current: current,
          suggested: suggested,
          reasoning: `Relayers evaluate on-chain submission cost vs expected L2 gas; increasing l2CallValue makes auto-redeem economically viable.`
        })
        causality.recommendations.push({
          priority: 'HIGH',
          action: 'Check current L2 gas prices',
          reasoning: 'High L2 gas prices increase cost to relay the ticket — verify and adjust submissionCost accordingly.'
        })
      } catch (e) {
        causality.rootCause = 'L1 submissionCost insufficient for auto-redeem relay fee'
      }
    }

    // ROOT CAUSE 3: Logic error / revert reason (L2 logic, not L1 params)
    if (failureReason === 'LOGIC_REVERT') {
      causality.chain = 'L2_CAUSED'  // L2 logic error, not L1 parameters
      causality.causalityType = 'LOGIC_ERROR'
      causality.rootCause = 'L2 contract execution reverted due to logic error or invalid input'
      causality.l2Impact = {
        revertReason: failureMessage || 'Unknown revert reason',
        instruction: 'Contract rejected the transaction at execution time',
        possibleReasons: [
          'Input validation failed (recipient, amount, permissions)',
          'Contract state condition not met (insufficient balance, locked, paused)',
          'Called function does not exist or is restricted',
          'Reentrancy guard triggered'
        ]
      }
      causality.recommendations.push({
        priority: 'HIGH',
        action: 'Review L2 contract logic',
        reasoning: failureMessage ? 'Revert reason: "' + failureMessage + '"' : 'Contract execution failed'
      })
      causality.recommendations.push({
        priority: 'HIGH',
        action: 'Verify L1 calldata',
        reasoning: 'Ensure L1 encoded parameters match L2 contract expectations'
      })
      causality.recommendations.push({
        priority: 'MEDIUM',
        action: 'Check contract preconditions',
        reasoning: 'Verify contract state allows the operation (e.g., not paused, sufficient funds)'
      })
    }

    // ROOT CAUSE 4: L1 parameters too close to actual L2 requirements
    if (l1MaxGas > 0n && gasLimit > 0n && gasUsed > 0n) {
      const utilization = Number(gasUsed) / Number(l1MaxGas)
      if (utilization > 0.95 && failureReason === 'UNKNOWN') {
        causality.chain = 'L1_CAUSED'
        causality.causalityType = 'PARAMETER_MISMATCH'
        causality.rootCause = 'L1 maxGas set too close to actual L2 execution needs (no safety margin)'
        causality.l2Impact = {
          gasUtilization: (utilization * 100).toFixed(1) + '%',
          explanation: 'Transaction consumed ' + (utilization * 100).toFixed(1) + '% of available gas, indicating marginal safety'
        }
        causality.recommendations.push({
          priority: 'MEDIUM',
          action: 'Increase L1 maxGas safety margin',
          current: retryable.gasLimit,
          suggested: String(Number(l1MaxGas) * 1.3),
          reasoning: 'Current usage is ' + (utilization * 100).toFixed(1) + '%. Target 70-80% utilization for safety margin.'
        })
      }
    }

  } catch (e) {
    // Causality analysis failed, return empty
  }

  // Provide a concise humanMessage for frontend consumption
  causality.humanMessage = causality.rootCause || null

  return causality
}


/**
 * Build causal graph showing L1 tx → retryable → L2 tx
 * This is the "cross-chain causality" that most explorers are missing
 */
export function computeCausalGraph(detection, retryables, l2Receipt) {
  const graph = {
    l1Submission: {
      txHash: detection.l1Receipt ? detection.l1Receipt.transactionHash : null,
      blockNumber: detection.l1Receipt ? detection.l1Receipt.blockNumber : null,
      status: detection.l1Receipt ? (detection.l1Receipt.status === 1 ? 'confirmed' : 'reverted') : null,
      gasUsed: detection.l1Receipt ? (detection.l1Receipt.gasUsed ? detection.l1Receipt.gasUsed.toString() : null) : null
    },

    retryableCreation: retryables.length > 0 ? {
      ticketId: retryables[0].ticketId,
      from: retryables[0].from,
      to: retryables[0].to,
      createdInL1Tx: retryables[0].transactionHash,
      createdInL1Block: retryables[0].blockNumber,
      parameters: {
        maxGas: retryables[0].gasLimit,
        gasPriceBid: retryables[0].maxFeePerGas,
        submissionCost: retryables[0].l2CallValue,
        calldata: retryables[0].data ? retryables[0].data.slice(0, 100) + '...' : '(empty)'
      }
    } : null,

    l2Execution: {
      txHash: detection.l2Receipt ? detection.l2Receipt.transactionHash : null,
      blockNumber: detection.l2Receipt ? detection.l2Receipt.blockNumber : null,
      status: detection.l2Receipt ? (detection.l2Receipt.status === 1 ? 'confirmed' : 'reverted') : null,
      gasUsed: detection.l2Receipt ? (detection.l2Receipt.gasUsed ? detection.l2Receipt.gasUsed.toString() : null) : null,
      from: detection.l2Receipt ? detection.l2Receipt.from : null,
      to: detection.l2Receipt ? detection.l2Receipt.to : null
    },

    causalChain: {
      step1: '1️⃣ L1 Transaction Submitted',
      step1Link: detection.l1Receipt ? detection.l1Receipt.transactionHash : 'N/A',
      step1Description: 'User submits transaction on Ethereum L1 calling Inbox contract',

      step2: '2️⃣ RetryableTicketCreated Event',
      step2Link: retryables.length > 0 ? 'Ticket ID: ' + retryables[0].ticketId : 'No ticket',
      step2Description: 'L1 transaction emits event with ticket ID and execution parameters',

      step3: '3️⃣ Arbitrum Relay Processes',
      step3Link: '(automatic)',
      step3Description: 'Arbitrum sequencer relays ticket execution to L2 after ~10 minutes',

      step4: '4️⃣ L2 Execution Result',
      step4Link: detection.l2Receipt ? detection.l2Receipt.transactionHash : 'N/A',
      step4Description: detection.l2Receipt ? (detection.l2Receipt.status === 1 ? '✅ Success' : '❌ Revert') : 'Pending or not found'
    },

    // New: explicit causality analysis
    causality: {
      question: 'Did my L2 tx fail because of something on L1?',
      answer: 'See "crossChainCausality" field in response for detailed analysis'
    }
  }
  return graph
}
