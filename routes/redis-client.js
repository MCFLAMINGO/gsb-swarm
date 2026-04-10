// routes/redis-client.js
// Upstash Redis client — used for X OAuth tokens, raid sessions, DCA configs
// Uses REST API so no native Redis driver needed (works in any Node env)

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Fallback: parse from redis:// URL if REST vars not set
function getRestUrl() {
  if (REDIS_URL) return REDIS_URL;
  const raw = process.env.UPSTASH_REDIS_URL || '';
  const match = raw.match(/redis:\/\/[^:]+:[^@]+@([^:]+):(\d+)/);
  if (match) return `https://${match[1]}`;
  return null;
}

function getToken() {
  if (REDIS_TOKEN) return REDIS_TOKEN;
  const raw = process.env.UPSTASH_REDIS_URL || '';
  const match = raw.match(/redis:\/\/[^:]+:([^@]+)@/);
  return match ? match[1] : null;
}

async function redisCmd(...args) {
  const url   = getRestUrl();
  const token = getToken();
  if (!url || !token) throw new Error('Upstash Redis not configured');

  const res = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

const redis = {
  set:    (key, value, ex) => ex
    ? redisCmd('set', key, typeof value === 'object' ? JSON.stringify(value) : value, 'ex', ex)
    : redisCmd('set', key, typeof value === 'object' ? JSON.stringify(value) : value),
  get:    async (key) => {
    const r = await redisCmd('get', key);
    if (!r) return null;
    try { return JSON.parse(r); } catch { return r; }
  },
  del:    (key)         => redisCmd('del', key),
  lpush:  (key, val)    => redisCmd('lpush', key, typeof val === 'object' ? JSON.stringify(val) : val),
  lrange: async (key, start, stop) => {
    const r = await redisCmd('lrange', key, start, stop);
    return (r || []).map(v => { try { return JSON.parse(v); } catch { return v; } });
  },
  ltrim:  (key, start, stop) => redisCmd('ltrim', key, start, stop),
  expire: (key, seconds)     => redisCmd('expire', key, seconds),
  exists: (key)              => redisCmd('exists', key),
};

module.exports = redis;
