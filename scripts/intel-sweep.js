'use strict';
/**
 * intel-sweep.js — Scheduled ACP Agent Intelligence Sweep
 *
 * Each of the 5 ACP agents fires a `local_intel_ask` call through the x402
 * premium paywall ($0.05 USDC each → $0.25/sweep) using creative, hard-to-parse
 * natural language questions that exercise the full oracle stack.
 *
 * Demonstrates:
 *   - Agent-to-agent payment (each agent is an autonomous paying customer)
 *   - X-Caller header tagging for observability in /call-log
 *   - Rotation through ZIPs and verticals per sweep cycle
 *   - TREASURY revenue accumulation visible on basescan
 *
 * Usage:
 *   node scripts/intel-sweep.js              — runs one sweep now, then exits
 *   node scripts/intel-sweep.js --daemon     — runs continuously every 30 min
 *   node scripts/intel-sweep.js --dry-run    — logs what would run, no payments
 *
 * PKs: uses THROW_PLAYER_PK (PLAYER wallet, $9 USDC on Base) as signer for all
 *      agents until ACP SDK natively exposes EVM-compatible signing.
 *      Label each agent via X-Caller header so /call-log attributes correctly.
 *
 * Endpoint: POST /api/local-intel/mcp/x402/premium  ($0.05 each)
 */

const { createWalletClient, http, createPublicClient } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const { createPaymentHeader, selectPaymentRequirements } = require('x402/client');

// ── Config ─────────────────────────────────────────────────────────────────────
const BASE_URL      = process.env.MCP_BASE_URL || 'https://gsb-swarm-production.up.railway.app';
const PREMIUM_EP    = `${BASE_URL}/api/local-intel/mcp/x402/premium`;
const TREASURY      = '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';
const INTER_AGENT_DELAY_MS = 12_000; // 12s — let Base finalize EIP-3009 nonce before next agent
const SWEEP_INTERVAL_MS    = 30 * 60 * 1000; // 30 min daemon cadence

const IS_DAEMON  = process.argv.includes('--daemon');
const IS_DRY_RUN = process.argv.includes('--dry-run');

// ── ZIP rotation (cycle through all covered ZIPs, round-robin per sweep) ───────
const ZIP_ROTATION = [
  { zip: '32082', name: 'Ponte Vedra Beach' },
  { zip: '32081', name: 'Nocatee' },
  { zip: '32092', name: 'World Golf Village' },
  { zip: '32084', name: 'St. Augustine' },
  { zip: '32086', name: 'St. Augustine South' },
  { zip: '32095', name: 'Palm Valley' },
  { zip: '32259', name: 'Fruit Cove' },
  { zip: '32256', name: 'Baymeadows / Tinseltown' },
  { zip: '32250', name: 'Jacksonville Beach' },
  { zip: '32266', name: 'Neptune Beach' },
];

// ── Agent roster — each with a rotating pool of hard NL questions ──────────────
// Questions are intentionally difficult to parse — they use metaphor, inference,
// multi-hop reasoning, and indirect signals — the kind external LLMs would rather
// pay LocalIntel to answer than hallucinate. Each pool has 20 questions;
// the sweep picks one pseudo-randomly based on sweep cycle index.

