/**
 * SessionManager.js
 * 
 * Manages shareable debug sessions with real-time WebSocket updates.
 * Enables multiple users to watch analysis happen in real-time and collaborate on debugging.
 * 
 * Features:
 * - Generate unique shareable session IDs
 * - Store active sessions with metadata
 * - Broadcast events to subscribed clients
 * - Clean up stale sessions
 * - Persist session history for replay
 */

import { getDatabase } from './dbUtils.js'

import { v4 as uuidv4 } from 'uuid';

const DB_NAME = 'sessions.db'

let db;
const activeSessions = new Map(); // sessionId -> { metadata, subscribers: Set, events: [] }
const subscribers = new Map(); // wsClient -> Set of sessionIds

/**
 * Initialize session database and in-memory session store
 */
export function initSessionManager() {
  try {
    db = getDatabase(DB_NAME)
    if (!db) return false

    // Create sessions table for persistence
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        creator_address TEXT,
        contract_address TEXT,
        transaction_hash TEXT,
        status TEXT DEFAULT 'active', -- active | completed | failed | archived
        viewer_count INTEGER DEFAULT 0,
        event_count INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_ts DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL, -- analysis_started, step_completed, error_occurred, completed
        event_data TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        UNIQUE(session_id, timestamp, event_type)
      );

      CREATE TABLE IF NOT EXISTS session_viewers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        viewer_id TEXT,
        joined_at INTEGER NOT NULL,
        left_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_viewers_session_id ON session_viewers(session_id);
    `);

    console.log('✅ Session manager initialized');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize session manager:', error);
    return false;
  }
}

/**
 * Create a new shareable debug session
 * @param {Object} options - Session options
 * @param {string} options.creatorAddress - Ethereum address of creator
 * @param {string} options.contractAddress - Contract being debugged
 * @param {string} options.transactionHash - Transaction being analyzed
 * @param {number} options.ttl - Time-to-live in seconds (default: 3600 = 1 hour)
 * @returns {string} Unique session ID
 */
export function createSession(options = {}) {
  const {
    creatorAddress = 'anonymous',
    contractAddress = '',
    transactionHash = '',
    ttl = 3600 // 1 hour default
  } = options;

  const sessionId = generateSessionId();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttl;

  try {
    // Store in database
    const stmt = db.prepare(`
      INSERT INTO sessions (
        id, created_at, expires_at, creator_address, contract_address, 
        transaction_hash, status, viewer_count, event_count, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sessionId,
      now,
      expiresAt,
      creatorAddress,
      contractAddress,
      transactionHash,
      'active',
      0,
      0,
      JSON.stringify({ createdAt: new Date(now * 1000).toISOString() })
    );

    // Store in memory
    activeSessions.set(sessionId, {
      id: sessionId,
      creatorAddress,
      contractAddress,
      transactionHash,
      createdAt: now,
      expiresAt,
      status: 'active',
      subscribers: new Set(),
      events: [],
      startedAnalysis: false,
      analysisStep: 0,
      totalSteps: 0
    });

    console.log(`✅ Session created: ${sessionId}`);
    return sessionId;
  } catch (error) {
    console.error('❌ Failed to create session:', error);
    return null;
  }
}

/**
 * Get session metadata and recent events
 * @param {string} sessionId - Session ID
 * @returns {Object} Session details or null
 */
export function getSession(sessionId) {
  const session = activeSessions.get(sessionId);

  if (!session) {
    // Try to load from database
    try {
      const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
      const dbSession = stmt.get(sessionId);

      if (!dbSession) return null;

      // Load events
      const events = db.prepare(`
        SELECT event_type, event_data, timestamp 
        FROM session_events 
        WHERE session_id = ? 
        ORDER BY timestamp DESC 
        LIMIT 100
      `).all(sessionId);

      return {
        ...dbSession,
        events: events.reverse()
      };
    } catch (error) {
      console.error('❌ Failed to get session:', error);
      return null;
    }
  }

  return {
    id: session.id,
    creatorAddress: session.creatorAddress,
    contractAddress: session.contractAddress,
    transactionHash: session.transactionHash,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status,
    viewerCount: session.subscribers.size,
    eventCount: session.events.length,
    startedAnalysis: session.startedAnalysis,
    analysisStep: session.analysisStep,
    totalSteps: session.totalSteps,
    events: session.events.slice(-50) // Last 50 events
  };
}

