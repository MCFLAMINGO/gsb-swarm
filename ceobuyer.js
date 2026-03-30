// CEO Buyer — fires test jobs at all 4 GSB workers to hit graduation thresholds
// Usage: node --experimental-require-module ceobuyer.js
require('dotenv').config();

const {
  AcpContractClient,
  baseAcpConfig,
  FareAmount,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

// ── RPC patch (same as acp.js) ──────────────────────────────────────────────
const VIRTUALS_RPC = baseAcpConfig.alchemyRpcUrl;
if (!baseAcpConfig.chain.rpcUrls.alchemy) {
  baseAcpConfig.chain.rpcUrls.alchemy = { http: [VIRTUALS_RPC] };
} else {
  baseAcpConfig.chain.rpcUrls.alchemy.http = [VIRTUALS_RPC];
}
baseAcpConfig.chain.rpcUrls.default.http = [VIRTUALS_RPC];
console.log('[ceo] RPC patched to Virtuals proxy:', VIRTUALS_RPC);

// ── Config ──────────────────────────────────────────────────────────────────
const CEO_ENTITY_ID      = 2;
const CEO_WALLET_ADDRESS = '0xf0d4832A4c2D33Faa1F655cd4dE5e7c551a0fE45';
const PRIVATE_KEY        = process.env.AGENT_WALLET_PRIVATE_KEY;

const WORKERS = [
  {
    name: 'GSB Token Analyst',
    address: '0xBF56F4EC74cC1aE19c48197Eb32066c8a85dEfda',
    price: 0.25,
    requirement: 'Analyze token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base',
  },
  {
    name: 'GSB Wallet Profiler',
    address: '0x730e371ff3E2277c36060748dd5207CEAF50701d',
    price: 0.50,
    requirement: 'Profile wallet 0x6dA1A9793Ebe96975c240501A633ab8B3c83D14A on Base',
  },
  {
    name: 'GSB Alpha Scanner',
    address: '0x2c87651012bFA0247Fe741448DEbBF06c1b5c906',
    price: 0.10,
    requirement: 'Scan Base chain for alpha signals now',
  },
  {
    name: 'GSB Thread Writer',
    address: '0x4ab8320491A1FD8396F7F23c212cd6fC978C8Ad0',
    price: 0.15,
    requirement: 'Write a crypto Twitter thread about $GSB Agent Gas Bible tokenized agent on Virtuals Protocol',
  },
];

const JOBS_PER_WORKER = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeFare(priceUsdc) {
  const baseUnits = Math.round(priceUsdc * 1_000_000);
  return new FareAmount(baseUnits, baseAcpConfig.baseFare);
}

async function main() {
  if (!PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set in env');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   GSB CEO BUYER — Graduation Job Firer           ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log('[ceo] Building ACP client for CEO (entity', CEO_ENTITY_ID, ')...');
  const contractClient = await AcpContractClient.build(
    PRIVATE_KEY,
    CEO_ENTITY_ID,
    CEO_WALLET_ADDRESS
  );
  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async () => {},
    onEvaluate: async (job) => {
      console.log(`[ceo] Auto-approving job ${job.id}`);
      try {
        await client.evaluateJob(job.id, true, 'Good work. Approved.');
        console.log(`[ceo] ✓ Job ${job.id} approved.`);
      } catch (err) {
        console.error(`[ceo] Evaluate error on job ${job.id}:`, err.message);
      }
    },
  });

  console.log('[ceo] CEO ACP client ready.\n');

  for (const worker of WORKERS) {
    console.log(`\n── Hiring ${worker.name} (${JOBS_PER_WORKER} jobs × $${worker.price} USDC) ──`);
    for (let i = 1; i <= JOBS_PER_WORKER; i++) {
      try {
        console.log(`  [job ${i}/${JOBS_PER_WORKER}] Initiating → ${worker.address}...`);
        const fare = makeFare(worker.price);
        const jobId = await client.initiateJob(
          worker.address,
          worker.requirement,
          fare,
          null,
          new Date(Date.now() + 1000 * 60 * 30),
        );
        console.log(`  [job ${i}/${JOBS_PER_WORKER}] ✓ Job created: ${jobId}`);
        if (i < JOBS_PER_WORKER) await sleep(5000);
      } catch (err) {
        console.error(`  [job ${i}/${JOBS_PER_WORKER}] ✗ Failed:`, err.message);
      }
    }
    await sleep(8000);
  }

  console.log('\n[ceo] All jobs fired. Listening for deliveries + auto-approving...\n');
  await sleep(1000 * 60 * 10);
  console.log('[ceo] Done.');
}

main().catch((err) => {
  console.error('[ceo] Fatal error:', err);
  process.exit(1);
});
