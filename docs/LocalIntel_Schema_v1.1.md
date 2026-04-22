# LocalIntel MCP — Schema Reference v1.1

**Last updated:** April 21, 2026  
**MCP Endpoint:** `https://gsb-swarm-production.up.railway.app/api/local-intel/mcp`  
**Smithery:** `https://smithery.ai/servers/erik-7clt/local-intel`  
**GitHub:** `https://github.com/MCFLAMINGO/gsb-swarm`

---

## Architecture

```
Census/ZBP/CBP data
      ↓
census_layer (27 ZIPs)       ← ZBP 2018 + CBP 2023 + PDB 2024 + sector_gaps[]
      ↓
oracle (6h refresh)          ← interprets demographics into market signals
      ↓
sector_gap                   ← ranks NAICS opportunities by demand model
      ↓
inference engine             ← 500+ prompts × 5 verticals × 27 ZIPs
      ↓
local_intel_query            ← fuzzy intent router (NEW v1.1)
      ↓
LLM-ready output             ← what agents and humans consume
      ↑_______________inference cache → scout dispatch on miss
```

---

## Tools (20 total)

### Free / Core Layer

| Tool | Cost (pathUSD) | Description |
|------|---------------|-------------|
| `local_intel_stats` | 0.005 | Dataset coverage stats + usage metrics |
| `local_intel_search` | 0.01 | Search businesses by name, category, group |
| `local_intel_zone` | 0.01 | Spending zone + demographic + economic data for a ZIP |
| `local_intel_changes` | 0.01 | Recently added or owner-verified listings |
| `local_intel_context` | 0.02 | Full spatial context block (best first call for location queries) |
| `local_intel_nearby` | 0.02 | Businesses within radius_miles of a lat/lon, sorted by distance |
| `local_intel_corridor` | 0.02 | Businesses along a named street corridor (A1A, Palm Valley Rd, etc.) |

### Tidal Intelligence Layer

| Tool | Cost (pathUSD) | Description |
|------|---------------|-------------|
| `local_intel_tide` | 0.02 | Tidal reading for a ZIP — temperature, direction, seasonal context |
| `local_intel_bedrock` | 0.02 | Infrastructure momentum — permits, road projects, flood zones. Leading indicator 12–36mo |
| `local_intel_signal` | 0.03 | Investment + activity signal — composite score bedrock through wave surface |
| `local_intel_oracle` | 0.03 | Pre-baked economic narrative — saturation, price-tier gaps, growth trajectory |
| `local_intel_sector_gap` | 0.03 | Ranked NAICS sector gaps — county vs ZIP presence, demand model, confidence tier |
| `local_intel_for_agent` | 0.05 | Premium composite — declare agent_type + intent, get pre-ranked signals |

### Vertical Agents (100 prompts each, 6h refresh)

| Tool | Cost (pathUSD) | Description |
|------|---------------|-------------|
| `local_intel_restaurant` | 0.02 | Restaurant: saturation, price-tier gaps, capture rate, corridor analysis |
| `local_intel_healthcare` | 0.02 | Healthcare: provider density, patient demand gaps, senior population signals |
| `local_intel_retail` | 0.02 | Retail: store categories, spending capture, undersupplied niches |
| `local_intel_construction` | 0.02 | Construction: active permits, contractor density, growth demand |
| `local_intel_realtor` | 0.02 | Real estate: demographics, commercial gaps, flood risk, investment signals |

### Inference Engine Layer (NEW v1.1)

| Tool | Cost (pathUSD) | Description |
|------|---------------|-------------|
| `local_intel_ask` | 0.05 | Composite NL query — any plain-English question about a ZIP, routes to all tools |
| `local_intel_query` | 0.03 | **Fuzzy intent router** — detects ZIP + vertical + tool from any free-text query. Checks inference cache first. Dispatches scout agent on low confidence. Handles region queries. |

---

## Inference Engine

### local_intel_query — How It Works

```
LLM query: "where should I open a clinic in Northeast Florida?"
      ↓
intentRouter.js
  → detectZip()     → no literal ZIP → detectRegion() → "northeast florida" → 10 ZIPs
  → detectVertical() → "clinic" → healthcare
  → pickTool()      → "gap|demand" → local_intel_healthcare
  → rankZipsForVertical() → ranks by census_layer sector_gap scores → [32082, 32081, 32084]
      ↓
inferenceCache.get(query, "healthcare", "32082")
  → HIT  → return instantly, include cache metadata
  → MISS → handleVerticalQuery("healthcare", query, "32082")
              → run local_intel_healthcare
              → scoreAnswer() → confidence score
              → inferenceCache.set() → store result
              → if score < 40 → dispatchScout() → POST enrichmentAgent /run (fire-and-forget)
      ↓
return { answer, route_confidence, reasoning, zips_evaluated, _cache }
```

### Inference Cache

| Confidence Tier | Score | TTL |
|----------------|-------|-----|
| HIGH | ≥ 70 | 7 days |
| MED | 40–69 | 3 days |
| LOW | < 40 | 6 hours |

- Fingerprint: `vertical|keyword1|keyword2|...|zip` (top 6 content tokens, stop words removed)
- Similarity threshold: ≥50% token overlap = cache hit
- Cache location: `data/inference/{zip}.json` per ZIP
- `invalidate(zip, vertical)` called by scout agent after enrichment fills a gap

### Scout Dispatch

On `confidence_score < 40`, `dispatchScout(zip, vertical, query)` fires a non-blocking HTTP POST to `enrichmentAgent` at `:3007/run`. The enrichment agent:
1. Targets that ZIP + vertical combination
2. Pulls from YellowPages, OSM, Chamber directories, BBB
3. Writes enriched data back to `data/zips/{zip}.json`
4. Next caller gets a higher-confidence result (and longer TTL)

