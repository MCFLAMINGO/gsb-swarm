"""
Fast Duval seed using PostgreSQL COPY instead of row-by-row upsert.
1. Parse pipe-delimited TXT → /tmp/duval_seed.csv
2. COPY into temp table
3. INSERT ... ON CONFLICT from temp table
"""
import io, zipfile, csv, time, sys, os

def ni(v):
    try: return str(int(float(v))) if v and str(v).strip() else r'\N'
    except: return r'\N'

def nf(v):
    try: return str(float(v)) if v and str(v).strip() else r'\N'
    except: return r'\N'

def esc(v):
    if not v or not str(v).strip():
        return r'\N'
    s = str(v).replace('\\', '\\\\').replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')
    return s

# ── Step 1: Parse Duval TXT ──────────────────────────────────────────────────
print("Parsing Duval TXT...", flush=True)
t0 = time.time()

ZFILE = '/tmp/duval_re.zip'
if not os.path.exists(ZFILE) or os.path.getsize(ZFILE) < 1000000:
    import urllib.request
    DUVAL_URL = "https://www.jacksonville.gov/getContentAsset/4ba5d763-86ad-4f25-9f1f-721be7260c14/135b97c9-84fa-4e82-b956-0fbccec4aa1f/DCPAO-REAL-ESTATE-PIPE-DELIMITED-TEXT-UNCERTIFIED-AS-OF-03-02-2026.zip?language=en"
    print("  Downloading...", flush=True)
    with urllib.request.urlopen(urllib.request.Request(DUVAL_URL, headers={"User-Agent":"Mozilla/5.0"}), timeout=120) as r:
        with open(ZFILE, 'wb') as f:
            f.write(r.read())
    print(f"  Downloaded {os.path.getsize(ZFILE)//1024//1024}MB", flush=True)

# Streaming parse
parcels = {}   # strap → dict
owners  = {}   # strap → name
sites   = {}   # strap → dict
bldgs   = {}   # strap → dict
beds    = {}   # strap → int
baths   = {}   # strap → float

z = zipfile.ZipFile(ZFILE)
fname = z.namelist()[0]
print(f"  Parsing {fname}...", flush=True)

with z.open(fname) as fh:
    for line in io.TextIOWrapper(fh, encoding='latin-1', errors='replace'):
        parts = line.rstrip('\n\r').split('|')
        if len(parts) < 3:
            continue
        rtype = parts[0].strip()
        strap = parts[1].strip()
        if not strap:
            continue

        if rtype == '00001':
            if len(parts) < 26:
                continue
            parcels[strap] = {
                'jv':    parts[22].strip() if len(parts)>22 else '',
                'av_sd': parts[23].strip() if len(parts)>23 else '',
                'tv_sd': parts[25].strip() if len(parts)>25 else '',
                'dor_uc': parts[13].strip() if len(parts)>13 else '',
                'sqft':  parts[30].strip() if len(parts)>30 else '',
            }
        elif rtype == '00003':
            ln = parts[2].strip() if len(parts)>2 else ''
            if ln == '1' and len(parts)>3:
                owners[strap] = parts[3].strip()
        elif rtype == '00004':
            num  = parts[2].strip() if len(parts)>2 else ''
            pfx  = parts[3].strip() if len(parts)>3 else ''
            nm   = parts[4].strip() if len(parts)>4 else ''
            sfx  = parts[5].strip() if len(parts)>5 else ''
            unit = parts[6].strip() if len(parts)>6 else ''
            city = parts[7].strip() if len(parts)>7 else ''
            zipcd= parts[8].strip() if len(parts)>8 else ''
            addr_parts = [x for x in [num, pfx, nm, sfx] if x]
            addr1 = ' '.join(addr_parts)
            if unit:
                addr1 += f' {unit}'
            sites[strap] = {'addr1': addr1, 'city': city, 'zip': zipcd[:5]}
        elif rtype == '00005':
            if strap not in bldgs and len(parts)>=13:
                bldgs[strap] = {
                    'act_yr': parts[8].strip() if len(parts)>8 else '',
                    'eff_yr': parts[9].strip() if len(parts)>9 else '',
                    'heat_ar': parts[12].strip() if len(parts)>12 else '',
                }
        elif rtype == '00007' and len(parts)>=6:
            cd   = parts[3].strip() if len(parts)>3 else ''
            desc = parts[4].strip().lower() if len(parts)>4 else ''
            units_raw = parts[5].strip() if len(parts)>5 else ''
            is_bed  = cd == '1' or 'bedroom' in desc or desc in ('br','bed')
            is_bath = cd == '2' or 'bath' in desc
            if is_bed and strap not in beds:
                try: beds[strap] = int(float(units_raw))
                except: pass
            elif is_bath and strap not in baths:
                try: baths[strap] = float(units_raw)
                except: pass

print(f"  {len(parcels):,} parcels in {time.time()-t0:.1f}s", flush=True)

