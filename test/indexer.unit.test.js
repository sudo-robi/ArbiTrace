import assert from 'assert'
import indexer, { insertMapping, getStylusMeta, upsertStylusMeta } from '../src/indexer.js'

async function run() {
  console.log('Running indexer unit test')
  // Insert a mapping
  const ok = insertMapping('0xT1', '0xL2TX', 999999)
  assert.ok(ok, 'insertMapping should return true')

  const map = indexer.findL2ForTicket('0xT1')
  assert.ok(map, 'mapping should be present')
  assert.equal(map.l2_tx_hash, '0xL2TX')

  // Upsert stylus meta via exported helper
  const up = upsertStylusMeta({ txHash: '0xL2TX', ticketId: '0xT1', panicCode: '0x01', panicReason: 'Overflow', gasUsed: '123456' })
  assert.ok(up, 'upsertStylusMeta should return true')

  const meta = getStylusMeta('0xL2TX')
  assert.ok(meta, 'stylus meta should exist')
  assert.equal(meta.panic_code, '0x01')

  console.log('Indexer unit test passed ✅')
}

run().catch(err => { console.error('Indexer unit test failed:', err); process.exit(1) })
