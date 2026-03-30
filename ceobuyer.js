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

// ── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeFare(priceUsdc) {
  const baseUnits = Math.round(priceUsdc * 1_000_000);
  return new FareAmount(baseUnits, baseAcpConfig.baseFare);
}

function extractDetails(err) {
  const m = err?.message || '';
  const match = m.match(/Details:\s*(.+?)(?:\nVersion:|$)/s);
  return match ? match[1].trim() : m.split('\n')[0];
}

// ── Serialized payment queue ─────────────────────────────────────────────────
// payAndAcceptRequirement does: approveAllowance + signMemo + createMemo(→TRANSACTION)
// All are UserOps — must be serialized to avoid bundler nonce conflicts
let payQueue = Promise.resolve();

function queuePay(job) {
  payQueue = payQueue.then(async () => {
    const MAX_RETRIES = 4;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[ceo] payAndAcceptRequirement job ${job.id} attempt ${attempt}...`);
        await job.payAndAcceptRequirement('Requirement accepted. Please deliver.');
        console.log(`[ceo] ✓ Job ${job.id} paid + accepted → TRANSACTION phase.`);
        break;
      } catch (err) {
        const detail = extractDetails(err);
        console.error(`[ceo] payAndAccept error job ${job.id} attempt ${attempt}: ${detail}`);
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 10000;
          console.log(`[ceo] Retrying job ${job.id} in ${delay/1000}s...`);
          await sleep(delay);
        } else {
          console.error(`[ceo] ✗ Gave up on job ${job.id}.`);
        }
      }
    }
    await sleep(6000); // let bundler clear
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
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

    onNewTask: async (job, memo) => {
      // onNewTask fires when worker has posted their requirement memo (nextPhase=2).
      // Use payAndAcceptRequirement() — it finds the memo itself, approves USDC,
      // signs it, and advances the job to TRANSACTION phase in one batch UserOp.
      if (memo) {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} memo=${memo?.id} memoNextPhase=${memo?.nextPhase}`);
        queuePay(job);
      } else {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} — no memo to sign.`);
      }
    },

    onEvaluate: async (job) => {
      console.log(`[ceo] Auto-approving job ${job.id}`);
      await sleep(2000);
      try {
        await job.evaluate(true, 'Good work. Approved.');
        console.log(`[ceo] ✓ Job ${job.id} approved.`);
      } catch (err) {
        console.error(`[ceo] Evaluate error job ${job.id}:`, extractDetails(err));
      }
    },
  });

  console.log('[ceo] CEO client ready. Using payAndAcceptRequirement (approve+sign+advance).\n');

  // Fire jobs sequentially per worker
  for (const worker of WORKERS) {
    console.log(`\n── Hiring ${worker.name} (${JOBS_PER_WORKER} jobs × $${worker.price} USDC) ──`);
    for (let i = 1; i <= JOBS_PER_WORKER; i++) {
      try {
        console.log(`  [job ${i}/${JOBS_PER_WORKER}] Initiating → ${worker.address}...`);
        const jobId = await client.initiateJob(
          worker.address,
          worker.requirement,
          makeFare(worker.price),
          null,
          new Date(Date.now() + 1000 * 60 * 30),
        );
        console.log(`  [job ${i}/${JOBS_PER_WORKER}] ✓ Created: ${jobId}`);
        await sleep(3000);
      } catch (err) {
        console.error(`  [job ${i}/${JOBS_PER_WORKER}] ✗ Failed:`, extractDetails(err));
      }
    }
    await sleep(5000);
  }

  console.log('\n[ceo] All jobs fired. Waiting for payAndAccept queue to drain...');
  await payQueue;
  console.log('\n[ceo] Queue drained. Waiting for workers to deliver + CEO to evaluate...\n');
  await sleep(1000 * 60 * 15);
  console.log('[ceo] Done.');
}

main().catch(err => {
  console.error('[ceo] Fatal:', err);
  process.exit(1);
});
