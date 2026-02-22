/**
 * onchainEventListener.js
 * 
 * Listens for RetryableIncidentReported events from the onchain RetryableIncidentRegistry.
 * Stores events in the local database and feeds them into the debugger pipeline.
 * 
 * Deployed contract: 0x915cC86fE0871835e750E93e025080FFf9927A3f (Arbitrum Sepolia)
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { withRetry, callWithTimeout } from './arbitrum.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Contract ABI (only the event we care about)
const INCIDENT_REGISTRY_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'reporter', type: 'address' },
      { indexed: true, internalType: 'bytes32', name: 'txHash', type: 'bytes32' },
      { indexed: false, internalType: 'uint8', name: 'failureType', type: 'uint8' },
      { indexed: false, internalType: 'bytes32', name: 'fingerprint', type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'timestamp', type: 'uint256' }
    ],
    name: 'RetryableIncidentReported',
    type: 'event'
  },
  {
    inputs: [{ internalType: 'uint256', name: 'n', type: 'uint256' }],
    name: 'topFailures',
    outputs: [
      { internalType: 'uint8[]', name: 'types_', type: 'uint8[]' },
      { internalType: 'uint256[]', name: 'counts_', type: 'uint256[]' }
    ],
    stateMutability: 'view',
    type: 'function'
  }
];

// FailureType enum mapping
const FAILURE_TYPE_NAMES = {
  0: 'InsufficientSubmissionCost',
  1: 'MaxGasTooLow',
  2: 'GasPriceBidTooLow',
  3: 'L1Revert',
  4: 'L2Revert',
  5: 'WASMPanic'
};

export class OnchainEventListener {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl || process.env.ARBITRUM_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
    this.contractAddress = options.contractAddress || '0x915cC86fE0871835e750E93e025080FFf9927A3f';
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.contract = new ethers.Contract(this.contractAddress, INCIDENT_REGISTRY_ABI, this.provider);
    this.db = options.db || null; // optional SQLite instance
    this.logger = options.logger || console;
    this.incidents = new Map(); // in-memory cache
  }

  /**
   * Start listening for events (polling mode)
   * In production, use event subscriptions via WebSocket provider
   */
  async startListening(fromBlock = 'latest', pollInterval = 12000) {
    this.logger.info(`[OnchainListener] Starting to listen for events from ${this.contractAddress}`);
    this.logger.info(`[OnchainListener] RPC: ${this.rpcUrl}`);

    let lastBlock = null;

    const poll = async () => {
      let waitTime = pollInterval;
      try {
        const currentBlock = await withRetry(
          () => callWithTimeout(this.provider.getBlockNumber(), 8000),
          { label: 'PollBlockNumber', maxAttempts: 4, initialDelay: 2000 }
        );

        if (lastBlock === null) {
          lastBlock = fromBlock === 'latest' ? currentBlock : parseInt(fromBlock, 10);
        }

        // Query events since last block
        const filter = this.contract.filters.RetryableIncidentReported();
        const events = await withRetry(
          () => callWithTimeout(this.contract.queryFilter(filter, lastBlock, currentBlock), 15000),
          { label: 'QueryFilter', maxAttempts: 3, initialDelay: 2000 }
        );

        for (const event of events) {
          await this.handleIncidentEvent(event);
        }

        lastBlock = currentBlock + 1;
      } catch (err) {
        this.logger.error('[OnchainListener] Error polling events:', err);
        // Increase wait time on failure to avoid hammering broken RPC
        waitTime = pollInterval * 2;
      }

      setTimeout(poll, waitTime);
    };

    poll();
  }

  /**
   * Handle a single RetryableIncidentReported event
   */
  async handleIncidentEvent(event) {
    try {
      const { reporter, txHash, failureType, fingerprint, timestamp } = event.args;

      const incident = {
        id: `onchain:${txHash}`,
        source: 'onchain',
        reporter,
        txHash,
        failureType: FAILURE_TYPE_NAMES[failureType] || `Unknown(${failureType})`,
        failureTypeCode: failureType,
        fingerprint,
        timestamp: Number(timestamp),
        contractAddress: this.contractAddress,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.index
      };

      this.logger.info(`[OnchainListener] New incident: ${incident.id} | Type: ${incident.failureType}`);

      // Store in memory
      this.incidents.set(txHash, incident);

      // Store in database if available
      if (this.db) {
        this.storeIncidentInDB(incident);
      }

      // Emit to any listeners (optional hook for debugger integration)
      if (this.onIncident) {
        this.onIncident(incident);
      }
    } catch (err) {
      this.logger.error('[OnchainListener] Error handling event:', err);
    }
  }

  /**
   * Store incident in SQLite database
   */
  storeIncidentInDB(incident) {
    try {
      const table = 'onchain_incidents';

      // Ensure table exists
      this.db
        .prepare(
          `
        CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          source TEXT,
          reporter TEXT,
          txHash TEXT UNIQUE,
          failureType TEXT,
          failureTypeCode INTEGER,
          fingerprint TEXT,
          timestamp INTEGER,
          contractAddress TEXT,
          blockNumber INTEGER,
          transactionHash TEXT,
          logIndex INTEGER,
          createdAt INTEGER
        )
      `
        )
        .run();

      // Insert or ignore (skip if already stored)
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO ${table} (
          id, source, reporter, txHash, failureType, failureTypeCode,
          fingerprint, timestamp, contractAddress, blockNumber, transactionHash, logIndex, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          incident.id,
          incident.source,
          incident.reporter,
          incident.txHash,
          incident.failureType,
          incident.failureTypeCode,
          incident.fingerprint,
          incident.timestamp,
          incident.contractAddress,
          incident.blockNumber,
          incident.transactionHash,
          incident.logIndex,
          Date.now()
        );

      this.logger.debug(`[DB] Stored incident: ${incident.txHash}`);
    } catch (err) {
      this.logger.error('[DB] Error storing incident:', err);
    }
  }

  /**
   * Retrieve top N failure types from onchain contract
   */
  async getTopFailures(n = 6) {
    try {
      const result = await withRetry(
        () => callWithTimeout(this.contract.topFailures(n), 5000),
        { label: 'GetTopFailures', maxAttempts: 2 }
      );
      const failures = result[0].map((typeCode, idx) => ({
        type: FAILURE_TYPE_NAMES[typeCode] || `Unknown(${typeCode})`,
        typeCode,
        count: Number(result[1][idx])
      }));

      this.logger.info(`[OnchainListener] Top ${n} failures:`, failures);
      return failures;
    } catch (err) {
      this.logger.error('[OnchainListener] Error fetching top failures:', err);
      return [];
    }
  }

  /**
   * Retrieve all cached incidents
   */
  getIncidents() {
    return Array.from(this.incidents.values());
  }

  /**
   * Retrieve a single incident by txHash
   */
  getIncident(txHash) {
    return this.incidents.get(txHash);
  }

  /**
   * Retrieve incidents from database with optional filters
   */
  queryIncidentsFromDB(filters = {}) {
    try {
      let query = 'SELECT * FROM onchain_incidents WHERE 1=1';
      const params = [];

      if (filters.failureType) {
        query += ' AND failureType = ?';
        params.push(filters.failureType);
      }

      if (filters.reporter) {
        query += ' AND reporter = ?';
        params.push(filters.reporter);
      }

      if (filters.fromTimestamp) {
        query += ' AND timestamp >= ?';
        params.push(filters.fromTimestamp);
      }

      query += ' ORDER BY timestamp DESC LIMIT 1000';

      return this.db.prepare(query).all(...params);
    } catch (err) {
      this.logger.error('[DB] Error querying incidents:', err);
      return [];
    }
  }

  /**
   * Optional: Register a callback when a new incident is received
   */
  onIncident(callback) {
    this.onIncident = callback;
  }
}

// Export for use in other modules
export default OnchainEventListener;
