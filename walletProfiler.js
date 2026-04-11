require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { buildAcpAgent, AssetToken } = require('./acp');
const { CHAIN_CONFIG, resolveChain, SUPPORTED_CHAINS } = require('./chains');

const AGENT_NAME = 'GSB Wallet Profiler & DCA Engine';

// ── Skill Registry ───────────────────────────────────────────────────────────
function loadSkills(workerName) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));
    return registry[workerName] || [];
  } catch (e) {
    console.warn('[skills] Could not load skills.json, using defaults');
    return [];
  }
}

function parseJobRequirement(requirement) {
  try {
    const parsed = JSON.parse(requirement);
    if (parsed.skillId) return parsed;
  } catch {}
  if (typeof requirement === 'string' && requirement.includes('skillId:')) {
    const parts = requirement.split(/\s+/);
    const result = {};
    parts.forEach(part => {
      const [key, ...rest] = part.split(':');
      if (key && rest.length) result[key] = rest.join(':');
    });
    if (result.skillId) return { skillId: result.skillId, params: result };
  }
  return { skillId: null, params: {}, rawText: requirement };
}

function executeSkillInstruction(skill, params) {
  let instruction = skill.instruction;
  Object.entries(params).forEach(([key, val]) => {
    instruction = instruction.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
  });
  return instruction;
}
const JOB_PRICE = 0.50;

// ── Job requirements JSON schema ──────────────────────────────────────────────
const EVM_CHAINS = SUPPORTED_CHAINS.filter(c => CHAIN_CONFIG[c].isEVM);

const REQUIREMENTS_SCHEMA = {
  name: 'GSB Wallet Profiler & DCA Engine',
  description: `Profiles EVM wallets AND executes DCA buys on Base via Uniswap v3. Skills: wallet profiling (holdings, tx history, classification) + DCA buy execution (token address, USDC amount). Supports: ${EVM_CHAINS.join(', ')}.`,
  parameters: {
    type: 'object',
    properties: {
      wallet_address: {
        type: 'string',
        description: 'EVM wallet address to profile (0x...)',
      },
      chain: {
        type: 'string',
        description: `Blockchain network (${EVM_CHAINS.join(', ')}). Defaults to base. Solana not yet supported.`,
      },
      action: {
        type: 'string',
        description: "'profile' (default) to analyze a wallet, or 'dca_buy' to execute a DCA buy",
      },
      token_address: {
        type: 'string',
        description: 'Token contract address to buy (required for dca_buy action)',
      },
      usdc_amount: {
        type: 'number',
        description: 'USDC amount to spend (required for dca_buy action, e.g. 5.00)',
      },
    },
    required: ['wallet_address'],
  },
  examples: [
    { input: { wallet_address: '0x1234...abcd', chain: 'base' }, description: 'Profile a Base wallet' },
    { input: { wallet_address: '0x1234...abcd', chain: 'ethereum' }, description: 'Profile an Ethereum wallet' },
  ],
  rejection_cases: [
    'Missing or invalid wallet address (not a valid 0x EVM address)',
    'Solana wallet address (non-EVM, not yet supported)',
    'NSFW or malicious intent detected in request',
  ],
};

// ── Input validation ──────────────────────────────────────────────────────────
const MALICIOUS_KEYWORDS = /hack|drain|steal|phish|scam|exploit|launder/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function validateInput(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'Missing or invalid wallet address (not a valid 0x EVM address).' };
  }

  // Reject malicious intent
  if (MALICIOUS_KEYWORDS.test(raw)) {
    return { valid: false, reason: 'Request appears to contain malicious intent and cannot be processed.' };
  }

  // Parse chain if present in JSON or plain text
  let chain = null;
  try {
    const parsed = JSON.parse(raw);
    chain = parsed.chain;
  } catch {
    const chainMatch = raw.match(/\bon\s+(base|ethereum|eth|arbitrum|arb|polygon|matic|solana|sol|bsc|bnb|avalanche|avax|optimism|op)\b/i);
    if (chainMatch) chain = chainMatch[1];
  }
  const resolvedChain = resolveChain(chain) || 'base';

  // Reject Solana wallets gracefully (non-EVM)
  if (resolvedChain === 'solana') {
    return { valid: false, reason: 'Solana wallet profiling coming soon — use an EVM address.' };
  }

  // Check for Solana address even if chain wasn't explicitly solana
  const words = raw.trim().split(/\s+/);
  for (const w of words) {
    if (SOLANA_ADDRESS.test(w)) {
      return { valid: false, reason: 'Solana wallet profiling coming soon — use an EVM address.' };
    }
  }

  // Reject non-EVM chains
  if (!CHAIN_CONFIG[resolvedChain]?.isEVM) {
    return { valid: false, reason: `${CHAIN_CONFIG[resolvedChain]?.name || resolvedChain} wallet profiling is not supported. Use an EVM chain.` };
  }

  // Must contain a valid 0x EVM address
  const match = raw.match(/0x[a-fA-F0-9]{40}/);
  if (!match) {
    return { valid: false, reason: 'Missing or invalid wallet address (not a valid 0x EVM address).' };
  }

  return { valid: true, address: match[0], chain: resolvedChain };
}

