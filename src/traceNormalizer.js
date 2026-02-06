/**
 * Trace Normalization Engine
 * Converts raw L1/L2 receipts and logs into a linear action graph.
 * Output format:
 * [
 *   { id, timestamp, action, status, details },
 *   ...
 * ]
 */
export function normalizeTrace(detection, retryables, l2TraceInfo) {
  const actions = []
  let actionId = 1
  const tsToIso = (ts) => {
    try {
      if (!ts) return new Date().toISOString()
      // provider.getBlock().timestamp is in seconds
      return new Date(Number(ts) * 1000).toISOString()
    } catch (e) {
      return new Date().toISOString()
    }
  }

  // Action 1: L1 Transaction Submitted
  if (detection.l1Receipt) {
    actions.push({
      id: actionId++,
      timestamp: detection.l1Receipt.blockTimestamp ? tsToIso(detection.l1Receipt.blockTimestamp) : new Date().toISOString(),
      action: 'L1_TX_SUBMITTED',
      status: detection.l1Receipt.status === 1 ? 'confirmed' : 'failed',
      details: {
        txHash: detection.l1Receipt.transactionHash,
        blockNumber: detection.l1Receipt.blockNumber,
        gasUsed: detection.l1Receipt.gasUsed ? detection.l1Receipt.gasUsed.toString() : '0'
      }
    })
  }

  // Action 2: Retryable Ticket Created
  if (retryables && retryables.length > 0) {
    const retryable = retryables[0]
    actions.push({
      id: actionId++,
      timestamp: detection.l1Receipt && detection.l1Receipt.blockTimestamp ? tsToIso(detection.l1Receipt.blockTimestamp) : new Date().toISOString(),
      action: 'RETRYABLE_CREATED',
      status: 'confirmed',
      details: {
        ticketId: retryable.ticketId,
        from: retryable.from,
        to: retryable.to,
        maxGas: retryable.gasLimit,
        gasPriceBid: retryable.maxFeePerGas,
        submissionCost: retryable.l2CallValue,
        dataSize: retryable.data ? (retryable.data.length / 2 - 1).toString() : '0' // bytes
      }
    })

    // Action 3: Auto-Redeem Attempt (inferred)
    actions.push({
      id: actionId++,
      timestamp: detection.l1Receipt && detection.l1Receipt.blockTimestamp ? tsToIso(detection.l1Receipt.blockTimestamp) : new Date().toISOString(),
      action: 'AUTO_REDEEM_ATTEMPT',
      status: 'unknown', // Would need to parse Arbitrum logs to determine
      details: {
        ticketId: retryable.ticketId,
        reason: 'Retryable auto-redeem occurs within ~1 hour of creation'
      }
    })
  }

  // Action 4: L2 Execution
  if (detection.l2Receipt) {
    actions.push({
      id: actionId++,
      timestamp: detection.l2Receipt.blockTimestamp ? tsToIso(detection.l2Receipt.blockTimestamp) : new Date().toISOString(),
      action: 'L2_EXECUTION',
      status: detection.l2Receipt.status === 1 ? 'confirmed' : 'failed',
      details: {
        txHash: detection.l2Receipt.transactionHash,
        blockNumber: detection.l2Receipt.blockNumber,
        gasUsed: detection.l2Receipt.gasUsed ? detection.l2Receipt.gasUsed.toString() : '0',
        to: detection.l2Receipt.to,
        from: detection.l2Receipt.from
      }
    })
  }

  // Action 5: Failure Node (if applicable)
  if (
    (detection.l1Receipt && detection.l1Receipt.status === 0) ||
    (detection.l2Receipt && detection.l2Receipt.status === 0)
  ) {
    actions.push({
      id: actionId++,
      timestamp: (detection.l2Receipt && detection.l2Receipt.blockTimestamp) ? tsToIso(detection.l2Receipt.blockTimestamp) : (detection.l1Receipt && detection.l1Receipt.blockTimestamp ? tsToIso(detection.l1Receipt.blockTimestamp) : new Date().toISOString()),
      action: 'FAILURE',
      status: 'failed',
      details: {
        location: detection.l1Receipt && detection.l1Receipt.status === 0 ? 'L1' : 'L2',
        reason: detection.l1Receipt && detection.l1Receipt.status === 0
          ? 'L1 transaction reverted'
          : 'L2 execution reverted'
      }
    })
  }

  return actions
}

/**
 * Convert action graph to timeline with visual metadata.
 */
export function buildTimeline(actions, failureClassification) {
  return {
    actions: actions.map((action, idx) => ({
      ...action,
      isTerminal: idx === actions.length - 1,
      color: colorForStatus(action.status)
    })),
    failureClassification: failureClassification,
    summary: {
      totalSteps: actions.length,
      successCount: actions.filter((a) => a.status === 'confirmed').length,
      failureCount: actions.filter((a) => a.status === 'failed').length
    }
  }
}

function colorForStatus(status) {
  switch (status) {
    case 'confirmed':
      return '#10b981' // green
    case 'failed':
      return '#ef4444' // red
    case 'pending':
      return '#eab308' // yellow
    default:
      return '#6b7280' // gray
  }
}
