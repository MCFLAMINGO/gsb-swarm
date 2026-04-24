# LocalIntel — Agentic Local Business Intelligence

[![smithery badge](https://smithery.ai/badge/erik-7clt/local-intel)](https://smithery.ai/servers/erik-7clt/local-intel)

Autonomous business intelligence for Florida ZIP codes. 20 MCP tools. 1,445 ZIP briefs. Built for LLMs and autonomous agents.

> *"Let Google pay for the satellites. We sell the weather forecast."*

---

## Tools

| Tool | Description | Cost |
|---|---|---|
| `local_intel_ask` | Plain-English question → synthesized answer (BEST FIRST CALL) | Free |
| `local_intel_oracle` | Pre-baked economic narrative: saturation, price-tier gaps, growth trajectory | $0.01 |
| `local_intel_signal` | Investment signal 0–100 with buy/hold/avoid band | $0.03 |
| `local_intel_tide` | Tidal momentum score synthesizing all 4 data layers | $0.03 |
| `local_intel_bedrock` | Infrastructure momentum: permits, roads, flood zones (12–36mo forward) | $0.02 |
| `local_intel_sector_gap` | NAICS sector whitespace — county presence vs ZIP absence | $0.03 |
| `local_intel_for_agent` | PREMIUM composite entry: top-10 signals personalized by agent type | $0.05 |
| `local_intel_zone` | Spending zone + demographics for a ZIP | Free |
| `local_intel_context` | Spatial context block: anchor business, distance rings, category breakdown | Free |
| `local_intel_search` | Search businesses by name, category, or semantic group | Free |
| `local_intel_nearby` | Businesses within radius of a lat/lon, sorted by distance | Free |
| `local_intel_corridor` | Businesses along a named street (A1A, Palm Valley, Crosswater) | Free |
| `local_intel_changes` | Recently added or owner-verified listings | Free |
| `local_intel_stats` | Dataset coverage stats, confidence scores, query volume | Free |
| `local_intel_realtor` | Real estate intelligence: demographics, gaps, flood risk, school proximity | $0.02 |
| `local_intel_healthcare` | Healthcare market: provider density, demand gaps, senior population | $0.02 |
| `local_intel_retail` | Retail: store categories, spending capture rates, undersupplied niches | $0.02 |
| `local_intel_construction` | Construction: contractor density, permits, housing starts | $0.02 |
| `local_intel_restaurant` | Restaurant: saturation, price-tier gaps, capture rates, corridor analysis | $0.02 |
| `local_intel_query` | Natural language entry point with ZIP auto-detection | Free |

---

## Installation

Connect via Smithery in one command:

```bash
npx -y @smithery/cli@latest mcp add erik-7clt/local-intel
```

Or connect directly to the MCP endpoint:

```
https://gsb-swarm-production.up.railway.app/api/local-intel/mcp
```

---

## Usage

### Quickstart

```json
POST https://gsb-swarm-production.up.railway.app/api/local-intel/mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "local_intel_ask",
    "arguments": {
      "question": "What restaurant categories are missing in 32082?",
      "zip": "32082"
    }
  }
}
```

### Agent Headers

Pass `x-agent-id` to enable delta computation and usage tracking:

```
x-agent-id: your-agent-uuid
```

### Payment

All paid calls ($0.01–$0.05) are billed in pathUSD on Tempo mainnet. Free discovery tier available for all read-only tools.

---

## Coverage

- **1,445 ZIP briefs** computed autonomously across Northeast Florida
- **982+ businesses** indexed with entity resolution
- **5 vertical agents** trained on 500+ real market queries
- **OpenAPI spec**: `GET /openapi.json`
- **ChatGPT plugin**: `GET /.well-known/ai-plugin.json`
- **Smithery**: [smithery.ai/servers/erik-7clt/local-intel](https://smithery.ai/servers/erik-7clt/local-intel)

---

## Data Layers

| Layer | What it covers |
|---|---|
| Bedrock (Layer 0) | Infrastructure: permits, FDOT road projects, flood zones, utility extensions |
| Ocean Floor (Layer 1) | Demographics: income, ownership, population, ACS signals |
| Surface Current (Layer 2) | Business activity: density, category mix, sector gaps |
| Wave Surface (Layer 3) | Momentum: tidal score, trend direction, investment signal |

---

## Homepage

[thelocalintel.com](https://thelocalintel.com)
