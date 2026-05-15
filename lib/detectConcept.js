'use strict';
/**
 * detectConcept.js — B62
 * Keyword-based concept router. Maps free-text business intent to one of five
 * scoring profiles handled by lib/scoringEngine.js. Pure function, zero LLM.
 */

const QSR_KEYWORDS = ['qsr','fast food','drive-thru','drive thru','burger','wendy','mcdonald','chick-fil','taco','subway','pizza','quick service','fast casual','popeyes','sonic','arby','dairy queen','dq','bojangles','checkers','rally'];
const DESTINATION_KEYWORDS = ['fine dining','destination','upscale','steakhouse','seafood','fish camp','wine bar','gastropub','farm to table','michelin','tasting menu','white tablecloth','bistro','brasserie','chef','culinary'];
const RETAIL_KEYWORDS = ['retail','strip','shopping','boutique','store','shop','outlet','mall','plaza','merchandise','apparel','fashion'];
const HEALTHCARE_KEYWORDS = ['healthcare','medical','clinic','urgent care','dental','pharmacy','doctor','physician','hospital','therapy','rehab','optometry','chiropractic','pediatric'];

function detectConcept(query) {
  if (!query) return 'GENERAL';
  const q = String(query).toLowerCase();
  if (QSR_KEYWORDS.some(k => q.includes(k))) return 'QSR_DRIVE_BY';
  if (DESTINATION_KEYWORDS.some(k => q.includes(k))) return 'DESTINATION_DINING';
  if (RETAIL_KEYWORDS.some(k => q.includes(k))) return 'RETAIL_STRIP';
  if (HEALTHCARE_KEYWORDS.some(k => q.includes(k))) return 'HEALTHCARE';
  return 'GENERAL';
}

module.exports = { detectConcept };