# ── Step 2: Write tab-separated file for COPY ────────────────────────────────
TSV = '/tmp/duval_seed.tsv'
print(f"  Writing {TSV}...", flush=True)
t0 = time.time()
cols = [
    'parcel_id','co_no','county_name',
    'phy_addr1','phy_city','phy_zipcd',
    'own_name','jv','av_sd','tv_sd',
    'lnd_val','lnd_sqfoot','tot_lvg_ar',
    'eff_yr_blt','act_yr_blt',
    'no_buldng','no_res_unt','dor_uc',
    'sale_prc1','sale_yr1','sale_mo1',
    'beds','baths'
]

with open(TSV, 'w') as f:
    for strap, p in parcels.items():
        site = sites.get(strap, {})
        bldg = bldgs.get(strap, {})
        row = [
            esc(strap), '26', 'duval',
            esc(site.get('addr1','')), esc(site.get('city','')), esc(site.get('zip','')),
            esc(owners.get(strap,'')),
            nf(p.get('jv','')), nf(p.get('av_sd','')), nf(p.get('tv_sd','')),
            r'\N', nf(p.get('sqft','')), nf(bldg.get('heat_ar','')),
            ni(bldg.get('eff_yr','')), ni(bldg.get('act_yr','')),
            r'\N', r'\N', esc(p.get('dor_uc','')),
            r'\N', r'\N', r'\N',
            str(beds[strap]) if strap in beds else r'\N',
            str(baths[strap]) if strap in baths else r'\N',
        ]
        f.write('\t'.join(row) + '\n')

sz = os.path.getsize(TSV)
print(f"  Wrote {sz//1024//1024}MB in {time.time()-t0:.1f}s", flush=True)

# Free memory
del parcels, owners, sites, bldgs, beds, baths
import gc; gc.collect()

# ── Step 3: COPY to Postgres ─────────────────────────────────────────────────
print("  COPYing to Postgres...", flush=True)
import psycopg2

conn = psycopg2.connect(
    host='turntable.proxy.rlwy.net', port=25739,
    dbname='railway', user='postgres',
    password='mHNhBVhHmYVQdPAKVuysgjpajxzneqkE',
    sslmode='require'
)
conn.autocommit = False
cur = conn.cursor()

# Create temp table matching property_parcels structure
cur.execute("""
CREATE TEMP TABLE tmp_duval (LIKE property_parcels INCLUDING DEFAULTS) ON COMMIT DROP
""")

t0 = time.time()
with open(TSV) as f:
    cur.copy_from(f, 'tmp_duval', sep='\t', null=r'\N', columns=cols)

row_count = cur.rowcount
print(f"  COPY: {row_count:,} rows in {time.time()-t0:.1f}s", flush=True)

# Upsert from temp table
print("  Upserting...", flush=True)
t0 = time.time()
cur.execute("""
INSERT INTO property_parcels (
    parcel_id, co_no, county_name,
    phy_addr1, phy_city, phy_zipcd,
    own_name, jv, av_sd, tv_sd,
    lnd_val, lnd_sqfoot, tot_lvg_ar,
    eff_yr_blt, act_yr_blt,
    no_buldng, no_res_unt, dor_uc,
    sale_prc1, sale_yr1, sale_mo1,
    beds, baths, fetched_at
)
SELECT
    parcel_id, co_no, county_name,
    phy_addr1, phy_city, phy_zipcd,
    own_name, jv, av_sd, tv_sd,
    lnd_val, lnd_sqfoot, tot_lvg_ar,
    eff_yr_blt, act_yr_blt,
    no_buldng, no_res_unt, dor_uc,
    sale_prc1, sale_yr1, sale_mo1,
    beds, baths, NOW()
FROM tmp_duval
ON CONFLICT (parcel_id) DO UPDATE SET
    own_name=EXCLUDED.own_name,
    jv=EXCLUDED.jv, av_sd=EXCLUDED.av_sd, tv_sd=EXCLUDED.tv_sd,
    tot_lvg_ar=EXCLUDED.tot_lvg_ar,
    eff_yr_blt=EXCLUDED.eff_yr_blt, act_yr_blt=EXCLUDED.act_yr_blt,
    phy_addr1=EXCLUDED.phy_addr1, phy_city=EXCLUDED.phy_city, phy_zipcd=EXCLUDED.phy_zipcd,
    sale_prc1=EXCLUDED.sale_prc1, sale_yr1=EXCLUDED.sale_yr1,
    beds=EXCLUDED.beds, baths=EXCLUDED.baths,
    fetched_at=NOW()
""")

conn.commit()
print(f"  Upsert done in {time.time()-t0:.1f}s", flush=True)

# Check
cur.execute("SELECT COUNT(*) FROM property_parcels WHERE co_no=26")
cnt = cur.fetchone()[0]
print(f"  Duval rows in DB: {cnt:,}", flush=True)

cur.execute("SELECT COUNT(*) FROM property_parcels WHERE co_no=26 AND beds IS NOT NULL")
bcnt = cur.fetchone()[0]
print(f"  Duval with beds: {bcnt:,}", flush=True)

cur.close()
conn.close()
print("\nDuval seed complete!", flush=True)
