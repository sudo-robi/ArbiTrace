// Simple in-memory cache with TTL
const cache = new Map()

export function cacheGet(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.value
}

export function cacheSet(key, value, ttlMs = 5 * 60 * 1000) {
  const expiresAt = ttlMs ? Date.now() + ttlMs : null
  cache.set(key, { value, expiresAt })
}

export function cacheDel(key) {
  cache.delete(key)
}

export default { cacheGet, cacheSet, cacheDel }
