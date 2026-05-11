"""
St. Johns seed v2 — correct field names from ParcelView inspection.
Fields: strap, name, dor_cd, addr_1, city, zip, mkt_val, jst_val, soh_val, tax_val, tot_lnd_val, acreage
"""
import subprocess, csv, io, time, os, pickle, sys
import psycopg2

def ni_tsv(v):
    try: return str(int(float(v))) if v and str(v).strip() else r'\N'
    except: return r'\N'

def nf_tsv(v):
    try: return str(float(v)) if v and str(v).strip() else r'\N'
    except: return r'\N'

def esc(v):
    if not v or not str(v).strip():
        return r'\N'
    s = str(v).strip().replace('\\','\\\\').replace('\t',' ').replace('\n',' ').replace('\r',' ')
    return s if s else r'\N'

# Load CAMA pickle
print("Loading cama.pkl...", flush=True)
with open('/tmp/sjcpa/cama.pkl', 'rb') as f:
    cama = pickle.load(f)
bld_cama   = cama.get('bld', {})
sales_cama = cama.get('sales', {})
print(f"  {len(bld_cama):,} bldg, {len(sales_cama):,} sales", flush=True)

# Also load SiteView for physical address if ParcelView addr_1 is mailing address
# Actually addr_1 IS the site address for most parcels (confirmed from sample)
# But zip has extra suffix like "32259-0000" — strip to 5 digits

print("Extracting ParcelView...", flush=True)
t0 = time.time()
result = subprocess.run(
    ['mdb-export', '/tmp/sjcpa/CAMAData.mdb', 'ParcelView'],
    capture_output=True, text=True, timeout=300
)
if result.returncode != 0:
    print(f"ERROR: {result.stderr[:400]}", flush=True)
    sys.exit(1)
print(f"  {time.time()-t0:.1f}s", flush=True)

# Parse and write TSV
print("Building TSV...", flush=True)
t0 = time.time()
reader = csv.DictReader(io.StringIO(result.stdout))
del result

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

TSV = '/tmp/stjohns_seed_v2.tsv'
total = 0

with open(TSV, 'w') as f:
    for row in reader:
        # Normalize keys
        row_lc = {k.lower().strip(): v for k, v in row.items()}
        
        strap = row_lc.get('strap', '').strip()
        if not strap:
            continue

        addr1 = row_lc.get('addr_1', '').strip()
        city  = row_lc.get('city', '').strip()
        zipcd = row_lc.get('zip', '').strip()
        if zipcd and '-' in zipcd:
            zipcd = zipcd.split('-')[0]
        zipcd = zipcd[:5] if zipcd else ''

        own    = row_lc.get('name', '').strip()
        dor_uc = row_lc.get('dor_cd', '').strip()

        # Values: mkt_val=market/JV, soh_val=SOH assessed, tax_val=taxable, tot_lnd_val=land value
        jv    = row_lc.get('mkt_val', '') or row_lc.get('jst_val', '')
        av_sd = row_lc.get('soh_val', '')
        tv_sd = row_lc.get('tax_val', '')
        lnd_v = row_lc.get('tot_lnd_val', '')
        
        # Land sqft from acreage (1 acre = 43560 sqft)
        acr = row_lc.get('acreage', '').strip()
        lnd_s = ''
        if acr:
            try: lnd_s = str(float(acr) * 43560)
            except: pass

        # CAMA enrichment
        b = bld_cama.get(strap, {})
        heat_ar = str(b.get('heat_ar')) if b.get('heat_ar') else ''
        eff_yr  = str(b.get('eff_yr')) if b.get('eff_yr') else ''
        act_yr  = str(b.get('act_yr')) if b.get('act_yr') else ''

        # Sales
        s = sales_cama.get(strap, {})
        sp1, sy1, sm1 = '', '', ''
        if s:
            sp1 = str(s.get('price','')) if s.get('price') else ''
            dos = s.get('dos', '')
            if dos:
                p = dos.split('/')
                if len(p) >= 3:
                    sm1 = p[0].strip()
                    yr = p[2].split()[0].strip() if p[2].strip() else ''
                    if yr:
                        try:
                            y = int(yr)
                            sy1 = str(y if y > 100 else (2000+y if y < 50 else 1900+y))
                        except: pass

        tsv_row = [
            esc(strap), '65', 'st_johns',
            esc(addr1), esc(city), esc(zipcd),
            esc(own),
            nf_tsv(jv), nf_tsv(av_sd), nf_tsv(tv_sd),
            nf_tsv(lnd_v), nf_tsv(lnd_s), nf_tsv(heat_ar),
            ni_tsv(eff_yr), ni_tsv(act_yr),
            r'\N', r'\N', esc(dor_uc),
            nf_tsv(sp1), ni_tsv(sy1), ni_tsv(sm1),
            r'\N', r'\N',
        ]
        f.write('\t'.join(tsv_row) + '\n')
        total += 1

