/**
 * Regression test for the word-boundary matching bug in the local (no-AI)
 * resume-vs-JD ranker's core keyword extraction/weighting.
 *
 * Root cause: extractJDKeywords() used `jdTextLower.includes(lower)` and
 * countOccurrences() used a manual indexOf loop — both are plain substring
 * checks with no concept of word boundaries. Any vocabulary term (anything
 * with length > 1, per buildKeywordVocabulary) could falsely match inside
 * an unrelated word that merely happens to contain it as a substring: a
 * resume listing the skill "Go" would have that JD keyword "match" against
 * ordinary English words like "going", "good", or "organize", even when the
 * JD text never mentions the Go programming language at all. This produced
 * the reported bimodal 100%/0% scoring: a resume with a short/generic skill
 * name could score unreasonably high off pure noise, while a resume with
 * genuinely relevant but textually-distinct skills (e.g. "Kubernetes",
 * "Terraform") that never happen to false-match anything scored 0% because
 * none of its terms were ever extracted as JD keywords in the first place.
 *
 * Notably, this codebase already has a correct whole-word helper
 * (containsWholeWord, used by isHighValueCategoryTerm and
 * detectSeniorityTier — see the "matches whole words only" tests elsewhere
 * in this file) — it just wasn't being used by extractJDKeywords,
 * countOccurrences, or jdKeywordWeight's required-section check, which is
 * exactly the gap this test closes. The fix reuses containsWholeWord for
 * the two boolean checks, and gives countOccurrences the same
 * lookahead-based whole-word counting lib/resumeKeywords.js's
 * countWholeWordOccurrences already uses (trailing boundary is a
 * zero-width lookahead, not a consumed character, so back-to-back
 * occurrences separated by a single delimiter are still all counted).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  rankResumes as mjsRank,
  extractJDKeywords as mjsExtractJDKeywords,
  jdKeywordWeight as mjsJdKeywordWeight,
} from '../../lib/resumeRanker.mjs';

let jsRank, jsExtractJDKeywords, jsJdKeywordWeight;
beforeAll(async () => {
  await import('../../lib/resumeKeywords.js');
  await import('../../lib/resumeRanker.js');
  jsRank = globalThis.JMResumeRanker.rankResumes;
  jsExtractJDKeywords = globalThis.JMResumeRanker.extractJDKeywords;
  jsJdKeywordWeight = globalThis.JMResumeRanker.jdKeywordWeight;
});

// Reproduces the exact bug report: a JD that never mentions Go, Kubernetes,
// or Terraform, but is full of ordinary English words containing "go" as a
// substring.
const noiseJD = 'We are looking for a driven engineer who enjoys going the ' +
  'extra mile, has a good attitude, and can organize cross-team projects.';

const shortTermResume = { id: 'a', name: 'Resume A', profile: { skills: ['Go', 'Python'] } };
const irrelevantSkillsResume = { id: 'b', name: 'Resume B', profile: { skills: ['Kubernetes', 'Terraform'] } };

describe('resumeRanker word-boundary matching (regression)', () => {
  it('[mjs] does not extract "go" from a JD that only contains it as a substring of other words', () => {
    const keywords = mjsExtractJDKeywords(noiseJD, [shortTermResume, irrelevantSkillsResume]);
    expect(keywords).not.toContain('go');
  });

  it('[js] does not extract "go" from a JD that only contains it as a substring of other words', () => {
    const keywords = jsExtractJDKeywords(noiseJD, [shortTermResume, irrelevantSkillsResume]);
    expect(keywords).not.toContain('go');
  });

  it('[mjs] a resume with a short skill matching only inside unrelated words does not outscore one with no false matches', () => {
    const ranked = mjsRank(noiseJD, [shortTermResume, irrelevantSkillsResume]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    // Neither resume's terms actually appear in this JD, so both should be 0
    // — not the pre-fix bug's "Resume A: 87%, Resume B: 0%".
    expect(byId.a).toBe(0);
    expect(byId.b).toBe(0);
  });

  it('[js] a resume with a short skill matching only inside unrelated words does not outscore one with no false matches', () => {
    const ranked = jsRank(noiseJD, [shortTermResume, irrelevantSkillsResume]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    expect(byId.a).toBe(0);
    expect(byId.b).toBe(0);
  });

  it('[mjs] still matches a short term when it genuinely appears as its own word', () => {
    const jdText = 'Must have experience with Go and distributed systems.';
    const keywords = mjsExtractJDKeywords(jdText, [shortTermResume]);
    expect(keywords).toContain('go');
  });

  it('[js] still matches a short term when it genuinely appears as its own word', () => {
    const jdText = 'Must have experience with Go and distributed systems.';
    const keywords = jsExtractJDKeywords(jdText, [shortTermResume]);
    expect(keywords).toContain('go');
  });

  it('[mjs] still matches terms containing symbols (whole-word check, not naive .includes())', () => {
    const symbolResume = { id: 'c', name: 'Resume C', profile: { skills: ['C++', 'C#', '.NET'] } };
    const jdText = 'Looking for a C++ developer, C# is a plus, .NET experience welcome.';
    const keywords = mjsExtractJDKeywords(jdText, [symbolResume]);
    expect(keywords.sort()).toEqual(['.net', 'c#', 'c++'].sort());
  });

  it('[js] still matches terms containing symbols (whole-word check, not naive .includes())', () => {
    const symbolResume = { id: 'c', name: 'Resume C', profile: { skills: ['C++', 'C#', '.NET'] } };
    const jdText = 'Looking for a C++ developer, C# is a plus, .NET experience welcome.';
    const keywords = jsExtractJDKeywords(jdText, [symbolResume]);
    expect(keywords.sort()).toEqual(['.net', 'c#', 'c++'].sort());
  });

  it('[mjs] countOccurrences (via jdKeywordWeight) correctly counts back-to-back whole-word repeats', () => {
    // "ai ai ai" with single-space delimiters — a naive both-sides-consuming
    // boundary regex would undercount this (the first match eating the
    // shared delimiter the second match needs as its own leading boundary).
    const weight = mjsJdKeywordWeight('ai ai ai', 'ai');
    expect(weight).toBeGreaterThanOrEqual(3 * 2); // count>=3, doubled by the AI/ML category boost
  });

  it('[js] countOccurrences (via jdKeywordWeight) correctly counts back-to-back whole-word repeats', () => {
    const weight = jsJdKeywordWeight('ai ai ai', 'ai');
    expect(weight).toBeGreaterThanOrEqual(3 * 2);
  });

  it('[mjs] does not inflate weight from a required-section "match" that is really a substring of another word', () => {
    // "sr" (a seniority abbreviation elsewhere in this codebase, not a JD
    // keyword itself here) is used as the needle to prove the
    // required-section boost check no longer does a naive .includes() —
    // "disruptive" contains "sr" as a substring but not as a whole word.
    const requiredTextLower = 'looking for someone disruptive and innovative';
    const weight = mjsJdKeywordWeight('we need help. ' + requiredTextLower, 'sr', requiredTextLower);
    // No genuine whole-word "sr" anywhere, so no required-section boost
    // should apply — weight should just be the `|| 1` floor.
    expect(weight).toBe(1);
  });

  it('[js] does not inflate weight from a required-section "match" that is really a substring of another word', () => {
    const requiredTextLower = 'looking for someone disruptive and innovative';
    const weight = jsJdKeywordWeight('we need help. ' + requiredTextLower, 'sr', requiredTextLower);
    expect(weight).toBe(1);
  });
});
