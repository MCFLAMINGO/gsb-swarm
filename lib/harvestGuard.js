// In-memory ZIP velocity tracker — no DB cost
// Blocks harvesting patterns, not legitimate cross-county agent use
const zipHits = new Map(); // ip -> { zips: Set, resetAt: number }

const FREE_LIMIT = 100; // max results for unauthenticated callers
const ZIP_VELOCITY_LIMIT = 20; // distinct ZIPs per 60s per IP
const VELOCITY_WINDOW_MS = 60_000;

function harvestGuard(req, res, next) {
  // Skip for authenticated requests (API key present)
  const hasAuth = req.headers['x-localintel-key'] || req.headers['authorization'];
  if (hasAuth) return next();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const body = req.body || {};
  const query = req.query || {};

  // Get the query params — works for MCP tools/call, REST POST bodies, and GET query strings
  const params = body.params?.arguments || body.params || (Object.keys(body).length ? body : query);
  const zip = params?.zip || params?.zipCode || params?.location?.zip;
  const limit = parseInt(params?.limit || params?.maxResults || 20);

  // GUARD 1: No location anchor = potential harvesting
  // For MCP: gated on tool name pattern. For REST: gated on path (any route that pipes through here is search-shaped).
  const toolName = body.params?.name || body.tool || '';
  const isMcpCall = !!body.method;
  const isSearchTool = isMcpCall
    ? /search|query|find|businesses|discover/i.test(toolName)
    : true;
  // A search is "anchored" if it has a location, a category filter, or a specific name query.
  // Unauthenticated *unanchored* searches (no zip, no city, no county, no lat, no cat, no name) are blocked.
  const hasName = !isMcpCall && (params?.q || params?.name);
  const hasLocation = zip || params?.city || params?.county || params?.lat || params?.q?.match?.(/\d{5}/) || params?.query?.match?.(/\d{5}/) || params?.cat || hasName;

  if (isSearchTool && !hasLocation) {
    return res.status(400).json({
      error: 'Location anchor required',
      message: 'Please provide a ZIP code, city, or county to search. Statewide queries require authentication.',
      code: 'LOCATION_REQUIRED'
    });
  }

  // GUARD 2: ZIP velocity — more than 20 distinct ZIPs in 60s = script
  if (zip) {
    const now = Date.now();
    let entry = zipHits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { zips: new Set(), resetAt: now + VELOCITY_WINDOW_MS };
      zipHits.set(ip, entry);
    }
    entry.zips.add(zip);
    if (entry.zips.size > ZIP_VELOCITY_LIMIT) {
      return res.status(429).json({
        error: 'Too many ZIP lookups',
        message: 'Rate limit exceeded. Authenticated agents may query more ZIPs.',
        code: 'ZIP_VELOCITY_LIMIT',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000)
      });
    }
  }

  // GUARD 3: Cap limit at 100 for unauthenticated callers (silent cap)
  if (params && limit > FREE_LIMIT) {
    if (body.params?.arguments) body.params.arguments.limit = FREE_LIMIT;
    else if (body.params) body.params.limit = FREE_LIMIT;
    else body.limit = FREE_LIMIT;
  }

  next();
}

// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of zipHits.entries()) {
    if (now > entry.resetAt) zipHits.delete(ip);
  }
}, 5 * 60_000);

module.exports = { harvestGuard };
