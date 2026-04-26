/**
 * enrich_yp_categories.js
 * Fetches YellowPages listing pages for all LocalBusiness records
 * and extracts the "categoryText" field to reclassify them.
 * Runs in parallel batches of 20 concurrent requests.
 */
const https = require('https');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.LOCAL_INTEL_DB_URL || 'postgresql://postgres:myufFnkSigImGnSylwyIjYmLCvkthQUr@turntable.proxy.rlwy.net:25739/railway' });

// YP categoryText → our (category, category_group)
const YP_MAP = {
  // Food
  'restaurants': { cat:'restaurant', grp:'food' },
  'pizza restaurants': { cat:'pizza', grp:'food' },
  'pizza': { cat:'pizza', grp:'food' },
  'fast food restaurants': { cat:'fast_food', grp:'food' },
  'fast food': { cat:'fast_food', grp:'food' },
  'coffee & tea': { cat:'cafe', grp:'food' },
  'coffee': { cat:'cafe', grp:'food' },
  'cafes': { cat:'cafe', grp:'food' },
  'bakeries': { cat:'bakery', grp:'food' },
  'bars': { cat:'bar', grp:'food' },
  'night clubs': { cat:'bar', grp:'food' },
  'nightclubs': { cat:'bar', grp:'food' },
  'lounges': { cat:'bar', grp:'food' },
  'american restaurants': { cat:'restaurant', grp:'food' },
  'italian restaurants': { cat:'italian', grp:'food' },
  'mexican restaurants': { cat:'mexican', grp:'food' },
  'chinese restaurants': { cat:'asian', grp:'food' },
  'japanese restaurants': { cat:'asian', grp:'food' },
  'sushi bars': { cat:'asian', grp:'food' },
  'thai restaurants': { cat:'asian', grp:'food' },
  'seafood restaurants': { cat:'seafood', grp:'food' },
  'steak houses': { cat:'steakhouse', grp:'food' },
  'steakhouses': { cat:'steakhouse', grp:'food' },
  'barbecue restaurants': { cat:'bbq', grp:'food' },
  'fine dining restaurants': { cat:'fine_dining', grp:'food' },
  'fine dining': { cat:'fine_dining', grp:'food' },
  'ice cream & frozen desserts': { cat:'dessert', grp:'food' },
  'ice cream': { cat:'dessert', grp:'food' },
  'sandwich shops': { cat:'deli', grp:'food' },
  'delis': { cat:'deli', grp:'food' },
  'burgers': { cat:'fast_food', grp:'food' },
  'diners': { cat:'casual_dining', grp:'food' },
  'family style restaurants': { cat:'casual_dining', grp:'food' },
  'sports bars': { cat:'sports_bar', grp:'food' },
  'wine bars': { cat:'bar_dining', grp:'food' },
  'breweries': { cat:'brewery', grp:'food' },
  'caterers': { cat:'restaurant', grp:'food' },
  'food trucks': { cat:'fast_food', grp:'food' },
  'grocery stores': { cat:'grocery', grp:'grocery' },
  'supermarkets & super stores': { cat:'grocery', grp:'grocery' },
  'supermarkets': { cat:'grocery', grp:'grocery' },
  'convenience stores': { cat:'convenience', grp:'grocery' },
  'gas stations': { cat:'gas_station', grp:'fuel' },
  'service stations': { cat:'gas_station', grp:'fuel' },
  // Health
  'physicians & surgeons': { cat:'clinic', grp:'health' },
  'medical centers': { cat:'clinic', grp:'health' },
  'medical clinics': { cat:'clinic', grp:'health' },
  'clinics': { cat:'clinic', grp:'health' },
  'urgent care': { cat:'urgent_care', grp:'health' },
  'emergency care facilities': { cat:'emergency_room', grp:'health' },
  'dentists': { cat:'dental', grp:'health' },
  'dental clinics': { cat:'dental', grp:'health' },
  'orthodontists': { cat:'dental', grp:'health' },
  'pharmacies': { cat:'pharmacy', grp:'health' },
  'drug stores': { cat:'pharmacy', grp:'health' },
  'chiropractors': { cat:'chiropractic', grp:'health' },
  'optometrists': { cat:'optometry', grp:'health' },
  'physical therapists': { cat:'physical_therapy', grp:'health' },
  'mental health services': { cat:'mental_health', grp:'health' },
  'psychologists': { cat:'mental_health', grp:'health' },
  'counseling services': { cat:'mental_health', grp:'health' },
  'assisted living facilities': { cat:'senior_care', grp:'health' },
  'nursing homes': { cat:'senior_care', grp:'health' },
  'home health services': { cat:'home_health', grp:'health' },
  'medical laboratories': { cat:'lab', grp:'health' },
  'laboratories': { cat:'lab', grp:'health' },
  'dermatologists': { cat:'dermatology', grp:'health' },
  'medical spas': { cat:'medical_spa', grp:'health' },
  'plastic surgeons': { cat:'medical_spa', grp:'health' },
  // Legal
  'attorneys': { cat:'legal', grp:'legal' },
  'lawyers': { cat:'legal', grp:'legal' },
  'personal injury attorneys': { cat:'personal_injury', grp:'legal' },
  'criminal law attorneys': { cat:'criminal_defense', grp:'legal' },
  'family law attorneys': { cat:'family_law', grp:'legal' },
  'real estate attorneys': { cat:'real_estate_law', grp:'legal' },
  'accountants': { cat:'accounting', grp:'legal' },
  'tax return preparation': { cat:'accounting', grp:'legal' },
  'certified public accountants': { cat:'accounting', grp:'legal' },
  'bookkeeping': { cat:'accounting', grp:'legal' },
  // Beauty
  'beauty salons': { cat:'hair_salon', grp:'beauty' },
  'hair salons': { cat:'hair_salon', grp:'beauty' },
  'barbers': { cat:'barbershop', grp:'beauty' },
  'nail salons': { cat:'nail_salon', grp:'beauty' },
  'day spas': { cat:'spa_massage', grp:'beauty' },
  'massage therapists': { cat:'spa_massage', grp:'beauty' },
  'massage': { cat:'spa_massage', grp:'beauty' },
  'waxing': { cat:'waxing_threading', grp:'beauty' },
  'dry cleaning': { cat:'dry_cleaning', grp:'beauty' },
  'laundry': { cat:'dry_cleaning', grp:'beauty' },
  'tanning salons': { cat:'tanning', grp:'beauty' },
  'tattoo': { cat:'tattoo', grp:'beauty' },
  // Fitness
  'health clubs': { cat:'gym_chain', grp:'fitness' },
  'gyms': { cat:'gym_chain', grp:'fitness' },
  'fitness centers': { cat:'gym_chain', grp:'fitness' },
  'yoga': { cat:'yoga', grp:'fitness' },
  'pilates': { cat:'pilates', grp:'fitness' },
  'martial arts': { cat:'martial_arts', grp:'fitness' },
  // Hospitality
  'hotels': { cat:'hotel', grp:'hospitality' },
  'motels': { cat:'hotel', grp:'hospitality' },
  'bed & breakfast & inns': { cat:'inn_bnb', grp:'hospitality' },
  'resorts': { cat:'resort', grp:'hospitality' },
  // Real Estate
  'real estate agents': { cat:'estate_agent', grp:'real_estate' },
  'real estate': { cat:'estate_agent', grp:'real_estate' },
  'real estate rental service': { cat:'apartments', grp:'real_estate' },
  'apartments': { cat:'apartments', grp:'real_estate' },
  'property management': { cat:'property_management', grp:'real_estate' },
  'self storage': { cat:'self_storage', grp:'real_estate' },
  // Banking
  'banks': { cat:'bank', grp:'banking' },
  'credit unions': { cat:'credit_union', grp:'banking' },
  'insurance': { cat:'insurance_agency', grp:'banking' },
  'insurance agents': { cat:'insurance_agency', grp:'banking' },
  'mortgage companies': { cat:'mortgage', grp:'banking' },
  'financial advisors': { cat:'financial_advisor', grp:'banking' },
  'financial planning consultants': { cat:'financial_advisor', grp:'banking' },
  // Auto
  'auto repair & service': { cat:'auto_repair', grp:'auto' },
  'automobile body repairing & painting': { cat:'auto_repair', grp:'auto' },
  'tire dealers': { cat:'auto_repair', grp:'auto' },
  'towing': { cat:'towing', grp:'auto' },
  'car washes': { cat:'car_wash', grp:'auto' },
  'new car dealers': { cat:'car_dealer', grp:'auto' },
  'used car dealers': { cat:'car_dealer', grp:'auto' },
  'auto parts & supplies': { cat:'auto_parts', grp:'auto' },
  // Construction
  'roofing contractors': { cat:'roofing', grp:'construction' },
  'plumbers': { cat:'plumber', grp:'construction' },
  'electricians': { cat:'electrician', grp:'construction' },
  'heating & air conditioning': { cat:'hvac', grp:'construction' },
  'landscaping & lawn services': { cat:'landscaping', grp:'construction' },
  'general contractors': { cat:'general_contractor', grp:'construction' },
  'pest control services': { cat:'pest_control', grp:'construction' },
  'painting contractors': { cat:'painting', grp:'construction' },
  'flooring contractors': { cat:'flooring', grp:'construction' },
  'swimming pool dealers': { cat:'pool_service', grp:'construction' },
  'fence contractors': { cat:'fencing', grp:'construction' },
  'solar energy contractors': { cat:'solar', grp:'construction' },
  'home builders': { cat:'general_contractor', grp:'construction' },
  // Retail
  'furniture stores': { cat:'furniture', grp:'retail' },
  'electronics stores': { cat:'electronics', grp:'retail' },
  'clothing stores': { cat:'clothing_boutique', grp:'retail' },
  'shoe stores': { cat:'clothing_boutique', grp:'retail' },
  'sporting goods': { cat:'sporting_goods', grp:'retail' },
  'pet stores': { cat:'pet_store', grp:'retail' },
  'book stores': { cat:'bookstore', grp:'retail' },
  'home improvement': { cat:'home_improvement', grp:'retail' },
  'hardware stores': { cat:'home_improvement', grp:'retail' },
  'department stores': { cat:'mass_retail', grp:'retail' },
  'discount stores': { cat:'mass_retail', grp:'retail' },
  'used merchandise stores': { cat:'thrift', grp:'retail' },
  'liquor stores': { cat:'liquor_store', grp:'retail' },
  // Pets
  'veterinarians': { cat:'veterinary', grp:'pets' },
  'animal hospitals': { cat:'veterinary', grp:'pets' },
  'pet grooming': { cat:'pet_grooming', grp:'pets' },
  'kennels': { cat:'pet_grooming', grp:'pets' },
  'pet training': { cat:'pet_grooming', grp:'pets' },
  // Civic
  'churches': { cat:'place_of_worship', grp:'civic' },
  'religious organizations': { cat:'place_of_worship', grp:'civic' },
  'schools': { cat:'school', grp:'civic' },
  'elementary schools': { cat:'school', grp:'civic' },
  'high schools': { cat:'school', grp:'civic' },
  'colleges': { cat:'college', grp:'civic' },
  'day care centers': { cat:'childcare', grp:'civic' },
  'child care': { cat:'childcare', grp:'civic' },
  // Services
  'cleaning services': { cat:'cleaning_service', grp:'services' },
  'movers': { cat:'moving', grp:'services' },
  'moving companies': { cat:'moving', grp:'services' },
  'printing services': { cat:'printing_signs', grp:'services' },
  'security services': { cat:'security', grp:'services' },
  'funeral homes': { cat:'funeral_home', grp:'services' },
  // Professional
  'marketing consultants': { cat:'marketing_agency', grp:'professional' },
  'computer service & repair': { cat:'it_services', grp:'professional' },
  'staffing services': { cat:'staffing', grp:'professional' },
  'employment agencies': { cat:'staffing', grp:'professional' },
};

