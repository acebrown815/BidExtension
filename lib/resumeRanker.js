/**
 * Local, no-AI resume-vs-job-description ranker.
 *
 * Algorithm (JD-keywords-first, weighted):
 *   1. Build a keyword vocabulary from every saved resume's own ATS
 *      keywords (skills + certifications + project technologies — see
 *      lib/resumeKeywords.js, the same extraction the Profile tab's "ATS
 *      Keywords" list is built from).
 *   2. Extract the JD's *own* ATS keywords: every vocabulary term that
 *      actually appears in the job description text. This is "what does
 *      this posting ask for", grounded in real skill/cert/tech terms
 *      instead of guessing at free-form NLP over the JD.
 *   3. Score each resume as its *weighted* coverage of those JD keywords,
 *      not a flat count. Two weights apply, and both are needed to reach
 *      100% -- coverage alone is not enough:
 *        - JD emphasis: a keyword the JD repeats several times (e.g.
 *          mentioned in the title, the summary, AND the requirements)
 *          counts for more than one mentioned only once in passing --
 *          capped so one very-repeated word can't dominate the score.
 *        - Resume depth: a keyword the resume backs up in more than one
 *          place (e.g. listed as a skill AND demonstrated in a project)
 *          earns more credit than one that's just a bare skill-list
 *          entry. Every JD keyword's MAXIMUM possible credit (full depth)
 *          is what the score is measured against, not just "present or
 *          not" -- so a resume that merely lists every matched keyword
 *          once, with no deeper evidence anywhere, lands around 87%, not
 *          100%. Reaching 100% requires covering every JD keyword *and*
 *          backing each one with real depth (skills + certs + projects).
 *      This keeps the two signals from being conflated into a single
 *      number that quietly discards one of them: a keyword you don't
 *      have at all, and a keyword you have but only shallowly, both pull
 *      the score down -- just by different amounts -- instead of a
 *      shallow-but-complete resume being indistinguishable from a
 *      deep-and-complete one.
 *
 * Zero AI calls and zero network latency, even with dozens of saved
 * resumes. This is a lightweight heuristic to help the user pick which
 * resume to run the real AI analysis with; it is not a substitute for the
 * AI-generated 0-100 match score.
 *
 * Loaded as a content script before content.js, and after
 * lib/resumeKeywords.js (its dependency) — hangs the API on globalThis.
 * Mirrored at lib/resumeRanker.mjs for tests; a parity test keeps the two
 * copies in sync.
 */
(function () {
  'use strict';

  function normalize(text) {
    return String(text || '').toLowerCase();
  }

  // Defensive fallback (mirrors content.js's own pattern for JMResumeRanker)
  // so a load-order mistake degrades to "everyone scores 0" instead of a
  // hard throw.
  const extractAtsKeywords = (globalThis.JMResumeKeywords && globalThis.JMResumeKeywords.extractAtsKeywords)
    || (() => []);

  /**
   * Union of every resume's own ATS keywords, lowercased and deduplicated.
   * This is the candidate pool "extract JD keywords" scans the JD text
   * against — it keeps keyword extraction grounded in real terms already
   * known from the user's resumes rather than free-form NLP.
   * @param {Array<{profile?: object}>} resumes
   * @returns {Map<string, string>} lowercase term -> canonical (first-seen) term
   */
  function buildKeywordVocabulary(resumes) {
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
   * Extracts the JD's own ATS keywords: every term from the resume
   * keyword vocabulary that appears as a substring of the JD text.
   * @param {string} jdText raw job description text
   * @param {Array<object>} resumes resumes to draw the keyword vocabulary from
   * @returns {string[]} matched terms, lowercased
   */
  function extractJDKeywords(jdText, resumes) {
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
  function jdKeywordWeight(jdTextLower, termLower) {
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
  const MAX_RESUME_DEPTH_MULTIPLIER = 1 + RESUME_DEPTH_BONUS_PER_EXTRA * RESUME_DEPTH_BONUS_CAP; // 1.15

  /**
   * @param {number} occurrenceCount how many places in the resume mention
   *   this term (lib/resumeKeywords.js's `count`) — 0 if absent.
   * @returns {number} multiplier: 0 if absent, else 1.0 .. MAX_RESUME_DEPTH_MULTIPLIER
   */
  function resumeDepthMultiplier(occurrenceCount) {
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
   * @param {{profile?: {skills?: string[], certifications?: string[], projects?: Array<{technologies?: string[]}>}}} resume
   * @param {string[]} jdKeywordsLower lowercased JD keywords, e.g. from extractJDKeywords()
   * @param {string} [jdText] raw JD text, used to weight each keyword by how
   *   often the JD repeats it. Falling back to a flat weight of 1 per
   *   keyword when omitted keeps this backward-compatible with any caller
   *   that doesn't have the raw text handy.
   * @returns {number} 0..1 — 1 only when every JD keyword is present AND
   *   at maximum resume depth.
   */
  function scoreResumeAgainstJD(resume, jdKeywordsLower, jdText) {
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
      // Denominator uses each keyword's MAXIMUM possible credit, not just
      // its base weight — this is what makes 100% require depth, not just
      // coverage. Mathematically numerator can never exceed denominator
      // (resumeDepthMultiplier is bounded by the same MAX), so the
      // Math.min below is a defensive floor, not something that should
      // ever actually trigger.
      denominator += weight * MAX_RESUME_DEPTH_MULTIPLIER;
      numerator += weight * resumeDepthMultiplier(resumeCounts.get(kw));
    }
    return denominator > 0 ? Math.min(1, numerator / denominator) : 0;
  }

  /**
   * Ranks all resumes against a job description, best match first. See the
   * file doc comment for the algorithm: JD keywords are extracted first
   * (from the union of all resumes' ATS keywords that appear in the JD),
   * then every resume is scored by its weighted coverage of that keyword
   * set.
   * @param {string} jdText
   * @param {Array<{id: string, name: string, profile?: {skills?: string[], certifications?: string[], projects?: Array<{technologies?: string[]}>}}>} resumes
   * @returns {Array<{id: string, name: string, score: number}>}
   */
  function rankResumes(jdText, resumes) {
    const jdKeywords = extractJDKeywords(jdText, resumes);
    return (resumes || [])
      .map(r => ({ id: r.id, name: r.name, score: scoreResumeAgainstJD(r, jdKeywords, jdText) }))
      .sort((a, b) => b.score - a.score);
  }

  const api = {
    rankResumes, scoreResumeAgainstJD, extractJDKeywords, buildKeywordVocabulary,
    jdKeywordWeight, resumeDepthMultiplier, MAX_RESUME_DEPTH_MULTIPLIER,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMResumeRanker = api;
  }
})();