const handledJobs = new Set();

function extractContent(req) {
  if (!req) return '';
  if (typeof req === 'string') {
    try { req = JSON.parse(req); } catch { return req; }
  }
  if (typeof req === 'object') {
    return req.topic || req.requirement || req.content || req.walletAddress || JSON.stringify(req);
  }
  return String(req);
}

// Uses Blockscout public API — no API key required
// Default URL for backwards compat; overridden per-chain in profileWallet
const DEFAULT_BLOCKSCOUT = 'https://base.blockscout.com/api';

async function profileWallet(address, chain = 'base') {
  try {
    const resolvedChain = resolveChain(chain) || 'base';
    // Blockscout V2 API for the target chain (fall back to Base)
    const blockscoutBase = CHAIN_CONFIG[resolvedChain]?.blockscoutUrl || 'https://base.blockscout.com/api/v2';
    // V1 compat endpoint (module=account style) — use /api path
    const blockscoutV1 = blockscoutBase.replace('/api/v2', '/api');
    const chainName = CHAIN_CONFIG[resolvedChain]?.name || resolvedChain;
    const nativeToken = CHAIN_CONFIG[resolvedChain]?.nativeToken || 'ETH';

    // 1. Transaction list (up to 50 most recent)
    const [txRes, tokenRes, ethRes] = await Promise.allSettled([
      axios.get(`${blockscoutV1}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc`, { timeout: 10000 }),
      axios.get(`${blockscoutV1}?module=account&action=tokenlist&address=${address}`, { timeout: 10000 }),
      axios.get(`${blockscoutV1}?module=account&action=balance&address=${address}`, { timeout: 10000 }),
    ]);

    const txs = txRes.status === 'fulfilled' ? (txRes.value.data?.result || []) : [];
    const tokens = tokenRes.status === 'fulfilled' ? (tokenRes.value.data?.result || []) : [];
    const ethBalRaw = ethRes.status === 'fulfilled' ? (ethRes.value.data?.result || '0') : '0';

    const txCount = Array.isArray(txs) ? txs.length : 0;
    const ethBal = (parseInt(ethBalRaw) / 1e18).toFixed(6);

    const recentTxs = Array.isArray(txs) ? txs.slice(0, 5).map(t => ({
      hash: t.hash,
      value_eth: (parseInt(t.value || 0) / 1e18).toFixed(6),
      age_days: Math.floor((Date.now() / 1000 - parseInt(t.timeStamp || 0)) / 86400),
      direction: t.from?.toLowerCase() === address.toLowerCase() ? 'OUT' : 'IN',
    })) : [];

    // Token holdings — format balances with decimals
    const tokenHoldings = Array.isArray(tokens) ? tokens.slice(0, 10).map(t => {
      const decimals = parseInt(t.decimals || '18');
      const bal = (parseInt(t.balance || '0') / Math.pow(10, decimals));
      return {
        symbol: t.symbol,
        name: t.name,
        balance: bal < 0.0001 ? bal.toExponential(2) : bal.toLocaleString('en-US', { maximumFractionDigits: 4 }),
        contract: t.contractAddress,
      };
    }) : [];

    // Classification
    let classification = 'RETAIL — Standard wallet activity.';
    if (txCount > 1000)     classification = 'WHALE — Very high transaction volume.';
    else if (txCount > 200) classification = 'ACTIVE TRADER — Frequent on-chain activity.';
    else if (txCount > 20)  classification = 'REGULAR USER — Moderate on-chain history.';
    else if (txCount < 5)   classification = 'NEW WALLET — Limited history.';

    // Risk flags
    const riskFlags = [];
    if (txCount === 0 && tokenHoldings.length === 0) riskFlags.push('EMPTY — No activity detected.');
    if (tokenHoldings.length > 15) riskFlags.push('HIGH TOKEN COUNT — May include dust or spam tokens.');

    return {
      wallet: address,
      chain: resolvedChain,
      chain_name: chainName,
      native_balance: `${ethBal} ${nativeToken}`,
      transaction_count: txCount,
      classification,
      token_holdings: tokenHoldings,
      recent_transactions: recentTxs,
      risk_flags: riskFlags,
      blockscout_url: `${blockscoutBase.replace('/api/v2', '')}/address/${address}`,
      profiled_at: new Date().toISOString(),
      powered_by: 'GSB Intelligence Swarm',
    };
  } catch (err) {
    return { error: `Profile failed: ${err.message}` };
  }
}

