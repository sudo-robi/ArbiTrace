import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * Robust database utility to handle Vercel's read-only filesystem.
 * Defaults to /tmp/arb-trace-data/ for persistence across requests in the same lambda execution,
 * or :memory: if /tmp is unavailable.
 */
export function getDatabase(dbName, options = {}) {
    const isVercel = process.env.VERCEL || process.env.NOW_REGION;
    let dbPath;

    if (isVercel) {
        // Vercel only allows writing to /tmp
        const tmpDir = path.join('/tmp', 'arb-trace-data');
        if (!fs.existsSync(tmpDir)) {
            try {
                fs.mkdirSync(tmpDir, { recursive: true });
            } catch (e) {
                console.error(`❌ Failed to create /tmp directory: ${e.message}`);
                return new Database(':memory:', options);
            }
        }
        dbPath = path.join(tmpDir, dbName);
        console.log(`🚀 Using Vercel /tmp path for ${dbName}: ${dbPath}`);
    } else {
        // Local development
        const dataDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        dbPath = path.join(dataDir, dbName);
    }

    try {
        const db = new Database(dbPath, options);
        // WAL mode might fail on some shared filesystems, fallback to DELETE if needed
        try {
            db.pragma('journal_mode = WAL');
        } catch (e) {
            console.warn(`⚠️ WAL mode failed for ${dbName}, falling back to default: ${e.message}`);
        }
        return db;
    } catch (err) {
        console.error(`❌ Failed to open database ${dbName} at ${dbPath}:`, err.message);
        console.warn(`⚠️ Falling back to :memory: for ${dbName}`);
        return new Database(':memory:', options);
    }
}

export default { getDatabase };
