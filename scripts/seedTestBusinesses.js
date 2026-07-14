'use strict';
/**
 * scripts/seedTestBusinesses.js
 * Seeds one demo business per key category — all in ZIP 32082.
 * Each gets a claimed_at, dispatch_token, and full W5+H presence data
 * so the inbox dashboard can be previewed at /inbox.html?token=<token>
 *
 * Worker contract: reads existing test businesses by name — skips if already present.
 * Safe to re-run on every deploy.
 *
 * WHO:  Erik / seeder script
 * WHAT: Create 12 demo businesses with full W5+H presence data
 * WHERE: businesses table, ZIP 32082
 * WHEN: runs once on deploy via runSeeds()
 * WHY:  Allow previewing the inbox admin page for every category type
 * HOW:  INSERT … ON CONFLICT (name, zip) DO UPDATE … (idempotent)
 */

const crypto = require('crypto');

const TEST_BUSINESSES = [
  {
    name: 'Ponte Vedra Grille [TEST]',
    category: 'restaurant', category_group: 'food_drink',
    address: '123 Ocean Way', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0101', website: 'https://pvgrille.demo',
    description: 'Farm-to-table American cuisine with ocean views. Breakfast, lunch, and dinner daily.',
    tagline: 'Fresh local ingredients, every plate.',
    why_choose_us: 'Award-winning chef, locally sourced menu, waterfront dining.',
    booking_url: 'https://www.opentable.com/demo', booking_system: 'opentable',
    accepts_reservations: true, accepts_walkins: true,
    payment_methods: ['cash', 'card'],
    tech_stack: [
      { id: 'toast', name: 'Toast POS', category: 'pos', status: 'connected', url: 'https://pos.toasttab.com' },
      { id: 'opentable', name: 'OpenTable', category: 'reservations', status: 'connected', url: 'https://www.opentable.com' },
      { id: 'google_workspace', name: 'Google Workspace', category: 'email', status: 'connected', url: 'https://workspace.google.com' },
      { id: 'jolt', name: 'Jolt', category: 'tasks', status: 'connected', url: 'https://www.jolt.com' },
    ],
    hours: 'Mon-Sun 7am-10pm',
  },
  {
    name: 'First Coast Plumbing [TEST]',
    category: 'plumber', category_group: 'home_services',
    address: '456 Solano Rd', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0102', website: 'https://fcplumbing.demo',
    description: 'Licensed plumber serving St. Johns and Duval County. Same-day service available.',
    tagline: 'Same-day plumbing — no surprises.',
    why_choose_us: 'Licensed & insured. Flat-rate pricing. 24/7 emergency line.',
    accepts_rfq: true, accepts_walkins: false, same_day_available: true,
    service_radius_miles: 25,
    payment_methods: ['cash', 'card', 'invoice'],
    tech_stack: [
      { id: 'servicetitan', name: 'ServiceTitan', category: 'pos', status: 'connected', url: 'https://www.servicetitan.com' },
      { id: 'google_workspace', name: 'Google Workspace', category: 'email', status: 'connected', url: 'https://workspace.google.com' },
      { id: 'stripe', name: 'Stripe', category: 'payments', status: 'connected', url: 'https://stripe.com' },
    ],
    hours: 'Mon-Fri 7am-6pm, Sat 8am-2pm',
  },
  {
    name: 'Coastal Nail Spa [TEST]',
    category: 'nail_salon', category_group: 'beauty_wellness',
    address: '789 A1A North', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0103', website: 'https://coastalnail.demo',
    description: 'Full-service nail salon. Manicures, pedicures, gel, acrylics, and nail art.',
    tagline: 'Your nails, perfected.',
    why_choose_us: 'Top-rated nail techs, clean & relaxing environment, walk-ins always welcome.',
    booking_url: 'https://booksy.com/demo', booking_system: 'booksy',
    accepts_appointments: true, accepts_walkins: true,
    payment_methods: ['cash', 'card'],
    tech_stack: [
      { id: 'square', name: 'Square POS', category: 'pos', status: 'connected', url: 'https://squareup.com' },
      { id: 'booksy', name: 'Booksy', category: 'scheduling', status: 'connected', url: 'https://booksy.com' },
    ],
    hours: 'Mon-Sat 9am-7pm, Sun 10am-5pm',
  },
  {
    name: 'Beachside Blowouts [TEST]',
    category: 'hairdresser', category_group: 'beauty_wellness',
    address: '321 Palm Valley Rd', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0104', website: 'https://beachsideblowouts.demo',
    description: 'Color, cuts, blowouts, and extensions. Specializing in balayage and beach waves.',
    tagline: 'Hair that moves like the ocean.',
    why_choose_us: 'Master colorists, Davines products, private suite available.',
    booking_url: 'https://vagaro.com/demo', booking_system: 'vagaro',
    accepts_appointments: true, accepts_walkins: false,
    payment_methods: ['cash', 'card'],
    tech_stack: [
      { id: 'vagaro', name: 'Vagaro', category: 'scheduling', status: 'connected', url: 'https://www.vagaro.com' },
      { id: 'square', name: 'Square POS', category: 'pos', status: 'connected', url: 'https://squareup.com' },
    ],
    hours: 'Tue-Sat 9am-6pm',
  },
  {
    name: 'Sunshine State Electric [TEST]',
    category: 'electrician', category_group: 'home_services',
    address: '654 Solano Rd', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0105', website: 'https://sselec.demo',
    description: 'Licensed electrician. Panel upgrades, EV chargers, whole-home rewiring, smart home.',
    tagline: 'Wired right the first time.',
    why_choose_us: 'Master electrician, 20-year warranty on labor, EV charger specialists.',
    accepts_rfq: true, same_day_available: true, service_radius_miles: 30,
    payment_methods: ['card', 'invoice'],
    tech_stack: [
      { id: 'servicetitan', name: 'ServiceTitan', category: 'pos', status: 'connected', url: 'https://www.servicetitan.com' },
      { id: 'stripe', name: 'Stripe', category: 'payments', status: 'connected', url: 'https://stripe.com' },
      { id: 'google_workspace', name: 'Google Workspace', category: 'email', status: 'connected', url: 'https://workspace.google.com' },
    ],
    hours: 'Mon-Fri 7am-5pm',
  },
  {
    name: 'Atlantic Lawn & Garden [TEST]',
    category: 'landscaping', category_group: 'home_services',
    address: '987 TPC Blvd', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0106', website: 'https://atlanticlawn.demo',
    description: 'Weekly lawn maintenance, irrigation systems, and landscape design. HOA specialists.',
    tagline: 'Your yard, every week.',
    why_choose_us: 'Licensed irrigator, Angies List certified, same crew every visit.',
    accepts_rfq: true, service_radius_miles: 15,
    payment_methods: ['card', 'invoice'],
    tech_stack: [
      { id: 'jobber', name: 'Jobber', category: 'pos', status: 'connected', url: 'https://getjobber.com' },
      { id: 'stripe', name: 'Stripe', category: 'payments', status: 'connected', url: 'https://stripe.com' },
    ],
    hours: 'Mon-Fri 7am-5pm',
  },
  {
    name: 'Ponte Vedra Dental [TEST]',
    category: 'dental', category_group: 'medical_health',
    address: '111 Sawgrass Village Dr', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0107', website: 'https://pvdental.demo',
    description: 'General and cosmetic dentistry. New patients welcome. Same-day emergency slots.',
    tagline: 'Your smile starts here.',
    why_choose_us: 'In-network with most insurance. Digital X-rays. Evening appointments available.',
    booking_url: 'https://zocdoc.com/demo', booking_system: 'zocdoc',
    accepts_appointments: true,
    payment_methods: ['card', 'insurance'],
    tech_stack: [
      { id: 'dentrix', name: 'Dentrix', category: 'pos', status: 'connected', url: 'https://www.dentrix.com' },
      { id: 'zocdoc', name: 'Zocdoc', category: 'scheduling', status: 'connected', url: 'https://www.zocdoc.com' },
      { id: 'google_workspace', name: 'Google Workspace', category: 'email', status: 'connected', url: 'https://workspace.google.com' },
    ],
    hours: 'Mon-Thu 8am-5pm, Fri 8am-1pm',
  },
  {
    name: 'Coastal Fitness [TEST]',
    category: 'gym', category_group: 'fitness_recreation',
    address: '222 Solano Rd', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0108', website: 'https://coastalfitness.demo',
    description: 'Full-service gym. Personal training, group classes, sauna, and open 5am-10pm daily.',
    tagline: 'Show up. Every day.',
    why_choose_us: 'No contracts, no commitment fees. Month-to-month memberships.',
    booking_url: 'https://mindbody.io/demo', booking_system: 'mindbody',
    accepts_appointments: true, accepts_walkins: true,
    payment_methods: ['card'],
    tech_stack: [
      { id: 'mindbody', name: 'Mindbody', category: 'scheduling', status: 'connected', url: 'https://www.mindbodyonline.com' },
      { id: 'stripe', name: 'Stripe', category: 'payments', status: 'connected', url: 'https://stripe.com' },
    ],
    hours: 'Mon-Fri 5am-10pm, Sat-Sun 7am-8pm',
  },
  {
    name: 'Shore & Sand Realty [TEST]',
    category: 'real_estate', category_group: 'professional_services',
    address: '333 A1A South', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0109', website: 'https://shoreandsand.demo',
    description: 'Luxury residential real estate. Buyer and seller representation in St. Johns County.',
    tagline: 'Find your place on the water.',
    why_choose_us: '$400M+ sold. Top 1% in St. Johns County. Dedicated buyer agents.',
    accepts_appointments: true,
    payment_methods: ['wire', 'check'],
    tech_stack: [
      { id: 'dotloop', name: 'Dotloop', category: 'pos', status: 'connected', url: 'https://www.dotloop.com' },
      { id: 'google_workspace', name: 'Google Workspace', category: 'email', status: 'connected', url: 'https://workspace.google.com' },
      { id: 'calendly', name: 'Calendly', category: 'scheduling', status: 'connected', url: 'https://calendly.com' },
    ],
    hours: 'Mon-Sat 9am-6pm',
  },
  {
    name: 'Osol & Associates Law [TEST]',
    category: 'legal', category_group: 'professional_services',
    address: '444 Sawgrass Village Dr', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0110', website: 'https://osolaw.demo',
    description: 'Real estate, business formation, and estate planning. Free 30-min consultations.',
    tagline: 'Clear advice. Straight answers.',
    why_choose_us: 'Board certified real estate attorney. Flat-fee pricing for most matters.',
    booking_url: 'https://calendly.com/demo', booking_system: 'calendly',
    accepts_appointments: true,
    payment_methods: ['card', 'check', 'wire'],
    tech_stack: [
      { id: 'clio', name: 'Clio', category: 'pos', status: 'connected', url: 'https://www.clio.com' },
      { id: 'calendly', name: 'Calendly', category: 'scheduling', status: 'connected', url: 'https://calendly.com' },
      { id: 'docusign', name: 'DocuSign', category: 'other', status: 'connected', url: 'https://www.docusign.com' },
      { id: 'google_workspace', name: 'Google Workspace', category: 'email', status: 'connected', url: 'https://workspace.google.com' },
    ],
    hours: 'Mon-Fri 9am-5pm',
  },
  {
    name: 'Ponte Vedra Builders [TEST]',
    category: 'handyman', category_group: 'home_services',
    address: '555 Palm Valley Rd', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0111', website: 'https://pvbuilders.demo',
    description: 'Licensed general contractor. Kitchen and bath renovations, additions, and remodels.',
    tagline: 'Built right. Built to last.',
    why_choose_us: 'Licensed CGC. 5-star reviews. 3D design previews before any work starts.',
    accepts_rfq: true, service_radius_miles: 20,
    payment_methods: ['check', 'wire', 'card'],
    tech_stack: [
      { id: 'buildertrend', name: 'Buildertrend', category: 'pos', status: 'connected', url: 'https://buildertrend.com' },
      { id: 'quickbooks', name: 'QuickBooks', category: 'accounting', status: 'connected', url: 'https://quickbooks.intuit.com' },
      { id: 'stripe', name: 'Stripe', category: 'payments', status: 'connected', url: 'https://stripe.com' },
    ],
    hours: 'Mon-Fri 7am-5pm',
  },
  {
    name: 'The Tidal Cup [TEST]',
    category: 'cafe', category_group: 'food_drink',
    address: '666 TPC Blvd', city: 'Ponte Vedra Beach', zip: '32082',
    phone: '(904) 555-0112', website: 'https://tidalcup.demo',
    description: 'Specialty coffee, house-made pastries, and light lunch. Open 6am-4pm.',
    tagline: 'Good coffee. Good people.',
    why_choose_us: 'Single-origin espresso, house-roasted beans, vegan-friendly menu.',
    booking_url: null, accepts_walkins: true, accepts_reservations: false,
    payment_methods: ['cash', 'card'],
    tech_stack: [
      { id: 'square', name: 'Square POS', category: 'pos', status: 'connected', url: 'https://squareup.com' },
      { id: 'google_workspace', name: 'Google Workspace', category: 'email', status: 'connected', url: 'https://workspace.google.com' },
    ],
    hours: 'Mon-Sun 6am-4pm',
  },
];

