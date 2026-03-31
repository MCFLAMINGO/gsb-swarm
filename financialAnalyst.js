require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { buildAcpClient } = require('./acp');

const AGENT_NAME = 'GSB Financial Analyst';

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

const JOB_PRICE = 0.25;

// ── In-memory triage result store (24hr TTL) ─────────────────────────────────
const triageJobs = new Map(); // token -> { pdfs: [{name, buffer}], createdAt, expiresAt }

// Clean expired entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of triageJobs) {
    if (now > entry.expiresAt) {
      triageJobs.delete(token);
      console.log(`[${AGENT_NAME}] Token ${token} expired and cleaned up.`);
    }
  }
}, 30 * 60 * 1000);

// ── Input validation ──────────────────────────────────────────────────────────
function validateInput(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'Missing job context. Please provide projectName, period, and file URLs.' };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.projectName) {
      return { valid: false, reason: 'Missing projectName in job context.' };
    }
    if (!parsed.bankFileUrl) {
      return { valid: false, reason: 'Missing bankFileUrl in job context.' };
    }
    return { valid: true, params: parsed };
  } catch {
    return { valid: false, reason: 'Job context must be valid JSON with projectName, bankFileUrl, period, and tier.' };
  }
}

function generateAccessToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = 'TKN-';
  for (let i = 0; i < 6; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

async function downloadFile(url, destPath) {
  const response = await axios({ method: 'get', url, responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(destPath, response.data);
  console.log(`[${AGENT_NAME}] Downloaded: ${destPath} (${response.data.length} bytes)`);
}

async function ensurePythonDeps() {
  try {
    execSync('python3 -c "import reportlab, openpyxl, pandas"', { stdio: 'pipe' });
  } catch {
    console.log(`[${AGENT_NAME}] Installing Python dependencies...`);
    execSync('pip install reportlab xlrd openpyxl pandas -q', { stdio: 'inherit' });
  }
}

async function runTriage(params) {
  const jobId = `ftriage_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpDir = `/tmp/${jobId}`;
  const outputDir = `${tmpDir}/output`;

  fs.mkdirSync(outputDir, { recursive: true });

  try {
    // Download files
    const bankExt = path.extname(new URL(params.bankFileUrl).pathname) || '.xlsx';
    const bankPath = `${tmpDir}/bank${bankExt}`;
    await downloadFile(params.bankFileUrl, bankPath);

    let posPath = null;
    if (params.posFileUrl) {
      const posExt = path.extname(new URL(params.posFileUrl).pathname) || '.xlsx';
      posPath = `${tmpDir}/pos${posExt}`;
      await downloadFile(params.posFileUrl, posPath);
    }

    // Ensure Python deps
    await ensurePythonDeps();

    // Build command
    const scriptPath = path.join(__dirname, 'scripts', 'analyze.py');
    let cmd = `python3 ${scriptPath} --project-name "${params.projectName}" --bank "${bankPath}" --period "${params.period || 'Current'}" --output-dir "${outputDir}"`;
    if (posPath) cmd += ` --pos "${posPath}"`;

    console.log(`[${AGENT_NAME}] Running: ${cmd}`);
    execSync(cmd, { stdio: 'inherit', timeout: 120000 });

    // Read generated PDFs into memory
    const pdfFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.pdf'));
    const pdfs = pdfFiles.map(name => ({
      name,
      buffer: fs.readFileSync(path.join(outputDir, name)),
    }));

    // Generate access token
    const accessToken = generateAccessToken();
    const now = Date.now();

    // Store in memory with 24hr TTL
    triageJobs.set(accessToken, {
      pdfs,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    });

    // Clean up /tmp
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[${AGENT_NAME}] Cleaned up ${tmpDir}. Generated ${pdfs.length} PDFs under token ${accessToken}.`);

    return {
      accessToken,
      filesGenerated: pdfs.map(p => p.name),
      downloadUrl: `/api/financial-triage/download/${accessToken}`,
      expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    };
  } catch (err) {
    // Clean up on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

const handledJobs = new Set();

async function waitForTransaction(client, jobId, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const fresh = await client.getJobById(jobId);
    if (fresh && fresh.phase === 2) return fresh;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} did not reach TRANSACTION phase within ${maxWaitMs}ms`);
}

function extractContent(req) {
  if (!req) return '';
  if (typeof req === 'string') {
    try { req = JSON.parse(req); } catch { return req; }
  }
  if (typeof req === 'object') {
    return req.projectName ? JSON.stringify(req) : (req.topic || req.requirement || req.content || JSON.stringify(req));
  }
  return String(req);
}

async function start() {
  console.log(`[${AGENT_NAME}] Starting ACP provider...`);
  const client = await buildAcpClient({
    privateKey:         process.env.AGENT_WALLET_PRIVATE_KEY,
    entityId:           parseInt(process.env.FINANCIAL_ANALYST_ENTITY_ID),
    agentWalletAddress: process.env.FINANCIAL_ANALYST_WALLET_AD,

    onNewTask: async (job) => {
      console.log(`[${AGENT_NAME}] New job: ${job.id} | phase=${job.phase}`);

      if (handledJobs.has(job.id)) {
        console.log(`[${AGENT_NAME}] Job ${job.id} already in progress — skipping.`);
        return;
      }
      handledJobs.add(job.id);

      try {
        let rawContent = extractContent(job.requirement)
          || extractContent(job.memos?.[0]?.content)
          || '';
        console.log(`[${AGENT_NAME}] Job ${job.id} content: ${rawContent.slice(0, 120)}`);

        // ── Skill registry routing ───────────────────────────────────────────
        const parsed = parseJobRequirement(rawContent);
        const skills = loadSkills(AGENT_NAME);
        if (parsed.skillId) {
          const skillDef = skills.find(s => s.skillId === parsed.skillId);
          if (skillDef) {
            const instruction = executeSkillInstruction(skillDef, parsed.params || {});
            console.log(`[${AGENT_NAME}] Skill ${parsed.skillId} → "${instruction.slice(0, 100)}"`);
            rawContent = instruction;
          }
        }

        // ── Validate BEFORE accepting ────────────────────────────────────────
        const check = validateInput(rawContent);
        if (!check.valid) {
          console.log(`[${AGENT_NAME}] Job ${job.id} REJECTED: ${check.reason}`);
          await job.reject(check.reason);
          handledJobs.delete(job.id);
          return;
        }

        let freshJob = job;
        if (job.phase === 2) {
          console.log(`[${AGENT_NAME}] Job ${job.id} already in TRANSACTION phase.`);
        } else {
          await job.respond(true, `Running financial triage for project "${check.params.projectName}"...`);
          console.log(`[${AGENT_NAME}] Job ${job.id} accepted. Waiting for TRANSACTION phase...`);
          freshJob = await waitForTransaction(client, job.id);
          console.log(`[${AGENT_NAME}] Job ${job.id} in TRANSACTION phase.`);
        }

        const result = await runTriage(check.params);
        const deliverable = `Your triage is ready. Access Token: ${result.accessToken}. Download at ${result.downloadUrl}\n\nFiles generated: ${result.filesGenerated.join(', ')}\nExpires: ${result.expiresAt}`;
        await freshJob.deliver({ type: 'text', value: deliverable });
        console.log(`[${AGENT_NAME}] Job ${job.id} delivered. Token: ${result.accessToken}`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] Job ${job.id} error:`, err.message);
        try {
          await job.rejectPayable(`Internal error: ${err.message}. Your payment will be refunded.`);
          console.log(`[${AGENT_NAME}] Job ${job.id} rejectPayable issued — buyer will be refunded.`);
        } catch (_) {}
        handledJobs.delete(job.id);
      }
    },

    onEvaluate: async (job) => {
      try { await job.evaluate(true, 'Delivered successfully.'); } catch (_) {}
    },
  });
  console.log(`[${AGENT_NAME}] Online. Listening at $${JOB_PRICE} USDC/job.`);
}

// Export triageJobs so dashboard-server.js can access them
module.exports = { start, triageJobs };

// If run directly as a child process, start immediately
if (require.main === module) {
  start().catch(console.error);
}
