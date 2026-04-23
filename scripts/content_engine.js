/**
 * GSB Content Engine
 * Drop-in Post King competitor — 12 content API capabilities
 * All powered by Claude Haiku + free data sources
 * 
 * Job Offerings (register on Virtuals ACP):
 *   analyze_website_audience  — $1.00
 *   list_my_brands             — $0.01
 *   generate_themes            — $0.50
 *   list_my_themes             — $0.01
 *   generate_social_post       — $0.25
 *   generate_bulk_posts        — $1.50
 *   generate_blog_post         — $2.00
 *   repurpose_content          — $0.75
 *   humanize_text              — $0.25
 *   rewrite_with_voice         — $0.50
 *   detect_ai_content          — $0.10
 *   get_x_mentions             — $0.75
 */

const nvim = require('../lib/nvim');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const BRANDS_FILE = '/tmp/gsb-brands.json';
const THEMES_FILE = '/tmp/gsb-themes.json';

// ── Persistence ───────────────────────────────────────────────────────────────
function loadBrands() {
  try { return JSON.parse(fs.readFileSync(BRANDS_FILE, 'utf8')); } catch { return {}; }
}
function saveBrands(data) {
  try { fs.writeFileSync(BRANDS_FILE, JSON.stringify(data, null, 2)); } catch {}
}
function loadThemes() {
  try { return JSON.parse(fs.readFileSync(THEMES_FILE, 'utf8')); } catch { return {}; }
}
function saveThemes(data) {
  try { fs.writeFileSync(THEMES_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── Fetch page content (lightweight scrape) ───────────────────────────────────
async function fetchPageContent(url) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GSBBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 10000,
    };
    const mod = parsedUrl.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { if (body.length < 50000) body += chunk; });
      res.on('end', () => {
        // Strip HTML tags, collapse whitespace
        const text = body
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);
        resolve(text);
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

// ── Claude call helper ────────────────────────────────────────────────────────
async function claudeCall(anthropic, prompt, systemPrompt = '', maxTokens = 1500) {
  // anthropic param kept for API compatibility but ignored — uses NVIDIA NIM (free)
  return nvim.nvimChat(
    systemPrompt || 'You are the GSB Content Engine — an expert content strategist and copywriter.',
    prompt,
    maxTokens
  );
}

// ── Public voice profiles ─────────────────────────────────────────────────────
const VOICE_PROFILES = {
  'naval': { name: 'Naval Ravikant', style: 'Aphoristic, philosophical, contrarian. Short punchy sentences. Deep wisdom in few words. No fluff.' },
  'seth_godin': { name: 'Seth Godin', style: 'One-sentence paragraphs. Storytelling with a point. Philosophical about marketing. Never uses jargon.' },
  'paul_graham': { name: 'Paul Graham', style: 'Intellectual, essay-like, uses concrete examples. Challenges conventional wisdom with logic.' },
  'alex_hormozi': { name: 'Alex Hormozi', style: 'Direct, bold, business-focused. Makes you feel dumb for not doing it. Numbers and specifics.' },
  'morgan_housel': { name: 'Morgan Housel', style: 'Financial clarity through storytelling. Historical context. Humble and thoughtful.' },
  'gary_vee': { name: 'Gary Vaynerchuk', style: 'High energy, hustle-focused, CAPS for emphasis, authentic, direct to camera energy.' },
  'sahil_bloom': { name: 'Sahil Bloom', style: 'Structured threads, numbered lists, actionable takeaways, growth mindset.' },
  'dickie_bush': { name: 'Dickie Bush', style: 'Writing-focused, clean structure, practical advice, relatable struggle to success arc.' },
  'justin_welsh': { name: 'Justin Welsh', style: 'Solo business, clean formatting, one big idea per post, authenticity over perfection.' },
  'ann_handley': { name: 'Ann Handley', style: 'Marketing warmth, conversational, practical, slightly humorous, human-first.' },
  'web3_degen': { name: 'Web3 Degen', style: 'Crypto-native slang, WAGMI energy, based takes, GM vibes, bullish on everything.' },
  'gsb_default': { name: 'GSB Intelligence', style: 'Data-driven, bold claims backed by on-chain proof. Agent economy native. Short, confident, Base chain focused.' },
};

// ── Platform rules ────────────────────────────────────────────────────────────
const PLATFORM_RULES = {
  'x': 'Twitter/X post. Max 280 chars for single tweet. For threads use numbered format (1/n). No markdown. Hashtags at end max 3.',
  'linkedin': 'LinkedIn post. 150-300 words. Professional tone. Line breaks between paragraphs. Hook first line. Call to action at end.',
  'instagram': 'Instagram caption. Engaging hook, 150-200 words, heavy hashtag use (10-20 at end), emoji-friendly.',
  'facebook': 'Facebook post. Conversational, 100-200 words, 1-2 hashtags, question or CTA at end.',
  'threads': 'Threads post. Max 500 chars. Conversational, authentic, low-key, no hard sell.',
};

// ═══════════════════════════════════════════════════════════════════════════════
// JOB HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 1. analyze_website_audience
 * Scrape a URL and produce audience intelligence
 */
async function analyzeWebsiteAudience(anthropic, { url, walletAddress, forceRefresh = false }) {
  if (!url) throw new Error('url is required');
  const brands = loadBrands();
  const brandKey = `${walletAddress || 'anon'}:${url}`;

  // Cache check (24hr)
  if (!forceRefresh && brands[brandKey]) {
    const age = Date.now() - brands[brandKey].analyzedAt;
    if (age < 86400000) return { brandId: brandKey, cached: true, ...brands[brandKey] };
  }

  const pageContent = await fetchPageContent(url);
  if (!pageContent) throw new Error('Could not fetch URL content');

  const analysis = await claudeCall(anthropic, `
Analyze this website content and produce a comprehensive audience intelligence report.

Website URL: ${url}
Content: ${pageContent}

Return a JSON object with exactly this structure:
{
  "businessName": "name of the business",
  "businessType": "type of business",
  "primaryAudience": {
    "demographics": "age range, gender split, income level, education",
    "psychographics": "values, interests, lifestyle, personality traits",
    "painPoints": ["pain point 1", "pain point 2", "pain point 3"],
    "goals": ["goal 1", "goal 2", "goal 3"],
    "awarenessLevel": "unaware/problem-aware/solution-aware/product-aware/most-aware"
  },
  "contentStrategy": {
    "tone": "recommended tone of voice",
    "topics": ["topic 1", "topic 2", "topic 3", "topic 4", "topic 5"],
    "formats": ["best content formats for this audience"],
    "postingFrequency": "recommended posting frequency"
  },
  "trustSources": ["what makes this audience trust brands"],
  "objections": ["common objections to buying/engaging"],
  "competitivePosition": "brief competitive positioning statement",
  "xBio": "suggested Twitter/X bio (160 chars max)",
  "tagline": "suggested brand tagline"
}

Return ONLY valid JSON, no markdown.
`, '', 2000);

  let parsed;
  try {
    parsed = JSON.parse(analysis.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    throw new Error('Failed to parse audience analysis');
  }

  const brand = {
    brandId: brandKey,
    url,
    walletAddress: walletAddress || 'anon',
    analyzedAt: Date.now(),
    ...parsed,
  };

  brands[brandKey] = brand;
  saveBrands(brands);

  return brand;
}

/**
 * 2. list_my_brands
 */
async function listMyBrands({ walletAddress }) {
  const brands = loadBrands();
  const owned = Object.values(brands).filter(b =>
    !walletAddress || b.walletAddress === walletAddress
  );
  return { brands: owned, count: owned.length };
}

/**
 * 3. generate_themes
 */
async function generateThemes(anthropic, { brandId, count = 10 }) {
  if (!brandId) throw new Error('brandId is required');
  const brands = loadBrands();
  const brand = brands[brandId];
  if (!brand) throw new Error('Brand not found — run analyze_website_audience first');

  const themes = await claudeCall(anthropic, `
You are a content strategist. Based on this brand intelligence, generate ${count} strategic content themes.

Brand: ${brand.businessName}
Type: ${brand.businessType}
Audience pain points: ${brand.primaryAudience?.painPoints?.join(', ')}
Audience goals: ${brand.primaryAudience?.goals?.join(', ')}
Tone: ${brand.contentStrategy?.tone}
Topics: ${brand.contentStrategy?.topics?.join(', ')}

Return a JSON array of ${count} theme objects:
[
  {
    "id": "theme_1",
    "title": "Theme title",
    "angle": "The specific angle or hook",
    "why": "Why this resonates with the audience",
    "postIdeas": ["post idea 1", "post idea 2", "post idea 3"],
    "cta": "call to action for this theme",
    "platforms": ["best platforms for this theme"]
  }
]

Return ONLY valid JSON array, no markdown.
`, '', 2500);

  let parsed;
  try {
    parsed = JSON.parse(themes.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    throw new Error('Failed to parse themes');
  }

  const themesStore = loadThemes();
  if (!themesStore[brandId]) themesStore[brandId] = [];
  themesStore[brandId] = parsed;
  saveThemes(themesStore);

  return { brandId, themes: parsed, count: parsed.length };
}

/**
 * 4. list_my_themes
 */
async function listMyThemes({ brandId }) {
  if (!brandId) throw new Error('brandId is required');
  const themes = loadThemes();
  return { brandId, themes: themes[brandId] || [], count: (themes[brandId] || []).length };
}

/**
 * 5. generate_social_post
 */
async function generateSocialPost(anthropic, { brandId, platform = 'x', topic, themeId, voiceProfile = 'gsb_default', variations = 1 }) {
  if (!platform) throw new Error('platform is required');
  const platformRule = PLATFORM_RULES[platform.toLowerCase()] || PLATFORM_RULES['x'];
  const voice = VOICE_PROFILES[voiceProfile] || VOICE_PROFILES['gsb_default'];

  let brandContext = '';
  if (brandId) {
    const brands = loadBrands();
    const brand = brands[brandId];
    if (brand) {
      brandContext = `Brand: ${brand.businessName}\nAudience: ${brand.primaryAudience?.demographics}\nTone: ${brand.contentStrategy?.tone}\nTagline: ${brand.tagline}`;
    }
    if (themeId) {
      const themes = loadThemes();
      const theme = (themes[brandId] || []).find(t => t.id === themeId);
      if (theme) brandContext += `\nTheme: ${theme.title}\nAngle: ${theme.angle}\nCTA: ${theme.cta}`;
    }
  }

  const posts = await claudeCall(anthropic, `
Write ${variations} social media post${variations > 1 ? 's' : ''} for:

Platform rules: ${platformRule}
Voice style: ${voice.style} (${voice.name})
Topic: ${topic || 'general brand content'}
${brandContext}

Return a JSON array of ${variations} post object(s):
[
  {
    "content": "the post text",
    "hashtags": ["tag1", "tag2"],
    "estimatedEngagement": "low/medium/high",
    "bestPostTime": "suggested posting time"
  }
]

Return ONLY valid JSON array, no markdown.
`, '', 1500);

  let parsed;
  try {
    parsed = JSON.parse(posts.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    // Fallback: wrap raw text
    parsed = [{ content: posts.trim(), hashtags: [], estimatedEngagement: 'medium', bestPostTime: '9am-11am' }];
  }

  return { platform, posts: parsed, voiceProfile, count: parsed.length };
}

/**
 * 6. generate_bulk_posts
 */
async function generateBulkPosts(anthropic, { brandId, platform = 'x', count = 10, voiceProfile = 'gsb_default' }) {
  if (!brandId) throw new Error('brandId is required');
  const themes = loadThemes();
  const brandThemes = themes[brandId] || [];

  if (brandThemes.length === 0) throw new Error('No themes found — run generate_themes first');

  const posts = [];
  const themesToUse = brandThemes.slice(0, Math.min(count, brandThemes.length));

  for (const theme of themesToUse) {
    try {
      const result = await generateSocialPost(anthropic, {
        brandId, platform, topic: theme.angle, themeId: theme.id, voiceProfile, variations: 1,
      });
      posts.push({ theme: theme.title, ...result.posts[0] });
    } catch (e) {
      posts.push({ theme: theme.title, content: null, error: e.message });
    }
  }

  return { brandId, platform, posts, count: posts.length };
}

/**
 * 7. generate_blog_post
 */
async function generateBlogPost(anthropic, { brandId, topic, keywords = [], wordCount = 1200, businessName }) {
  if (!topic) throw new Error('topic is required');

  let brandContext = businessName ? `Business: ${businessName}` : '';
  if (brandId) {
    const brands = loadBrands();
    const brand = brands[brandId];
    if (brand) brandContext = `Business: ${brand.businessName}\nAudience: ${JSON.stringify(brand.primaryAudience)}\nTone: ${brand.contentStrategy?.tone}`;
  }

  const blog = await claudeCall(anthropic, `
Write a ${wordCount}-word SEO-optimized blog post.

Topic: ${topic}
Keywords to include: ${keywords.join(', ') || 'naturally relevant keywords'}
${brandContext}

Return a JSON object:
{
  "title": "SEO-optimized title",
  "metaDescription": "155-char meta description",
  "slug": "url-friendly-slug",
  "body": "full blog post in markdown with H2/H3 headings",
  "wordCount": approximate_word_count,
  "keywords": ["keyword1", "keyword2"],
  "readTime": "X min read"
}

Return ONLY valid JSON, no markdown wrapper.
`, '', 4000);

  let parsed;
  try {
    parsed = JSON.parse(blog.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    throw new Error('Failed to parse blog post');
  }

  return parsed;
}

/**
 * 8. repurpose_content
 */
async function repurposeContent(anthropic, { content, sourceType = 'text', platforms = ['x', 'linkedin'], brandId }) {
  if (!content) throw new Error('content is required');

  let brandContext = '';
  if (brandId) {
    const brands = loadBrands();
    const brand = brands[brandId];
    if (brand) brandContext = `Brand voice: ${brand.contentStrategy?.tone}`;
  }

  const platformList = platforms.map(p => `${p}: ${PLATFORM_RULES[p] || 'standard post'}`).join('\n');

  const result = await claudeCall(anthropic, `
Repurpose this ${sourceType} content into platform-optimized posts for each platform.

Original content:
${content.slice(0, 3000)}

${brandContext}

Target platforms:
${platformList}

Return a JSON object with a key per platform:
{
  "x": "twitter post text",
  "linkedin": "linkedin post text",
  "instagram": "instagram caption",
  "facebook": "facebook post",
  "threads": "threads post",
  "summary": "one-line summary of the content"
}

Only include the platforms requested: ${platforms.join(', ')}
Return ONLY valid JSON, no markdown.
`, '', 2000);

  let parsed;
  try {
    parsed = JSON.parse(result.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    throw new Error('Failed to parse repurposed content');
  }

  return { sourceType, platforms, repurposed: parsed };
}

/**
 * 9. humanize_text
 */
async function humanizeText(anthropic, { text, intensity = 'medium' }) {
  if (!text) throw new Error('text is required');

  const intensityGuide = {
    light: 'Minor adjustments — vary sentence length slightly, remove obvious AI patterns like "Certainly!" or "Great question!"',
    medium: 'Moderate rewrite — add natural imperfections, contractions, conversational asides, vary rhythm significantly',
    heavy: 'Full rewrite — sound like a real human typed this quickly, include natural thought flow, first-person voice, slight informality',
  };

  const humanized = await claudeCall(anthropic, `
Rewrite this text to sound authentically human. ${intensityGuide[intensity] || intensityGuide.medium}

Rules:
- No "Certainly!", "Great!", "Absolutely!", "Of course!"
- Use contractions (it's, don't, can't)
- Vary sentence length (short punchy + longer flowing)
- Occasional sentence fragments are fine
- Sound like a real person, not a robot
- Preserve the core message and facts exactly

Original text:
${text}

Return ONLY the rewritten text, nothing else.
`, '', 2000);

  return {
    original: text,
    humanized: humanized.trim(),
    intensity,
    characterDelta: humanized.length - text.length,
  };
}

/**
 * 10. rewrite_with_voice
 */
async function rewriteWithVoice(anthropic, { text, voiceProfile, customStyle }) {
  if (!text) throw new Error('text is required');

  const voice = VOICE_PROFILES[voiceProfile];
  const style = customStyle || (voice ? voice.style : 'clear and direct');
  const voiceName = voice ? voice.name : voiceProfile || 'custom';

  const rewritten = await claudeCall(anthropic, `
Rewrite this text in the style of ${voiceName}.

Style guide: ${style}

Preserve the core message but adapt the voice, structure, tone, and rhythm completely.

Original:
${text}

Return ONLY the rewritten text.
`, '', 2000);

  return {
    original: text,
    rewritten: rewritten.trim(),
    voiceProfile: voiceProfile || 'custom',
    voiceName,
  };
}

/**
 * 11. detect_ai_content
 */
async function detectAiContent(anthropic, { text }) {
  if (!text) throw new Error('text is required');

  const analysis = await claudeCall(anthropic, `
Analyze this text and determine if it was AI-generated. Look for:
- Uniform sentence length (low burstiness)
- Formulaic transitions ("Furthermore", "Moreover", "In conclusion")
- Overly balanced hedging ("on one hand... on the other hand")
- Lack of specific personal details or opinions
- Predictable paragraph structure
- Missing typos, contractions, or natural speech patterns
- Generic examples vs specific real-world references

Text to analyze:
${text.slice(0, 2000)}

Return a JSON object:
{
  "aiProbability": 0.0-1.0,
  "confidence": "low/medium/high",
  "verdict": "human/likely_human/uncertain/likely_ai/ai",
  "signals": ["signal 1", "signal 2"],
  "burstiness": 0.0-1.0,
  "perplexity": "low/medium/high",
  "recommendation": "what to do if AI probability is high"
}

Return ONLY valid JSON.
`, '', 800);

  let parsed;
  try {
    parsed = JSON.parse(analysis.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    parsed = { aiProbability: 0.5, confidence: 'low', verdict: 'uncertain', signals: [] };
  }

  return parsed;
}

/**
 * 12. get_x_mentions
 * Uses X API via Railway env vars
 */
async function getXMentions({ query, username, count = 20 }) {
  const bearerToken = process.env.X_BEARER_TOKEN || process.env.X_API_KEY;
  if (!bearerToken) throw new Error('X API credentials not configured');

  const searchQuery = username ? `@${username.replace('@', '')}` : query;
  if (!searchQuery) throw new Error('query or username is required');

  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(`${searchQuery} -is:retweet lang:en`);
    const reqPath = `/2/tweets/search/recent?query=${encoded}&max_results=${Math.min(count, 100)}&tweet.fields=created_at,author_id,public_metrics,text&expansions=author_id&user.fields=username,name,public_metrics`;

    const options = {
      hostname: 'api.twitter.com',
      path: reqPath,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bearerToken}` },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const tweets = (json.data || []).map(t => ({
            id: t.id,
            text: t.text,
            created_at: t.created_at,
            likes: t.public_metrics?.like_count || 0,
            retweets: t.public_metrics?.retweet_count || 0,
            replies: t.public_metrics?.reply_count || 0,
          }));
          resolve({ query: searchQuery, tweets, count: tweets.length });
        } catch (e) {
          reject(new Error('Failed to parse X API response'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * list_public_voices — resource endpoint
 */
function listPublicVoices() {
  return Object.entries(VOICE_PROFILES).map(([id, v]) => ({
    id, name: v.name, style: v.style,
  }));
}

/**
 * get_supported_platforms — resource endpoint
 */
function getSupportedPlatforms() {
  return Object.entries(PLATFORM_RULES).map(([id, rules]) => ({ id, rules }));
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
  analyzeWebsiteAudience,
  listMyBrands,
  generateThemes,
  listMyThemes,
  generateSocialPost,
  generateBulkPosts,
  generateBlogPost,
  repurposeContent,
  humanizeText,
  rewriteWithVoice,
  detectAiContent,
  getXMentions,
  listPublicVoices,
  getSupportedPlatforms,
  VOICE_PROFILES,
  PLATFORM_RULES,
};
