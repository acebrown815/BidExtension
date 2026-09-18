// Tests for qaQuestionMatchesLabel, the matcher shared by directFill.js's
// Pass 1 (instant, no-AI direct fill) and aiService.js's buildAutofillPrompt()
// qa_hint attachment (Pass 2).
//
// History of this file, since the matcher went through two real-world
// corrections:
//
// 1. Originally, aiService.js had its OWN, looser matcher (one shared
//    keyword longer than 3 characters, no stopword filtering) while
//    directFill.js required at least 2 overlapping non-stopword keywords.
//    Unified on directFill.js's stricter rule so both passes agreed.
//
// 2. That "always require 2 keywords" rule then broke a real, common case:
//    ATS platforms often phrase EEO/visa screening questions so tersely
//    ("Will you need sponsorship?") that only ONE non-stopword survives
//    filtering ("will" and "need" are themselves stopwords) — so a saved
//    Q&A entry like "Will you now or in the future require sponsorship to
//    continue or extend your current work authorization status?" could
//    never reach the 2-keyword bar against it, even though both are
//    obviously the same question. STRONG_TOPIC_WORDS carves out an
//    exception: a single shared word is enough IF it's one of a small set
//    of unambiguous screening-question topic anchors (sponsorship, visa,
//    gender, veteran, disability, etc.) — this Q&A feature exists
//    specifically for that narrow domain, so a hit there is reliable even
//    with only one shared word. The accepted trade-off: a coincidental
//    single-word overlap on one of these anchor words (e.g. "sponsorship"
//    appearing in an unrelated "sponsorship program management experience"
//    question) can now match too — considered acceptable since real EEO/
//    visa screening questions in this domain are near-universally direct
//    yes/no questions about the applicant, not experience descriptions.
import { describe, it, expect, beforeAll } from 'vitest';

let qaQuestionMatchesLabel;
beforeAll(async () => {
  await import('../../lib/qaMatch.js');
  qaQuestionMatchesLabel = globalThis.JMQaMatch.qaQuestionMatchesLabel;
});

describe('qaQuestionMatchesLabel — should match', () => {
  it('identical questions', () => {
    expect(qaQuestionMatchesLabel('Do you need sponsorship?', 'Do you need sponsorship?')).toBe(true);
  });

  it('case/whitespace differences only', () => {
    expect(qaQuestionMatchesLabel('  DO YOU NEED SPONSORSHIP?  ', 'do you need sponsorship?')).toBe(true);
  });

  it('a short saved question fully contained in a short label', () => {
    expect(qaQuestionMatchesLabel('Salary expectations', 'What are your salary expectations?')).toBe(true);
  });

  it('a short label fully contained in a short saved question', () => {
    expect(qaQuestionMatchesLabel('I identify my gender as', 'Gender')).toBe(true);
  });

  it('longer questions sharing 2+ substantial keywords', () => {
    expect(qaQuestionMatchesLabel(
      'Do you require visa sponsorship to work in the US?',
      'Will you now or in the future require visa sponsorship?'
    )).toBe(true);
  });

  it('a terse form label ("Will you need sponsorship?") against a verbose saved question, sharing only "sponsorship" — the real bug this carve-out fixes', () => {
    expect(qaQuestionMatchesLabel(
      'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?',
      'Will you need sponsorship?'
    )).toBe(true);
    expect(qaQuestionMatchesLabel(
      'Will you now or in the future require sponsorship to continue or extend your current work authorization status?',
      'Will you need sponsorship?'
    )).toBe(true);
    expect(qaQuestionMatchesLabel(
      'Will you now or in the future require visa sponsorship?',
      'Will you need sponsorship?'
    )).toBe(true);
  });

  it('a differently-worded pair sharing one topic-anchor keyword ("sponsorship")', () => {
    expect(qaQuestionMatchesLabel(
      'Do you need sponsorship?',
      'Do you expect any sponsorship from us?'
    )).toBe(true);
  });
});

describe('qaQuestionMatchesLabel — should NOT match', () => {
  it('different topics entirely, no shared keywords at all', () => {
    expect(qaQuestionMatchesLabel('What is your desired salary?', 'Are you willing to relocate?')).toBe(false);
  });

  it('two long questions sharing only one NON-anchor keyword', () => {
    expect(qaQuestionMatchesLabel(
      'Do you have prior experience with our proprietary scheduling software?',
      'Do you have experience leading a team of 5 or more engineers?'
    )).toBe(false);
  });

  it('empty or missing input', () => {
    expect(qaQuestionMatchesLabel('', 'Anything')).toBe(false);
    expect(qaQuestionMatchesLabel('Anything', '')).toBe(false);
    expect(qaQuestionMatchesLabel(null, 'Anything')).toBe(false);
    expect(qaQuestionMatchesLabel('Anything', undefined)).toBe(false);
  });
});
