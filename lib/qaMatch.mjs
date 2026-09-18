/**
 * ES-module version of qaQuestionMatchesLabel for the MV3 service worker
 * (aiService.js runs there, not as a content script). The classic-script
 * copy at lib/qaMatch.js is the same logic for content scripts
 * (directFill.js).
 *
 * If you change one, change the other — the parity test at
 * tests/unit/qaMatch-parity.test.js verifies they produce identical output.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'did', 'you',
  'your', 'have', 'has', 'will', 'would', 'in', 'on', 'at', 'to', 'for', 'of', 'or',
  'and', 'from', 'with', 'by', 'this', 'that', 'what', 'how', 'which', 'who', 'where',
  'when', 'please', 'select', 'enter', 'provide', 'currently', 'now', 'not', 'been',
  'being', 'most', 'any', 'if', 'can', 'may', 'need', 'order', 'job', 'posted',
]);

// Job-application screening questions are a narrow, well-known domain —
// this Q&A feature exists specifically for EEO/demographic and
// work-authorization questions. A single shared word from this list is a
// reliable topic match on its own, even when everything else about the two
// questions' phrasing differs — see lib/qaMatch.js for the full rationale.
const STRONG_TOPIC_WORDS = new Set([
  'sponsorship', 'visa', 'citizenship', 'authorization', 'authorized', 'clearance',
  'relocate', 'relocation', 'veteran', 'disability', 'felony', 'misdemeanor',
  'background', 'salary', 'compensation', 'gender', 'race', 'ethnicity',
  'orientation', 'pronoun', 'criminal',
]);

export function qaQuestionMatchesLabel(qaQuestion, label) {
  if (!qaQuestion || !label) return false;
  const q = qaQuestion.toLowerCase().trim();
  const l = label.toLowerCase().trim();

  if (q === l) return true;

  if (q.length < 50 && l.length < 50) {
    if (l.length >= 6 && q.includes(l)) return true;
    if (q.length >= 6 && l.includes(q)) return true;
  }

  if (l.length > 20) {
    const labelWords = l.split(/[\s,?/()]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    if (labelWords.length >= 1) {
      const qWords = q.split(/[\s,?/()]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
      const overlap = qWords.filter(qw => labelWords.some(lw =>
        lw === qw || (lw.length > 4 && qw.includes(lw)) || (qw.length > 4 && lw.includes(qw))
      ));
      if (overlap.length === 0 || qWords.length === 0) return false;
      if (overlap.length >= 2) return overlap.length >= Math.ceil(qWords.length * 0.5);
      return overlap.some(w => STRONG_TOPIC_WORDS.has(w));
    }
  }

  return false;
}