/**
 * Subscribe a WebSocket client to a session
 * @param {WebSocket} client - WebSocket connection
 * @param {string} sessionId - Session to subscribe to
 * @returns {boolean} Success status
 */
export function subscribeToSession(client, sessionId) {
  const session = activeSessions.get(sessionId);

  if (!session) {
    console.warn(`⚠️ Cannot subscribe to non-existent session: ${sessionId}`);
    return false;
  }

  // Add client to session subscribers
  session.subscribers.add(client);

  // Track which sessions this client is subscribed to
  if (!subscribers.has(client)) {
    subscribers.set(client, new Set());
  }
  subscribers.get(client).add(sessionId);

  // Update viewer count in database
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO session_viewers (session_id, viewer_id, joined_at)
      VALUES (?, ?, ?)
    `).run(sessionId, `viewer_${uuidv4().slice(0, 8)}`, now);

    const viewerCount = db.prepare(`
      SELECT COUNT(*) as count FROM session_viewers 
      WHERE session_id = ? AND left_at IS NULL
    `).get(sessionId).count;

    db.prepare('UPDATE sessions SET viewer_count = ? WHERE id = ?')
      .run(viewerCount, sessionId);
  } catch (error) {
    console.error('❌ Failed to update viewer count:', error);
  }

  console.log(`✅ Client subscribed to session ${sessionId} (${session.subscribers.size} subscribers)`);
  return true;
}

/**
 * Unsubscribe a WebSocket client from a session
 * @param {WebSocket} client - WebSocket connection
 * @param {string} sessionId - Session to unsubscribe from
 */
export function unsubscribeFromSession(client, sessionId) {
  const session = activeSessions.get(sessionId);

  if (session) {
    session.subscribers.delete(client);
    console.log(`✅ Client unsubscribed from session ${sessionId}`);
  }

  const clientSessions = subscribers.get(client);
  if (clientSessions) {
    clientSessions.delete(sessionId);
  }
}

/**
 * Remove all sessions for a disconnected client
 * @param {WebSocket} client - WebSocket connection
 */
export function removeClient(client) {
  const clientSessions = subscribers.get(client);

  if (clientSessions) {
    for (const sessionId of clientSessions) {
      unsubscribeFromSession(client, sessionId);
    }
    subscribers.delete(client);
    console.log(`✅ Client removed from all sessions`);
  }
}

/**
 * Record an analysis event in a session
 * @param {string} sessionId - Session ID
 * @param {string} eventType - Type of event (analysis_started, step_completed, etc.)
 * @param {Object} eventData - Event data
 * @returns {boolean} Success status
 */
export function recordEvent(sessionId, eventType, eventData = {}) {
  const session = activeSessions.get(sessionId);

  if (!session) {
    console.warn(`⚠️ Cannot record event in non-existent session: ${sessionId}`);
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const event = {
    type: eventType,
    data: eventData,
    timestamp
  };

  // Add to in-memory session
  session.events.push(event);
  if (session.events.length > 1000) {
    session.events.shift(); // Keep only last 1000 events
  }

  // Track analysis progress
  if (eventType === 'analysis_started') {
    session.startedAnalysis = true;
    session.analysisStep = 0;
    session.totalSteps = eventData.totalSteps || 10;
  } else if (eventType === 'step_completed') {
    session.analysisStep = eventData.step || session.analysisStep + 1;
  } else if (eventType === 'analysis_completed') {
    session.status = 'completed';
  } else if (eventType === 'analysis_error') {
    session.status = 'failed';
  }

  // Store in database
  try {
    db.prepare(`
      INSERT OR IGNORE INTO session_events (session_id, event_type, event_data, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, eventType, JSON.stringify(eventData), timestamp);

    db.prepare('UPDATE sessions SET event_count = event_count + 1 WHERE id = ?')
      .run(sessionId);
  } catch (error) {
    console.error('❌ Failed to record event:', error);
  }

  return true;
}

/**
 * Broadcast an event to all subscribers of a session
 * @param {string} sessionId - Session ID
 * @param {Object} message - Message to broadcast
 */
export function broadcastToSession(sessionId, message) {
  const session = activeSessions.get(sessionId);

  if (!session) {
    console.warn(`⚠️ Cannot broadcast to non-existent session: ${sessionId}`);
    return;
  }

  const payload = JSON.stringify({
    sessionId,
    timestamp: Math.floor(Date.now() / 1000),
    ...message
  });

  let failedClients = [];

  for (const client of session.subscribers) {
    try {
      if (client.readyState === 1) { // WebSocket.OPEN = 1
        client.send(payload);
      } else {
        failedClients.push(client);
      }
    } catch (error) {
      console.error('❌ Failed to send to client:', error);
      failedClients.push(client);
    }
  }

  // Clean up failed clients
  for (const client of failedClients) {
    unsubscribeFromSession(client, sessionId);
  }
}

