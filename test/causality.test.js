import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { analyzeCrossChainCausality, computeCausalGraph } from '../src/causalityAnalyzer.js'

function loadFixture() {
  const p = path.join(process.cwd(), 'test', 'fixtures', 'causality_sample.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

async function run() {
  const fixture = loadFixture()
  const detection = fixture.detection
  const retryable = fixture.retryable
  const l2Receipt = fixture.detection.l2Receipt

  // Case 1: OUT_OF_GAS
  const outOfGasResult = analyzeCrossChainCausality(detection, retryable, Object.assign({}, l2Receipt), 'OUT_OF_GAS', null)
  console.log('OUT_OF_GAS analysis:', outOfGasResult.causalityType, outOfGasResult.chain)
  assert(outOfGasResult.chain === 'L1_CAUSED', 'Expected L1_CAUSED for OUT_OF_GAS')
  assert(outOfGasResult.causalityType === 'INSUFFICIENT_GAS', 'Expected INSUFFICIENT_GAS causalityType')

  // Case 2: LOGIC_REVERT
  const logicResult = analyzeCrossChainCausality(detection, retryable, Object.assign({}, l2Receipt), 'LOGIC_REVERT', 'Insufficient balance')
  console.log('LOGIC_REVERT analysis:', logicResult.causalityType, logicResult.chain)
  assert(logicResult.chain === 'L2_CAUSED', 'Expected L2_CAUSED for LOGIC_REVERT')
  assert(logicResult.causalityType === 'LOGIC_ERROR', 'Expected LOGIC_ERROR causalityType')

  // Compute causal graph
  const graph = computeCausalGraph(detection, [retryable], l2Receipt)
  console.log('Causal graph keys:', Object.keys(graph))
  assert(graph.retryableCreation && graph.l2Execution, 'Graph should contain retryableCreation and l2Execution')

  console.log('\nAll causality tests passed ✅')
}

run().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