const { execSync } = require('child_process');
const fsSync = require('fs');

async function executeDcaBuy(tokenAddress, usdcAmount) {
  const PRIVATE_KEY = process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!PRIVATE_KEY) return { ok: false, error: 'No AGENT_WALLET_PRIVATE_KEY configured' };

  const WETH   = '0x4200000000000000000000000000000000000006';
  const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
  const RPC    = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const amount = parseFloat(usdcAmount);
  if (!amount || amount <= 0) return { ok: false, error: 'Invalid usdc_amount' };
  if (!tokenAddress || !tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) return { ok: false, error: 'Invalid token_address' };

  const script = `
const { createWalletClient, createPublicClient, http, parseUnits, maxUint256 } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const ERC20_ABI = [
  { name:'approve', type:'function', inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}], outputs:[{name:'',type:'bool'}] },
  { name:'allowance', type:'function', inputs:[{name:'owner',type:'address'},{name:'spender',type:'address'}], outputs:[{name:'',type:'uint256'}] },
];
const MULTIHOP_ABI = [{
  name: 'exactInput', type: 'function',
  inputs: [{ name: 'params', type: 'tuple', components: [
    {name:'path',type:'bytes'},{name:'recipient',type:'address'},
    {name:'amountIn',type:'uint256'},{name:'amountOutMinimum',type:'uint256'},
  ]}],
  outputs: [{name:'amountOut',type:'uint256'}],
}];

async function run() {
  const account = privateKeyToAccount('${PRIVATE_KEY}');
  const walletClient = createWalletClient({ account, chain: base, transport: http('${RPC}') });
  const publicClient = createPublicClient({ chain: base, transport: http('${RPC}') });
  const amountIn = parseUnits('${amount.toFixed(6)}', 6);

  const allowance = await publicClient.readContract({ address: '${USDC}', abi: ERC20_ABI, functionName: 'allowance', args: [account.address, '${ROUTER}'] });
  if (allowance < amountIn) {
    const approveTx = await walletClient.writeContract({ address: '${USDC}', abi: ERC20_ABI, functionName: 'approve', args: ['${ROUTER}', maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }
  const encodePath = (tokens, fees) => {
    let enc = tokens[0].slice(2).toLowerCase();
    for (let i = 0; i < fees.length; i++) { enc += fees[i].toString(16).padStart(6,'0'); enc += tokens[i+1].slice(2).toLowerCase(); }
    return '0x' + enc;
  };
  const path = encodePath(['${USDC}', '${WETH}', '${tokenAddress}'], [500, 3000]);
  const hash = await walletClient.writeContract({
    address: '${ROUTER}', abi: MULTIHOP_ABI, functionName: 'exactInput',
    args: [{ path, recipient: account.address, amountIn, amountOutMinimum: 0n }],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('TX_HASH:' + hash);
  console.log('AMOUNT_OUT:' + receipt.logs?.[receipt.logs.length-1]?.data || '0');
}
run().catch(e => console.error('DCA_ERROR:' + e.message));
`;

  const tmpFile = path.join(__dirname, `dca_${Date.now()}.js`);
  try {
    fsSync.writeFileSync(tmpFile, script);
    const output = execSync(`node ${tmpFile}`, { timeout: 90000, env: process.env, cwd: __dirname }).toString();
    fsSync.unlinkSync(tmpFile);

    const txLine = output.split('\n').find(l => l.startsWith('TX_HASH:'));
    const errLine = output.split('\n').find(l => l.startsWith('DCA_ERROR:'));
    if (errLine) return { ok: false, error: errLine.replace('DCA_ERROR:', '').trim() };
    if (!txLine) return { ok: false, error: 'No tx hash returned' };

    const txHash = txLine.replace('TX_HASH:', '').trim();
    return {
      ok: true, txHash, amountIn: amount,
      explorerUrl: `https://basescan.org/tx/${txHash}`,
      status: 'confirmed',
    };
  } catch (err) {
    try { fsSync.unlinkSync(tmpFile); } catch {}
    const errMsg = err.stdout?.toString().match(/DCA_ERROR:(.*)/)?.[1]?.trim() || err.message;
    return { ok: false, error: errMsg };
  }
}

