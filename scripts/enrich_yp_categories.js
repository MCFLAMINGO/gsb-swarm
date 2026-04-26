/**
 * enrich_yp_categories.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LocalIntel pipeline step 2: YP category enrichment.
 *
 * For every business still stuck as 'LocalBusiness', fetches the YP listing
 * page (URL already stored in `website` column) and extracts the structured
 * `categoryText` field that YP embeds in every listing page.
 *
 * Runs in batches of 20 concurrent requests with 500ms delay between batches
 * to avoid rate-limiting. Progress is committed to DB per batch (resumable).
 *
 * After enrichment, kicks the name-pattern reclassifier for anything still
 * unmatched, then backfills sector_counts.
 *
 * Zero LLM calls. Pure structured data extraction.
 *
 * Run: node scripts/enrich_yp_categories.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';
const https  = require('https');
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.LOCAL_INTEL_DB_URL
    || 'postgresql://postgres:myufFnkSigImGnSylwyIjYmLCvkthQUr@turntable.proxy.rlwy.net:25739/railway',
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// ─── YP CATEGORY → OUR SCHEMA ────────────────────────────────────────────────
// YP returns UPPERCASE strings. Keys here are lowercased for matching.
// When a YP category isn't listed, we fall back to keyword extraction from it.
const YP_MAP = {
  // ── Food ──
  'restaurants':                                    { cat: 'restaurant',         grp: 'food' },
  'american restaurants':                           { cat: 'restaurant',         grp: 'food' },
  'family style restaurants':                       { cat: 'casual_dining',      grp: 'food' },
  'casual dining':                                  { cat: 'casual_dining',      grp: 'food' },
  'fine dining restaurants':                        { cat: 'fine_dining',        grp: 'food' },
  'fine dining':                                    { cat: 'fine_dining',        grp: 'food' },
  'fast food restaurants':                          { cat: 'fast_food',          grp: 'food' },
  'chicken restaurants':                            { cat: 'fast_food',          grp: 'food' },
  'hamburgers & hot dogs':                          { cat: 'fast_food',          grp: 'food' },
  'pizza':                                          { cat: 'pizza',              grp: 'food' },
  'pizza restaurants':                              { cat: 'pizza',              grp: 'food' },
  'sandwiches & subs':                              { cat: 'sandwich',           grp: 'food' },
  'sandwich shops':                                 { cat: 'sandwich',           grp: 'food' },
  'mexican restaurants':                            { cat: 'mexican',            grp: 'food' },
  'italian restaurants':                            { cat: 'italian',            grp: 'food' },
  'asian restaurants':                              { cat: 'asian',              grp: 'food' },
  'chinese restaurants':                            { cat: 'asian',              grp: 'food' },
  'japanese restaurants':                           { cat: 'asian',              grp: 'food' },
  'sushi bars':                                     { cat: 'asian',              grp: 'food' },
  'thai restaurants':                               { cat: 'asian',              grp: 'food' },
  'seafood restaurants':                            { cat: 'seafood',            grp: 'food' },
  'steak houses':                                   { cat: 'steakhouse',         grp: 'food' },
  'steakhouses':                                    { cat: 'steakhouse',         grp: 'food' },
  'barbecue restaurants':                           { cat: 'bbq',                grp: 'food' },
  'sports bars':                                    { cat: 'sports_bar',         grp: 'food' },
  'bars':                                           { cat: 'bar',                grp: 'food' },
  'night clubs':                                    { cat: 'bar',                grp: 'food' },
  'nightclubs':                                     { cat: 'bar',                grp: 'food' },
  'lounges':                                        { cat: 'bar',                grp: 'food' },
  'wine':                                           { cat: 'bar_dining',         grp: 'food' },
  'wine bars':                                      { cat: 'bar_dining',         grp: 'food' },
  'breweries':                                      { cat: 'brewery',            grp: 'food' },
  'coffee & tea':                                   { cat: 'cafe',               grp: 'food' },
  'coffee shops':                                   { cat: 'cafe',               grp: 'food' },
  'bakeries':                                       { cat: 'bakery',             grp: 'food' },
  'ice cream & frozen desserts':                    { cat: 'dessert',            grp: 'food' },
  'donut shops':                                    { cat: 'bakery',             grp: 'food' },
  'caterers':                                       { cat: 'restaurant',         grp: 'food' },
  'food trucks':                                    { cat: 'fast_food',          grp: 'food' },
  'delis':                                          { cat: 'deli',               grp: 'food' },
  'delicatessens':                                  { cat: 'deli',               grp: 'food' },
  // ── Grocery ──
  'grocery stores':                                 { cat: 'grocery',            grp: 'grocery' },
  'supermarkets & super stores':                    { cat: 'grocery',            grp: 'grocery' },
  'supermarkets':                                   { cat: 'grocery',            grp: 'grocery' },
  'health food products':                           { cat: 'health_food',        grp: 'grocery' },
  'natural & organic food stores':                  { cat: 'health_food',        grp: 'grocery' },
  'convenience stores':                             { cat: 'convenience',        grp: 'grocery' },
  'liquor stores':                                  { cat: 'liquor',             grp: 'grocery' },
  'beer wine & spirits':                            { cat: 'liquor',             grp: 'grocery' },
  // ── Fuel ──
  'gas stations':                                   { cat: 'gas_station',        grp: 'fuel' },
  'service stations':                               { cat: 'gas_station',        grp: 'fuel' },
  'synthetic oils':                                 { cat: 'gas_station',        grp: 'fuel' },
  // ── Health ──
  'physicians & surgeons':                          { cat: 'clinic',             grp: 'health' },
  'physicians & surgeons, family medicine & general practice': { cat: 'clinic', grp: 'health' },
  'physicians & surgeons, internal medicine':       { cat: 'clinic',             grp: 'health' },
  'physicians & surgeons, pediatrics':              { cat: 'pediatrics',         grp: 'health' },
  'clinics':                                        { cat: 'clinic',             grp: 'health' },
  'medical clinics':                                { cat: 'clinic',             grp: 'health' },
  'medical centers':                                { cat: 'clinic',             grp: 'health' },
  'urgent care':                                    { cat: 'urgent_care',        grp: 'health' },
  'emergency care facilities':                      { cat: 'emergency_room',     grp: 'health' },
  'hospitals':                                      { cat: 'hospital',           grp: 'health' },
  'dentists':                                       { cat: 'dental',             grp: 'health' },
  'dental clinics':                                 { cat: 'dental',             grp: 'health' },
  'orthodontists':                                  { cat: 'dental',             grp: 'health' },
  'oral & maxillofacial surgery':                   { cat: 'dental',             grp: 'health' },
  'pharmacies':                                     { cat: 'pharmacy',           grp: 'health' },
  'drug stores':                                    { cat: 'pharmacy',           grp: 'health' },
  'chiropractors':                                  { cat: 'chiropractic',       grp: 'health' },
  'optometrists':                                   { cat: 'optometry',          grp: 'health' },
  'ophthalmologists':                               { cat: 'optometry',          grp: 'health' },
  'opticians':                                      { cat: 'optometry',          grp: 'health' },
  'physical therapists':                            { cat: 'physical_therapy',   grp: 'health' },
  'physical therapy & rehabilitation':              { cat: 'physical_therapy',   grp: 'health' },
  'mental health services':                         { cat: 'mental_health',      grp: 'health' },
  'psychologists':                                  { cat: 'mental_health',      grp: 'health' },
  'counseling services':                            { cat: 'mental_health',      grp: 'health' },
  'psychiatrists':                                  { cat: 'mental_health',      grp: 'health' },
  'acupuncture':                                    { cat: 'alternative_health', grp: 'health' },
  'assisted living facilities':                     { cat: 'senior_care',        grp: 'health' },
  'nursing homes':                                  { cat: 'senior_care',        grp: 'health' },
  'home health services':                           { cat: 'home_health',        grp: 'health' },
  'medical laboratories':                           { cat: 'lab',                grp: 'health' },
  'laboratories-medical':                           { cat: 'lab',                grp: 'health' },
  'dermatologists':                                 { cat: 'dermatology',        grp: 'health' },
  'cardiologists':                                  { cat: 'cardiology',         grp: 'health' },
  'obstetricians & gynecologists':                  { cat: 'obgyn',              grp: 'health' },
  'orthopedic surgeons':                            { cat: 'orthopedics',        grp: 'health' },
  'plastic & reconstructive surgery':               { cat: 'aesthetics',         grp: 'health' },
  'medical spas':                                   { cat: 'aesthetics',         grp: 'health' },
  'physicians & surgeons, dermatology':             { cat: 'dermatology',        grp: 'health' },
  'physicians & surgeons, oncology':                { cat: 'clinic',             grp: 'health' },
  'veterinarians':                                  { cat: 'veterinary',         grp: 'pets' },
  'animal hospitals':                               { cat: 'veterinary',         grp: 'pets' },
  // ── Fitness ──
  'health clubs':                                   { cat: 'gym',                grp: 'fitness' },
  'gyms':                                           { cat: 'gym',                grp: 'fitness' },
  'fitness centers':                                { cat: 'gym',                grp: 'fitness' },
  'yoga':                                           { cat: 'yoga_studio',        grp: 'fitness' },
  'yoga studios':                                   { cat: 'yoga_studio',        grp: 'fitness' },
  'pilates':                                        { cat: 'pilates',            grp: 'fitness' },
  'martial arts':                                   { cat: 'martial_arts',       grp: 'fitness' },
  'dance studios':                                  { cat: 'dance_studio',       grp: 'fitness' },
  'swimming pools':                                 { cat: 'swim_school',        grp: 'fitness' },
  // ── Auto ──
  'auto repair & service':                          { cat: 'auto_repair',        grp: 'auto' },
  'automobile repairing & service':                 { cat: 'auto_repair',        grp: 'auto' },
  'automobile repairing & service-equipment & supplies': { cat: 'auto_repair',  grp: 'auto' },
  'auto body repairing & painting':                 { cat: 'auto_body',          grp: 'auto' },
  'automobile body repairing & painting':           { cat: 'auto_body',          grp: 'auto' },
  'auto dealers':                                   { cat: 'auto_dealer',        grp: 'auto' },
  'new car dealers':                                { cat: 'auto_dealer',        grp: 'auto' },
  'used car dealers':                               { cat: 'auto_dealer',        grp: 'auto' },
  'auto glass':                                     { cat: 'auto_glass',         grp: 'auto' },
  'windshield repair':                              { cat: 'auto_glass',         grp: 'auto' },
  'automobile air conditioning equipment-service & repair': { cat: 'auto_repair', grp: 'auto' },
  'tires':                                          { cat: 'auto_repair',        grp: 'auto' },
  'towing':                                         { cat: 'towing',             grp: 'auto' },
  'auto parts & supplies':                          { cat: 'auto_parts',         grp: 'auto' },
  // ── Construction / Trades ──
  'general contractors':                            { cat: 'general_contractor', grp: 'construction' },
  'building contractors':                           { cat: 'general_contractor', grp: 'construction' },
  'home builders':                                  { cat: 'general_contractor', grp: 'construction' },
  'contractors':                                    { cat: 'general_contractor', grp: 'construction' },
  'electricians':                                   { cat: 'electrician',        grp: 'construction' },
  'electric companies':                             { cat: 'electrician',        grp: 'construction' },
  'electrical contractors':                         { cat: 'electrician',        grp: 'construction' },
  'plumbers':                                       { cat: 'plumber',            grp: 'construction' },
  'plumbing contractors':                           { cat: 'plumber',            grp: 'construction' },
  'plumbing-drain & sewer cleaning':                { cat: 'plumber',            grp: 'construction' },
  'heating contractors':                            { cat: 'hvac',               grp: 'construction' },
  'heating & cooling':                              { cat: 'hvac',               grp: 'construction' },
  'air conditioning contractors & systems':         { cat: 'hvac',               grp: 'construction' },
  'hvac':                                           { cat: 'hvac',               grp: 'construction' },
  'roofing contractors':                            { cat: 'roofing',            grp: 'construction' },
  'roofing':                                        { cat: 'roofing',            grp: 'construction' },
  'pest control services':                          { cat: 'pest_control',       grp: 'construction' },
  'pest control':                                   { cat: 'pest_control',       grp: 'construction' },
  'exterminating & fumigating':                     { cat: 'pest_control',       grp: 'construction' },
  'landscape contractors':                          { cat: 'landscaping',        grp: 'construction' },
  'lawn maintenance':                               { cat: 'landscaping',        grp: 'construction' },
  'landscaping & lawn services':                    { cat: 'landscaping',        grp: 'construction' },
  'tree service':                                   { cat: 'landscaping',        grp: 'construction' },
  'swimming pool contractors':                      { cat: 'pool_service',       grp: 'construction' },
  'swimming pool dealers':                          { cat: 'pool_service',       grp: 'construction' },
  'swimming pool repair & service':                 { cat: 'pool_service',       grp: 'construction' },
  'screen enclosures':                              { cat: 'screen_enclosure',   grp: 'construction' },
  'patio, porch & deck builders':                   { cat: 'screen_enclosure',   grp: 'construction' },
  'painting contractors':                           { cat: 'painting',           grp: 'construction' },
  'painters':                                       { cat: 'painting',           grp: 'construction' },
  'flooring':                                       { cat: 'flooring',           grp: 'construction' },
  'floor laying, refinishing & resurfacing':        { cat: 'flooring',           grp: 'construction' },
  'tile-contractors & dealers':                     { cat: 'flooring',           grp: 'construction' },
  'fences':                                         { cat: 'fencing',            grp: 'construction' },
  'fence repair':                                   { cat: 'fencing',            grp: 'construction' },
  'solar energy equipment & systems':               { cat: 'solar',              grp: 'construction' },
  'solar energy systems':                           { cat: 'solar',              grp: 'construction' },
  'irrigation systems & equipment':                 { cat: 'irrigation',         grp: 'construction' },
  'sprinklers-garden & lawn':                       { cat: 'irrigation',         grp: 'construction' },
  'masonry contractors':                            { cat: 'masonry',            grp: 'construction' },
  'concrete contractors':                           { cat: 'concrete',           grp: 'construction' },
  'concrete products':                              { cat: 'concrete',           grp: 'construction' },
  'windows':                                        { cat: 'window_door',        grp: 'construction' },
  'windows & doors':                                { cat: 'window_door',        grp: 'construction' },
  'doors, frames & accessories':                    { cat: 'window_door',        grp: 'construction' },
  'drywall contractors':                            { cat: 'drywall',            grp: 'construction' },
  'handyman services':                              { cat: 'handyman',           grp: 'construction' },
  'home repair & maintenance':                      { cat: 'handyman',           grp: 'construction' },
  'home improvements':                              { cat: 'general_contractor', grp: 'construction' },
  'remodeling & repair':                            { cat: 'general_contractor', grp: 'construction' },
  'bathroom remodeling':                            { cat: 'general_contractor', grp: 'construction' },
  'kitchen remodeling':                             { cat: 'general_contractor', grp: 'construction' },
  'home inspection':                                { cat: 'home_inspection',    grp: 'construction' },
  'building inspection service':                    { cat: 'home_inspection',    grp: 'construction' },
  'pressure washing':                               { cat: 'pressure_washing',   grp: 'construction' },
  'power washing':                                  { cat: 'pressure_washing',   grp: 'construction' },
  'septic tanks & systems':                         { cat: 'septic',             grp: 'construction' },
  'gutters & downspouts':                           { cat: 'gutters',            grp: 'construction' },
  'insulation contractors':                         { cat: 'insulation',         grp: 'construction' },
  'interior designers & decorators':                { cat: 'interior_design',    grp: 'construction' },
  'interior design':                                { cat: 'interior_design',    grp: 'construction' },
  'home theater systems':                           { cat: 'home_theater',       grp: 'construction' },
  'home automation':                                { cat: 'home_theater',       grp: 'construction' },
  'audio-visual equipment & services':              { cat: 'home_theater',       grp: 'construction' },
  'mold remediation':                               { cat: 'general_contractor', grp: 'construction' },
  'waterproofing contractors':                      { cat: 'general_contractor', grp: 'construction' },
  // ── Real Estate ──
  'real estate agents':                             { cat: 'real_estate',        grp: 'real_estate' },
  'real estate buyer brokers':                      { cat: 'real_estate',        grp: 'real_estate' },
  'real estate':                                    { cat: 'real_estate',        grp: 'real_estate' },
  'real estate rental service':                     { cat: 'apartment_complex',  grp: 'real_estate' },
  'apartments':                                     { cat: 'apartment_complex',  grp: 'real_estate' },
  'property management':                            { cat: 'property_management',grp: 'real_estate' },
  'mortgages':                                      { cat: 'mortgage',           grp: 'banking' },
  'mortgage bankers':                               { cat: 'mortgage',           grp: 'banking' },
  // ── Banking / Financial ──
  'banks':                                          { cat: 'bank_branch',        grp: 'banking' },
  'credit unions':                                  { cat: 'credit_union',       grp: 'banking' },
  'insurance':                                      { cat: 'insurance',          grp: 'banking' },
  'insurance agents':                               { cat: 'insurance',          grp: 'banking' },
  'life insurance':                                 { cat: 'insurance',          grp: 'banking' },
  'investment advisory service':                    { cat: 'financial_advisor',  grp: 'banking' },
  'financial planning consultants':                 { cat: 'financial_advisor',  grp: 'banking' },
  'tax return preparation & filing':                { cat: 'accounting',         grp: 'professional' },
  'accountants':                                    { cat: 'accounting',         grp: 'professional' },
  // ── Legal ──
  'attorneys':                                      { cat: 'law_firm',           grp: 'legal' },
  'immigration & naturalization consultants':       { cat: 'law_firm',           grp: 'legal' },
  'notaries public':                                { cat: 'law_firm',           grp: 'legal' },
  'title companies':                                { cat: 'law_firm',           grp: 'legal' },
  // ── Retail ──
  'department stores':                              { cat: 'big_box',            grp: 'retail' },
  'clothing stores':                                { cat: 'clothing',           grp: 'retail' },
  'shoe stores':                                    { cat: 'retail',             grp: 'retail' },
  'sporting goods':                                 { cat: 'sporting_goods',     grp: 'retail' },
  'furniture stores':                               { cat: 'furniture',          grp: 'retail' },
  'hardware stores':                                { cat: 'hardware_store',     grp: 'retail' },
  'electronics':                                    { cat: 'electronics_store',  grp: 'retail' },
  'nurseries-plants & trees':                       { cat: 'nursery',            grp: 'retail' },
  'thrift shops':                                   { cat: 'thrift_store',       grp: 'retail' },
  'gifts':                                          { cat: 'retail',             grp: 'retail' },
  'florists':                                       { cat: 'retail',             grp: 'retail' },
  'jewelry':                                        { cat: 'retail',             grp: 'retail' },
  // ── Beauty ──
  'beauty salons':                                  { cat: 'hair_salon',         grp: 'beauty' },
  'hair salons':                                    { cat: 'hair_salon',         grp: 'beauty' },
  'barbers':                                        { cat: 'barbershop',         grp: 'beauty' },
  'nail salons':                                    { cat: 'nail_salon',         grp: 'beauty' },
  'day spas':                                       { cat: 'massage_spa',        grp: 'beauty' },
  'massage therapists':                             { cat: 'massage_spa',        grp: 'beauty' },
  'day spa':                                        { cat: 'massage_spa',        grp: 'beauty' },
  'tanning salons':                                 { cat: 'tanning',            grp: 'beauty' },
  'dry cleaners':                                   { cat: 'dry_cleaning',       grp: 'beauty' },
  'dry cleaners & laundries':                       { cat: 'dry_cleaning',       grp: 'beauty' },
  'cleaners':                                       { cat: 'dry_cleaning',       grp: 'beauty' },
  'alterations':                                    { cat: 'alterations',        grp: 'beauty' },
  // ── Hospitality ──
  'hotels & motels':                                { cat: 'hotel',              grp: 'hospitality' },
  'hotels':                                         { cat: 'hotel',              grp: 'hospitality' },
  'motels':                                         { cat: 'budget_hotel',       grp: 'hospitality' },
  'resorts':                                        { cat: 'upscale_hotel',      grp: 'hospitality' },
  'vacation rentals':                               { cat: 'vacation_rental',    grp: 'hospitality' },
  // ── Civic / Education ──
  'churches':                                       { cat: 'church',             grp: 'civic' },
  'religious organizations':                        { cat: 'church',             grp: 'civic' },
  'schools':                                        { cat: 'school',             grp: 'civic' },
  'child care':                                     { cat: 'childcare',          grp: 'civic' },
  'day care centers & nurseries':                   { cat: 'childcare',          grp: 'civic' },
  'libraries':                                      { cat: 'library',            grp: 'civic' },
  'community centers':                              { cat: 'community_center',   grp: 'civic' },
  // ── Pets ──
  'pet services':                                   { cat: 'pet_grooming',       grp: 'pets' },
  'pet grooming':                                   { cat: 'pet_grooming',       grp: 'pets' },
  'pet stores':                                     { cat: 'pet_store',          grp: 'pets' },
  'kennels':                                        { cat: 'pet_boarding',       grp: 'pets' },
  // ── Professional / Services ──
  'cleaning services':                              { cat: 'cleaning',           grp: 'services' },
  'janitorial service':                             { cat: 'cleaning',           grp: 'services' },
  'moving companies':                               { cat: 'moving',             grp: 'services' },
  'movers':                                         { cat: 'moving',             grp: 'services' },
  'storage-self storage':                           { cat: 'storage',            grp: 'services' },
  'security systems':                               { cat: 'security',           grp: 'professional' },
  'photographers':                                  { cat: 'photography',        grp: 'professional' },
  'printing':                                       { cat: 'printing',           grp: 'professional' },
  'advertising agencies':                           { cat: 'marketing_agency',   grp: 'professional' },
  'computer & equipment dealers':                   { cat: 'it_services',        grp: 'professional' },
  'computer service & repair':                      { cat: 'it_services',        grp: 'professional' },
  'staffing agencies':                              { cat: 'staffing',           grp: 'professional' },
  'funeral homes':                                  { cat: 'funeral_home',       grp: 'professional' },
  'transportation services':                        { cat: 'transport',          grp: 'services' },
  'trucking':                                       { cat: 'transport',          grp: 'services' },
};

// ─── YP KEYWORD FALLBACK ─────────────────────────────────────────────────────
// When YP category string isn't in YP_MAP, extract keywords to map it.
const YP_KEYWORD_RULES = [
  [/plumb/i,              { cat: 'plumber',            grp: 'construction' }],
  [/electr/i,             { cat: 'electrician',        grp: 'construction' }],
  [/roofing/i,            { cat: 'roofing',            grp: 'construction' }],
  [/hvac|air\s*cond|heating|cooling/i, { cat: 'hvac', grp: 'construction' }],
  [/landscap|lawn/i,      { cat: 'landscaping',        grp: 'construction' }],
  [/pest|extermina/i,     { cat: 'pest_control',       grp: 'construction' }],
  [/pool/i,               { cat: 'pool_service',       grp: 'construction' }],
  [/solar/i,              { cat: 'solar',              grp: 'construction' }],
  [/fence|fencing/i,      { cat: 'fencing',            grp: 'construction' }],
  [/flooring|tile/i,      { cat: 'flooring',           grp: 'construction' }],
  [/paint/i,              { cat: 'painting',           grp: 'construction' }],
  [/window|door/i,        { cat: 'window_door',        grp: 'construction' }],
  [/masonry|brick|stone/i,{ cat: 'masonry',            grp: 'construction' }],
  [/concrete/i,           { cat: 'concrete',           grp: 'construction' }],
  [/drywall/i,            { cat: 'drywall',            grp: 'construction' }],
  [/irrig|sprinkl/i,      { cat: 'irrigation',         grp: 'construction' }],
  [/screen|lanai|enclos/i,{ cat: 'screen_enclosure',   grp: 'construction' }],
  [/insul/i,              { cat: 'insulation',         grp: 'construction' }],
  [/gutter/i,             { cat: 'gutters',            grp: 'construction' }],
  [/septic/i,             { cat: 'septic',             grp: 'construction' }],
  [/contract|construct|build|remodel/i, { cat: 'general_contractor', grp: 'construction' }],
  [/physician|surgeon|doctor|medic/i,   { cat: 'clinic',             grp: 'health' }],
  [/dentist|dental|ortho/i,             { cat: 'dental',             grp: 'health' }],
  [/pharm/i,                            { cat: 'pharmacy',           grp: 'health' }],
  [/optom|vision|eye/i,                 { cat: 'optometry',          grp: 'health' }],
  [/chiro/i,                            { cat: 'chiropractic',       grp: 'health' }],
  [/therap|rehab/i,                     { cat: 'physical_therapy',   grp: 'health' }],
  [/mental|counsel|psych/i,             { cat: 'mental_health',      grp: 'health' }],
  [/restaur|dining|eatery/i,            { cat: 'restaurant',         grp: 'food' }],
  [/pizza/i,                            { cat: 'pizza',              grp: 'food' }],
  [/auto|car\s*(repair|service)/i,      { cat: 'auto_repair',        grp: 'auto' }],
  [/attorney|law\s*(firm|office)/i,     { cat: 'law_firm',           grp: 'legal' }],
  [/insur/i,                            { cat: 'insurance',          grp: 'banking' }],
  [/bank|credit\s*union/i,              { cat: 'bank_branch',        grp: 'banking' }],
  [/real\s*estate|realtor/i,            { cat: 'real_estate',        grp: 'real_estate' }],
  [/hair|salon|barber/i,                { cat: 'hair_salon',         grp: 'beauty' }],
  [/nail/i,                             { cat: 'nail_salon',         grp: 'beauty' }],
  [/gym|fitness|health\s*club/i,        { cat: 'gym',                grp: 'fitness' }],
  [/hotel|motel|inn/i,                  { cat: 'hotel',              grp: 'hospitality' }],
  [/child\s*care|daycare|preschool/i,   { cat: 'childcare',          grp: 'civic' }],
  [/church|chapel|ministry/i,           { cat: 'church',             grp: 'civic' }],
  [/clean/i,                            { cat: 'cleaning',           grp: 'services' }],
  [/moving|mover/i,                     { cat: 'moving',             grp: 'services' }],
  [/grocery|supermark/i,                { cat: 'grocery',            grp: 'grocery' }],
  [/gas\s*station|fuel/i,               { cat: 'gas_station',        grp: 'fuel' }],
  [/pet\s*(groo|serv|store)/i,          { cat: 'pet_grooming',       grp: 'pets' }],
  [/veterina|animal\s*(hosp|clinic)/i,  { cat: 'veterinary',         grp: 'pets' }],
];

// ─── HTTP FETCH ───────────────────────────────────────────────────────────────
const fetchYP = (url) => new Promise((resolve) => {
  const req = https.get(url, {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  }, (res) => {
    // Handle redirects
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      resolve(fetchYP(res.headers.location));
      return;
    }
    let data = '';
    res.on('data', c => { data += c; if (data.length > 200000) req.destroy(); });
    res.on('end', () => {
      const m = data.match(/"categoryText":"([^"]+)"/i);
      resolve(m ? m[1].trim() : null);
    });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

// ─── MAP YP CATEGORY STRING TO OUR SCHEMA ────────────────────────────────────
function mapYpCategory(ypCat) {
  if (!ypCat) return null;
  const lower = ypCat.toLowerCase().trim();
  // Exact match first
  if (YP_MAP[lower]) return YP_MAP[lower];
  // Partial match — check if any YP_MAP key is contained in the string
  for (const [key, val] of Object.entries(YP_MAP)) {
    if (lower.includes(key)) return val;
  }
  // Keyword fallback
  for (const [regex, val] of YP_KEYWORD_RULES) {
    if (regex.test(lower)) return val;
  }
  return null;
}

// ─── PIPELINE FUNCTION ────────────────────────────────────────────────────────
const BATCH_SIZE  = 20;  // concurrent requests per batch
const BATCH_DELAY = 600; // ms between batches

async function runYpEnrichment() {
  const startedAt = new Date();
  console.log(`[yp-enrich] Start: ${startedAt.toISOString()}`);

  // Pull all remaining LocalBusiness records with YP URLs
  const { rows: businesses } = await pool.query(`
    SELECT business_id, name, website
    FROM businesses
    WHERE category = 'LocalBusiness'
      AND status = 'active'
      AND website ILIKE '%yellowpages%'
    ORDER BY business_id
  `);
  console.log(`[yp-enrich] Records to enrich: ${businesses.length}`);

  let matched    = 0;
  let unmatched  = 0;
  let fetchFailed = 0;
  let unmappedCats = {};

  for (let i = 0; i < businesses.length; i += BATCH_SIZE) {
    const batch = businesses.slice(i, i + BATCH_SIZE);

    // Fetch all in parallel
    const results = await Promise.all(
      batch.map(async (biz) => {
        const ypCat = await fetchYP(biz.website);
        const mapping = mapYpCategory(ypCat);
        return { biz, ypCat, mapping };
      })
    );

    // Collect updates for this batch
    const updates = results.filter(r => r.mapping);
    const ids    = updates.map(r => r.biz.business_id);
    const cats   = updates.map(r => r.mapping.cat);
    const groups = updates.map(r => r.mapping.grp);

    if (ids.length > 0) {
      await pool.query(
        `UPDATE businesses
           SET category = vals.cat,
               category_group = vals.grp,
               classification_attempted_at = NOW()
           FROM (SELECT unnest($1::uuid[]) as business_id,
                        unnest($2::text[])  as cat,
                        unnest($3::text[])  as grp) vals
          WHERE businesses.business_id = vals.business_id`,
        [ids, cats, groups]
      );
      matched += ids.length;
    }

    // Track unmatched
    results.forEach(r => {
      if (!r.ypCat) { fetchFailed++; }
      else if (!r.mapping) {
        unmatched++;
        const k = r.ypCat.toUpperCase();
        unmappedCats[k] = (unmappedCats[k] || 0) + 1;
      }
    });

    const done = Math.min(i + BATCH_SIZE, businesses.length);
    process.stdout.write(`\r[yp-enrich] ${done}/${businesses.length} | matched: ${matched} | unmatched: ${unmatched} | no-fetch: ${fetchFailed}`);

    // Rate limit delay between batches
    if (i + BATCH_SIZE < businesses.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
  console.log('');

  // Log top unmapped YP categories (to improve mapping table over time)
  const topUnmapped = Object.entries(unmappedCats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  if (topUnmapped.length > 0) {
    console.log('[yp-enrich] Top unmapped YP categories (add to YP_MAP):');
    topUnmapped.forEach(([cat, cnt]) => console.log(`  ${cnt.toString().padStart(4)}  ${cat}`));
  }

  // Log to pipeline_runs
  const finishedAt = new Date();
  await pool.query(
    `INSERT INTO pipeline_runs
       (pipeline, started_at, finished_at, total_scanned, matched, unmatched, downgraded, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      'enrich_yp_categories',
      startedAt,
      finishedAt,
      businesses.length,
      matched,
      unmatched,
      fetchFailed,
      `fetch_failed: ${fetchFailed} | runtime: ${Math.round((finishedAt - startedAt) / 1000)}s`,
    ]
  );

  const stats = { total: businesses.length, matched, unmatched, fetchFailed };
  console.log('[yp-enrich] Done.', stats);
  return stats;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  runYpEnrichment()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runYpEnrichment };
