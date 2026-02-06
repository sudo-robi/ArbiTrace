import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const DB_DIR = path.join(process.cwd(), 'data')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })
const DB_PATH = path.join(DB_DIR, 'abi_cache.db')

const db = new Database(DB_PATH)

db.exec(`
CREATE TABLE IF NOT EXISTS signatures (
  selector TEXT PRIMARY KEY,
  results TEXT,
  last_updated INTEGER
)
`)

const getStmt = db.prepare('SELECT results, last_updated FROM signatures WHERE selector = ?')
const upsertStmt = db.prepare('INSERT OR REPLACE INTO signatures (selector, results, last_updated) VALUES (?, ?, ?)')

export function getCachedSignatures(selector) {
  if (!selector) return null
  const row = getStmt.get(selector.toLowerCase())
  if (!row) return null
  try {
    const results = JSON.parse(row.results)
    return { results, last_updated: row.last_updated }
  } catch (e) {
    return null
  }
}

export function setCachedSignatures(selector, results) {
  try {
    const now = Date.now()
    upsertStmt.run(selector.toLowerCase(), JSON.stringify(results), now)
    return true
  } catch (e) {
    return false
  }
}

export default { getCachedSignatures, setCachedSignatures }

export function stats() {
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM signatures').get()
    return { count: row ? row.cnt : 0 }
  } catch (e) {
    return { count: 0 }
  }
}