const AGENTS = [
  {
    id:       '1332',
    name:     'GSB CEO',
    vertical: 'realtor',
    callerHeader: 'gsb-ceo-1332',
    questions: [
      // Hard realtor NL questions — indirect signals, multi-hop reasoning
      "If household income in Nocatee puts buyers in the $700k–$900k bracket, which price tier of restaurant is most likely to open within 18 months?",
      "A family relocating from Manhattan is considering 32082 vs 32081 — which ZIP has more walkable daily services and why?",
      "What's the fastest-growing neighborhood by business count in St Johns County and what does that signal for residential appreciation?",
      "I'm a real estate attorney scouting a second office. Where in 32082 is foot traffic highest based on business density?",
      "If the owner-occupancy rate in 32092 climbs from 65% to 80%, what categories of business should open there first to serve that shift?",
      "Where would you open a luxury dog grooming salon in St Johns County and which demographic data point makes you say that?",
      "What is the infrastructure momentum score for 32084 and does it suggest construction demand will rise or plateau in the next 2 years?",
      "A buyer wants walkable coffee + daycare + dentist all in one ZIP — which ZIP gets closest and how close is it really?",
      "What is the capture rate for food spending in World Golf Village and does the gap represent a real opening for a new concept?",
      "If you were advising a REIT on which of our covered ZIPs has the most commercial white space per capita, what would you tell them?",
      "Is Ponte Vedra Beach in the empty nest transition or still in family formation, and how does that change what retail should go there?",
      "Which ZIP in St Johns County has the highest median home value but the thinnest healthcare coverage — and what business does that unlock?",
      "A national franchise brand wants the ZIP with the most affluent, underserved retail customer base. Which one do I point them to?",
      "What school-adjacent business categories are most undersupplied in Nocatee given its family formation trajectory?",
      "How does the flood zone percentage in 32082 vs 32084 affect the buildable commercial area available for new tenants?",
      "If I overlay owner-occupancy rate with school count, which ZIP is most likely to see population growth in the next 3 years?",
      "What is the tidal direction for 32092 and does it suggest buyers are entering or exiting the market?",
      "Which corridor — A1A, CR-210, or Palm Valley Road — has the densest gap between business count and population demand?",
      "If the infrastructure momentum score in 32081 is above 50, what types of commercial tenants should be actively recruited now?",
      "What would a Bloomberg Terminal analyst say is the single best investment signal for 32082 right now?",
    ],
  },
  {
    id:       '1334',
    name:     'GSB Wallet Profiler',
    vertical: 'healthcare',
    callerHeader: 'gsb-wallet-profiler-1334',
    questions: [
      "If the senior population in 32082 is above 20%, how many home health agencies should the market support vs. how many actually exist?",
      "A telehealth platform wants to open a physical anchor location in St Johns County. Which ZIP gives them the highest income-to-patient ratio?",
      "What is the ratio of dentists to population in 32081 and does it indicate room for a boutique cosmetic dental practice?",
      "I'm a health insurance broker — which ZIP in our coverage has the highest concentration of affluent established patients with low physician density?",
      "Where is the physical therapy gap largest relative to the aging population demographic in St Johns County?",
      "If population growth in Nocatee is pulling young families, what pediatric healthcare services are currently absent?",
      "A mental health group practice wants to open its first St Johns County location. Which ZIP has the highest unmet demand signal?",
      "What's the median household income in 32086 and does it attract out-of-pocket-pay medical practices or insurance-dependent ones?",
      "If I'm a pharmacist evaluating 32092 vs 32084, which ZIP has more healthcare providers who could refer patients to a new pharmacy?",
      "Which of our covered ZIPs has urgent care deserts — meaning population over 10,000 with no walk-in clinic indexed?",
      "What wellness or fitness businesses are currently in 32082 and is there enough income density to support a premium medical spa?",
      "A vertically integrated dental chain wants the ZIP with the best income, lowest dentist-to-pop ratio, and growing family population. What's the answer?",
      "If the consumer profile in 32082 is affluent_established, what does that imply for direct-pay concierge medicine viability?",
      "Which St Johns County ZIP has the fastest-growing new resident base that drives new patient acquisition for primary care?",
      "What is the healthcare coverage gap index for 32092 — number of expected providers vs. number actually indexed?",
      "I want to open a sleep medicine clinic. Which ZIP has the highest concentration of high-income, high-stress professionals who are potential patients?",
      "Is there an optometry gap in 32084 vs 32081 given comparable income levels? Which ZIP should I enter first?",
      "What age distribution signals in 32086 suggest the highest utilization of orthopedic or spine care services?",
      "A hospital system wants to scout micro-clinic locations. Which ZIP has the lowest provider-per-capita ratio across all healthcare categories?",
      "How does the population growth trajectory in 32081 vs 32082 affect 5-year patient volume projections for a new primary care group?",
    ],
  },
  {
    id:       '1335',
    name:     'GSB Alpha Scanner',
    vertical: 'construction',
    callerHeader: 'gsb-alpha-scanner-1335',
    questions: [
      "If the infrastructure momentum score in 32081 is above 60, how many additional HVAC contractors should the market be able to support?",
      "Which ZIP in our coverage has the most active new construction permits and is therefore the best target for a concrete supplier entering the market?",
      "A roofing company is deciding between 32082 and 32081 — which has higher home value density to justify premium roofing services?",
      "What new construction activity in World Golf Village creates demand for landscaping companies in the next 12 months?",
      "I'm a plumbing supply distributor. Which ZIP should I open my first warehouse in based on contractor density and new build volume?",
      "If owner-occupied housing stock in 32082 was built primarily in the 1990s, what home services category is most overdue for replacement cycles?",
      "What is the ratio of construction businesses to active permits in 32084 and does it suggest a labor shortage or oversupply?",
      "A national pest control franchise wants to enter St Johns County. Which ZIP has the best income + housing density + competition gap combination?",
      "Which corridor — A1A or CR-210 — has more active rooftops that need exterior maintenance services right now?",
      "If flood zone percentage in 32082 is above 30%, what categories of home services see elevated demand from flood remediation and prevention?",
      "What is the projected new household formation rate in Nocatee and how does it translate to annual pool installation demand?",
      "A window company wants to serve one ZIP in St Johns County first. Which ZIP has the oldest housing stock with the highest average home value?",
      "How many general contractors serve 32086 and what does the ratio of GCs to population suggest about subcontractor opportunity?",
      "I'm a painting contractor considering a territory expansion. Which covered ZIP has the highest density of homes over $600k with thin painting competition?",
      "What active road projects in 32092 suggest infrastructure build-out that will drive residential lot sales and new construction demand?",
      "A home inspection company wants the ZIP where turnover is highest — which covered ZIP has the best combination of resale volume signals?",
      "If 32081 is in active family formation, which home services categories get hired in the first 2 years after a family moves in?",
      "What is the infrastructure momentum delta between 32084 and 32092 — which is accelerating faster?",
      "A fire suppression contractor wants to target commercial new builds. Which ZIP has the most commercial permit activity vs. residential?",
      "If a framing subcontractor can only serve one ZIP, which one gives them the most consecutive years of work based on current pipeline signals?",
    ],
  },
  {
    id:       '1333',
    name:     'GSB Token Analyst',
    vertical: 'restaurant',
    callerHeader: 'gsb-token-analyst-1333',
    questions: [
      "If a restaurant at A1A and Palm Valley does $2.4M/year, is that above or below the median capture rate you'd expect given local meal demand?",
      "What is the caloric gap in 32082 — how many daily meals are going unserved by current restaurant inventory at the income-appropriate price tier?",
      "A James Beard-caliber chef wants to open in St Johns County. Based on income and existing supply, where does she have the highest probability of success?",
      "If Nocatee adds 3,000 new residents in 2026, what restaurant categories should open to serve them — and in what order of demand priority?",
      "Which ZIP in our coverage has the starkest gap between fine dining demand (per income) and fine dining supply (per indexed businesses)?",
      "I'm a franchise consultant. The client wants the ZIP where a fast casual concept can get to 400 covers/day fastest. Which ZIP wins?",
      "What is the tidal momentum for food investment in 32092 and does it suggest the window to enter is open or closing?",
      "A coffee roaster wants to open a flagship cafe. Which ZIP has the highest disposable income per capita with the fewest specialty coffee shops indexed?",
      "If the restaurant capture rate in 32084 is below 60%, what specific price tier is responsible for the biggest drag on that number?",
      "A ghost kitchen operator wants to set up in the ZIP with the biggest gap between food demand and current restaurant capacity. Which ZIP is it?",
      "What does the combination of owner-occupancy rate, school count, and median income in 32081 tell a restaurateur about their customer's dining behavior?",
      "Is there a brunch opportunity gap in Ponte Vedra Beach given income, owner-occupancy, and current breakfast/brunch indexed businesses?",
      "Which covered ZIP would an upscale sushi concept penetrate most successfully based on income tier, existing Japanese food gap, and population density?",
      "A national bar-and-grill chain wants one ZIP in St Johns County. Which has the best weeknight cover count potential based on population and competitor density?",
      "If food truck permitting opened up in 32082, would it represent an opportunity or add to an already saturated market? Use the capture rate to answer.",
      "What is the daily meal demand number for 32081 and how many additional restaurants would need to open to bring the capture rate to 85%?",
      "A beverage alcohol distributor wants to know which ZIP has the most licensed on-premise accounts relative to the size of the drinking-age population.",
      "Is the A1A corridor in 32082 oversupplied with restaurants or does foot traffic from beach tourism create absorptive capacity beyond resident meal demand?",
      "What combination of ZIP demographics, tidal direction, and price-tier gap makes the single strongest case for a new restaurant opening right now?",
      "A private equity firm wants to acquire a restaurant in the ZIP with the best 3-year demand outlook. Which ZIP do you hand them and what data backs it?",
    ],
  },
  {
    id:       '1336',
    name:     'GSB Thread Writer',
    vertical: 'retail',
    callerHeader: 'gsb-thread-writer-1336',
    questions: [
      "If 32082 is affluent_established, what luxury retail category is most absent relative to what that income tier would sustain in a comparably-sized market?",
      "A DTC brand wants to open its first physical location in St Johns County. Which ZIP has the best income, foot traffic signal, and retail gap combination?",
      "What is the capture rate for retail spending in 32081 and does the gap suggest residents are driving to Jacksonville for things they should be able to buy locally?",
      "I'm a wine bar operator. Which ZIP has the highest median income, lowest competition in wine/spirits, and strongest growth trajectory?",
      "If a national specialty grocer like Trader Joe's were scoring ZIPs in our coverage, which ZIP would score highest on their demographic criteria?",
      "What pet-related services are missing in Nocatee given the family formation demographic and above-average household income?",
      "A flooring company wants to co-locate near construction activity. Which ZIP has the best overlap between active construction permits and consumer spending power?",
      "Which covered ZIP has the thinnest apparel retail density relative to income level — meaning the best white space for a boutique clothing store?",
      "A bookstore-cafe hybrid concept is looking for a neighborhood feel. Which ZIP has the right income, walkability signal, and absence of existing bookstores?",
      "If the consumer profile in 32092 is mixed rather than affluent_established, what does that mean for which price tier of retail is most likely to succeed there?",
      "What convenience retail gaps exist in 32081 specifically — categories that residents search for that aren't indexed in our dataset?",
      "A hardware store chain wants the ZIP with the most homeowner density and least existing competition. Rank the top 3 based on our data.",
      "I'm launching a subscription box for golfers. Which of our ZIPs has the best combination of golf-adjacent demographics, income, and retailer void?",
      "What is the signal for a home goods store entering 32084 vs 32086 — income, homeowner rate, and infrastructure momentum compared?",
      "A national pharmacy chain is considering 32092 for expansion. What retail health and personal care gap does our data show for that ZIP?",
      "If Ponte Vedra Beach has an affluent_established profile, which premium retail categories are conspicuously absent that a national chain would assume should be there?",
      "What is the school-supply and children's education retail gap in Nocatee given its family formation demographic?",
      "A sporting goods retailer wants the ZIP most likely to support a premium outdoor and water sports concept. Which one and why?",
      "Which ZIP in our coverage has the highest income-to-retail-business-count ratio — meaning the most underretailed affluent consumer base?",
      "If I'm a site selector for a fast-fashion brand targeting 25–40 demographic, which ZIP has the income, growth trajectory, and retail gap that fits best?",
    ],
  },
];

