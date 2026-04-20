'use strict';
/**
 * ACP Resource Registration — GSB Swarm
 *
 * Registers external data feeds and tools as ACP Resources on the Virtuals
 * marketplace so other agents (yours or external) can discover and pay for them.
 *
 * Called once at startup from index.js after agents are online.
 *
 * Resources registered:
 *   1. THROW Watcher — live Tempo on-chain transfer surveillance data feed
 *   2. GSB Skill Report — live agent skill confidence scores (free, public)
 *
 * The CEO agent wallet is used as the resource owner (it's the primary identity).
 * Resources are registered against CEO's ACP agent on Virtuals.
 *
 * Auth: delegates to acpAuth.js → getValidToken().
 * acpAuth handles expiry detection and auto-refresh. No manual token management needed.
 * Set VIRTUALS_PRIVY_REFRESH_TOKEN in Railway for zero-downtime token renewal.
 */

const { getValidToken } = require('./acpAuth');
const ACP_SERVER = 'https://api.acp.virtuals.io';

// Agent ID for CEO on Virtuals (UUID from app.virtuals.io URL)
// From screenshot: 019d7568-cd41-7523-9538-e501cc1875cc
const CEO_AGENT_ID = process.env.CEO_ACP_AGENT_ID || '019d7568-cd41-7523-9538-e501cc1875cc';

const RESOURCES = [
  {
    name: 'THROW Watcher — Live Chain Data',
    description:
      'Real-time Tempo blockchain surveillance for the THROW betting app. ' +
      'Returns live transfer events, wallet activity, bet signals, and on-chain ' +
      'pattern data. Pay-per-call via ACP escrow. Any agent can subscribe to ' +
      'specific wallet addresses or event types. Ideal for: MEV bots, risk monitors, ' +
      'portfolio trackers, and custom alert agents.',
    url: process.env.THROW_WATCHER_URL || 'https://throw-watcher-production.up.railway.app',
    params: {
      type: 'object',
      description: 'Query parameters for THROW Watcher data feed',
      properties: {
        endpoint: {
          type: 'string',
          enum: ['transfers', 'bets', 'wallets', 'patterns'],
          description: 'Data feed type: transfers (all Tempo transfers), bets (THROW poker events), wallets (specific address activity), patterns (volume/frequency anomalies)',
        },
        walletAddress: {
          type: 'string',
          description: 'Specific wallet to watch (optional — omit for global feed)',
        },
        since: {
          type: 'number',
          description: 'Unix timestamp — only return events after this time',
        },
        limit: {
          type: 'number',
          description: 'Max events to return (default 50, max 200)',
        },
      },
      required: ['endpoint'],
    },
  },
  {
    name: 'GSB Skill Confidence Report',
    description:
      'Live agent skill performance report for the MCFLAMINGO GSB Swarm. ' +
      'Returns current confidence scores, success rates, average execution time, ' +
      'and failure hints for all 27 skills across 5 agents. ' +
      'Free to query — use to route jobs to the best-performing agent for any task.',
    url: process.env.GSB_SWARM_URL || 'https://gsb-swarm-production.up.railway.app',
    params: {
      type: 'object',
      properties: {
        agentName: {
          type: 'string',
          description: 'Filter to a specific agent (optional)',
        },
        status: {
          type: 'string',
          enum: ['DEGRADED', 'WEAK', 'OK', 'STRONG'],
          description: 'Filter by confidence tier (optional)',
        },
      },
    },
  },
];

async function registerResources() {
  const jwt = await getValidToken();
  if (!jwt) {
    console.log('[acpResources] No valid ACP token — skipping ACP resource registration.');
    console.log('[acpResources] See acpAuth.js instructions to set VIRTUALS_PRIVY_REFRESH_TOKEN in Railway.');
    return;
  }

  console.log('[acpResources] Registering resources on Virtuals ACP marketplace...');

  for (const resource of RESOURCES) {
    try {
      // Check if resource already exists
      const listRes = await fetch(`${ACP_SERVER}/agents/${CEO_AGENT_ID}/resources`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      if (listRes.ok) {
        const existing = await listRes.json();
        const alreadyExists = (existing.data || []).find(r => r.name === resource.name);
        if (alreadyExists) {
          console.log(`[acpResources] Already registered: "${resource.name}"`);
          continue;
        }
      }

      // Create the resource
      const createRes = await fetch(`${ACP_SERVER}/agents/${CEO_AGENT_ID}/resources`, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name:        resource.name,
          description: resource.description,
          url:         resource.url,
          params:      resource.params,
          hidden:      false,
        }),
      });

      if (createRes.ok) {
        const created = await createRes.json();
        console.log(`[acpResources] ✅ Registered: "${resource.name}" (ID: ${created.data?.id || '?'})`);
      } else {
        const err = await createRes.text();
        console.warn(`[acpResources] ⚠️ Failed to register "${resource.name}": ${createRes.status} ${err.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[acpResources] Error registering "${resource.name}":`, err.message);
    }
  }

  console.log('[acpResources] Resource registration complete.');
}

module.exports = { registerResources };
