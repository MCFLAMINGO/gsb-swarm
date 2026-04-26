"""
LocalIntel ZIP Code Expansion Scoring
Ranks ZIP codes by: High Income (40%) + Growth Trend (35%) + Business Density/Value (25%)

Currently covered ZIPs (excluded from candidates):
32081, 32082, 32084, 32086, 32092, 32080 — all St Johns County
"""

import json

ALREADY_COVERED = {"32081", "32082", "32084", "32086", "32092", "32080"}

zips_raw = [

    # ===== ST JOHNS COUNTY (remaining ZIPs) =====
    {
        "zip": "32259",
        "city": "Saint Johns (Fruit Cove / Julington Creek)",
        "county": "St Johns County",
        "population": 75016,
        "median_hhi": 149213,
        "growth_pct_2020_2023": 12.4,
        "growth_label": "fast",
        "business_density_score": 9,
        "primary_industries": ["retail", "healthcare", "professional services", "financial services"],
        "why_valuable": "Highest median HHI on the entire First Coast ($149K). Durbin Pavilion anchors 1.3M SF of commercial space; UF Health and Baptist both expanding here. Population surged 68% 2010-2023. High-value platform for business intel targeting affluent suburban consumers. 26% of households earn $200K+."
    },
    {
        "zip": "32095",
        "city": "Saint Augustine (Twin Creeks / Palencia / World Golf Village North)",
        "county": "St Johns County",
        "population": 21399,
        "median_hhi": 136038,
        "growth_pct_2020_2023": 89.2,
        "growth_label": "explosive",
        "business_density_score": 7,
        "primary_industries": ["construction", "professional services", "retail", "healthcare"],
        "why_valuable": "Fastest-growing ZIP in St Johns County (+89% pop since 2018), HHI $136K. BeachWalk/Twin Creeks development adding 3M SF commercial entitlements. New master-planned communities (Beachwalk, Seabrook) driving young high-income household formation. Virtually untapped by business intel platforms."
    },
    {
        "zip": "32033",
        "city": "Elkton",
        "county": "St Johns County",
        "population": 4789,
        "median_hhi": 83901,
        "growth_pct_2020_2023": 5.1,
        "growth_label": "stable",
        "business_density_score": 3,
        "primary_industries": ["agriculture", "residential services", "construction"],
        "why_valuable": "Rural exurb of St Johns County. Rising income trend (from $58K in 2011 to $84K in 2023) but low population and business density limit near-term value. Best as long-term fill-in coverage."
    },
    {
        "zip": "32145",
        "city": "Hastings",
        "county": "St Johns County",
        "population": 5759,
        "median_hhi": 66075,
        "growth_pct_2020_2023": 10.7,
        "growth_label": "stable",
        "business_density_score": 2,
        "primary_industries": ["agriculture", "retail services"],
        "why_valuable": "Lowest-income ZIP in St Johns County. Agricultural community with minimal commercial base. Poor fit for a platform targeting high-income suburban markets. Low priority."
    },

    # ===== DUVAL COUNTY / JACKSONVILLE SUBURBS =====
    {
        "zip": "32258",
        "city": "Jacksonville (Bartram Park / Bartram Trail)",
        "county": "Duval County",
        "population": 40545,
        "median_hhi": 102204,
        "growth_pct_2020_2023": 26.7,
        "growth_label": "fast",
        "business_density_score": 8,
        "primary_industries": ["healthcare", "professional services", "retail", "finance"],
        "why_valuable": "Bartram Park is one of Jacksonville's fastest-growing suburban corridors. 126K SF Bartram Office Park dense with medical/professional tenants. Massive new UF Health hospital and mixed-use development underway. $100K+ HHI, 27% pop growth 2020-2023, young family demographic bordering St Johns County territory."
    },
    {
        "zip": "32223",
        "city": "Jacksonville (Mandarin)",
        "county": "Duval County",
        "population": 26079,
        "median_hhi": 95347,
        "growth_pct_2020_2023": 1.9,
        "growth_label": "stable",
        "business_density_score": 8,
        "primary_industries": ["retail", "professional services", "healthcare", "restaurants", "finance"],
        "why_valuable": "Mandarin is Jacksonville's wealthiest established neighborhood. 36% of households earn $150K+. Dense commercial corridor on San Jose Blvd with high business churn in retail, medical, and professional services. Natural adjacency to LocalIntel's existing SJC coverage territory."
    },
    {
        "zip": "32250",
        "city": "Jacksonville Beach",
        "county": "Duval County",
        "population": 30080,
        "median_hhi": 117724,
        "growth_pct_2020_2023": 8.9,
        "growth_label": "growing",
        "business_density_score": 8,
        "primary_industries": ["restaurants", "hospitality", "retail", "healthcare", "professional services"],
        "why_valuable": "Top-3 highest-income ZIP in Duval County ($117K HHI, avg $169K). Dense Beach Blvd/3rd St commercial corridor. 26% of households earn $200K+. Forecasted 9-16% pop growth 2020-2030. Strong restaurant, retail, and professional services market with affluent permanent and seasonal residents."
    },
    {
        "zip": "32266",
        "city": "Neptune Beach",
        "county": "Duval County",
        "population": 7199,
        "median_hhi": 111025,
        "growth_pct_2020_2023": 0.0,
        "growth_label": "stable",
        "business_density_score": 7,
        "primary_industries": ["restaurants", "specialty retail", "professional services"],
        "why_valuable": "High-affluence beach community ($111K HHI, avg $155K, per-cap $72K). 20% of households earn $200K+. Small but dense Atlantic Blvd commercial strip with boutique retail and dining. Premium clientele; 60% hold bachelor's degree or higher. Natural pairing with Jacksonville Beach (32250) coverage."
    },
    {
        "zip": "32226",
        "city": "Jacksonville (North Jacksonville / Heckscher Drive)",
        "county": "Duval County",
        "population": 21256,
        "median_hhi": 110179,
        "growth_pct_2020_2023": 24.3,
        "growth_label": "fast",
        "business_density_score": 6,
        "primary_industries": ["industrial/logistics", "professional services", "construction", "retail"],
        "why_valuable": "Fastest income growth in Duval County (+52% since 2011, now $110K HHI). Forecasted 26-33% population growth by 2030. Port-adjacent industrial/logistics hub with 418 business establishments and $470M annual payroll. New residential communities attracting management-class professionals."
    },
    {
        "zip": "32246",
        "city": "Jacksonville (Southside / St Johns Town Center)",
        "county": "Duval County",
        "population": 60443,
        "median_hhi": 80963,
        "growth_pct_2020_2023": 6.0,
        "growth_label": "growing",
        "business_density_score": 9,
        "primary_industries": ["retail", "finance", "professional services", "tech", "restaurants"],
        "why_valuable": "Home to St Johns Town Center — Jacksonville's premier retail destination (Nordstrom, Apple, high-end dining). One of the highest business densities in Duval County. Dense Butler Blvd/Baymeadows office corridor. Exceptional B2B intel value despite mid-tier residential HHI."
    },
    {
        "zip": "32256",
        "city": "Jacksonville (Baymeadows / Southside)",
        "county": "Duval County",
        "population": 55510,
        "median_hhi": 73570,
        "growth_pct_2020_2023": 8.8,
        "growth_label": "growing",
        "business_density_score": 9,
        "primary_industries": ["technology", "financial services", "healthcare", "professional services", "retail"],
        "why_valuable": "Core Southside office market: major tech employers (CSX Technology), Fidelity, major healthcare systems. Highest B2B business density in Jacksonville. Growing international workforce (South American, South Asian diaspora). B2B intel demand is exceptional even with moderate residential HHI."
    },
    {
        "zip": "32225",
        "city": "Jacksonville (Arlington North / Regency area)",
        "county": "Duval County",
        "population": 54591,
        "median_hhi": 90559,
        "growth_pct_2020_2023": 5.0,
        "growth_label": "stable",
        "business_density_score": 7,
        "primary_industries": ["retail", "healthcare", "restaurants", "financial services"],
        "why_valuable": "4th highest HHI in Duval ($90K). Large dense suburban corridor; Regency Square retail, major hospital cluster (Baptist/UF Health campus). 11% earn $200K+. Strong consumer retail and healthcare business intelligence opportunity."
    },
    {
        "zip": "32224",
        "city": "Jacksonville (Beach Boulevard corridor / Southside East)",
        "county": "Duval County",
        "population": 42252,
        "median_hhi": 80774,
        "growth_pct_2020_2023": 5.6,
        "growth_label": "stable",
        "business_density_score": 7,
        "primary_industries": ["healthcare", "professional services", "retail", "education", "finance"],
        "why_valuable": "Large affluent ZIP bordering Ponte Vedra. 16% earn $200K+, 914 business establishments, $425K median home value. Contains UNF campus driving young professional and healthcare services density. Close adjacency to LocalIntel's existing SJC Ponte Vedra territory (32082)."
    },
    {
        "zip": "32233",
        "city": "Atlantic Beach",
        "county": "Duval County",
        "population": 24111,
        "median_hhi": 81586,
        "growth_pct_2020_2023": 0.5,
        "growth_label": "stable",
        "business_density_score": 6,
        "primary_industries": ["restaurants", "retail", "professional services", "healthcare"],
        "why_valuable": "Established beach community with rising affluence, 14% of households earn $200K+. Dense Town Center commercial corridor on Atlantic Blvd/Mayport Rd. $614K median home value (data USA). Stable but highly engaged consumer and professional market."
    },
    {
        "zip": "32257",
        "city": "Jacksonville (Mandarin South / San Jose)",
        "county": "Duval County",
        "population": 41791,
        "median_hhi": 75780,
        "growth_pct_2020_2023": 4.5,
        "growth_label": "stable",
        "business_density_score": 7,
        "primary_industries": ["retail", "healthcare", "professional services", "restaurants"],
        "why_valuable": "Large population base adjacent to Mandarin (32223). Well-established San Jose Blvd commercial corridor. 12% earn $200K+. Good supporting market for LocalIntel coverage expansion building off the adjacent Mandarin presence."
    },
    {
        "zip": "32207",
        "city": "Jacksonville (San Marco / Southside Central)",
        "county": "Duval County",
        "population": 35320,
        "median_hhi": 65234,
        "growth_pct_2020_2023": 3.0,
        "growth_label": "stable",
        "business_density_score": 7,
        "primary_industries": ["restaurants", "professional services", "retail", "real estate", "healthcare"],
        "why_valuable": "San Marco is Jacksonville's most walkable urban neighborhood with boutique retail, dining, and professional cluster. High-education population (58% bachelor's+). Below-average HHI masked by dense mix of renters and younger professionals; business owner clientele is wealthy. Gateway to Riverside/Avondale corridor."
    },
    {
        "zip": "32217",
        "city": "Jacksonville (Ortega / Yacht Club / Avondale South)",
        "county": "Duval County",
        "population": 20543,
        "median_hhi": 73832,
        "growth_pct_2020_2023": 3.5,
        "growth_label": "stable",
        "business_density_score": 6,
        "primary_industries": ["professional services", "restaurants", "retail", "healthcare", "real estate"],
        "why_valuable": "Ortega and San Jose areas contain some of Jacksonville's most prestigious historic estates. 12% earn $200K+; average HHI ($104K) significantly exceeds median due to wealth concentration. Boutique professional and hospitality business cluster along San Jose Blvd."
    },
    {
        "zip": "32221",
        "city": "Jacksonville (Westside / Cecil Commerce Center)",
        "county": "Duval County",
        "population": 31234,
        "median_hhi": 82969,
        "growth_pct_2020_2023": 8.5,
        "growth_label": "growing",
        "business_density_score": 6,
        "primary_industries": ["logistics", "warehousing", "retail", "construction", "manufacturing"],
        "why_valuable": "Cecil Commerce Center is a major industrial/logistics hub with Amazon, Boeing, and military facilities. Growing residential base; forecasted 9-14.5% population growth. Rising HHI driven by blue-collar to management-class transition. Growing B2B commercial services demand."
    },

    # ===== CLAY COUNTY =====
    {
        "zip": "32003",
        "city": "Fleming Island",
        "county": "Clay County",
        "population": 30481,
        "median_hhi": 119046,
        "growth_pct_2020_2023": -0.3,
        "growth_label": "stable",
        "business_density_score": 7,
        "primary_industries": ["retail", "healthcare", "professional services", "finance", "restaurants"],
        "why_valuable": "Highest-income ZIP in Clay County ($119K HHI), 21% earn $200K+. Fleming Island master-planned community with US-17 commercial corridor, medical offices, strong family demographic. 1.8% unemployment, 87% homeownership. Natural expansion corridor from LocalIntel's SJC coverage."
    },
    {
        "zip": "32065",
        "city": "Orange Park / Oakleaf Plantation",
        "county": "Clay County",
        "population": 70000,
        "median_hhi": 97455,
        "growth_pct_2020_2023": 7.7,
        "growth_label": "growing",
        "business_density_score": 7,
        "primary_industries": ["retail", "healthcare", "restaurants", "professional services", "construction"],
        "why_valuable": "Largest ZIP in Clay County by population. Oakleaf Plantation CDP ($110K HHI) is a fast-growing master-planned community. Dense Blanding Blvd commercial corridor with retail and healthcare concentration. Young median age (35) signals sustained multi-year growth. 2.48% annual growth rate."
    },
    {
        "zip": "32068",
        "city": "Middleburg",
        "county": "Clay County",
        "population": 32000,
        "median_hhi": 84431,
        "growth_pct_2020_2023": 6.7,
        "growth_label": "growing",
        "business_density_score": 4,
        "primary_industries": ["residential services", "retail", "construction"],
        "why_valuable": "Exurban growth corridor in Clay County. Moderately rising income. Lower commercial density than Fleming Island or Oakleaf. Best pursued after core Clay County ZIPs are established."
    },


    {
        "zip": "32218",
        "city": "Jacksonville (Northside / River City Marketplace)",
        "county": "Duval County",
        "population": 71066,
        "median_hhi": 69638,
        "growth_pct_2020_2023": 8.5,
        "growth_label": "growing",
        "business_density_score": 7,
        "primary_industries": ["retail", "logistics", "healthcare", "restaurants", "construction"],
        "why_valuable": "Largest ZIP by population in Duval County (71K). River City Marketplace is a major regional retail hub. Northside booming per ICI Homes 2025. 8.5% pop growth. High business activity drives strong need for local commercial intelligence."
    },
    {
        "zip": "32073",
        "city": "Orange Park (Town Core)",
        "county": "Clay County",
        "population": 32000,
        "median_hhi": 76139,
        "growth_pct_2020_2023": 5.2,
        "growth_label": "stable",
        "business_density_score": 6,
        "primary_industries": ["retail", "healthcare", "restaurants", "professional services"],
        "why_valuable": "Orange Park town center anchor. Orange Park Medical Center is a major regional hospital. Commercial activity concentrated on US-17 and College Drive corridors. Hub for surrounding Clay County residential communities."
    },
    # ===== NASSAU COUNTY =====
    {
        "zip": "32034",
        "city": "Fernandina Beach / Amelia Island",
        "county": "Nassau County",
        "population": 35000,
        "median_hhi": 97756,
        "growth_pct_2020_2023": 9.4,
        "growth_label": "growing",
        "business_density_score": 7,
        "primary_industries": ["tourism", "hospitality", "retail", "real estate", "healthcare", "restaurants"],
        "why_valuable": "Amelia Island is a premier resort destination. 18.6% of households earn $200K+, avg HHI $135K. Tourism-driven business ecosystem with affluent visitors and growing retiree base. Nassau County grew 12.3% 2020-2023 (one of FL's fastest-growing counties). Strong B2C and hospitality intel market."
    },
    {
        "zip": "32097",
        "city": "Yulee",
        "county": "Nassau County",
        "population": 25000,
        "median_hhi": 89270,
        "growth_pct_2020_2023": 13.6,
        "growth_label": "fast",
        "business_density_score": 5,
        "primary_industries": ["retail", "construction", "professional services", "residential services"],
        "why_valuable": "Fastest-growing area in Nassau County driven by domestic migration from Jacksonville metro. Yulee CDP grew 23.5% 2010-2020 and accelerating. New commercial development along US-17 corridor following residential growth surge. Lower current business density but trajectory is strongly upward — high-value early-mover opportunity."
    },
]

