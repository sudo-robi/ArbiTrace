import { getDatabase } from './dbUtils.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const DB_NAME = 'auth.db'
let db

function initAuth() {
  try {
    db = getDatabase(DB_NAME)
    if (!db) return false

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL
      );
    `)

    // Optionally bootstrap admin user from environment
    const adminUser = process.env.ADMIN_USER
    const adminPass = process.env.ADMIN_PASSWORD
    if (adminUser && adminPass) {
      const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(adminUser)
      if (!existing) {
        const hash = bcrypt.hashSync(adminPass, 10)
        db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
          .run(adminUser, hash, 'admin', Date.now())
      }
    }

    return true
  } catch (e) {
    console.error('Failed to initialize auth DB:', e)
    return false
  }
}

function createUser(username, password, role = 'user') {
  if (!db) throw new Error('Auth DB not initialized')
  const hash = bcrypt.hashSync(password, 10)
  try {
    const res = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hash, role, Date.now())
    return res.changes === 1
  } catch (e) {
    return false
  }
}

function verifyUser(username, password) {
  if (!db) throw new Error('Auth DB not initialized')
  const row = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(username)
  if (!row) return null
  const ok = bcrypt.compareSync(password, row.password_hash)
  if (!ok) return null
  return { id: row.id, username: row.username, role: row.role }
}

function listUsers() {
  if (!db) throw new Error('Auth DB not initialized')
  return db.prepare('SELECT id, username, role, created_at FROM users').all()
}

function generateToken(user) {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_API_KEY || 'dev-secret'
  const expiresIn = process.env.JWT_EXPIRES_IN || '8h'
  const payload = { id: user.id, username: user.username, role: user.role }
  return jwt.sign(payload, secret, { expiresIn })
}

function verifyToken(token) {
  try {
    const secret = process.env.JWT_SECRET || process.env.ADMIN_API_KEY || 'dev-secret'
    return jwt.verify(token, secret)
  } catch (e) {
    return null
  }
}

export default {
  initAuth,
  createUser,
  verifyUser,
  generateToken,
  verifyToken,
  listUsers
}
