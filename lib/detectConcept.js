'use strict';
/**
 * detectConcept.js — B62 / B70
 * Keyword-based concept router. Maps free-text business intent to one of five
 * scoring profiles handled by lib/scoringEngine.js. Pure function, zero LLM.
 *
 * B70: layered atmosphere keywords + negation handling.
 *   - Atmosphere words ("quiet", "romantic", "lively", etc.) boost toward the
 *     concept whose ambience they imply, even when no explicit concept keyword
 *     is present.
 *   - Negation handling: tokens preceded by "no ", "not ", "nothing ", or
 *     "without " are stripped before matching so "nothing too loud" does not
 *     count "loud" as a positive lively signal.
 *
 * Behavior is additive: the original first-match-wins keyword scan still runs
 * first. Atmosphere is a tie-breaker / fallback for conversational phrases.
 */

const QSR_KEYWORDS = ['qsr','fast food','drive-thru','drive thru','burger','wendy','mcdonald','chick-fil','taco','subway','pizza','quick service','fast casual','popeyes','sonic','arby','dairy queen','dq','bojangles','checkers','rally'];
const DESTINATION_KEYWORDS = ['fine dining','destination','upscale','steakhouse','seafood','fish camp','wine bar','gastropub','farm to table','michelin','tasting menu','white tablecloth','bistro','brasserie','chef','culinary'];
const RETAIL_KEYWORDS = ['retail','strip','shopping','boutique','store','shop','outlet','mall','plaza','merchandise','apparel','fashion'];
const HEALTHCARE_KEYWORDS = ['healthcare','medical','clinic','urgent care','dental','pharmacy','doctor','physician','hospital','therapy','rehab','optometry','chiropractic','pediatric'];

// B70 — atmosphere → concept boosts. Each phrase adds a point to its concept.
// Pure conversational signals; complement (not replace) explicit keywords.
const ATMOSPHERE = {
  DESTINATION_DINING: [
    'quiet','romantic','date night','nice','upscale','elegant',
    'fine dining','special occasion','intimate','cozy','candlelit',
  ],
  QSR_DRIVE_BY: [
    'quick','fast','cheap','grab','on the go','to go','in a hurry',
    'drive thru','drive-thru','quick bite',
  ],
  // No dedicated nightlife profile yet — boost toward DESTINATION_DINING as
  // the closest "go out for the evening" profile until BAR_NIGHTLIFE exists.
  BAR_NIGHTLIFE: [
    'lively','bar','drinks','happy hour','loud','fun','nightlife',
    'cocktails','pub','tavern','sports bar',
  ],
  RETAIL_STRIP: [
    'shop','browse','store','mall','shopping center','strip mall',
    'big box','outlet','plaza',
  ],
};

// Map atmosphere bucket → profile name actually defined in conceptProfiles.js.
// BAR_NIGHTLIFE doesn't have its own profile yet, so it falls back to the
// closest "destination evening out" experience.
const ATMOSPHERE_PROFILE = {
  DESTINATION_DINING: 'DESTINATION_DINING',
  QSR_DRIVE_BY:       'QSR_DRIVE_BY',
  BAR_NIGHTLIFE:      'DESTINATION_DINING',
  RETAIL_STRIP:       'RETAIL_STRIP',
};

// Strip tokens that follow a negation marker. Removes the whole phrase
// up to the next punctuation or end-of-string so "no fast food" does not
// match "fast food" downstream.
function stripNegations(text) {
  return text.replace(/\b(?:no|not|nothing|without)\s+([^.,;!?]*)/gi, ' ');
}

function scoreAtmosphere(text) {
  const scores = { DESTINATION_DINING: 0, QSR_DRIVE_BY: 0, BAR_NIGHTLIFE: 0, RETAIL_STRIP: 0 };
  for (const [bucket, phrases] of Object.entries(ATMOSPHERE)) {
    for (const p of phrases) {
      if (text.includes(p)) scores[bucket] += 1;
    }
  }
  return scores;
}

function detectConcept(query) {
  if (!query) return 'GENERAL';
  const original = String(query).toLowerCase();
  // B70 — strip negated phrases before keyword/atmosphere scans.
  const q = stripNegations(original);

  // First-match-wins keyword scan (unchanged behavior).
  if (QSR_KEYWORDS.some(k => q.includes(k))) return 'QSR_DRIVE_BY';
  if (DESTINATION_KEYWORDS.some(k => q.includes(k))) return 'DESTINATION_DINING';
  if (RETAIL_KEYWORDS.some(k => q.includes(k))) return 'RETAIL_STRIP';
  if (HEALTHCARE_KEYWORDS.some(k => q.includes(k))) return 'HEALTHCARE';

  // B70 — atmosphere fallback. Pick the highest-scoring bucket if any phrase hit.
  const scores = scoreAtmosphere(q);
  let bestBucket = null;
  let bestScore  = 0;
  for (const [bucket, n] of Object.entries(scores)) {
    if (n > bestScore) { bestScore = n; bestBucket = bucket; }
  }
  if (bestBucket && bestScore > 0) {
    return ATMOSPHERE_PROFILE[bestBucket] || 'GENERAL';
  }
  return 'GENERAL';
}

module.exports = { detectConcept };
