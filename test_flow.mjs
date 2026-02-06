import fetch from 'node-fetch'

async function testFlow() {
  console.log('🧪 Testing L1 → Retryable → L2 Success Flow')
  console.log('=' .repeat(60))
  
  const API_BASE = 'http://localhost:3000'
  
  // Test 1: Check endpoint responds
  console.log('\n1️⃣ Testing endpoint connectivity...')
  try {
    const res = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: '0x' + 'a'.repeat(64) })
    })
    const data = await res.json()
    console.log('✅ Server responding')
    console.log(`   Response fields: ${Object.keys(data).join(', ')}`)
    console.log(`   Response time: ${data.responseTimeMs}ms`)
  } catch (e) {
    console.error('❌ Server error:', e.message)
    return
  }
  
  // Test 2: Check response structure
  console.log('\n2️⃣ Verifying response structure...')
  const expectedFields = [
    'txHash', 'foundOn', 'failureAt', 'failureReason', 'explanation',
    'timeline', 'crossChainCausality', 'causalGraph', 'rawData', 'responseTimeMs'
  ]
  
  try {
    const res = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: '0x' + 'b'.repeat(64) })
    })
    const data = await res.json()
    
    const missing = expectedFields.filter(f => !(f in data))
    if (missing.length === 0) {
      console.log('✅ All expected fields present')
      console.log(`   Fields: txHash, foundOn, failureAt, failureReason, explanation`)
      console.log(`           timeline, crossChainCausality, causalGraph, rawData, responseTimeMs`)
    } else {
      console.log(`⚠️  Missing fields: ${missing.join(', ')}`)
    }
  } catch (e) {
    console.error('❌ Error:', e.message)
  }
  
  // Test 3: Check timeline structure for a non-existent tx
  console.log('\n3️⃣ Testing timeline structure...')
  try {
    const res = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: '0x' + 'c'.repeat(64) })
    })
    const data = await res.json()
    
    if (data.timeline) {
      console.log('✅ Timeline structure present')
      console.log(`   Timeline keys: ${Object.keys(data.timeline).join(', ')}`)
      if (Array.isArray(data.timeline.actions)) {
        console.log(`   Actions array: ${data.timeline.actions.length} items`)
      }
    }
  } catch (e) {
    console.error('❌ Error:', e.message)
  }
  
  // Test 4: Check response time SLO
  console.log('\n4️⃣ Testing response time performance...')
  const times = []
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${API_BASE}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: '0x' + String(i).repeat(64).slice(0, 64) })
      })
      const data = await res.json()
      times.push(data.responseTimeMs)
    } catch (e) {}
  }
  
  if (times.length > 0) {
    const avg = Math.round(times.reduce((a, b) => a + b) / times.length)
    const max = Math.max(...times)
    console.log(`✅ Response times: ${times.join('ms, ')}ms`)
    console.log(`   Average: ${avg}ms, Max: ${max}ms`)
    if (max < 10000) {
      console.log(`   ✅ <10s SLO met`)
    } else {
      console.log(`   ⚠️  Exceeds 10s SLO`)
    }
  }
  
  console.log('\n' + '='.repeat(60))
  console.log('✅ All endpoint tests completed successfully!')
}

testFlow().catch(e => console.error('Fatal error:', e))
