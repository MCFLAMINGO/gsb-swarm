# GSB Intelligence Swarm ⛽
### Agent Gas Bible · ACP Provider Network · Base Mainnet

[![smithery badge](https://smithery.ai/badge/erik-7clt/local-intel)](https://smithery.ai/servers/erik-7clt/local-intel)

> *Thou shalt never run out of GAS.*

Four autonomous ACP provider agents that earn USDC on Virtuals Protocol by selling crypto intelligence to other AI agents.

---

## The Swarm

| Worker | Service | Price | Revenue Target |
|--------|---------|-------|---------------|
| Token Analyst | Full report on any contract address | $0.25 USDC | $75/day |
| Wallet Profiler | PnL, holdings, whale classification | $0.50 USDC | $75/day |
| Alpha Scanner | New pair scanner, smart money signals | $0.10 USDC | $75/day |
| Thread Writer | Viral X threads with live data | $0.25 USDC | $75/day |
| **Total** | | | **$300/day** |

---

## Setup (15 minutes)

### Step 1 — Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/gsb-swarm.git
cd gsb-swarm
npm install
```

### Step 2 — Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `AGENT_WALLET_PRIVATE_KEY` — private key of a Base wallet with ~$5 USDC + ~$2 ETH
- `OPENAI_API_KEY` — your new OpenAI key (get from platform.openai.com/api-keys)

### Step 3 — Register each agent on ACP

Go to [app.virtuals.io/acp](https://app.virtuals.io/acp) and register 4 agents:

| Agent Name | Role | Service Description |
|-----------|------|---------------------|
| GSB Token Analyst | Provider | Full token analysis report for any Base/Solana contract address. Price: 0.25 USDC |
| GSB Wallet Profiler | Provider | Complete wallet PnL, holdings, and whale classification. Price: 0.50 USDC |
| GSB Alpha Scanner | Provider | New pair scanner with smart money signals on Base. Price: 0.10 USDC |
| GSB Thread Writer | Provider | Viral X thread writer with live on-chain data injection. Price: 0.25 USDC |

After registering each agent, copy the **Entity ID** and **Wallet Address** into your `.env`.

### Step 4 — Test locally

```bash
npm start
```

Visit `http://localhost:3000` to confirm all 4 workers are online.

### Step 5 — Deploy to Railway

1. Push to GitHub:
```bash
git init
git add .
git commit -m "GSB Intelligence Swarm v1"
git remote add origin https://github.com/YOUR_USERNAME/gsb-swarm.git
git push -u origin main
```

2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Go to **Variables** tab and add all values from your `.env` file
5. Railway auto-deploys. Your swarm is live 24/7.

---

## ACP Job Format

Each worker accepts jobs via ACP with this format in the job description:

**Token Analyst:**
```
Analyze this token: 0xYOUR_CONTRACT_ADDRESS
```

**Wallet Profiler:**
```
Profile this wallet: 0xWALLET_ADDRESS
```

**Alpha Scanner:**
```
Scan for new alpha on Base
```
or
```
Scan for new alpha on Solana
```

**Thread Writer:**
```
Write a thread about $GSB on Virtuals Protocol
```
or
```
Write a thread about this token: 0xCONTRACT_ADDRESS
```

---

## Security Rules

- NEVER commit `.env` to GitHub
- NEVER paste your private key or API keys in chat
- Use a dedicated hot wallet with only $5-10 USDC — not your main wallet
- Keep your main treasury (`0x6dA1...3D14A`) completely separate
- Rotate OpenAI keys every 30 days

---

## Revenue Tracking

Jobs completed and USDC earned are visible in your ACP dashboard at [app.virtuals.io/acp](https://app.virtuals.io/acp) under **Completed Jobs**.

---

*Agent Gas Bible ($GSB) · Virtuals Protocol · Base Mainnet*  
*[app.virtuals.io/virtuals/68291](https://app.virtuals.io/virtuals/68291)*
tial context, tidal momentum scores, spending zones, corridor analysis, and staleness-graded data.

**MCP Endpoint:** `https://gsb-swarm-production.up.railway.app/api/local-intel/mcp`  
**Payment:** $0.01–$0.05/call in pathUSD (Tempo) or USDC (Base x402)  
**Listed on:** [Smithery](https://smithery.ai/servers/erik-7clt/local-intel)

| Tool | Description |
|---|---|
| `local_intel_context` | Full spatial context for a ZIP or lat/lon |
| `local_intel_search` | Search businesses by name or category |
| `local_intel_nearby` | Businesses within radius of any point |
| `local_intel_zone` | Spending zone + demographic data |
| `local_intel_corridor` | Businesses along a named street |
| `local_intel_tide` | Tidal momentum score for a ZIP |
| `local_intel_signal` | Investment signal 0-100 for a ZIP |
| `local_intel_bedrock` | Infrastructure momentum from permits |
| `local_intel_for_agent` | PREMIUM — composite signals by agent type |
