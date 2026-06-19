// orderFormTemplates.js
// Agent-readable JSON schema forms for each business category.
// Structure: { fields: [...], notification_defaults, meta }
//
// Each field:
//   key         — machine key used in submission payload
//   label       — human-readable label shown in UI
//   type        — text | textarea | select | date | time | number | phone | email | address | boolean
//   required    — boolean
//   options     — array of strings (for select type)
//   placeholder — hint text
//   agent_hint  — what the agent should pull from client profile to fill this
//
// Businesses can extend/override fields in their own order_form.custom_fields array.
// The base template is stored in order_form.template; overrides in order_form.fields.

'use strict';

const COMMON_CONTACT = [
  { key: 'customer_name',  label: 'Your Name',         type: 'text',  required: true,  agent_hint: 'client.full_name' },
  { key: 'customer_phone', label: 'Phone Number',       type: 'phone', required: true,  agent_hint: 'client.phone' },
  { key: 'customer_email', label: 'Email Address',      type: 'email', required: false, agent_hint: 'client.email' },
];

const COMMON_NOTES = [
  { key: 'notes', label: 'Additional Notes', type: 'textarea', required: false, placeholder: 'Anything else we should know?' },
];

// ---------------------------------------------------------------------------
// CATEGORY TEMPLATES
// ---------------------------------------------------------------------------