/**
 * Get share URL for a session
 * @param {string} sessionId - Session ID
 * @param {string} baseUrl - Base URL of the application
 * @returns {string} Shareable URL
 */
export function getShareUrl(sessionId, baseUrl = 'http://localhost:3000') {
  return `${baseUrl}/?session=${sessionId}`;
}

/**
 * Get session share link (short form)
 * @param {string} sessionId - Session ID
 * @returns {string} Short share ID
 */
export function getShareId(sessionId) {
  // Return last 8 characters for easy sharing
  return sessionId.slice(-8).toUpperCase();
}

/**
 * List all active sessions (admin view)
 * @returns {Array} Array of active sessions
 */
export function listActiveSessions() {
  const sessions = [];

  for (const [sessionId, session] of activeSessions) {
    sessions.push({
      id: sessionId,
      shareId: getShareId(sessionId),
      creatorAddress: session.creatorAddress,
      contractAddress: session.contractAddress,
      status: session.status,
      viewers: session.subscribers.size,
      events: session.events.length,
      analysisProgress: session.startedAnalysis ?
        `${session.analysisStep}/${session.totalSteps}` : 'pending',
      ageSeconds: Math.floor(Date.now() / 1000) - session.createdAt
    });
  }

  return sessions;
}

/**
 * Archive a completed session (remove from active, keep in DB)
 * @param {string} sessionId - Session ID
 * @returns {boolean} Success status
 */
export function archiveSession(sessionId) {
  try {
    // Update in database
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run('archived', sessionId);

    // Remove from active sessions
    activeSessions.delete(sessionId);

    console.log(`✅ Session archived: ${sessionId}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to archive session:', error);
    return false;
  }
}

/**
 * Clean up expired sessions (runs periodically)
 */
export function cleanupExpiredSessions() {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Find expired sessions
    const expiredSessions = db.prepare(`
      SELECT id FROM sessions 
      WHERE status = 'active' AND expires_at < ?
    `).all(now);

    for (const { id } of expiredSessions) {
      // Close all subscribers
      const session = activeSessions.get(id);
      if (session) {
        for (const client of session.subscribers) {
          client.send(JSON.stringify({
            type: 'session_expired',
            message: 'This debug session has expired'
          }));
          unsubscribeFromSession(client, id);
        }
      }

      // Mark as archived in database
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
        .run('archived', id);

      activeSessions.delete(id);
    }

    if (expiredSessions.length > 0) {
      console.log(`✅ Cleaned up ${expiredSessions.length} expired sessions`);
    }
  } catch (error) {
    console.error('❌ Failed to cleanup expired sessions:', error);
  }
}

/**
 * Generate a unique 16-character session ID
 * @returns {string} Session ID
 */
function generateSessionId() {
  return `sess_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Get session statistics (total, active, viewers)
 * @returns {Object} Session statistics
 */
export function getSessionStats() {
  try {
    const totalActive = activeSessions.size;

    const dbStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(viewer_count) as total_viewers,
        SUM(event_count) as total_events
      FROM sessions
    `).get();

    return {
      totalSessions: dbStats.total,
      activeSessions: totalActive,
      completedSessions: dbStats.completed || 0,
      failedSessions: dbStats.failed || 0,
      totalViewers: dbStats.total_viewers || 0,
      totalEvents: dbStats.total_events || 0
    };
  } catch (error) {
    console.error('❌ Failed to get session stats:', error);
    return {};
  }
}

// Periodic cleanup of expired sessions (every 5 minutes)
export function startSessionCleanupInterval() {
  setInterval(() => {
    cleanupExpiredSessions();
  }, 5 * 60 * 1000);
  console.log('✅ Session cleanup interval started (5 min)');
}

export default {
  initSessionManager,
  createSession,
  getSession,
  subscribeToSession,
  unsubscribeFromSession,
  removeClient,
  recordEvent,
  broadcastToSession,
  getShareUrl,
  getShareId,
  listActiveSessions,
  archiveSession,
  cleanupExpiredSessions,
  getSessionStats,
  startSessionCleanupInterval
};
