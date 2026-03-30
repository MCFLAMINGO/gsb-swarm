// CEO DEBUG — print the full underlying error from acceptRequirement
require('dotenv').config();

const {
  AcpContractClient,
  baseAcpConfig,
  FareAmount,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

// RPC patch
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

function makeFare(priceUsdc) {
  const baseUnits = Math.round(priceUsdc * 1_000_000);
  return new FareAmount(baseUnits, baseAcpConfig.baseFare);
}

async function main() {
  if (!PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  console.log('\n[debug] Building CEO ACP client...');
  const contractClient = await AcpContractClient.build(
    PRIVATE_KEY,
    CEO_ENTITY_ID,
    CEO_WALLET_ADDRESS
  );

  let capturedJob = null;
  let capturedMemo = null;

  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job, memo) => {
      if (memo && !capturedJob) {
        capturedJob = job;
        capturedMemo = memo;
        console.log(`[debug] Captured job ${job.id} with memo ${memo.id} — will attempt acceptRequirement`);
      }
    },
    onEvaluate: async () => {},
  });

  console.log('[debug] CEO client ready. Firing ONE test job at Token Analyst...');

  const jobId = await client.initiateJob(
    '0xBF56F4EC74cC1aE19c48197Eb32066c8a85dEfda',
    'DEBUG: Analyze token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base',
    makeFare(0.25),
    null,
    new Date(Date.now() + 1000 * 60 * 30),
  );
  console.log(`[debug] Job created: ${jobId}. Waiting for worker to respond...`);

  // Wait up to 60 seconds for memo
  for (let i = 0; i < 30; i++) {
    if (capturedJob) break;
    await sleep(2000);
  }

  if (!capturedJob) {
    console.log('[debug] Timed out waiting for worker response (no onNewTask callback)');
    process.exit(0);
  }

  console.log(`\n[debug] Calling acceptRequirement on job ${capturedJob.id}...`);
  try {
    await capturedJob.acceptRequirement(capturedMemo, 'Debug acceptance');
    console.log('[debug] ✓ SUCCESS — acceptRequirement worked!');
  } catch (err) {
    console.error('\n[debug] FULL ERROR:');
    console.error('  name:', err.name);
    console.error('  message:', err.message);
    console.error('  stack:', err.stack);
    if (err.cause) console.error('  cause:', err.cause);
    // Print the entire error object
    console.error('\n[debug] JSON.stringify error:');
    try {
      console.error(JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    } catch (e) {
      console.error('  (circular)');
    }
  }

  await sleep(3000);
  process.exit(0);
}

main().catch(err => {
  console.error('[debug] Fatal:', err);
  process.exit(1);
});
