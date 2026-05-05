# LocalIntel — Sector Gap Benchmarks

> **Purpose:** Reference document for the gap-scoring logic used on ZIP landing pages (`/zip/:zip`).
> Every decision here has a reasoning trail. Do not change benchmark values without updating this file.

---

## What is a "gap"?

A gap is the difference between how many businesses of a given type *should* exist in a ZIP code (based on population + income) and how many actually exist in our Postgres `businesses` table.

We express gaps as a **percentage of expected**, not an absolute count, so the signal is stable across small and large ZIPs.

```
gap_pct = (expected - actual) / expected
```

---

## Tier Thresholds (percentage-based)

| Tier | gap_pct condition | Label shown to user |
|---|---|---|
| `high` | >= 30% undersupplied | Significant Opportunity |
| `medium` | >= 15% undersupplied | Moderate Opportunity |
| `low` | >= 5% undersupplied | Slight Opportunity |
| `balanced` | within ±5% to -20% | Balanced Market |
| `saturated` | <= -20% oversupplied | Competitive Market |

**Why percentage, not absolute?**
The old code used `gap >= 10` (absolute count). For large sectors like `services` (expected ~288), a gap of 10 is noise (<4%). For small sectors like `automotive` (expected ~13), a gap of 10 is 77%. Percentage normalizes across sector sizes.

---

## Hybrid Benchmark Values

Each sector has a `base` (businesses per 10,000 residents) and an `inc` multiplier applied when ZIP median household income > $100,000.

| Sector key | Label | Base/10k | Aff. mult | Source |
|---|---|---|---|---|
| `health` | Healthcare | 27.6 | 1.15 | DB median (26 FL ZIPs) |
| `food` | Food & Dining | 27.7 | 1.10 | DB suburban median (tourist ZIPs excluded) |
| `retail` | Retail & Shopping | 20.0 | 1.10 | BLS national (NAICS 44-45) |
| `fitness` | Fitness & Wellness | 9.0 | 1.25 | BLS national |
| `finance` | Financial Services | 8.0 | 1.15 | BLS national (banks + advisors) |
| `hospitality` | Hospitality | 3.0 | 1.00 | DB suburban median (tourist ZIPs excluded) |
| `legal` | Legal Services | 5.4 | 1.20 | BLS national (~180k law offices / 335M pop) |
| `construction` | Construction & Trades | 17.8 | 1.00 | DB median (FL-calibrated) |
| `automotive` | Automotive Services | 5.1 | 0.90 | BLS national (~170k repair shops / 335M pop) |
| `services` | Professional Services | 91.2 | 1.10 | DB median (broad catch-all) |

---

## Source Rationale — Why Hybrid?

Three baselines were evaluated on 2026-05-05:

### Baseline A — DB Median (all FL ZIPs in our Postgres)
- Pulled from 26 FL ZIPs with population > 5,000 and > 20 businesses
- **Problem:** Food and hospitality medians are polluted by tourist-dense ZIPs (Miami Beach: 296 food/10k, South Beach: 163 food/10k). Using these as benchmarks would make every suburban ZIP look like it needs 10x more restaurants.
- **Fix:** For food and hospitality, filter to suburban ZIPs only (exclude ZIPs where food > 80/10k or hospitality > 20/10k). Tourist-filtered food median = **27.7/10k**.
- Used for: `health`, `construction`, `services`, `hospitality` (filtered), `food` (filtered)

### Baseline B — BLS/Census National
- Sources: BLS QCEW establishment counts, Census County Business Patterns 2022, NRA national restaurant count (~1M / 335M pop)
- More stable across sectors not skewed by FL tourism
- **Problem:** Doesn't account for FL construction density (active development market) or the broad `services` catch-all in our classification
- Used for: `retail`, `fitness`, `finance`, `legal`, `automotive`

### Current Code (discarded)
- Used hardcoded `base` values (e.g. health=40, food=28, services=35) with absolute gap thresholds
- **Problem:** Absolute threshold `gap >= 10` flagged everything as "Significant" because large sectors always had gaps > 10 even when well-served. Every sector in 32082 showed "Significant Opportunity" — clearly wrong.

