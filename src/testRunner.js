#!/usr/bin/env node

/**
 * CLI Test Runner for Arbitrum Debugger MVP
 * 
 * Usage:
 *   node src/testRunner.js <txHash> [--scenario <name>]
 * 
 * Example:
 *   node src/testRunner.js 0x1234567890abcdef... --scenario LOW_GAS_EXAMPLE
 */

import fetch from 'node-fetch'
import { validateTestResult, TEST_SCENARIOS } from './testScenarios.js'

const API_BASE = 'http://localhost:3000'

async function runTest(txHash, scenarioName) {
  console.log('\n' + '='.repeat(60))
  console.log(`Testing Arbitrum Tx: ${txHash}`)
  if (scenarioName) {
    console.log(`Scenario: ${scenarioName}`)
  }
  console.log('='.repeat(60))

  try {
    console.log('\n📡 Sending request to /analyze endpoint...')
    const response = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash })
    })

    if (!response.ok) {
      const error = await response.json()
      console.error(`❌ API Error: ${error.error}`)
      return
    }

    const data = await response.json()

    // Display results
    console.log(`\n✅ Analysis Complete`)
    console.log(`   Found on: ${data.foundOn}`)

    // Timeline summary
    console.log(`\n📋 Timeline (${data.timeline.actions.length} steps):`)
    data.timeline.actions.forEach((action, idx) => {
      const statusEmoji = action.status === 'confirmed' ? '✓' : action.status === 'failed' ? '✗' : '?'
      console.log(`   ${idx + 1}. [${statusEmoji}] ${formatActionName(action.action)}`)
    })

    // Failures
    if (data.timeline.failureClassification.length > 0) {
      console.log(`\n⚠️  Failures Detected:`)
      data.timeline.failureClassification.forEach((f) => {
        console.log(`   • [${f.severity.toUpperCase()}] ${f.type}: ${f.message}`)
      })
    } else {
      console.log(`\n✅ No failures detected`)
    }

    // Stylus metadata (if applicable)
    if (data.stylusMetadata && data.stylusMetadata.isWasmContract) {
      console.log(`\n🔧 Stylus (WASM) Execution Detected:`)
      console.log(`   Precompile: ${data.stylusMetadata.wasmAddress}`)
      console.log(`   Panic Detected: ${data.stylusMetadata.panicDetected ? 'Yes' : 'No'}`)
    }

    // Validate against scenario if provided
    if (scenarioName && TEST_SCENARIOS[scenarioName]) {
      console.log(`\n🧪 Validating Against Scenario: ${scenarioName}`)
      const scenario = TEST_SCENARIOS[scenarioName]
      const validation = validateTestResult(data, scenario)

      validation.checks.forEach((check) => {
        const icon = check.passed ? '✓' : '✗'
        console.log(`   [${icon}] ${check.name}`)
        if (!check.passed) {
          console.log(`      Expected: ${JSON.stringify(check.expected)}`)
          console.log(`      Got: ${JSON.stringify(check.actual)}`)
        }
      })

      console.log(`\n${validation.passed ? '✅ Validation PASSED' : '❌ Validation FAILED'}`)
    }

    // Raw data summary
    console.log(`\n📊 Raw Data Summary:`)
    if (data.rawData.l1Receipt) {
      console.log(`   L1 Tx: ${data.rawData.l1Receipt.transactionHash}`)
      console.log(`   L1 Status: ${data.rawData.l1Receipt.status === 1 ? 'Success' : 'Failed'}`)
    }
    if (data.rawData.l2Receipt) {
      console.log(`   L2 Tx: ${data.rawData.l2Receipt.transactionHash}`)
      console.log(`   L2 Status: ${data.rawData.l2Receipt.status === 1 ? 'Success' : 'Failed'}`)
    }
    if (data.rawData.retryableTickets.length > 0) {
      const ticket = data.rawData.retryableTickets[0]
      console.log(`   Retryable Ticket ID: ${ticket.ticketId}`)
      console.log(`   Max Gas: ${ticket.gasLimit}`)
      console.log(`   Gas Price Bid: ${ticket.maxFeePerGas}`)
      console.log(`   Submission Cost: ${ticket.l2CallValue}`)
    }

    console.log('\n' + '='.repeat(60) + '\n')
  } catch (e) {
    console.error(`❌ Test Error: ${e.message}`)
  }
}

function formatActionName(action) {
  return action
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}

// CLI entrypoint
const args = process.argv.slice(2)
const txHash = args[0]
const scenarioIdx = args.indexOf('--scenario')
const scenarioName = scenarioIdx >= 0 ? args[scenarioIdx + 1] : null

if (!txHash) {
  console.error(`Usage: node src/testRunner.js <txHash> [--scenario <name>]`)
  console.error(`\nExample:`)
  console.error(`  node src/testRunner.js 0x1234567890abcdef...`)
  console.error(`  node src/testRunner.js 0x1234567890abcdef... --scenario LOW_GAS_EXAMPLE`)
  process.exit(1)
}

runTest(txHash, scenarioName)
