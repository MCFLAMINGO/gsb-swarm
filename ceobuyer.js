// CEO Buyer — orchestrates the GSB Intelligence Swarm
// Fires jobs at all 4 workers, reads their deliverables,
// synthesizes a GSB Intelligence Brief, and saves it to disk.
// Usage: node --experimental-require-module ceobuyer.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');

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
    role: 'token_analysis',
    address: '0xBF56F4EC74cC1aE19c48197Eb32066c8a85dEfda',
    price: 0.25,
    requirement: 'Analyze token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base',
  },
  {
    name: 'GSB Wallet Profiler',
    role: 'wallet_profile',
    address: '0x730e371ff3E2277c36060748dd5207CEAF50701d',
    price: 0.50,
    requirement: 'Profile wallet 0x6dA1A9793Ebe96975c240501A633ab8B3c83D14A on Base',
  },
  {
    name: 'GSB Alpha Scanner',
    role: 'alpha_signals',
    address: '0x2c87651012bFA0247Fe741448DEbBF06c1b5c906',
    price: 0.10,
    requirement: 'Scan Base chain for alpha signals now',
  },
  {
    name: 'GSB Thread Writer',
    role: 'thread',
    address: '0x4ab8320491A1FD8396F7F23c212cd6fC978C8Ad0',
    price: 0.15,
    requirement: 'Write a crypto Twitter thread about $GSB Agent Gas Bible tokenized agent on Virtuals Protocol',
  },
];

const JOBS_PER_WORKER = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeFare(p) {
  return new FareAmount(p, baseAcpConfig.baseFare);
}

// ── Deliverable store — keyed by jobId ──────────────────────────────────────
const deliverables = new Map(); // jobId → { workerName, role, data }

// ── Serialized accept queue ──────────────────────────────────────────────────
let acceptQueue = Promise.resolve();