# ------------------------------------------------------------------
# SCORING MODEL
# Income Score  (0–40 pts): normalized on $65K–$150K range
# Growth Score  (0–35 pts): explosive=35, fast=28, growing=21, stable=12, declining=0
# Business Score(0–25 pts): business_density_score (1–10) × 2.5
# ------------------------------------------------------------------

INCOME_MIN = 65000
INCOME_MAX = 150000

GROWTH_SCORES = {
    "explosive": 35,
    "fast": 28,
    "growing": 21,
    "stable": 12,
    "declining": 0,
}

def score_zip(z):
    inc = min(max(z["median_hhi"], INCOME_MIN), INCOME_MAX)
    income_score = 40 * (inc - INCOME_MIN) / (INCOME_MAX - INCOME_MIN)
    growth_score = GROWTH_SCORES.get(z["growth_label"], 12)
    biz_score = z["business_density_score"] * 2.5
    return round(income_score + growth_score + biz_score, 2)

candidates = [z for z in zips_raw if z["zip"] not in ALREADY_COVERED]
for z in candidates:
    z["_score"] = score_zip(z)

candidates.sort(key=lambda x: x["_score"], reverse=True)
for i, z in enumerate(candidates):
    z["priority_rank"] = i + 1

output = []
for z in candidates:
    output.append({
        "zip": z["zip"],
        "city": z["city"],
        "county": z["county"],
        "population": z["population"],
        "median_hhi": z["median_hhi"],
        "growth_trend": z["growth_label"],
        "growth_pct_2020_2023": round(z.get("growth_pct_2020_2023", 0), 1),
        "primary_industries": z["primary_industries"],
        "business_density_score": z["business_density_score"],
        "composite_score": z["_score"],
        "priority_rank": z["priority_rank"],
        "why_valuable": z["why_valuable"],
    })

top25 = output[:25]

with open("/home/user/workspace/gsb-swarm/data/zip_expansion_candidates.json", "w") as f:
    json.dump(top25, f, indent=2)

print(f"Saved {len(top25)} ZIP codes to zip_expansion_candidates.json\n")
print(f"{'Rank':<5} {'ZIP':<8} {'County':<16} {'City'[:35]:<36} {'HHI':>10} {'Growth':<12} {'Score':>7}")
print("-" * 100)
for z in top25:
    city_short = z['city'][:35]
    print(f"{z['priority_rank']:<5} {z['zip']:<8} {z['county'][:15]:<16} {city_short:<36} ${z['median_hhi']:>9,} {z['growth_trend']:<12} {z['composite_score']:>7.1f}")