// ── Sweep state (persists across daemon cycles) ────────────────────────────────
let sweepCycle = 0;

// ── x402 payment helper (premium endpoint) ────────────────────────────────────
async function callWithX402Premium(privateKey, agent, question, zip) {
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);

  const walletClient = createWalletClient({
    account,
    chain:     base,
    transport: http(),
  });

  const mcpBody = {
    jsonrpc: '2.0',
    id:      Date.now(),
    method:  'tools/call',
    params: {
      name:      'local_intel_ask',
      arguments: { question, zip },
    },
  };

  // Step 1: probe — expect 402
  const probeRes = await fetch(PREMIUM_EP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Caller':     agent.callerHeader,
      'X-Agent-Id':   agent.id,
      'User-Agent':   `LocalIntel-ACP-Agent/${agent.name}/1.0`,
    },
    body: JSON.stringify(mcpBody),
  });

  if (probeRes.status !== 402) {
    const data = await probeRes.json().catch(() => ({}));
    return { paid: false, status: probeRes.status, data };
  }

  // Step 2: parse payment requirements
  const payReq = await probeRes.json();
  const accepts = payReq?.accepts || payReq;
  const selected = selectPaymentRequirements(
    Array.isArray(accepts) ? accepts : [accepts],
    { network: 'base', scheme: 'exact' }
  );

  if (!selected) throw new Error('No Base/exact payment requirement found');

  // Step 3: sign EIP-3009 payment header
  const paymentHeader = await createPaymentHeader(walletClient, 1, selected);

  // Step 4: re-send with payment
  const paidRes = await fetch(PREMIUM_EP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PAYMENT':    paymentHeader,
      'X-Caller':     agent.callerHeader,
      'X-Agent-Id':   agent.id,
      'User-Agent':   `LocalIntel-ACP-Agent/${agent.name}/1.0`,
    },
    body: JSON.stringify(mcpBody),
  });

  const data = await paidRes.json();
  return { paid: true, status: paidRes.status, data };
}