const fetchYP = (url) => new Promise((resolve) => {
  const req = https.get(url, { 
    headers: { 
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0',
      'Accept': 'text/html',
    },
    timeout: 7000
  }, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; if (data.length > 80000) req.destroy(); });
    res.on('end', () => resolve(data));
  });
  req.on('error', () => resolve(''));
  req.on('timeout', () => { req.destroy(); resolve(''); });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const { rows } = await pool.query(`
    SELECT business_id, name, website FROM businesses 
    WHERE category='LocalBusiness' AND status='active' AND website ILIKE '%yellowpages%'
    ORDER BY zip  -- process by ZIP for locality
  `);
  
  console.log(`Total to fetch: ${rows.length}`);
  
  const CONCURRENCY = 15;
  const CHUNK = 15;
  let processed = 0;
  let matched = 0;
  let updates = [];
  const SAVE_EVERY = 200;

  const saveUpdates = async () => {
    if (updates.length === 0) return;
    const batch = updates.splice(0, updates.length);
    await pool.query(
      `UPDATE businesses SET category = vals.cat, category_group = vals.grp
       FROM (SELECT unnest($1::uuid[]) as id, unnest($2::text[]) as cat, unnest($3::text[]) as grp) vals
       WHERE businesses.business_id = vals.id`,
      [batch.map(u=>u.id), batch.map(u=>u.cat), batch.map(u=>u.grp)]
    );
    return batch.length;
  };

  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map(async (biz) => {
      const html = await fetchYP(biz.website);
      if (!html) return null;
      const m = html.match(/"categoryText":"([^"]+)"/i);
      if (!m) return null;
      const ypCat = m[1].toLowerCase().trim();
      const mapping = YP_MAP[ypCat];
      if (mapping) return { id: biz.business_id, cat: mapping.cat, grp: mapping.grp, ypCat };
      return null;
    }));

    for (const r of results) {
      processed++;
      if (r) {
        matched++;
        updates.push(r);
      }
    }

    if (updates.length >= SAVE_EVERY) {
      const saved = await saveUpdates();
      process.stdout.write(`\rFetched: ${processed}/${rows.length} | Matched: ${matched} | Saved: ${saved}   `);
    } else {
      process.stdout.write(`\rFetched: ${processed}/${rows.length} | Matched: ${matched}   `);
    }

    // Polite delay every 100 requests
    if (i > 0 && i % 100 === 0) await sleep(500);
  }

  // Save remaining
  await saveUpdates();
  console.log(`\nDone. Processed: ${processed}, Matched+Updated: ${matched}`);

  const lb = await pool.query(`SELECT COUNT(*) FROM businesses WHERE category='LocalBusiness' AND status='active'`);
  console.log('Remaining LocalBusiness:', lb.rows[0].count);

  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
