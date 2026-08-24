/**
 * ES-module mirror of lib/resumeRanker.js. The classic-script copy is for
 * content scripts; this copy is for tests. A parity test asserts both
 * produce the same output for the same inputs — change one, change both.
 */
import { extractAtsKeywords } from './resumeKeywords.mjs';

function normalize(text) {
  return String(text || '').toLowerCase();
}

/**
 * Union of every resume's own ATS keywords, lowercased and deduplicated —
 * the candidate pool JD keyword extraction scans against.
 * @param {Array<{profile?: object}>} resumes
 * @returns {Map<string, string>} lowercase term -> canonical (first-seen) term
 */
export function buildKeywordVocabulary(resumes) {
  const vocab = new Map();
  (resumes || []).forEach(r => {
    extractAtsKeywords(r && r.profile).forEach(k => {
      const lower = normalize(k.term).trim();
      if (lower.length > 1 && !vocab.has(lower)) vocab.set(lower, k.term);
    });
  });
  return vocab;
}

/**
 * The JD's own ATS keywords: every term from the resume keyword vocabulary
 * that appears as a substring of the JD text.
 * @param {string} jdText raw job description text
 * @param {Array<object>} resumes resumes to draw the keyword vocabulary from
 * @returns {string[]} matched terms, lowercased
 */
export function extractJDKeywords(jdText, resumes) {
  const jdTextLower = normalize(jdText);
  if (!jdTextLower) return [];
  const vocab = buildKeywordVocabulary(resumes);
  const matched = [];
  vocab.forEach((canonical, lower) => {
    if (jdTextLower.includes(lower)) matched.push(lower);
  });
  return matched;
}

// A JD keyword's weight is how many times it's mentioned in the JD text,
// capped so one very-repeated word (often just a common word that happens
// to also be a skill name) can't swamp every other keyword's contribution.
const JD_TERM_WEIGHT_CAP = 5;

/** Counts (non-overlapping) occurrences of needleLower in haystackLower. */
function countOccurrences(haystackLower, needleLower) {
  if (!needleLower) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystackLower.indexOf(needleLower, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needleLower.length;
  }
  return count;
}

/**
 * How much this JD keyword should count toward the score, based on how
 * many times the JD text repeats it. Every kw passed in here was matched
 * via a substring check against this same jdTextLower, so it occurs at
 * least once; the `|| 1` floor is just defense against that invariant
 * ever being violated by a future caller.
 * @param {string} jdTextLower
 * @param {string} termLower
 * @returns {number} weight >= 1
 */
export function jdKeywordWeight(jdTextLower, termLower) {
  return Math.min(countOccurrences(jdTextLower, termLower), JD_TERM_WEIGHT_CAP) || 1;
}

// A resume keyword backed up in more than one place (e.g. the skills
// list AND a project's technologies) earns more credit than the base
// 1.0x for simply having it once — each additional occurrence beyond the
// first adds RESUME_DEPTH_BONUS_PER_EXTRA, up to RESUME_DEPTH_BONUS_CAP
// extra occurrences, for a maximum of MAX_RESUME_DEPTH_MULTIPLIER. That
// maximum is what each keyword's credit is measured AGAINST (see
// scoreResumeAgainstJD) — not just 1.0x — so merely having a keyword
// caps out below 100% on its own; reaching the max requires real depth.
const RESUME_DEPTH_BONUS_PER_EXTRA = 0.05;
const RESUME_DEPTH_BONUS_CAP = 3;
export const MAX_RESUME_DEPTH_MULTIPLIER = 1 + RESUME_DEPTH_BONUS_PER_EXTRA * RESUME_DEPTH_BONUS_CAP; // 1.15

/**
 * @param {number} occurrenceCount how many places in the resume mention
 *   this term (lib/resumeKeywords.js's `count`) — 0 if absent.
 * @returns {number} multiplier: 0 if absent, else 1.0 .. MAX_RESUME_DEPTH_MULTIPLIER
 */
export function resumeDepthMultiplier(occurrenceCount) {
  if (!occurrenceCount || occurrenceCount <= 0) return 0;
  const extra = Math.min(occurrenceCount - 1, RESUME_DEPTH_BONUS_CAP);
  return 1 + extra * RESUME_DEPTH_BONUS_PER_EXTRA;
}

/**
 * Scores a single resume against a JD's own ATS keywords (as produced by
 * extractJDKeywords), weighted by JD emphasis and resume depth — see the
 * file doc comment. Each JD keyword's actual credit (0 if missing, up to
 * MAX_RESUME_DEPTH_MULTIPLIER if deeply represented) is measured against
 * its own MAXIMUM possible credit, not just against "present or not" —
 * so both an entirely-missing keyword and a merely-once-mentioned one
 * pull the score below 100%, by different amounts, instead of the depth
 * signal disappearing the moment coverage is complete.
 * @param {{profile?: object}} resume
 * @param {string[]} jdKeywordsLower lowercased JD keywords, e.g. from extractJDKeywords()
 * @param {string} [jdText] raw JD text, used to weight each keyword by how
 *   often the JD repeats it. Falling back to a flat weight of 1 per
 *   keyword when omitted keeps this backward-compatible with any caller
 *   that doesn't have the raw text handy.
 * @returns {number} 0..1 — 1 only when every JD keyword is present AND
 *   at maximum resume depth.
 */
export function scoreResumeAgainstJD(resume, jdKeywordsLower, jdText) {
  if (!jdKeywordsLower || !jdKeywordsLower.length) return 0;
  const jdTextLower = normalize(jdText);

  const resumeCounts = new Map();
  extractAtsKeywords(resume && resume.profile).forEach(k => {
    resumeCounts.set(normalize(k.term).trim(), k.count);
  });

  let numerator = 0;
  let denominator = 0;
  for (const kw of jdKeywordsLower) {
    const weight = jdTextLower ? jdKeywordWeight(jdTextLower, kw) : 1;
    denominator += weight * MAX_RESUME_DEPTH_MULTIPLIER;
    numerator += weight * resumeDepthMultiplier(resumeCounts.get(kw));
  }
  return denominator > 0 ? Math.min(1, numerator / denominator) : 0;
}

/**
 * Ranks all resumes against a job description, best match first — extracts
 * the JD's own ATS keywords first, then scores every resume by its
 * weighted coverage of that keyword set. See lib/resumeRanker.js's file
 * doc comment for the full algorithm description.
 * @param {string} jdText
 * @param {Array<{id: string, name: string, profile?: object}>} resumes
 * @returns {Array<{id: string, name: string, score: number}>}
 */
export function rankResumes(jdText, resumes) {
  const jdKeywords = extractJDKeywords(jdText, resumes);
  return (resumes || [])
    .map(r => ({ id: r.id, name: r.name, score: scoreResumeAgainstJD(r, jdKeywords, jdText) }))
    .sort((a, b) => b.score - a.score);
}
