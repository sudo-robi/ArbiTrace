#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

console.log('\n🔍 ArbiTrace System Verification')
console.log('='.repeat(70))

const checks = []

// 1. File structure
console.log('\n1️⃣ Checking file structure...')
const requiredFiles = [
  'src/server.js',
  'src/arbitrum.js',
  'src/causalityAnalyzer.js',
  'src/traceNormalizer.js',
  'src/stylusParser.js',
  'src/indexer.js',
  'src/cache.js',
  'public/index.html',
  'package.json',
  '.env'
]

let filesOk = 0
requiredFiles.forEach(f => {
  const full = path.join(__dirname, f)
  if (fs.existsSync(full)) {
    console.log(`   ✅ ${f}`)
    filesOk++
  } else {
    console.log(`   ❌ ${f} (missing)`)
  }
})
checks.push({ name: 'File Structure', passed: filesOk === requiredFiles.length })

// 2. Check key exports in arbitrum.js
console.log('\n2️⃣ Checking module exports...')
try {
  const arbitrumPath = path.join(__dirname, 'src/arbitrum.js')
  const content = fs.readFileSync(arbitrumPath, 'utf8')
  
  const exports = [
    'INBOX_ABI',
    'ARB_RETRYABLE_ABI',
    'BRIDGE_ABI',
    'SEQUENCER_INBOX_ABI',
    'getProviders',
    'callWithTimeout',
    'findTxOnProviders',
    'fetchL1Logs',
    'findRetryableCreationLogs',
    'findL2TransactionFromRetryable'
  ]
  
  let exportsOk = 0
  exports.forEach(exp => {
    if (content.includes(exp)) {
      console.log(`   ✅ ${exp}`)
      exportsOk++
    } else {
      console.log(`   ❌ Missing: ${exp}`)
    }
  })
  checks.push({ name: 'Module Exports', passed: exportsOk === exports.length })
} catch (e) {
  console.log(`   ❌ Error reading file: ${e.message}`)
  checks.push({ name: 'Module Exports', passed: false })
}

// 3. Check server.js structure
console.log('\n3️⃣ Checking server implementation...')
try {
  const serverPath = path.join(__dirname, 'src/server.js')
  const content = fs.readFileSync(serverPath, 'utf8')
  
  const checks_items = [
    { name: 'Express app creation', pattern: /const app = express\(\)/ },
    { name: '/analyze POST endpoint', pattern: /app\.post\('\/analyze'/ },
    { name: 'rpcTimings capture', pattern: /rpcTimings/ },
    { name: 'responseTimeMs field', pattern: /responseTimeMs/ },
    { name: 'explanation field', pattern: /explanation:/ },
    { name: 'classifyFailureDetailed function', pattern: /classifyFailureDetailed/ },
    { name: 'Instrumentation', pattern: /timings\./ }
  ]
  
  let serverOk = 0
  checks_items.forEach(check => {
    if (check.pattern.test(content)) {
      console.log(`   ✅ ${check.name}`)
      serverOk++
    } else {
      console.log(`   ❌ Missing: ${check.name}`)
    }
  })
  checks.push({ name: 'Server Implementation', passed: serverOk === checks_items.length })
} catch (e) {
  console.log(`   ❌ Error: ${e.message}`)
  checks.push({ name: 'Server Implementation', passed: false })
}

// 4. Check UI improvements
console.log('\n4️⃣ Checking UI enhancements...')
try {
  const htmlPath = path.join(__dirname, 'public/index.html')
  const content = fs.readFileSync(htmlPath, 'utf8')
  
  const uiChecks = [
    { name: 'Toast helper function', pattern: /function showToast\(message/ },
    { name: 'Toast animations (slideIn)', pattern: /@keyframes slideIn/ },
    { name: 'Toast animations (slideOut)', pattern: /@keyframes slideOut/ },
    { name: 'No alert() calls', pattern: /alert\(/, inverse: true },
    { name: 'Button label "Explain this failure"', pattern: /Explain this failure/ },
    { name: 'Copy explanation button', pattern: /copyCausalityBtn/ },
    { name: 'Dark mode toggle', pattern: /modeToggle/ }
  ]
  
  let uiOk = 0
  uiChecks.forEach(check => {
    const found = check.pattern.test(content)
    const ok = check.inverse ? !found : found
    if (ok) {
      console.log(`   ✅ ${check.name}`)
      uiOk++
    } else {
      console.log(`   ❌ Missing: ${check.name}`)
    }
  })
  checks.push({ name: 'UI Enhancements', passed: uiOk === uiChecks.length })
} catch (e) {
  console.log(`   ❌ Error: ${e.message}`)
  checks.push({ name: 'UI Enhancements', passed: false })
}

// 5. Check cache implementation
console.log('\n5️⃣ Checking cache module...')
try {
  const cachePath = path.join(__dirname, 'src/cache.js')
  const content = fs.readFileSync(cachePath, 'utf8')
  
  const cacheChecks = [
    { name: 'cacheGet function', pattern: /export function cacheGet/ },
    { name: 'cacheSet function', pattern: /export function cacheSet/ },
    { name: 'cacheDel function', pattern: /export function cacheDel/ },
    { name: 'TTL support', pattern: /ttl/ }
  ]
  
  let cacheOk = 0
  cacheChecks.forEach(check => {
    if (check.pattern.test(content)) {
      console.log(`   ✅ ${check.name}`)
      cacheOk++
    } else {
      console.log(`   ❌ Missing: ${check.name}`)
    }
  })
  checks.push({ name: 'Cache Implementation', passed: cacheOk === cacheChecks.length })
} catch (e) {
  console.log(`   ❌ Error: ${e.message}`)
  checks.push({ name: 'Cache Implementation', passed: false })
}

// 6. Check test files
console.log('\n6️⃣ Checking test suite...')
const testFiles = [
  'test/causality.test.js',
  'test/e2e.test.js',
  'test/indexer.unit.test.js',
  'test/out_of_gas_suggestion.test.js',
  'test/basefee_average.test.js'
]

let testsOk = 0
testFiles.forEach(f => {
  const full = path.join(__dirname, f)
  if (fs.existsSync(full)) {
    console.log(`   ✅ ${f}`)
    testsOk++
  } else {
    console.log(`   ⚠️  Optional: ${f}`)
  }
})
checks.push({ name: 'Test Files', passed: testsOk >= 3 })

// Summary
console.log('\n' + '='.repeat(70))
console.log('📊 Verification Summary')
console.log('='.repeat(70))

const passed = checks.filter(c => c.passed).length
const total = checks.length

checks.forEach(check => {
  const icon = check.passed ? '✅' : '❌'
  console.log(`${icon} ${check.name}`)
})

console.log('\n' + '='.repeat(70))
if (passed === total) {
  console.log(`🎉 PERFECT! All ${total} checks passed!`)
  console.log('\n✨ ArbiTrace is ready for deployment!')
  console.log('\nNext steps:')
  console.log('  1. Start server: npm start')
  console.log('  2. Open UI: http://localhost:3000')
  console.log('  3. Test with real Arbitrum transactions')
  console.log('  4. Monitor responseTimeMs for SLO compliance')
  process.exit(0)
} else {
  console.log(`⚠️  ${passed}/${total} checks passed`)
  console.log('\nPlease fix the failing checks before deploying.')
  process.exit(1)
}
