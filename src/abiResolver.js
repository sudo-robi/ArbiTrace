import fetch from 'node-fetch'
import { getCachedSignatures, setCachedSignatures } from './abiCache.js'

const MEMORY = new Map()

export async function resolveSelector(selector) {
  // selector should be '0x....' 4-byte
  if (!selector) return { ok: false, results: [] }
  const key = selector.toLowerCase()

  // In-memory quick path
  if (MEMORY.has(key)) return { ok: true, results: MEMORY.get(key) }

  // Persistent cache (SQLite)
  try {
    const cached = getCachedSignatures(key)
    if (cached && Array.isArray(cached.results) && cached.results.length) {
      MEMORY.set(key, cached.results)
      return { ok: true, results: cached.results }
    }
  } catch (e) {
    // ignore cache failures
  }

  try {
    // Query 4byte.directory API for hex_signature
    const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${key}`
    const res = await fetch(url, { timeout: 8000 })
    if (!res.ok) return { ok: false, results: [] }
    const json = await res.json()
    const results = (json.results || []).map(r => ({ text: r.text_signature, id: r.id }))
    MEMORY.set(key, results)
    try { setCachedSignatures(key, results) } catch (e) {}
    return { ok: true, results }
  } catch (e) {
    return { ok: false, results: [] }
  }
}