// ── USDC balance helper ────────────────────────────────────────────────────────
async function getUSDCBalance(address) {
  const pub = createPublicClient({ chain: base, transport: http() });
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  try {
    const bal = await pub.readContract({
      address: USDC,
      abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
              inputs: [{ name: 'account', type: 'address' }],
              outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [address],
    });
    return (Number(bal) / 1e6).toFixed(4);
  } catch { return 'unknown'; }
}

// ── Single sweep ───────────────────────────────────────────────────────────────
async function runSweep() {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const zipEntry = ZIP_ROTATION[sweepCycle % ZIP_ROTATION.length];
  const { zip, name: zipName } = zipEntry;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  LocalIntel Intel Sweep  •  Cycle ${String(sweepCycle + 1).padEnd(3)} •  ZIP ${zip} ${zipName.padEnd(20)}║`);
  console.log(`║  ${ts} UTC${IS_DRY_RUN ? '  [DRY RUN — no payments]' : '  → ' + PREMIUM_EP}    ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const pk = process.env.THROW_PLAYER_PK;
  if (!pk && !IS_DRY_RUN) {
    console.error('ERROR: THROW_PLAYER_PK not set. Set it in env or Railway vars.');
    return;
  }

  const treasuryBefore = IS_DRY_RUN ? 'n/a' : await getUSDCBalance(TREASURY);
  if (!IS_DRY_RUN) console.log(`  TREASURY before: $${treasuryBefore} USDC\n`);

  const results = [];

  for (const agent of AGENTS) {
    // Rotate question: use (sweepCycle * AGENTS.length + agentIndex) mod pool size
    const agentIdx   = AGENTS.indexOf(agent);
    const questionIdx = (sweepCycle * AGENTS.length + agentIdx) % agent.questions.length;
    const question   = `${agent.questions[questionIdx]} (ZIP ${zip})`;

    process.stdout.write(`  [${agent.name}] ${agent.questions[questionIdx].slice(0, 80)}...\n  → `);

    if (IS_DRY_RUN) {
      console.log(`DRY RUN — would call local_intel_ask via x402 premium ($0.05)`);
      results.push({ agent: agent.name, status: 'DRY_RUN', question: agent.questions[questionIdx].slice(0, 60), zip });
      continue;
    }

    try {
      const { paid, status, data } = await callWithX402Premium(pk, agent, question, zip);

      const content  = data?.result?.content?.[0]?.text;
      let parsed = null;
      try { parsed = JSON.parse(content); } catch { parsed = null; }

      const score   = parsed?.confidence_score ?? '—';
      const intent  = parsed?.intent           ?? '—';
      const answer  = parsed?.answer ? String(parsed.answer).slice(0, 80) + '…' : '—';
      const latency = data?.result?._meta?.latency_ms ?? '—';

      const icon = status === 200 ? '✅' : '❌';
      console.log(`${icon} ${status} · paid=${paid} · intent=${intent} · score=${score} · ${latency}ms`);
      console.log(`     answer: ${answer}\n`);

      results.push({
        agent:    agent.name,
        vertical: agent.vertical,
        zip,
        paid,
        status:   status === 200 ? 'PASS' : 'FAIL',
        intent,
        score,
        latency,
        question: agent.questions[questionIdx].slice(0, 60),
      });

    } catch (err) {
      console.log(`❌ ERROR: ${err.message}\n`);
      results.push({ agent: agent.name, status: 'ERROR', error: err.message, zip });
    }

    // Wait for Base to finalize nonce before next agent
    if (AGENTS.indexOf(agent) < AGENTS.length - 1) {
      await new Promise(r => setTimeout(r, INTER_AGENT_DELAY_MS));
    }
  }

  // Summary
  const treasuryAfter = IS_DRY_RUN ? 'n/a' : await getUSDCBalance(TREASURY);
  const passes = results.filter(r => r.status === 'PASS').length;
  const paid   = results.filter(r => r.paid).length;
  const delta  = IS_DRY_RUN ? 'n/a' : (parseFloat(treasuryAfter) - parseFloat(treasuryBefore)).toFixed(4);

  console.log('── Sweep Results ─────────────────────────────────────────────');
  console.table(results.map(r => ({
    Agent:    r.agent,
    ZIP:      r.zip,
    Vertical: r.vertical,
    Paid:     r.paid ? 'yes' : IS_DRY_RUN ? 'dry' : 'no',
    Status:   r.status,
    Intent:   r.intent,
    Score:    r.score,
    'ms':     r.latency,
  })));

  if (!IS_DRY_RUN) {
    console.log('\n── Revenue ──────────────────────────────────────────────────');
    console.log(`  TREASURY before : $${treasuryBefore} USDC`);
    console.log(`  TREASURY after  : $${treasuryAfter} USDC`);
    console.log(`  Delta           : +$${delta} USDC  (${paid} payments × $0.05)`);
    console.log(`  Basescan        : https://basescan.org/address/${TREASURY}`);
  }

  console.log(`\n  ${passes}/${AGENTS.length} passed · Smithery: https://smithery.ai/servers/erik-7clt/local-intel`);
  console.log(`  Revenue page: https://swarm-deploy-throw.vercel.app/local-intel/revenue\n`);

  sweepCycle++;
  return results;
}

// ── Entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (IS_DRY_RUN) {
    console.log('\n[intel-sweep] DRY RUN mode — no payments will be made\n');
  }

  await runSweep();

  if (IS_DAEMON) {
    console.log(`[intel-sweep] Daemon mode — next sweep in ${SWEEP_INTERVAL_MS / 60000} min\n`);
    setInterval(async () => {
      try {
        await runSweep();
      } catch (err) {
        console.error('[intel-sweep] Sweep error:', err.message);
      }
    }, SWEEP_INTERVAL_MS);
    // Keep process alive
    process.stdin.resume();
  }
}

main().catch(err => {
  console.error('[intel-sweep] Fatal:', err.message);
  process.exit(1);
});