async function processJob(client, job, chain = 'base') {
  const rawContent = extractContent(job.requirement)
    || extractContent(job.memos?.[0]?.content)
    || '';

  // ── DCA buy branch ───────────────────────────────────────────────────────
  const parsed = parseJobRequirement(rawContent);
  if (parsed.skillId === 'dca_buy' || parsed.params?.action === 'dca_buy') {
    const tokenAddress = parsed.params?.token_address;
    const usdcAmount   = parsed.params?.usdc_amount;
    console.log(`[${AGENT_NAME}] DCA buy: ${usdcAmount} USDC → ${tokenAddress}`);
    const result = await executeDcaBuy(tokenAddress, usdcAmount);
    await job.deliver({ type: 'text', value: JSON.stringify(result, null, 2) });
    console.log(`[${AGENT_NAME}] DCA job ${job.id} delivered. ok=${result.ok}`);
    return;
  }

  // ── Wallet profile branch (default) ─────────────────────────────────────
  const match = rawContent.match(/0x[a-fA-F0-9]{40}/);
  if (!match) {
    await job.deliver({ type: 'text', value: 'No wallet address found. Please provide a valid EVM wallet address.' });
    return;
  }
  const profile = await profileWallet(match[0], chain);
  await job.deliver({ type: 'text', value: JSON.stringify(profile, null, 2) });
  console.log(`[${AGENT_NAME}] Profile job ${job.id} delivered.`);
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);

  const agent = await buildAcpAgent({
    signerPrivateKey:   process.env.WALLET_PROFILER_SIGNER_PK || process.env.WALLET_PROFILER_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY,
    walletId:           process.env.WALLET_PROFILER_WALLET_ID,
    entityId: parseInt(process.env.WALLET_PROFILER_ENTITY_ID) || 1,
    agentWalletAddress: process.env.WALLET_PROFILER_WALLET_ADDRESS,
    onEntry: async (session, entry) => {
      if (entry.kind !== 'system') return;
      const { type } = entry.event;
      const jobId = session.jobId;

      // ── job.created — validate and set budget ─────────────────────────────
      if (type === 'job.created') {
        if (handledJobs.has(jobId)) return;
        handledJobs.add(jobId);

        try {
          let rawContent = entry.event.requirement || entry.event.content || '';
          console.log(`[${AGENT_NAME}] Job ${jobId} content: ${rawContent.slice(0, 120)}`);

          const parsed = parseJobRequirement(rawContent);
          const skills = loadSkills(AGENT_NAME);
          if (parsed.skillId) {
            const skillDef = skills.find(s => s.skillId === parsed.skillId);
            if (skillDef) {
              rawContent = executeSkillInstruction(skillDef, parsed.params || {});
            }
          }

          const check = validateInput(rawContent);
          if (!check.valid) {
            console.log(`[${AGENT_NAME}] Job ${jobId} REJECTED: ${check.reason}`);
            await session.reject(check.reason);
            handledJobs.delete(jobId);
            return;
          }

          const chainName = CHAIN_CONFIG[check.chain || 'base']?.name || (check.chain || 'base');
          await session.setBudget(AssetToken.usdc(JOB_PRICE, session.chainId));
          console.log(`[${AGENT_NAME}] Job ${jobId} acked for ${chainName} — budget set $${JOB_PRICE} USDC`);
        } catch (err) {
          console.error(`[${AGENT_NAME}] Job ${jobId} job.created error:`, err.message);
          try { await session.reject(`Setup error: ${err.message}`); } catch (_) {}
          handledJobs.delete(jobId);
        }

      // ── job.funded — profile/DCA and submit ───────────────────────────────
      } else if (type === 'job.funded') {
        try {
          let rawContent = entry.event.requirement || entry.event.content || '';
          if (!rawContent) {
            const history = await session.getHistory?.() || [];
            const reqMsg = history.find(m => m.contentType === 'requirement');
            rawContent = reqMsg?.content || '';
          }

          const check = validateInput(rawContent);
          const jobChain = check.chain || 'base';

          // Build a fake job-like object for processJob compatibility
          const jobProxy = {
            id: jobId,
            requirement: rawContent,
            memos: [],
            deliver: async ({ type: t, value }) => {
              await session.submit(value);
              console.log(`[${AGENT_NAME}] Job ${jobId} submitted.`);
            },
          };
          await processJob(null, jobProxy, jobChain);
        } catch (err) {
          console.error(`[${AGENT_NAME}] Job ${jobId} job.funded error:`, err.message);
          try { await session.reject(`Delivery error: ${err.message}`); } catch (_) {}
          handledJobs.delete(jobId);
        }

      // ── job.submitted — evaluator completes ───────────────────────────────
      } else if (type === 'job.submitted') {
        try {
          await session.complete('Delivered successfully.');
          console.log(`[${AGENT_NAME}] Job ${jobId} completed.`);
        } catch (_) {}
      }
    },
  });

  await agent.start();
  console.log(`[${AGENT_NAME}] Online. Listening for jobs at $${JOB_PRICE} USDC each.`);
}

start().catch(console.error);
