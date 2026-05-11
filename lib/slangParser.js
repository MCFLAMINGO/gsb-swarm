'use strict';

/**
 * Parse a slang submission from user input.
 * Accepts:
 *   "Dunkins = Dunkin Donuts"
 *   "dunkins equals dunkin donuts"
 *   "fish camp = palm valley fish camp"
 * Returns { slangTerm, businessQuery } or null if not a slang submission.
 */
function parseSlangSubmission(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();

  const m = t.match(/^(.+?)\s*(?:=|\bequals\b)\s*(.+)$/i);
  if (!m) return null;

  const slangTerm = m[1].trim();
  const businessQuery = m[2].trim();

  if (slangTerm.length < 2 || slangTerm.length > 60) return null;
  if (businessQuery.length < 2 || businessQuery.length > 100) return null;

  const SENTENCE_RE = /\b(want|need|get|find|looking|help|can|should|would|please|where|what|how|why|is|are|have|has|do|did|will|make|give)\b/i;
  if (SENTENCE_RE.test(slangTerm)) return null;

  return { slangTerm, businessQuery };
}

module.exports = { parseSlangSubmission };