print(f"  {total:,} rows in {time.time()-t0:.1f}s", flush=True)

# COPY to Postgres
print("COPYing...", flush=True)
conn = psycopg2.connect(
    host='turntable.proxy.rlwy.net', port=25739,
    dbname='railway', user='postgres',
    password='mHNhBVhHmYVQdPAKVuysgjpajxzneqkE',
    sslmode='require'
)
conn.autocommit = False
cur = conn.cursor()

cur.execute("CREATE TEMP TABLE tmp_sj (LIKE property_parcels INCLUDING DEFAULTS) ON COMMIT DROP")

t0 = time.time()
with open(TSV) as f:
    cur.copy_from(f, 'tmp_sj', sep='\t', null=r'\N', columns=cols)
print(f"  COPY {cur.rowcount:,} rows in {time.time()-t0:.1f}s", flush=True)

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
FROM tmp_sj
ON CONFLICT (parcel_id) DO UPDATE SET
    own_name=EXCLUDED.own_name,
    jv=EXCLUDED.jv, av_sd=EXCLUDED.av_sd, tv_sd=EXCLUDED.tv_sd,
    lnd_val=EXCLUDED.lnd_val, lnd_sqfoot=EXCLUDED.lnd_sqfoot,
    tot_lvg_ar=EXCLUDED.tot_lvg_ar,
    eff_yr_blt=EXCLUDED.eff_yr_blt, act_yr_blt=EXCLUDED.act_yr_blt,
    phy_addr1=EXCLUDED.phy_addr1, phy_city=EXCLUDED.phy_city, phy_zipcd=EXCLUDED.phy_zipcd,
    sale_prc1=EXCLUDED.sale_prc1, sale_yr1=EXCLUDED.sale_yr1,
    fetched_at=NOW()
""")
conn.commit()
print(f"  Upsert done in {time.time()-t0:.1f}s", flush=True)

# Verify
cur.execute("SELECT county_name, COUNT(*), COUNT(own_name), COUNT(phy_addr1), COUNT(phy_zipcd), COUNT(jv), COUNT(tot_lvg_ar), COUNT(sale_prc1) FROM property_parcels GROUP BY county_name ORDER BY county_name")
print("\n=== FINAL COUNTS ===")
for r in cur.fetchall():
    print(f"  {r[0]}: total={r[1]:,} owner={r[2]:,} addr={r[3]:,} zip={r[4]:,} jv={r[5]:,} sqft={r[6]:,} sale={r[7]:,}")

cur.execute("SELECT COUNT(*) FROM property_parcels WHERE beds IS NOT NULL")
print(f"  With beds (Duval only): {cur.fetchone()[0]:,}")

# Sample good St. Johns row
cur.execute("""
    SELECT parcel_id, phy_addr1, phy_city, phy_zipcd, own_name, jv, tot_lvg_ar, sale_prc1, dor_uc
    FROM property_parcels WHERE co_no=65 AND phy_addr1 IS NOT NULL LIMIT 3
""")
print("\n=== ST JOHNS SAMPLE ===")
for r in cur.fetchall():
    print(f"  {r}")

cur.close()
conn.close()
print("\nDone!", flush=True)
