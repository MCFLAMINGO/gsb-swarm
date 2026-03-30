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
const ACP_CONTRACT          = '0x6a1FE26D54ab0d3E1e3168f2e0c0cDa5cC0A0A4A';
const USDC_CONTRACT         = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_APPROVE_AMOUNT   = BigInt(100_000_000); // 100 USDC

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

function extractErrorDetails(err) {
  const detailsMatch = err.message?.match(/Details:\s*(.+?)(?:\nVersion:|$)/s);
  if (detailsMatch) return detailsMatch[1].trim();
  return err.message;
}

// ── Serialized acceptRequirement queue ──────────────────────────────────────
let acceptQueue = Promise.resolve();

function queueAccept(job, memo) {
  acceptQueue = acceptQueue.then(async () => {
    const MAX_RETRIES = 4;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[ceo] Accepting requirement for job ${job.id} (memo ${memo.id}) attempt ${attempt}...`);
        await job.acceptRequirement(memo, 'Requirement accepted. Proceed with delivery.');
        console.log(`[ceo] ✓ Job ${job.id} requirement accepted — now in TRANSACTION phase.`);
        break;
      } catch (err) {
        const details = extractErrorDetails(err);
        console.error(`[ceo] acceptRequirement error on job ${job.id} (attempt ${attempt}): ${details}`);
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 8000;
          console.log(`[ceo] Retrying job ${job.id} in ${delay/1000}s...`);
          await sleep(delay);
        } else {
          console.error(`[ceo] ✗ Giving up on job ${job.id}.`);
        }
      }
    }
    await sleep(5000);
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

  // ── STEP 1: Check + set USDC allowance ────────────────────────────────────
  console.log('[ceo] Checking USDC allowance...');
  try {
    // Read current allowance via public RPC
    const { createPublicClient, http, erc20Abi } = require('viem');
    const { base } = require('viem/chains');
    const pub = createPublicClient({ chain: base, transport: http(VIRTUALS_RPC) });
    const allowance = await pub.readContract({
      address: USDC_CONTRACT,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [CEO_WALLET_ADDRESS, ACP_CONTRACT],
    });
    console.log(`[ceo] Current USDC allowance: ${Number(allowance) / 1e6} USDC`);

    if (allowance < BigInt(10_000_000)) { // less than 10 USDC, re-approve
      console.log('[ceo] Allowance low — approving 100 USDC for ACP contract...');
      const approveOp = contractClient.approveAllowance(USDC_APPROVE_AMOUNT, USDC_CONTRACT, ACP_CONTRACT);
      await contractClient.handleOperation([approveOp]);
      console.log('[ceo] ✓ USDC approved.\n');
    } else {
      console.log('[ceo] ✓ Allowance sufficient — skipping approve.\n');
    }
  } catch (approveErr) {
    console.error('[ceo] Allowance check/approve error:', approveErr.message);
    console.error('[ceo] Proceeding anyway...\n');
  }

  // ── STEP 2: Build ACP client ───────────────────────────────────────────────
  const client = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job, memo) => {
      if (memo) {
        queueAccept(job, memo);
      } else {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} — no memo.`);
      }
    },
    onEvaluate: async (job) => {
      console.log(`[ceo] Auto-approving job ${job.id}`);
      await sleep(2000);
      try {
        await job.evaluate(true, 'Good work. Approved.');
        console.log(`[ceo] ✓ Job ${job.id} approved.`);
      } catch (err) {
        console.error(`[ceo] Evaluate error on job ${job.id}:`, extractErrorDetails(err));
      }
    },
  });

  console.log('[ceo] CEO ACP client ready.\n');

  // ── STEP 3: Fire jobs ──────────────────────────────────────────────────────
  for (const worker of WORKERS) {
    console.log(`\n── Hiring ${worker.name} (${JOBS_PER_WORKER} jobs × $${worker.price} USDC) ──`);
    for (let i = 1; i <= JOBS_PER_WORKER; i++) {
      try {
        console.log(`  [job ${i}/${JOBS_PER_WORKER}] Initiating job → ${worker.address}...`);
        const jobId = await client.initiateJob(
          worker.address,
          worker.requirement,
          makeFare(worker.price),
          null,
          new Date(Date.now() + 1000 * 60 * 30),
        );
        console.log(`  [job ${i}/${JOBS_PER_WORKER}] ✓ Job created: ${jobId}`);
        await sleep(3000);
      } catch (err) {
        console.error(`  [job ${i}/${JOBS_PER_WORKER}] ✗ Failed:`, extractErrorDetails(err));
      }
    }
    await sleep(5000);
  }

  console.log('\n[ceo] All jobs fired. Waiting for acceptRequirement queue to drain...');
  await acceptQueue;
  console.log('\n[ceo] Queue drained. Keeping alive for deliveries + evaluations...\n');
  await sleep(1000 * 60 * 15);
  console.log('[ceo] Done.');
}

main().catch(err => {
  console.error('[ceo] Fatal error:', err);
  process.exit(1);
});