function queueAccept(job, memo) {
  acceptQueue = acceptQueue.then(async () => {
    const MAX_RETRIES = 4;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[ceo] acceptRequirement job ${job.id} memo ${memo.id} attempt ${attempt}...`);
        await job.acceptRequirement(memo, 'Requirement accepted. Proceed with delivery.');
        console.log(`[ceo] ✓ Job ${job.id} → TRANSACTION phase.`);
        break;
      } catch (err) {
        console.error(`\n[ceo] === ERROR job ${job.id} attempt ${attempt} ===`);
        console.error(err.stack || err.message);
        console.error(`[ceo] === END ERROR ===\n`);
        if (attempt < MAX_RETRIES) {
          await sleep(attempt * 8000);
        } else {
          console.error(`[ceo] ✗ Gave up job ${job.id}.`);
        }
      }
    }
    await sleep(5000);
  });
}

// ── Parse a worker deliverable payload ──────────────────────────────────────
function parseDeliverable(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === 'object') return rawValue;
  try { return JSON.parse(rawValue); } catch { return { raw: rawValue }; }
}

// ── Build the GSB Intelligence Brief from all deliverables ──────────────────
function buildBrief(results) {
  const ts = new Date().toISOString();
  const lines = [];

  lines.push('╔══════════════════════════════════════════════════════════╗');
  lines.push('║          GSB INTELLIGENCE BRIEF                          ║');
  lines.push(`║          ${ts}          ║`);
  lines.push('╚══════════════════════════════════════════════════════════╝');
  lines.push('');

  // ── Token Analysis ──
  const tokenData = results.token_analysis;
  if (tokenData && !tokenData.error) {
    lines.push('── TOKEN ANALYSIS ─────────────────────────────────────────');
    lines.push(`  Token:       ${tokenData.token?.name} (${tokenData.token?.symbol})`);
    lines.push(`  Price:       $${tokenData.price?.usd} (${tokenData.price?.change_24h > 0 ? '+' : ''}${tokenData.price?.change_24h}% 24h)`);
    lines.push(`  Liquidity:   $${Number(tokenData.liquidity_usd).toLocaleString()}`);
    lines.push(`  Volume 24h:  $${Number(tokenData.volume_24h).toLocaleString()}`);
    lines.push(`  Market Cap:  $${Number(tokenData.market_cap).toLocaleString()}`);
    lines.push(`  Verdict:     ${tokenData.gsb_verdict}`);
    lines.push(`  DexScreener: ${tokenData.dexscreener_url}`);
  } else if (tokenData?.error) {
    lines.push('── TOKEN ANALYSIS ─────────────────────────────────────────');
    lines.push(`  Error: ${tokenData.error}`);
  }
  lines.push('');

  // ── Wallet Profile ──
  const walletData = results.wallet_profile;
  if (walletData && !walletData.error) {
    lines.push('── WALLET PROFILE ──────────────────────────────────────────');
    lines.push(`  Wallet:       ${walletData.wallet}`);
    lines.push(`  Tx Count:     ${walletData.transaction_count}`);
    lines.push(`  Class:        ${walletData.classification}`);
    if (walletData.recent_transactions?.length > 0) {
      lines.push(`  Recent txs:`);
      walletData.recent_transactions.slice(0, 3).forEach(tx => {
        lines.push(`    ${tx.hash?.slice(0,18)}…  ${tx.value_eth} ETH  (${tx.age_days}d ago)`);
      });
    }
    lines.push(`  BaseScan:     ${walletData.basescan_url}`);
  } else if (walletData?.error) {
    lines.push('── WALLET PROFILE ──────────────────────────────────────────');
    lines.push(`  Error: ${walletData.error}`);
  }
  lines.push('');

  // ── Alpha Signals ──
  const alphaData = results.alpha_signals;
  if (alphaData && !alphaData.error) {
    lines.push('── ALPHA SIGNALS ───────────────────────────────────────────');
    lines.push(`  Signal:  ${alphaData.gsb_signal}`);
    if (alphaData.top_gainers_base?.length > 0) {
      lines.push(`  Top Gainers (Base):`);
      alphaData.top_gainers_base.forEach(g => {
        lines.push(`    ${g.symbol?.padEnd(10)} ${g.change_24h?.padStart(8)}  liq ${g.liquidity}  vol ${g.volume_24h}`);
      });
    }
    if (alphaData.boosted_tokens_base?.length > 0) {
      lines.push(`  Boosted Tokens (Base):`);
      alphaData.boosted_tokens_base.slice(0, 3).forEach(b => {
        lines.push(`    ${b.address?.slice(0,18)}…  boost ${b.boostAmount}`);
      });
    }
  } else if (alphaData?.error) {
    lines.push('── ALPHA SIGNALS ───────────────────────────────────────────');
    lines.push(`  Error: ${alphaData.error}`);
  }
  lines.push('');

  // ── Thread ──
  const threadData = results.thread;
  if (threadData?.thread) {
    lines.push('── THREAD READY TO POST ────────────────────────────────────');
    lines.push('');
    lines.push(threadData.thread);
    lines.push('');
    lines.push(`  Generated: ${threadData.generated_at}`);
  }
  lines.push('');
  lines.push('── END OF BRIEF ────────────────────────────────────────────');

  return lines.join('\n');
}

async function main() {
  if (!PRIVATE_KEY) throw new Error('AGENT_WALLET_PRIVATE_KEY not set');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   GSB CEO — Intelligence Swarm Orchestrator      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Track which jobId belongs to which worker
  const jobWorkerMap = new Map(); // jobId → worker
  // Track deliverable results by role (last one wins per role)
  const briefResults = {};
  // Track completed evaluations
  let evaluatedCount = 0;
  const totalJobs = WORKERS.length * JOBS_PER_WORKER;

  console.log('[ceo] Building ACP client for CEO (entity', CEO_ENTITY_ID, ')...');
  const contractClient = await AcpContractClient.build(
    PRIVATE_KEY, CEO_ENTITY_ID, CEO_WALLET_ADDRESS
  );

  const client = new AcpClient({
    acpContractClient: contractClient,

    onNewTask: async (job, memo) => {
      if (memo) {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} memo=${memo.id} nextPhase=${memo.nextPhase}`);
        queueAccept(job, memo);
      } else {
        console.log(`[ceo] onNewTask job ${job.id} phase=${job.phase} — no memo.`);
      }
    },

    onEvaluate: async (job) => {
      console.log(`[ceo] Evaluating job ${job.id}...`);
      await sleep(2000);

      try {
        // ── Read the deliverable ──────────────────────────────────────────
        const worker = jobWorkerMap.get(job.id);
        const memos = job.memos || [];

        // Find the DELIVER memo (nextPhase = EVALUATION = 3)
        const deliverMemo = memos.find(m => m.nextPhase === 3 || m.nextPhase === 'EVALUATION');
        const rawValue = deliverMemo?.content ?? memos[memos.length - 1]?.content;
        const parsed = parseDeliverable(rawValue);

        if (worker && parsed) {
          console.log(`\n[ceo] ── Deliverable from ${worker.name} (job ${job.id}) ──`);
          if (parsed.raw) {
            console.log(parsed.raw.slice(0, 400));
          } else {
            console.log(JSON.stringify(parsed, null, 2).slice(0, 800));
          }
          console.log('[ceo] ──────────────────────────────────────────────────\n');

          // Store for brief (always overwrite — last delivery is freshest)
          briefResults[worker.role] = parsed;
        } else {
          console.log(`[ceo] Job ${job.id} — no deliverable parsed (worker=${worker?.name}, memos=${memos.length})`);
        }

        await job.evaluate(true, 'Intelligence received. Brief updated.');
        console.log(`[ceo] ✓ Job ${job.id} approved.`);
        evaluatedCount++;

        // ── Print + save brief after the last job of each round ──────────
        if (evaluatedCount % WORKERS.length === 0) {
          const filledRoles = Object.keys(briefResults).length;
          if (filledRoles > 0) {
            const brief = buildBrief(briefResults);
            console.log('\n' + brief + '\n');

            // Save to disk
            const outDir = path.join(__dirname, 'briefs');
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const filename = `brief-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            const filepath = path.join(outDir, filename);
            fs.writeFileSync(filepath, brief, 'utf8');
            console.log(`[ceo] Brief saved → ${filepath}\n`);
          }
        }
      } catch (err) {
        console.error(`[ceo] Evaluate error job ${job.id}:`, err.message);
        // Still approve so job completes
        try { await job.evaluate(true, 'Approved.'); } catch (_) {}
      }
    },
  });

  console.log('[ceo] Ready. Firing jobs at all 4 workers.\n');

  // ── Fire all jobs ────────────────────────────────────────────────────────
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
        jobWorkerMap.set(jobId, worker);
        console.log(`  [${i}/${JOBS_PER_WORKER}] ✓ Job: ${jobId}`);
        await sleep(3000);
      } catch (err) {
        console.error(`  [${i}/${JOBS_PER_WORKER}] ✗`, err.message);
      }
    }
    await sleep(5000);
  }

  console.log('\n[ceo] All fired. Draining acceptRequirement queue...');
  await acceptQueue;
  console.log('\n[ceo] Queue done. Waiting 15 min for deliveries + evaluations...\n');
  await sleep(1000 * 60 * 15);

  // ── Final brief if anything came in ─────────────────────────────────────
  if (Object.keys(briefResults).length > 0) {
    const brief = buildBrief(briefResults);
    console.log('\n══ FINAL GSB INTELLIGENCE BRIEF ══\n');
    console.log(brief);
    const outDir = path.join(__dirname, 'briefs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const filename = `brief-final-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    fs.writeFileSync(path.join(outDir, filename), brief, 'utf8');
    console.log(`[ceo] Final brief saved → briefs/${filename}`);
  }

  console.log('[ceo] Done.');
}

main().catch(err => { console.error('[ceo] Fatal:', err); process.exit(1); });
