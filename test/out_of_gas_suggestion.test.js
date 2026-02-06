import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { analyzeCrossChainCausality } from '../src/causalityAnalyzer.js'

async function run() {
  const detection = {
    l1Receipt: { transactionHash: '0xL1', blockNumber: 1, status: 1, gasUsed: 21000 },
    l2Receipt: { transactionHash: '0xL2', blockNumber: 2, status: 0, gasUsed: 340000, gasLimit: 340000 }
  }
  const retryable = {
    ticketId: '0xT',
    transactionHash: '0xL1',
    blockNumber: 1,
    from: '0xFrom',
    to: '0xTo',
    gasLimit: '200000',
    maxFeePerGas: '1000000000',
    l2CallValue: '1000',
    data: '0x'
  }

  const res = analyzeCrossChainCausality(detection, retryable, detection.l2Receipt, 'OUT_OF_GAS', null)
  console.log('Human message:', res.humanMessage)
  assert(res.causalityType === 'INSUFFICIENT_GAS', 'Expected INSUFFICIENT_GAS')
  // Should recommend ~70% increase (140k deficit on 200k gives 70%)
  assert(res.humanMessage && res.humanMessage.includes('70%'), 'Expected suggested percent increase in humanMessage')

  console.log('OUT_OF_GAS suggestion test passed ✅')
}

run().catch(err => { console.error(err); process.exit(1) })
