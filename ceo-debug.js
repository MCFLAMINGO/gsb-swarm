// CEO DEBUG v2 — test acceptRequirement with full error detail + USDC already approved
require('dotenv').config();

const {
  AcpContractClient,
  baseAcpConfig,
  FareAmount,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

const VIRTUALS_RPC = baseAcpConfig.alchemyRpcUrl;
if (!baseAcpConfig.chain.rpcUrls.alchemy) {
  baseAcpConfig.chain.rpcUrls.alchemy = { http: [VIRTUALS_RPC] };
} else {
  baseAcpConfig.chain.rpcUrls.alchemy.http = [VIRTUALS_RPC];
}
baseAcpConfig.chain.rpcUrls.default.http = [VIRTUALS_RPC];

const CEO_ENTITY_ID      = 2;
const CEO_WALLET_ADDRESS = '0xf0d4832A4c2D33Faa1F655cd4dE5e7c551a0fE45';
const PRIVATE_KEY        = process.env.AGENT_WALLET_PRIVATE_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function makeFare(p) { return new FareAmount(Math.round(p * 1_000_000), baseAcpConfig.baseFare); }

async function main() {
  if (!PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  console.log('[debug] Building CEO ACP client...');
  const contractClient = await AcpContractClient.build(PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS);

  let capturedJob = null;
  let capturedMemo = null;

  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job, memo) => {
      if (memo && !capturedJob) {
        capturedJob = job;
        capturedMemo = memo;
        console.log(`[debug] Captured job ${job.id} memo ${memo.id} phase=${job.phase}`);
        console.log(`[debug] job keys:`, Object.keys(job));
        console.log(`[debug] memo keys:`, Object.keys(memo));
        console.log(`[debug] job.budget:`, job.budget);
        console.log(`[debug] job.priceValue:`, job.priceValue);
        console.log(`[debug] job.priceType:`, job.priceType);
        console.log(`[debug] memo.content:`, memo.content);
        console.log(`[debug] memo.type:`, memo.type);
        console.log(`[debug] memo.nextPhase:`, memo.nextPhase);
      }
    },
    onEvaluate: async () => {},
  });

  console.log('[debug] Firing ONE job at Token Analyst...');
  const jobId = await client.initiateJob(
    '0xBF56F4EC74cC1aE19c48197Eb32066c8a85dEfda',
    'DEBUG: Analyze token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base',
    makeFare(0.25),
    null,
    new Date(Date.now() + 1000 * 60 * 30),
  );
  console.log(`[debug] Job created: ${jobId}. Waiting for worker response...`);

  for (let i = 0; i < 30; i++) {
    if (capturedJob) break;
    await sleep(2000);
  }

  if (!capturedJob) {
    console.log('[debug] Timed out — no onNewTask callback received.');
    process.exit(0);
  }

  console.log(`\n[debug] Calling acceptRequirement...`);
  try {
    await capturedJob.acceptRequirement(capturedMemo, 'Debug acceptance');
    console.log('[debug] ✓ SUCCESS!');
  } catch (err) {
    console.error('[debug] FULL ERROR name:', err.name);
    console.error('[debug] FULL ERROR message:', err.message);
    // Extract the innermost "Details:" line
    const detailsMatch = err.message.match(/Details:\s*(.+)/);
    if (detailsMatch) console.error('[debug] DETAILS:', detailsMatch[1]);
    const stackLines = err.stack?.split('\n') || [];
    const causedBy = stackLines.findIndex(l => l.includes('Caused by'));
    if (causedBy >= 0) {
      console.error('[debug] CAUSED BY:');
      stackLines.slice(causedBy, causedBy + 10).forEach(l => console.error('  ', l));
    }
  }

  await sleep(3000);
  process.exit(0);
}

main().catch(err => { console.error('[debug] Fatal:', err); process.exit(1); });
