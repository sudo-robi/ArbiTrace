import fs from 'fs'
import path from 'path'
import { getProviders } from '../arbitrum.js'
import indexer from '../indexer.js'

const STATE_PATH = path.join(process.cwd(), 'data', 'indexer_state.json')
const REORG_DEPTH = 12
const LOOP_DELAY_MS = Number(process.env.INDEXER_LOOP_MS || 15_000)
const L2_BATCH = Number(process.env.INDEXER_L2_BATCH || 20)
const L1_BATCH = Number(process.env.INDEXER_L1_BATCH || 20)

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { lastL1: 0, lastL2: 0 }
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch (e) {
    return { lastL1: 0, lastL2: 0 }
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
  } catch (e) {}
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function ensureProviders() {
  const p = getProviders()
  if (!p || !p.l1Provider || !p.l2Provider) throw new Error('Providers not configured')
  return p
}

async function indexLoop() {
  console.log('Indexer worker starting...')
  let state = readState()
  try {
    const { l1Provider, l2Provider } = await ensureProviders()
    while (true) {
      try {
        // L1 indexing
        const latestL1 = await l1Provider.getBlockNumber()
        let startL1 = Math.max(0, (state.lastL1 || 0) - REORG_DEPTH)
        const endL1 = Math.min(latestL1, startL1 + L1_BATCH)
        if (endL1 >= startL1) {
          console.log(`Indexing L1 blocks ${startL1}..${endL1}`)
          try {
            const res = await indexer.indexRange(startL1, endL1)
            console.log('L1 index result:', res)
          } catch (e) { console.warn('L1 index error', e.message) }
          state.lastL1 = endL1
          writeState(state)
        }

        // L2 indexing
        const latestL2 = await l2Provider.getBlockNumber()
        let startL2 = Math.max(0, (state.lastL2 || 0) - REORG_DEPTH)
        const endL2 = Math.min(latestL2, startL2 + L2_BATCH)
        if (endL2 >= startL2) {
          console.log(`Indexing L2 blocks ${startL2}..${endL2}`)
          try {
            const res2 = await indexer.indexL2Range(startL2, endL2)
            console.log('L2 index result:', res2)
          } catch (e) { console.warn('L2 index error', e.message) }
          state.lastL2 = endL2
          writeState(state)
        }

        // sleep until next loop
        await sleep(LOOP_DELAY_MS)
      } catch (e) {
        console.warn('Indexer loop error', e.message)
        await sleep(5000)
      }
    }
  } catch (e) {
    console.error('Indexer worker fatal error:', e.message)
    process.exit(1)
  }
}

if (require.main === module) {
  indexLoop().catch(e => { console.error(e); process.exit(1) })
}

export default { indexLoop, readState, writeState }
