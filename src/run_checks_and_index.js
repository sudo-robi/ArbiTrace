import dotenv from 'dotenv'
import { ethers } from 'ethers'
import indexer from './indexer.js'

dotenv.config()

const { L1_RPC_URL, ARBITRUM_RPC_URL } = process.env

async function run() {
  console.log('Starting RPC checks and indexer run...')

  const l1 = new ethers.JsonRpcProvider(L1_RPC_URL)
  const l2 = new ethers.JsonRpcProvider(ARBITRUM_RPC_URL)

  try {
    const l1Network = await l1.getNetwork()
    console.log('L1 network:', l1Network)
  } catch (e) {
    console.error('Failed to connect to L1 RPC:', e.message)
    process.exit(1)
  }

  try {
    const l2Network = await l2.getNetwork()
    console.log('L2 network:', l2Network)
  } catch (e) {
    console.error('Failed to connect to L2 RPC:', e.message)
    process.exit(1)
  }

  // Determine a safe small L1 block range: latest-20 .. latest-10
  const latestL1 = await l1.getBlockNumber()
  const endBlock = Math.max(0, latestL1 - 10)
  const startBlock = Math.max(0, latestL1 - 20)
  console.log(`Indexing L1 blocks from ${startBlock} to ${endBlock} (safe small range)`)

  const idxResult = await indexer.indexRange(startBlock, endBlock)
  console.log('Indexer result:', idxResult)

  // Attempt debug_traceTransaction on a recent L2 tx
  try {
    const latestL2 = await l2.getBlockNumber()
    const block = await l2.getBlock(latestL2, true)  // true = include full transactions
    const txs = (block && Array.isArray(block.transactions)) ? block.transactions.filter(tx => tx && tx.hash) : []
    if (txs.length === 0) {
      console.log('No recent L2 transactions to test debug_traceTransaction (block may be empty)')
      process.exit(0)
    }

    const txHash = txs[0].hash
    if (!txHash) {
      console.log('Could not extract transaction hash from latest block')
      process.exit(0)
    }
    
    console.log('Testing debug_traceTransaction on L2 tx:', txHash)
    try {
      const trace = await l2.send('debug_traceTransaction', [txHash, {}])
      console.log('debug_traceTransaction supported. Trace keys:', Object.keys(trace).slice(0, 5))
    } catch (e) {
      console.log('debug_traceTransaction not supported (common on public RPCs):', e.message.substring(0, 80))
    }
  } catch (e) {
    console.log('Error while attempting L2 trace test:', e.message.substring(0, 80))
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
