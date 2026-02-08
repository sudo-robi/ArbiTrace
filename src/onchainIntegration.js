/**
 * Example: Integrate onchain incident listener into your indexer
 * 
 * This shows how to wire up the RetryableIncidentRegistry events
 * into your existing traceNormalizer and causalityAnalyzer flow.
 */

import OnchainEventListener from './onchainEventListener.js';

/**
 * Initialize the onchain listener and integrate with your indexer
 */
export async function initOnchainIntegration(indexerInstance, dbInstance) {
  const listener = new OnchainEventListener({
    contractAddress: '0x915cC86fE0871835e750E93e025080FFf9927A3f', // Arbitrum Sepolia
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
    db: dbInstance,
    logger: indexerInstance.logger || console
  });

  // Register callback to integrate onchain incidents into your debugger
  listener.onIncident((incident) => {
    // Enrich your internal incident tracker
    enrichIncidentWithOnchainData(indexerInstance, incident);

    // Optionally emit to WebSocket clients
    if (indexerInstance.broadcastToClients) {
      indexerInstance.broadcastToClients({
        type: 'onchain-incident',
        data: incident
      });
    }
  });

  // Start listening for events (polls every 12 seconds)
  listener.startListening('latest', 12000);

  return listener;
}

/**
 * Enrich your internal incident tracking with onchain data
 */
function enrichIncidentWithOnchainData(indexer, onchainIncident) {
  // If you have an internal incident database, cross-reference:
  // - Look up by txHash
  // - Mark as "verified on Arbitrum" with contract address
  // - Aggregate with your own failure analysis

  console.log(`[Integration] Enriching incident ${onchainIncident.txHash} with onchain verification`);

  // Example: Update your causalityAnalyzer or trace storage
  if (indexer.traceStore) {
    const existingTrace = indexer.traceStore.get(onchainIncident.txHash);
    if (existingTrace) {
      existingTrace.onchainVerified = true;
      existingTrace.onchainFailureType = onchainIncident.failureType;
      existingTrace.onchainFingerprint = onchainIncident.fingerprint;
      indexer.traceStore.set(onchainIncident.txHash, existingTrace);
    }
  }
}

/**
 * Query onchain incident history (example endpoint)
 */
export function createOnchainIncidentEndpoint(listener) {
  return {
    /**
     * GET /api/incidents/onchain
     * Fetch recent onchain incidents with optional filters
     */
    async handler(req, res) {
      const { failureType, reporter, limit = 50 } = req.query;

      const filters = {};
      if (failureType) filters.failureType = failureType;
      if (reporter) filters.reporter = reporter;

      const incidents = listener.queryIncidentsFromDB(filters);
      const topFailures = await listener.getTopFailures(6);

      res.json({
        status: 'ok',
        incidents: incidents.slice(0, limit),
        topFailures,
        total: incidents.length
      });
    },

    /**
     * GET /api/incidents/onchain/:txHash
     * Fetch details for a specific onchain incident
     */
    async detailHandler(req, res) {
      const { txHash } = req.params;
      const incident = listener.getIncident(txHash) || listener.queryIncidentsFromDB()[0]; // demo

      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      res.json({ status: 'ok', incident });
    },

    /**
     * GET /api/failures/top
     * Fetch top failure types across all reported incidents
     */
    async topFailuresHandler(req, res) {
      const { limit = 6 } = req.query;
      const topFailures = await listener.getTopFailures(Math.min(limit, 6));
      res.json({ status: 'ok', topFailures });
    }
  };
}

/**
 * Example: Hook into your existing Express server
 */
export function mountOnchainRoutes(app, listener) {
  const endpoint = createOnchainIncidentEndpoint(listener);

  app.get('/api/incidents/onchain', endpoint.handler.bind(endpoint));
  app.get('/api/incidents/onchain/:txHash', endpoint.detailHandler.bind(endpoint));
  app.get('/api/failures/top', endpoint.topFailuresHandler.bind(endpoint));

  console.log('[API] Mounted onchain incident routes');
}

export default { initOnchainIntegration, mountOnchainRoutes, createOnchainIncidentEndpoint };
