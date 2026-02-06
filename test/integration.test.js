/**
 * Integration tests for ArbiTrace /analyze endpoint
 * Tests failure attribution, lifecycle detection, and edge cases
 */

import { strict as assert } from 'assert'

const API_BASE = process.env.API_BASE || 'http://localhost:3000'

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
    return true
  } catch (err) {
    console.error(`❌ ${name}`)
    console.error(`   Error: ${err.message}`)
    return false
  }
}

async function runAnalyze(txHash) {
  const res = await fetch(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

// Test suite
async function runTests() {
  console.log('🧪 ArbiTrace Integration Tests\n')
  
  let passed = 0, failed = 0

  // Test 1: /analyze returns structured failure attribution
  if (await test('Response includes failureAt and failureReason fields', async () => {
    const data = await runAnalyze('0x0000000000000000000000000000000000000000000000000000000000000000')
    assert(typeof data.failureAt === 'string', 'failureAt is string')
    assert(typeof data.failureReason === 'string', 'failureReason is string')
  })) passed++; else failed++

  // Test 2: Response includes timeline with actions
  if (await test('Timeline contains actions array with failure classification', async () => {
    const data = await runAnalyze('0x0000000000000000000000000000000000000000000000000000000000000000')
    assert(Array.isArray(data.timeline.actions), 'timeline.actions is array')
    assert(Array.isArray(data.timeline.failureClassification), 'timeline.failureClassification is array')
  })) passed++; else failed++

  // Test 3: failureAt is one of expected values
  if (await test('failureAt is one of expected enum values', async () => {
    const data = await runAnalyze('0x0000000000000000000000000000000000000000000000000000000000000000')
    const valid = ['L1_SUBMISSION', 'RETRYABLE_CREATION', 'AUTO_REDEEM', 'MANUAL_REDEEM', 'L2_EXECUTION', 'UNKNOWN']
    assert(valid.includes(data.failureAt), `failureAt is valid: ${data.failureAt}`)
  })) passed++; else failed++

  // Test 4: failureReason is one of expected values
  if (await test('failureReason is one of expected enum values', async () => {
    const data = await runAnalyze('0x0000000000000000000000000000000000000000000000000000000000000000')
    const valid = ['OUT_OF_GAS', 'LOGIC_REVERT', 'TIMEOUT', 'LOW_SUBMISSION_COST', 'LOW_GAS_LIMIT', 'UNKNOWN']
    assert(valid.includes(data.failureReason), `failureReason is valid: ${data.failureReason}`)
  })) passed++; else failed++

  // Test 5: rawData contains L1/L2 receipts or null
  if (await test('rawData structure is present with receipt info', async () => {
    const data = await runAnalyze('0x0000000000000000000000000000000000000000000000000000000000000000')
    assert(data.rawData, 'rawData exists')
    assert(data.rawData.l1Receipt === null || typeof data.rawData.l1Receipt === 'object', 'l1Receipt is null or object')
    assert(data.rawData.l2Receipt === null || typeof data.rawData.l2Receipt === 'object', 'l2Receipt is null or object')
  })) passed++; else failed++

  // Test 6: failureMessage is optional but valid when present
  if (await test('failureMessage is optional string when present', async () => {
    const data = await runAnalyze('0x0000000000000000000000000000000000000000000000000000000000000000')
    if (data.failureMessage !== null && data.failureMessage !== undefined) {
      assert(typeof data.failureMessage === 'string', 'failureMessage is string when present')
    }
  })) passed++; else failed++

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

// Run tests
runTests().catch(err => {
  console.error('Test harness error:', err)
  process.exit(1)
})