---

## Prompt Evolution

**File:** `data/oracle_prompts_v2.json`  
**Worker:** `workers/promptEvolutionWorker.js`  
**Schedule:** Daily at 2am

### Quality Tiers

| Tier | Cycles | Prompt Target |
|------|--------|--------------|
| RICH | ≥ 10 cycles with demo data | 20 prompts |
| THIN | 3–9 cycles | 10 targeted prompts |
| BLIND | No history | 5 bootstrap prompts |
| CONTRADICTED | capture_rate swings > 20% | 15 contradiction-resolving prompts |

The machine writes its own questions. Prompts that return null every cycle are retired. Gap-targeted prompts are added automatically.

---

## Data Layer

### Files

| Path | Contents | Refresh |
|------|----------|---------|
| `data/spendingZones.json` | 27 ZIPs — Census ACS 5yr 2023, WFH%, daytime multiplier, renovation wave, income distribution | Weekly |
| `data/oracle/{zip}.json` | Oracle output per ZIP | Every 6h |
| `data/census_layer/{zip}.json` | ZBP 2018 + CBP 2023 + sector_gaps[] + PDB confidence | Weekly |
| `data/census_layer/_confidence.json` | Confidence scores per ZIP | Weekly |
| `data/census_layer/_county_sectors.json` | County NAICS breakdown | Weekly |
| `data/inference/{zip}.json` | Inference cache per ZIP | TTL-based |
| `data/gaps/{vertical}.json` | Live gap log per vertical | Real-time |
| `data/vertical-runs/{vertical}-{ts}.json` | Scored run history | Every 6h |
| `data/evolution/_report.json` | Daily prompt evolution audit | Daily 2am |
| `data/evolution/_gaps.json` | Per-ZIP gap audit | Daily 2am |

### Sources

- Census ACS 5-year 2023 (demographics, income, WFH, housing)
- ZIP Business Patterns 2018 (NAICS establishment counts per ZIP)
- County Business Patterns 2023 (NAICS establishment + employment per county)
- Planning Database 2024 (hard-to-survey confidence scores)
- YellowPages (business listings — no API key required)
- OSM Nominatim (addresses, hours, categories)
- Chamber of Commerce directories (per-town enrichment)
- County appraiser records (property + permit data)

---

## Payment Rails

### x402 (USDC on Base)
- Standard: `POST /api/local-intel/mcp/x402` — $0.01/call
- Premium: `POST /api/local-intel/mcp/x402/premium` — $0.05/call
- Free: `POST /api/local-intel/mcp` — no payment required

### Tempo (pathUSD)
- All tool costs denominated in pathUSD (see Tools table above)
- `tokenAddr: 'auto'` for sponsor-tx calls
- EXECUTOR wallet handles fee sponsorship on Tempo mainnet

---

## Smithery Config Schema

No API keys required. Server operates in full read-only mode without configuration.

Optional overrides via `configSchema`:

| Key | Default | Purpose |
|-----|---------|---------|
| `MCP_ENDPOINT` | Railway URL | Override MCP endpoint |
| `X402_ENABLED` | false | Enable USDC-on-Base paywall |
| `TEMPO_ENABLED` | false | Enable pathUSD-on-Tempo paywall |
| `ENRICHMENT_ENDPOINT` | `localhost:3007/run` | Scout agent endpoint (self-hosted only) |

---

## ZIP Coverage (27 ZIPs)

| ZIP | Name | County |
|-----|------|--------|
| 32081 | Nocatee | St. Johns |
| 32082 | Ponte Vedra Beach | St. Johns |
| 32084 | St. Augustine | St. Johns |
| 32086 | St. Augustine South | St. Johns |
| 32092 | World Golf Village | St. Johns |
| 32080 | St. Augustine Beach | St. Johns |
| 32095 | Palm Valley | St. Johns |
| 32259 | Fruit Cove / Saint Johns | St. Johns |
| 32250 | Jacksonville Beach | Duval |
| 32266 | Neptune Beach | Duval |
| 32258 | Bartram Park | Duval |
| 32233 | Atlantic Beach | Duval |
| 32256 | Baymeadows / Tinseltown | Duval |
| 32257 | Mandarin South | Duval |
| 32224 | Jacksonville Intracoastal | Duval |
| 32225 | Jacksonville Arlington | Duval |
| 32246 | Jacksonville Regency | Duval |
| 32216 | Southside Blvd | Duval |
| 32217 | San Jose | Duval |
| 32207 | Jacksonville Southbank | Duval |
| 32211 | Jacksonville East | Duval |
| 32218 | North Jacksonville | Duval |
| 32003 | Fleming Island | Clay |
| 32073 | Orange Park | Clay |
| 32068 | Oakleaf | Clay |
| 32034 | Fernandina Beach | Nassau |
| 32097 | Yulee | Nassau |

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v1.1 | 2026-04-21 | +`local_intel_query` fuzzy intent router · +`inferenceCache.js` (prompt→answer store, TTL tiers, similarity matching) · +`intentRouter.js` (ZIP/vertical/tool detection, region expansion, ZIP ranking by census_layer) · scout dispatch wired into `handleVerticalQuery` · Smithery configSchema added to server.json · MCP_MANIFEST updated to 20 tools / 500 prompts |
| v1.0 | 2026-04-20 | +`local_intel_sector_gap` · +`/api/sector-gap/feed` discovery endpoint · censusLayerWorker (ZBP + CBP + PDB) · promptEvolutionWorker · gapDataFetcher · spendingZones 27 ZIPs backfilled |
