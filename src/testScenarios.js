/**
 * Demo & Test Scenarios
 * Known failed Arbitrum transactions for validation
 */

// Common test scenarios for Arbitrum Debugger MVP

export const TEST_SCENARIOS = {
  // Scenario 1: Low gas limit on retryable (common failure)
  LOW_GAS_EXAMPLE: {
    description: 'Retryable with insufficient maxGas - auto-redeem fails',
    l1TxHash: null, // Will be filled with real example
    expectedFailures: ['LOW_GAS_LIMIT', 'AUTO_REDEEM_ATTEMPT'],
    expectedTimeline: ['L1_TX_SUBMITTED', 'RETRYABLE_CREATED', 'AUTO_REDEEM_ATTEMPT', 'FAILURE']
  },

  // Scenario 2: Low submission cost (insufficient L2 gas price bid)
  LOW_SUBMISSION_COST_EXAMPLE: {
    description: 'Retryable with insufficient submission cost',
    l1TxHash: null,
    expectedFailures: ['LOW_SUBMISSION_COST'],
    expectedTimeline: ['L1_TX_SUBMITTED', 'RETRYABLE_CREATED', 'FAILURE']
  },

  // Scenario 3: L2 contract revert (calldata issue or logic error)
  L2_REVERT_EXAMPLE: {
    description: 'L2 execution reverted due to contract logic',
    l2TxHash: null,
    expectedFailures: ['L2_REVERT'],
    expectedTimeline: ['L2_EXECUTION', 'FAILURE']
  },

  // Scenario 4: Stylus WASM panic (if available)
  STYLUS_PANIC_EXAMPLE: {
    description: 'WASM contract panic - assertion or arithmetic error',
    l2TxHash: null,
    expectedFailures: ['WASM_PANIC'],
    expectedTimeline: ['STYLUS_WASM_EXECUTION', 'FAILURE']
  }
}

/**
 * Sample transaction hashes for testing (from public Arbitrum mainnet).
 * These are publicly available failed transactions for demo purposes.
 * 
 * To use: Uncomment a tx hash and run:
 *   curl -X POST http://localhost:3000/analyze \
 *     -H "Content-Type: application/json" \
 *     -d '{"txHash":"0x..."}'
 */

export const KNOWN_TEST_TXS = {
  // Real-world example: A tx that likely has low gas or submission cost issues
  // (This would need to be a real tx from Arbiscan with visible failure)
  arbiscan_failed_retryable: '0x', // Placeholder - find a real one

  // Generic revert example
  arbiscan_l2_revert: '0x', // Placeholder

  // Demo: You can test with any recent Arbitrum tx hash from https://arbiscan.io/
  // Filter: Status = Failed
  // Then paste the tx hash into the frontend at http://localhost:3000
}

/**
 * Validate test results against expected behavior.
 */
export function validateTestResult(response, scenario) {
  const results = {
    passed: true,
    checks: []
  }

  // Check 1: Timeline has expected actions
  const actualActions = response.timeline.actions.map((a) => a.action)
  const expectedActions = scenario.expectedTimeline || []
  const hasExpectedActions = expectedActions.every((exp) => actualActions.some((act) => act.includes(exp)))

  results.checks.push({
    name: 'Timeline contains expected actions',
    passed: hasExpectedActions,
    expected: expectedActions,
    actual: actualActions
  })

  // Check 2: Failures are classified correctly
  const actualFailureTypes = response.timeline.failureClassification.map((f) => f.type)
  const expectedFailureTypes = scenario.expectedFailures || []
  const hasExpectedFailures = expectedFailureTypes.some((exp) =>
    actualFailureTypes.some((act) => act.includes(exp))
  )

  results.checks.push({
    name: 'Expected failures detected',
    passed: hasExpectedFailures,
    expected: expectedFailureTypes,
    actual: actualFailureTypes
  })

  // Check 3: Timeline is non-empty
  results.checks.push({
    name: 'Timeline not empty',
    passed: response.timeline.actions.length > 0,
    actual: response.timeline.actions.length
  })

  // Overall result
  results.passed = results.checks.every((c) => c.passed)
  return results
}
