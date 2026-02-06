import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import fetch from 'node-fetch'

function waitForReady(child, marker = 'test-server:') {
  return new Promise((resolve, reject) => {
    const onData = (data) => {
      const s = String(data || '')
      if (s.includes(marker)) {
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.on('error', (err) => reject(err))
    setTimeout(() => reject(new Error('Server did not start in time')), 5000)
  })
}

async function run() {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'causality_sample.json')
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

  const child = spawn(process.execPath, ['src/test_server.js'], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await waitForReady(child, 'test-server:')
    // POST fixture with OUT_OF_GAS case
    const url = 'http://localhost:3456/__test/analyze'
    const body = { detection: fixture.detection, retryable: fixture.retryable, failureReason: 'OUT_OF_GAS', failureMessage: null }
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json()
    console.log('E2E response keys:', Object.keys(json))
    if (!json.ok) throw new Error('E2E server returned not ok: ' + JSON.stringify(json))
    if (!json.crossChainCausality) throw new Error('Missing crossChainCausality in response')
    if (json.crossChainCausality.chain !== 'L1_CAUSED') throw new Error('Expected L1_CAUSED for OUT_OF_GAS')

    // POST logic revert case
    const body2 = { detection: fixture.detection, retryable: fixture.retryable, failureReason: 'LOGIC_REVERT', failureMessage: 'Insufficient balance' }
    const res2 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body2) })
    const json2 = await res2.json()
    if (!json2.ok) throw new Error('E2E second response not ok')
    if (json2.crossChainCausality.chain !== 'L2_CAUSED') throw new Error('Expected L2_CAUSED for LOGIC_REVERT')

    console.log('\nE2E tests passed ✅')
  } finally {
    try { child.kill() } catch (e) {}
  }
}

run().catch(err => {
  console.error('E2E test failed:', err)
  process.exit(1)
})