const TEMPLATES = {

  // ── FLORIST ───────────────────────────────────────────────────────────────
  florist: {
    title: 'Flower Order',
    description: 'Place a flower order or arrangement request.',
    fields: [
      ...COMMON_CONTACT,
      { key: 'arrangement_type', label: 'Arrangement Type', type: 'select', required: true,
        options: ['Bouquet', 'Centerpiece', 'Corsage / Boutonnière', 'Wreath', 'Sympathy arrangement', 'Custom — describe below'],
        agent_hint: 'intent.query' },
      { key: 'occasion',        label: 'Occasion',          type: 'select', required: false,
        options: ['Birthday', 'Anniversary', 'Wedding', 'Sympathy', 'Get well', 'Just because', 'Other'] },
      { key: 'recipient_name',  label: 'Recipient Name',    type: 'text',   required: false, agent_hint: 'intent.recipient' },
      { key: 'delivery_address',label: 'Delivery Address',  type: 'address',required: false, agent_hint: 'client.delivery_address' },
      { key: 'delivery_date',   label: 'Delivery / Pickup Date', type: 'date', required: true },
      { key: 'budget',          label: 'Budget (USD)',       type: 'number', required: false, agent_hint: 'intent.amountCents / 100' },
      { key: 'card_message',    label: 'Card Message',       type: 'textarea', required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'New flower order from {customer_name}' },
  },

  // ── LANDSCAPER / LAWN CARE ───────────────────────────────────────────────
  landscaper: {
    title: 'Landscaping Request',
    description: 'Request landscaping, lawn care, or yard work.',
    fields: [
      ...COMMON_CONTACT,
      { key: 'service_type', label: 'Service Needed', type: 'select', required: true,
        options: ['Lawn mowing', 'Hedge trimming', 'Tree removal / trimming', 'Landscape design', 'Sod installation', 'Mulching', 'Irrigation', 'Cleanup / debris removal', 'Full yard maintenance', 'Other — describe below'],
        agent_hint: 'intent.query' },
      { key: 'property_address', label: 'Property Address', type: 'address', required: true, agent_hint: 'client.property_address || client.address' },
      { key: 'lot_size',         label: 'Approx. Lot Size', type: 'select', required: false,
        options: ['Under 1/4 acre', '1/4 – 1/2 acre', '1/2 – 1 acre', 'Over 1 acre', 'Not sure'] },
      { key: 'preferred_date',   label: 'Preferred Date',   type: 'date',   required: false },
      { key: 'frequency',        label: 'Frequency',        type: 'select', required: false,
        options: ['One-time', 'Weekly', 'Bi-weekly', 'Monthly', 'Seasonal'] },
      { key: 'budget',           label: 'Budget (USD)',      type: 'number', required: false, agent_hint: 'intent.amountCents / 100' },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'New landscaping request from {customer_name}' },
  },

  // ── PLUMBER ───────────────────────────────────────────────────────────────
  plumber: {
    title: 'Plumbing Service Request',
    description: 'Request plumbing repair or installation.',
    fields: [
      ...COMMON_CONTACT,
      { key: 'issue_type', label: 'Issue / Service', type: 'select', required: true,
        options: ['Leak repair', 'Drain clog', 'Toilet repair / replacement', 'Water heater', 'Pipe installation', 'Emergency service', 'Inspection', 'Remodel / renovation', 'Other'],
        agent_hint: 'intent.query' },
      { key: 'service_address', label: 'Service Address', type: 'address', required: true, agent_hint: 'client.address' },
      { key: 'urgency',         label: 'Urgency',         type: 'select', required: true,
        options: ['Emergency — today', 'Urgent — within 48 hrs', 'Flexible — schedule at convenience'] },
      { key: 'preferred_date',  label: 'Preferred Date',  type: 'date',   required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email', 'sms'], subject_template: 'Plumbing request from {customer_name} — {urgency}' },
  },

  // ── ELECTRICIAN ───────────────────────────────────────────────────────────
  electrician: {
    title: 'Electrical Service Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'issue_type', label: 'Issue / Service', type: 'select', required: true,
        options: ['Outlet / switch repair', 'Panel upgrade', 'New installation', 'EV charger', 'Generator hookup', 'Lighting', 'Inspection', 'Emergency', 'Other'] },
      { key: 'service_address', label: 'Service Address', type: 'address', required: true, agent_hint: 'client.address' },
      { key: 'urgency', label: 'Urgency', type: 'select', required: true,
        options: ['Emergency — today', 'Urgent — within 48 hrs', 'Flexible'] },
      { key: 'preferred_date', label: 'Preferred Date', type: 'date', required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email', 'sms'], subject_template: 'Electrical request from {customer_name}' },
  },

  // ── CLEANER / CLEANING SERVICE ────────────────────────────────────────────
  cleaning_service: {
    title: 'Cleaning Service Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'service_type', label: 'Service Type', type: 'select', required: true,
        options: ['Standard home clean', 'Deep clean', 'Move-in / move-out', 'Post-construction', 'Office / commercial', 'Window cleaning', 'Carpet cleaning', 'Other'] },
      { key: 'property_address', label: 'Property Address', type: 'address', required: true, agent_hint: 'client.address' },
      { key: 'bedrooms',         label: 'Bedrooms',         type: 'number', required: false },
      { key: 'bathrooms',        label: 'Bathrooms',        type: 'number', required: false },
      { key: 'sq_ft',            label: 'Approx. Sq Ft',    type: 'number', required: false },
      { key: 'preferred_date',   label: 'Preferred Date',   type: 'date',   required: true },
      { key: 'frequency',        label: 'Frequency',        type: 'select', required: false,
        options: ['One-time', 'Weekly', 'Bi-weekly', 'Monthly'] },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Cleaning request from {customer_name}' },
  },

  // ── LAWYER / LEGAL ────────────────────────────────────────────────────────
  legal: {
    title: 'Legal Consultation Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'matter_type', label: 'Matter Type', type: 'select', required: true,
        options: ['Real estate', 'Estate / will / trust', 'Business formation', 'Contract review', 'Family law', 'Personal injury', 'Criminal defense', 'Immigration', 'Other'] },
      { key: 'description', label: 'Brief Description', type: 'textarea', required: true,
        placeholder: 'Briefly describe your situation (confidential)' },
      { key: 'preferred_date', label: 'Preferred Consult Date', type: 'date',   required: false },
      { key: 'preferred_time', label: 'Preferred Time',         type: 'time',   required: false },
      { key: 'contact_method', label: 'Preferred Contact',      type: 'select', required: true,
        options: ['Phone call', 'Email', 'In-person', 'Video call'] },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'New legal inquiry from {customer_name} — {matter_type}' },
  },

  // ── RESTAURANT (catering / large orders) ─────────────────────────────────
  restaurant: {
    title: 'Catering / Large Order Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'order_type', label: 'Order Type', type: 'select', required: true,
        options: ['Catering event', 'Large group order', 'Meal prep / weekly', 'Corporate order', 'Delivery', 'Pickup'] },
      { key: 'guest_count',     label: 'Guest / Person Count', type: 'number', required: false },
      { key: 'event_date',      label: 'Event / Pickup Date',  type: 'date',   required: true },
      { key: 'event_time',      label: 'Time',                 type: 'time',   required: false },
      { key: 'delivery_address',label: 'Delivery Address (if applicable)', type: 'address', required: false, agent_hint: 'client.address' },
      { key: 'dietary_needs',   label: 'Dietary Requirements', type: 'select', required: false,
        options: ['None', 'Gluten free', 'Vegetarian', 'Vegan', 'Halal', 'Kosher', 'Mixed — describe below'] },
      { key: 'budget',          label: 'Budget (USD)',          type: 'number', required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Catering inquiry from {customer_name} — {guest_count} guests' },
  },

  // ── REAL ESTATE AGENT ─────────────────────────────────────────────────────
  real_estate_agent: {
    title: 'Real Estate Inquiry',
    fields: [
      ...COMMON_CONTACT,
      { key: 'inquiry_type', label: 'I am looking to', type: 'select', required: true,
        options: ['Buy a home', 'Sell my home', 'Rent / lease', 'Investment property', 'Commercial', 'General info'] },
      { key: 'zip_of_interest', label: 'ZIP / Area of Interest', type: 'text',   required: false, agent_hint: 'intent.zip' },
      { key: 'budget',          label: 'Budget / Price Range',   type: 'text',   required: false },
      { key: 'timeline',        label: 'Timeline',               type: 'select', required: false,
        options: ['ASAP', 'Within 3 months', '3–6 months', '6–12 months', 'Just exploring'] },
      { key: 'pre_approved',    label: 'Pre-approved for mortgage?', type: 'select', required: false,
        options: ['Yes', 'No', 'In progress', 'Cash buyer'] },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Real estate inquiry — {inquiry_type} from {customer_name}' },
  },

  // ── HVAC ─────────────────────────────────────────────────────────────────
  hvac: {
    title: 'HVAC Service Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'service_type', label: 'Service Needed', type: 'select', required: true,
        options: ['AC repair', 'Heating repair', 'New installation', 'Maintenance / tune-up', 'Duct cleaning', 'Air quality', 'Emergency', 'Other'] },
      { key: 'service_address', label: 'Service Address', type: 'address', required: true, agent_hint: 'client.address' },
      { key: 'unit_age',        label: 'Approx. Unit Age', type: 'select', required: false,
        options: ['Under 5 years', '5–10 years', '10–15 years', 'Over 15 years', 'Not sure'] },
      { key: 'urgency', label: 'Urgency', type: 'select', required: true,
        options: ['Emergency — today', 'Urgent — within 48 hrs', 'Flexible'] },
      { key: 'preferred_date', label: 'Preferred Date', type: 'date', required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email', 'sms'], subject_template: 'HVAC request from {customer_name} — {urgency}' },
  },

  // ── AUTO REPAIR ───────────────────────────────────────────────────────────
  auto_repair: {
    title: 'Auto Service Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'service_type', label: 'Service Needed', type: 'select', required: true,
        options: ['Oil change', 'Tire replacement', 'Brake service', 'Engine repair', 'Transmission', 'AC / heat', 'Inspection', 'Body work', 'Other'] },
      { key: 'vehicle_year',  label: 'Vehicle Year',  type: 'number', required: true },
      { key: 'vehicle_make',  label: 'Make',          type: 'text',   required: true },
      { key: 'vehicle_model', label: 'Model',         type: 'text',   required: true },
      { key: 'mileage',       label: 'Mileage',       type: 'number', required: false },
      { key: 'preferred_date',label: 'Preferred Date',type: 'date',   required: false },
      { key: 'drop_off',      label: 'Drop-off or wait?', type: 'select', required: false,
        options: ['Drop off', 'Wait', 'Either is fine'] },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Auto service request from {customer_name} — {vehicle_year} {vehicle_make} {vehicle_model}' },
  },

  // ── PET SERVICES ─────────────────────────────────────────────────────────
  pet_services: {
    title: 'Pet Service Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'service_type', label: 'Service', type: 'select', required: true,
        options: ['Grooming', 'Boarding', 'Daycare', 'Dog walking', 'Training', 'Veterinary consult', 'Other'] },
      { key: 'pet_type',   label: 'Pet Type',   type: 'select', required: true,
        options: ['Dog', 'Cat', 'Bird', 'Small animal', 'Other'] },
      { key: 'pet_breed',  label: 'Breed',      type: 'text',   required: false },
      { key: 'pet_weight', label: 'Weight (lbs)', type: 'number', required: false },
      { key: 'preferred_date', label: 'Preferred Date', type: 'date', required: true },
      { key: 'preferred_time', label: 'Preferred Time', type: 'time', required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Pet service request from {customer_name} — {service_type}' },
  },

  // ── SALON / BEAUTY ────────────────────────────────────────────────────────
  salon: {
    title: 'Salon / Beauty Appointment',
    fields: [
      ...COMMON_CONTACT,
      { key: 'service_type', label: 'Service', type: 'select', required: true,
        options: ['Haircut', 'Color / highlights', 'Blowout / styling', 'Manicure', 'Pedicure', 'Waxing', 'Facial', 'Massage', 'Full package', 'Other'] },
      { key: 'preferred_date', label: 'Preferred Date', type: 'date', required: true },
      { key: 'preferred_time', label: 'Preferred Time', type: 'time', required: false },
      { key: 'stylist_pref',   label: 'Stylist Preference', type: 'text', required: false,
        placeholder: 'Name of preferred stylist, or "no preference"' },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Appointment request from {customer_name} — {service_type}' },
  },

  // ── CONTRACTOR / HANDYMAN ────────────────────────────────────────────────
  contractor: {
    title: 'Contractor / Handyman Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'service_type', label: 'Work Needed', type: 'select', required: true,
        options: ['Painting (interior)', 'Painting (exterior)', 'Flooring', 'Drywall', 'Tile / grout', 'Deck / patio', 'Fence', 'Remodel', 'Handyman — misc', 'Other'] },
      { key: 'property_address', label: 'Property Address', type: 'address', required: true, agent_hint: 'client.address' },
      { key: 'project_scope',    label: 'Project Scope',    type: 'textarea', required: true,
        placeholder: 'Describe the work — size, materials, timeline expectations' },
      { key: 'preferred_start',  label: 'Preferred Start Date', type: 'date', required: false },
      { key: 'budget',           label: 'Budget (USD)',     type: 'number', required: false },
      { key: 'need_estimate',    label: 'Need a free estimate?', type: 'boolean', required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Contractor request from {customer_name} — {service_type}' },
  },

  // ── MOVING COMPANY ────────────────────────────────────────────────────────
  moving_company: {
    title: 'Moving Service Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'move_type', label: 'Move Type', type: 'select', required: true,
        options: ['Local move', 'Long-distance move', 'Labor only (no truck)', 'Packing service', 'Storage', 'Commercial / office move'] },
      { key: 'origin_address',      label: 'Moving From', type: 'address', required: true, agent_hint: 'client.address' },
      { key: 'destination_address', label: 'Moving To',   type: 'address', required: true },
      { key: 'move_date',           label: 'Move Date',   type: 'date',    required: true },
      { key: 'home_size',           label: 'Home Size',   type: 'select',  required: false,
        options: ['Studio / 1BR', '2BR', '3BR', '4BR+', 'Office / commercial'] },
      { key: 'need_packing',        label: 'Need packing help?', type: 'boolean', required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Moving request from {customer_name} — {move_date}' },
  },

  // ── CATERING (standalone, not restaurant) ────────────────────────────────
  catering: {
    title: 'Catering Request',
    fields: [
      ...COMMON_CONTACT,
      { key: 'event_type', label: 'Event Type', type: 'select', required: true,
        options: ['Wedding', 'Corporate event', 'Birthday / party', 'Holiday gathering', 'Funeral / memorial', 'Other'] },
      { key: 'guest_count',      label: 'Guest Count',    type: 'number',  required: true },
      { key: 'event_date',       label: 'Event Date',     type: 'date',    required: true },
      { key: 'event_address',    label: 'Event Location', type: 'address', required: true },
      { key: 'cuisine_style',    label: 'Cuisine Style',  type: 'text',    required: false,
        placeholder: 'e.g. BBQ, Italian, Mediterranean, buffet…' },
      { key: 'dietary_needs',    label: 'Dietary Needs',  type: 'textarea',required: false },
      { key: 'budget',           label: 'Budget (USD)',    type: 'number',  required: false },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'Catering request — {event_type} for {guest_count} guests on {event_date}' },
  },

  // ── GENERIC FALLBACK (any uncategorized business) ─────────────────────────
  default: {
    title: 'Service / Order Request',
    description: 'Submit a request or inquiry to this business.',
    fields: [
      ...COMMON_CONTACT,
      { key: 'request_type', label: 'Request Type', type: 'select', required: true,
        options: ['Order / purchase', 'Quote / estimate', 'Appointment', 'General inquiry', 'Other'] },
      { key: 'description', label: 'Describe your request', type: 'textarea', required: true,
        placeholder: 'What do you need? Include any relevant details — quantity, date, location, budget…',
        agent_hint: 'intent.query' },
      { key: 'preferred_date', label: 'Preferred Date / Deadline', type: 'date',   required: false },
      { key: 'budget',         label: 'Budget (USD)',               type: 'number', required: false, agent_hint: 'intent.amountCents / 100' },
      ...COMMON_NOTES,
    ],
    notification_defaults: { channels: ['email'], subject_template: 'New request from {customer_name}' },
  },
};

// Category aliases — map common category strings to template keys
const CATEGORY_MAP = {
  // florist
  'florist': 'florist', 'florists': 'florist', 'flowers': 'florist', 'flower shop': 'florist',
  // landscaper
  'landscaper': 'landscaper', 'landscapers': 'landscaper', 'landscaping': 'landscaper',
  'lawn care': 'landscaper', 'lawn service': 'landscaper', 'yard work': 'landscaper',
  // plumber
  'plumber': 'plumber', 'plumbers': 'plumber', 'plumbing': 'plumber',
  // electrician
  'electrician': 'electrician', 'electricians': 'electrician', 'electrical': 'electrician',
  // cleaning
  'cleaning_service': 'cleaning_service', 'cleaning service': 'cleaning_service',
  'cleaner': 'cleaning_service', 'maid service': 'cleaning_service', 'janitorial': 'cleaning_service',
  // legal
  'legal': 'legal', 'lawyer': 'legal', 'attorney': 'legal', 'law firm': 'legal',
  // restaurant
  'restaurant': 'restaurant', 'food': 'restaurant', 'dining': 'restaurant',
  // real estate
  'real_estate_agent': 'real_estate_agent', 'real estate agent': 'real_estate_agent',
  'realtor': 'real_estate_agent', 'real estate': 'real_estate_agent',
  // hvac
  'hvac': 'hvac', 'air conditioning': 'hvac', 'heating': 'hvac', 'ac repair': 'hvac',
  // auto
  'auto_repair': 'auto_repair', 'auto repair': 'auto_repair', 'mechanic': 'auto_repair',
  'auto shop': 'auto_repair', 'car repair': 'auto_repair',
  // pets
  'pet_services': 'pet_services', 'pet services': 'pet_services', 'grooming': 'pet_services',
  'dog grooming': 'pet_services', 'pet groomer': 'pet_services', 'boarding': 'pet_services',
  // salon
  'salon': 'salon', 'beauty salon': 'salon', 'hair salon': 'salon', 'barbershop': 'salon',
  'nail salon': 'salon', 'spa': 'salon',
  // contractor
  'contractor': 'contractor', 'handyman': 'contractor', 'general contractor': 'contractor',
  'painter': 'contractor', 'painting': 'contractor', 'remodeling': 'contractor',
  // moving
  'moving_company': 'moving_company', 'moving company': 'moving_company', 'movers': 'moving_company',
  // catering
  'catering': 'catering', 'caterer': 'catering', 'event catering': 'catering',
};

/**
 * Get the order_form template for a category string.
 * Returns a complete order_form object ready to be stored in businesses.order_form.
 */
function getTemplateForCategory(category) {
  const key = category ? CATEGORY_MAP[category.toLowerCase().trim()] : null;
  const template = TEMPLATES[key] || TEMPLATES['default'];
  return {
    template_key: key || 'default',
    version: 1,
    title: template.title,
    description: template.description || null,
    fields: template.fields,
    notification_defaults: template.notification_defaults,
    custom_fields: [],       // business can append fields here
    disabled_field_keys: [], // business can hide default fields
    updated_at: null,        // set when business customizes
    seeded_at: new Date().toISOString(),
  };
}

/**
 * Merge base template with business customizations.
 * custom_fields are appended; disabled_field_keys are removed.
 */
function resolveOrderForm(orderForm) {
  if (!orderForm) return null;
  const disabled = new Set(orderForm.disabled_field_keys || []);
  const base = (orderForm.fields || []).filter(f => !disabled.has(f.key));
  const custom = orderForm.custom_fields || [];
  return {
    ...orderForm,
    resolved_fields: [...base, ...custom],
  };
}

module.exports = { TEMPLATES, CATEGORY_MAP, getTemplateForCategory, resolveOrderForm };