---

## Tourist ZIP Exclusion List

ZIPs excluded from food/hospitality median calculation (food > 80/10k or hospitality > 20/10k):

| ZIP | Area | Food/10k | Reason |
|---|---|---|---|
| 33132 | Miami downtown | 295.9 | Commercial/tourist core |
| 33140 | Miami Beach | 162.7 | Beach tourist district |
| 33139 | South Beach | 93.4 | Beach tourist district |
| 33141 | Miami Beach N | 80.6 | Beach tourist district |
| 33128 | Overtown/Wynwood | 351.5 | Urban entertainment district |
| 33127 | Miami NW | 103.9 | Urban core |
| 33629 | Tampa | 87.5 | Downtown commercial |
| 32819 | Orlando | 69.0 | Theme park corridor |
| 32204 | Jax urban core | 251.5 | Urban core |
| 32202 | Jax downtown | 287.8 | Urban core |

---

## Validation Results (2026-05-05)

Applied hybrid + percentage thresholds against actual Postgres data:

### 32082 — Ponte Vedra Beach (pop 28,697, HHI $121,484)

| Sector | Actual | Expected | Gap% | Signal |
|---|---|---|---|---|
| Automotive | 1 | 13 | +92% | Significant Opportunity |
| Retail | 11 | 63 | +83% | Significant Opportunity |
| Finance | 10 | 26 | +62% | Significant Opportunity |
| Fitness | 15 | 32 | +53% | Significant Opportunity |
| Construction | 30 | 51 | +41% | Significant Opportunity |
| Services | 218 | 288 | +24% | Moderate Opportunity |
| Food | 77 | 87 | +12% | Slight Opportunity |
| Hospitality | 10 | 9 | -11% | Balanced Market |
| Healthcare | 108 | 91 | -19% | Balanced Market |
| Legal | 35 | 19 | -84% | Competitive Market |

**Sanity check:** Healthcare balanced ✅ (lots of clinics in PVB), Legal competitive ✅ (many law offices), Food slight ✅ (not screaming gap, not oversupplied), Retail significant ✅ (few shops).

### 32081 — Nocatee (pop 24,368, HHI $129,875)

| Sector | Actual | Expected | Gap% | Signal |
|---|---|---|---|---|
| Finance | 1 | 22 | +96% | Significant Opportunity |
| Automotive | 1 | 11 | +91% | Significant Opportunity |
| Retail | 6 | 54 | +89% | Significant Opportunity |
| Fitness | 4 | 27 | +85% | Significant Opportunity |
| Food | 44 | 74 | +41% | Significant Opportunity |
| Legal | 10 | 16 | +38% | Significant Opportunity |
| Hospitality | 7 | 7 | 0% | Balanced Market |
| Healthcare | 94 | 77 | -22% | Competitive Market |
| Services | 365 | 244 | -50% | Competitive Market |
| Construction | 407 | 43 | -846% | Competitive Market |

**Sanity check:** Construction competitive ✅ (Nocatee is an active master-planned build-out), Services competitive ✅, Healthcare competitive ✅ (well-served suburb), Food significant ✅ (Nocatee genuinely underserved on restaurants).

---

## Implementation Notes

- Logic lives **client-side** in `/zip/32082.html` and `/zip/32081.html` — no server cost, no LLM
- `computeGaps(sb, pop, hhi)` receives `sector_breakdown` from the oracle (`/api/local-intel/oracle?zip=`)
- Gap cards show **tier label only** — no exact counts or percentages shown to public
- Cards filtered to non-`balanced` tiers, sorted by gap_pct descending, max 8 shown
- "See Full Report →" gates to `/claim.html`
- Graceful fallback if oracle unavailable

---

## When to Recalibrate

Recalibrate when:
1. We have 50+ ZIPs in Postgres with reliable population data (re-run tourist filter, recompute medians)
2. A sector's classification system changes (new `category_group` values)
3. A ZIP page result fails obvious smell test (e.g. "Legal: Significant Opportunity" in a ZIP full of law firms)

Re-run `/tmp/benchmark_query.js` (in gsb-swarm root) against live Postgres and update this file.
