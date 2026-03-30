// CEO Buyer — fires test jobs at all 4 GSB workers to hit graduation thresholds
// Usage: node --experimental-require-module ceobuyer.js
require('dotenv').config();

const {
  AcpContractClient,
  baseAcpConfig,
  FareAmount,
  default: AcpClient,
} = require('@virtuals-protocol/acp-node');

// ── RPC patch ──────────────────────────────────────────────────────────────
const VIRTUALS_RPC = baseAcpConfig.alchemyRpcUrl;
if (!baseAcpConfig.chain.rpcUrls.alchemy) {
  baseAcpConfig.chain.rpcUrls.alchemy = { http: [VIRTUALS_RPC] };
} else {
  baseAcpConfig.chain.rpcUrls.alchemy.http = [VIRTUALS_RPC];
}
baseAcpConfig.chain.rpcUrls.default.http = [VIRTUALS_RPC];

// ── Config ──────────────────────────────────────────────────────────────────
const CEO_ENTITY_ID         = 2;
const CEO_WALLET_ADDRESS    = '0xf0d4832A4c2D33Faa1F655cd4dE5e7c551a0fE45';
const PRIVATE_KEY           = process.env.AGENT_WALLET_PRIVATE_KEY;

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
function makeFare(p) {
  return new FareAmount(Math.round(p * 1_000_000), baseAcpConfig.baseFare);
}

// ── Serialized queue ─────────────────────────────────────────────────────────
let payQueue = Promise.resolve();

function queuePay(job) {
  payQueue = payQueue.then(async () => {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[ceo] payAndAcceptRequirement job ${job.id} attempt ${attempt}...`);
        await job.payAndAcceptRequirement('Requirement accepted. Please deliver.');
        console.log(`[ceo] ✓ Job ${job.id} → TRANSACTION phase.`);
        break;
      } catch (err) {
        // Print the FULL raw stack so we can see the Details: line
        console.error(`\n[ceo] === ERROR job ${job.id} attempt ${attempt} ===`);
        console.error(err.stack || err.message);
        console.error(`[ceo] === END ERROR ===\n`);
        if (attempt < MAX_RETRIES) {
          await sleep(attempt * 10000);
        } else {
          console.error(`[ceo] ✗ Gave up job ${job.id}.`);
        }
      }
    }
    await sleep(6000);
  });
}

async function main() {
  if (!PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   GSB CEO BUYER — Graduation Job Firer           ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log('[ceo] Building ACP client for CEO (entity', CEO_ENTITY_ID, ')...');
  const contractClient = await AcpContractClient.build(
    PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS
  );

  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job, memo) => {
      if (memo) {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} memo=${memo?.id} nextPhase=${memo?.nextPhase}`);
        queuePay(job);
      } else {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} — no memo.`);
      }
    },
    onEvaluate: async (job) => {
      console.log(`[ceo] Evaluating job ${job.id}...`);
      await sleep(2000);
      try {
        await job.evaluate(true, 'Good work. Approved.');
        console.log(`[ceo] ✓ Job ${job.id} approved.`);
      } catch (err) {
        console.error(`[ceo] Evaluate error job ${job.id}:`, err.message);
      }
    },
  });

  console.log('[ceo] Ready.\n');

  for (const worker of WORKERS) {
    console.log(`\n── Hiring ${worker.name} (${JOBS_PER_WORKER} × $${worker.price} USDC) ──`);
    for (let i = 1; i <= JOBS_PER_WORKER; i++) {
      try {
        console.log(`  [${i}/${JOBS_PER_WORKER}] → ${worker.address}...`);
        const jobId = await client.initiateJob(
          worker.address, worker.requirement,
          makeFare(worker.price), null,
          new Date(Date.now() + 1000 * 60 * 30),
        );
        console.log(`  [${i}/${JOBS_PER_WORKER}] ✓ Job: ${jobId}`);
        await sleep(3000);
      } catch (err) {
        console.error(`  [${i}/${JOBS_PER_WORKER}] ✗`, err.message);
      }
    }
    await sleep(5000);
  }

  console.log('\n[ceo] All fired. Draining queue...');
  await payQueue;
  console.log('\n[ceo] Queue done. Waiting for deliveries...\n');
  await sleep(1000 * 60 * 15);
  console.log('[ceo] Done.');
}

main().catch(err => { console.error('[ceo] Fatal:', err); process.exit(1); });