async function seedTestBusinesses(db) {
  let seeded = 0, skipped = 0;

  for (const biz of TEST_BUSINESSES) {
    try {
      // Check existing
      const [existing] = await db.query(
        `SELECT business_id, dispatch_token FROM businesses WHERE name = $1 AND zip = $2 LIMIT 1`,
        [biz.name, biz.zip]
      );

      const dispatch_token = existing?.dispatch_token || crypto.randomBytes(24).toString('hex');
      const notification_email = (biz.category_group === 'food_drink' || biz.category === 'restaurant' || biz.category === 'cafe')
        ? 'erik@mcflamingo.com'   // restaurant/cafe test alerts only
        : null;                   // never pipe landscaping/trades into the McFlamingo restaurant inbox

      const fields = {
        address: biz.address,
        city: biz.city,
        phone: biz.phone,
        website: biz.website,
        category: biz.category,
        category_group: biz.category_group,
        description: biz.description,
        services_text: biz.description,
        hours: biz.hours || null,
        // W5+H
        tagline: biz.tagline || null,
        why_choose_us: biz.why_choose_us || null,
        booking_url: biz.booking_url || null,
        booking_system: biz.booking_system || null,
        accepts_walkins: biz.accepts_walkins ?? true,
        accepts_rfq: biz.accepts_rfq || false,
        accepts_appointments: biz.accepts_appointments || false,
        accepts_reservations: biz.accepts_reservations || false,
        accepts_walkin_orders: biz.accepts_walkin_orders ?? true,
        same_day_available: biz.same_day_available || false,
        service_radius_miles: biz.service_radius_miles || null,
        payment_methods: biz.payment_methods || [],
        tech_stack: JSON.stringify(biz.tech_stack || []),
        presence_score: 75, // pre-seeded demo score
      };

      if (existing) {
        await db.query(
          `UPDATE businesses SET
             address=$2, city=$3, phone=$4, website=$5, category=$6, category_group=$7,
             description=$8, services_text=$9, hours=$10,
             tagline=$11, why_choose_us=$12, booking_url=$13, booking_system=$14,
             accepts_walkins=$15, accepts_rfq=$16, accepts_appointments=$17,
             accepts_reservations=$18, accepts_walkin_orders=$19, same_day_available=$20,
             service_radius_miles=$21, payment_methods=$22, tech_stack=$23::jsonb,
             presence_score=$24, claimed_at=COALESCE(claimed_at,NOW()),
             dispatch_token=COALESCE(dispatch_token,$25),
             notification_email=COALESCE(notification_email,$26),
             notify_email=TRUE, status='active'
           WHERE business_id=$1`,
          [existing.business_id,
           fields.address, fields.city, fields.phone, fields.website,
           fields.category, fields.category_group, fields.description, fields.services_text,
           fields.hours, fields.tagline, fields.why_choose_us, fields.booking_url,
           fields.booking_system, fields.accepts_walkins, fields.accepts_rfq,
           fields.accepts_appointments, fields.accepts_reservations, fields.accepts_walkin_orders,
           fields.same_day_available, fields.service_radius_miles, fields.payment_methods,
           fields.tech_stack, fields.presence_score, dispatch_token, notification_email]
        );
        skipped++;
      } else {
        await db.query(
          `INSERT INTO businesses
             (name, zip, address, city, phone, website, category, category_group,
              description, services_text, hours,
              tagline, why_choose_us, booking_url, booking_system,
              accepts_walkins, accepts_rfq, accepts_appointments, accepts_reservations,
              accepts_walkin_orders, same_day_available, service_radius_miles,
              payment_methods, tech_stack, presence_score,
              status, claimed_at, dispatch_token, notification_email, notify_email,
              confidence_score, primary_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,
                   'active', NOW(), $26, $27, TRUE, 90, 'manual')`,
          [biz.name, biz.zip, fields.address, fields.city, fields.phone, fields.website,
           fields.category, fields.category_group, fields.description, fields.services_text,
           fields.hours, fields.tagline, fields.why_choose_us, fields.booking_url,
           fields.booking_system, fields.accepts_walkins, fields.accepts_rfq,
           fields.accepts_appointments, fields.accepts_reservations, fields.accepts_walkin_orders,
           fields.same_day_available, fields.service_radius_miles, fields.payment_methods,
           fields.tech_stack, fields.presence_score, dispatch_token, notification_email]
        );
        seeded++;
      }
    } catch (e) {
      console.warn(`[seedTestBiz] ${biz.name} warn:`, e.message.slice(0, 120));
    }
  }

  console.log(`[seedTestBiz] done — seeded=${seeded} updated=${skipped}`);
}

module.exports = { seedTestBusinesses, TEST_BUSINESSES };
