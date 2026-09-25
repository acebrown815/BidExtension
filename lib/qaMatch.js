/**
 * Shared "does this saved Q&A question mean the same thing as this form
 * label?" matcher, used by both autofill passes:
 *   - Pass 1, directFill.js: instant, no-AI direct fill — must be strict,
 *     since a match here writes the saved answer straight into the form
 *     with no further review.
 *   - Pass 2, aiService.js's buildAutofillPrompt(): attaches a matched
 *     answer as a `qa_hint` the AI is told to treat as authoritative
 *     ("find the option closest in meaning to the hint").
 *
 * These two passes used to have SEPARATE matching logic — directFill.js's
 * was already appropriately strict (exact match, then high-similarity
 * containment, then a keyword-overlap check requiring at least 2 shared
 * non-stopword keywords), but aiService.js's independent matcher only
 * required ONE shared keyword longer than 3 characters, with no stopword
 * filtering. That's loose enough to false-positive-match unrelated
 * questions that happen to share one word — e.g. "Do you need
 * sponsorship?" would match "Do you have sponsorship program management
 * experience?" on the word "sponsorship" alone, attaching a misleading
 * hint the AI is told to treat as authoritative for a question it was
 * never actually about.
 *
 * Extracting one shared, appropriately-strict matcher (this file) means
 * both passes now agree on what counts as "the same question", instead of
 * Pass 2 being meaningfully looser than the Pass 1 it's supposed to be a
 * fallback for.
 *
 * Loaded as a content script before directFill.js — hangs the API on
 * globalThis so other content scripts in the same isolated world can use
 * it, and tests can `import './lib/qaMatch.js'` and read globalThis.
 *
 * Mirrored at lib/qaMatch.mjs for the service worker (aiService.js runs
 * there, not as a content script); a parity test keeps the two copies in
 * sync — if you change one, change the other.
 */
(function () {
  'use strict';

  // Common words stripped out before comparing keyword overlap — without
  // this, two questions that share only filler words ("do", "you", "any")
  // would look related when they aren't.
  //
  // 'profile', 'url', and 'link' are included for the same reason but
  // confirmed live as a distinct, real bug: "GitHub/GitLab Profile URL" and
  // "LinkedIn Profile URL" share nothing but these three words after
  // filtering — the label's own "/" got split into "github" + "gitlab" by
  // the tokenizer below, and "profile"/"url" alone hit the >=2-word overlap
  // threshold, wrongly matching two entirely different questions. This
  // isn't GitHub-specific: ANY pair of "<platform> Profile URL"-style
  // questions (LinkedIn/GitHub/Portfolio/Twitter/etc.) would false-match
  // the same way, since "profile"/"url"/"link" carry no platform-specific
  // meaning on their own — the platform name is the only word that
  // actually distinguishes these questions from one another.
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'do', 'does', 'did', 'you',
    'your', 'have', 'has', 'will', 'would', 'in', 'on', 'at', 'to', 'for', 'of', 'or',
    'and', 'from', 'with', 'by', 'this', 'that', 'what', 'how', 'which', 'who', 'where',
    'when', 'please', 'select', 'enter', 'provide', 'currently', 'now', 'not', 'been',
    'being', 'most', 'any', 'if', 'can', 'may', 'need', 'order', 'job', 'posted',
    'profile', 'url', 'link',
  ]);

  // Job-application screening questions are a narrow, well-known domain —
  // this Q&A feature exists specifically for EEO/demographic and
  // work-authorization questions (see aiService.js's dropdown-matcher
  // prompt, which lists exactly this topic set). A single shared word from
  // this list is a reliable topic match on its own, even when everything
  // else about the two questions' phrasing differs — e.g. "Will you need
  // sponsorship?" vs. "Will you now or in the future require sponsorship
  // to continue or extend your current work authorization status?" share
  // only "sponsorship" after stopword filtering (both "will" and "need"
  // are themselves stopwords), but that one word IS the entire topic of
  // both questions, not an incidental mention.
  const STRONG_TOPIC_WORDS = new Set([
    'sponsorship', 'visa', 'citizenship', 'authorization', 'authorized', 'clearance',
    'relocate', 'relocation', 'veteran', 'disability', 'felony', 'misdemeanor',
    'background', 'salary', 'compensation', 'gender', 'race', 'ethnicity',
    'orientation', 'pronoun', 'criminal',
  ]);

  /**
   * @param {string} qaQuestion - A saved Q&A entry's question text.
   * @param {string} label      - The form field's label/question text.
   * @returns {boolean} Whether they're close enough to treat as the same question.
   */
  function qaQuestionMatchesLabel(qaQuestion, label) {
    if (!qaQuestion || !label) return false;
    const q = qaQuestion.toLowerCase().trim();
    const l = label.toLowerCase().trim();

    // 1. Exact match.
    if (q === l) return true;

    // 2. High similarity: both short (<50 chars), and one fully contains
    // the other (with a minimum length so a tiny label like "role" doesn't
    // trivially match any longer question containing that word).
    if (q.length < 50 && l.length < 50) {
      if (l.length >= 6 && q.includes(l)) return true;
      if (q.length >= 6 && l.includes(q)) return true;
    }

    // 3. For longer questions: require at least 2 overlapping, substantial,
    // non-stopword keywords — not just one, UNLESS that one shared word is
    // a STRONG_TOPIC_WORD (see above), since a single hit there is already
    // a reliable topic match. Without that carve-out, a generic 2-keyword
    // requirement blocks exactly the short, common EEO/visa questions this
    // feature is built for, since ATS platforms often phrase them so
    // tersely ("Will you need sponsorship?") that only one non-stopword
    // survives filtering on that side.
    if (l.length > 20) {
      const labelWords = l.split(/[\s,?/()]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
      if (labelWords.length >= 1) {
        const qWords = q.split(/[\s,?/()]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
        const overlap = qWords.filter(qw => labelWords.some(lw =>
          lw === qw || (lw.length > 4 && qw.includes(lw)) || (qw.length > 4 && lw.includes(qw))
        ));
        if (overlap.length === 0 || qWords.length === 0) return false;
        if (overlap.length >= 2) return overlap.length >= Math.ceil(qWords.length * 0.5);
        // overlap.length === 1: only acceptable if that one shared word is
        // a strong, unambiguous topic anchor.
        return overlap.some(w => STRONG_TOPIC_WORDS.has(w));
      }
    }

    return false;
  }

  const api = { qaQuestionMatchesLabel };

  // CommonJS / vitest
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Content script / browser
  if (typeof globalThis !== 'undefined') {
    globalThis.JMQaMatch = api;
  }
})();
