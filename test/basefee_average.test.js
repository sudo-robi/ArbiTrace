import assert from 'assert'
import { computeL2BaseFeeAverage } from '../src/arbitrum.js'

async function run() {
  const blocks = [
    { baseFeePerGas: '1000000000' },
    { baseFeePerGas: '1200000000' },
    { baseFeePerGas: '800000000' }
  ]
  const avg = await computeL2BaseFeeAverage(3, blocks)
  console.log('Computed avg baseFee:', avg.toString())
  // avg of [1e9,1.2e9,0.8e9] = 1e9
  assert(avg && avg.toString() === '1000000000', 'Expected average baseFee of 1000000000')
  console.log('Base fee average test passed ✅')
}

run().catch(err => { console.error(err); process.exit(1) })
