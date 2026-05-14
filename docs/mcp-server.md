# MCP Server

MCP server architecture, 22 tools, three roles (market intel / business discovery / task dispatch), Smithery, oracle re-wire.

## Access Point: MCP Server (Architecture Canon)

#### 2. MCP Server (`/api/local-intel/mcp` → Smithery)
**Who:** AI agents (Claude, GPT, Cursor), programmatic callers, humans via Smithery.
**What it is:** The canonical single entry point for ALL queries — market intelligence, business discovery, and task routing. 22 tools registered. `local_intel_query` is the START HERE tool — plain-English, auto-routes to the right ZIP + vertical + tool.
**Three roles inside MCP:**
- **Role 1 — Market Intelligence:** `local_intel_oracle` (now reads ceo-assess), `local_intel_signal`, `local_intel_sector_gap`, `local_intel_tide`, vertical agents (restaurant/healthcare/retail/construction/realtor). Answers "what is this market?" questions.
- **Role 2 — Business Discovery:** `local_intel_search`, `local_intel_nearby`, `local_intel_context`, `local_intel_project`. Searches 205,794 FL businesses by name/category/ZIP. Statewide. No ZIP restrictions on name search — proximity-sorted by caller ZIP.
- **Role 3 — Task Dispatch:** `local_intel_rfq` → `local_intel_rfq_status` → `local_intel_book` → `local_intel_decline_response` → `local_intel_complete`. Full loop: post job → ranked quotes → book → pay → complete. Payment on confirmed success only (Tempo/pathUSD).


---

## B40 — MCP Oracle re-wire

## B40 — MCP Oracle re-wire + Architecture Canon
**Date:** 2026-05-14
**Commit:** (see below)

### Problem
`local_intel_oracle` MCP tool read from `zip_intelligence.oracle_json` — null for all target ZIPs because the oracle worker predates the Postgres workers architecture. Every agent connecting via Smithery got no data.

### Fix
Re-wired `handleOracle()` in `localIntelMCP.js` to query `zip_signals` + `businesses` + `intent_dead_ends` directly (same parallel query pattern as ceo-assess endpoint). Returns structured market intelligence, labor signals, demographics, migration, business activity, and unmet demand. Falls back to `zip_intelligence.oracle_json` only if zip_signals has no data. Legacy oracle path preserved but demoted to fallback.

**Result:** `local_intel_oracle` now returns live World Model scores, income tier, peer cohort, sector signals, and unmet demand for any ZIP that has worker data. MCP agents on Smithery get real intelligence immediately.
