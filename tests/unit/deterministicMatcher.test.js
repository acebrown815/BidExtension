// deterministicMatcher.js had zero test coverage before this — added
// while fixing a real bug: a saved Q&A answer of "U.S.Citizen" (no space
// after the abbreviation's period) failed to match the dropdown option
// "US Citizen" on Dice's "Work Authorization" field, silently escalated
// to the AI, and the AI guessed "Have H1 Visa" from resume content alone
// instead. Root cause: normalize() stripped punctuation but PRESERVED
// existing spaces rather than also stripping them, so "U.S.Citizen" (no
// space) normalized to "uscitizen" while "US Citizen" (has a space)
// normalized to "us citizen" — same content, unequal strings.
import { describe, it, expect } from 'vitest';
import { deterministicFieldMatcher, detectTopic, normalize } from '../../deterministicMatcher.js';

describe('normalize — the actual bug', () => {
  it('makes "U.S.Citizen" and "US Citizen" equal (the real failure)', () => {
    expect(normalize('U.S.Citizen')).toBe(normalize('US Citizen'));
  });

  it('strips punctuation and spaces alike', () => {
    expect(normalize('South Asian (India)')).toBe('southasianindia');
    expect(normalize('Straight/Heterosexual')).toBe('straightheterosexual');
  });

  it('is case-insensitive', () => {
    expect(normalize('US CITIZEN')).toBe(normalize('us citizen'));
  });
});

describe('detectTopic', () => {
  it('detects work_auth from "Work Authorization" and "Work authorization status"', () => {
    expect(detectTopic('Work Authorization')).toBe('work_auth');
    expect(detectTopic('Work authorization status')).toBe('work_auth');
  });

  it('detects sponsorship, veteran, disability, gender', () => {
    expect(detectTopic('Will you now or in the future require sponsorship?')).toBe('sponsorship');
    expect(detectTopic('Are you a protected veteran?')).toBe('veteran');
    expect(detectTopic('Do you have a disability?')).toBe('disability');
    expect(detectTopic('What is your gender?')).toBe('gender');
  });

  it('prefers the more specific gender_identity over the broader gender topic', () => {
    expect(detectTopic('What is your gender identity?')).toBe('gender_identity');
  });

  it('returns null for a question with no known topic', () => {
    expect(detectTopic('What is your desired salary?')).toBeNull();
  });
});

describe('deterministicFieldMatcher — the real Dice bug', () => {
  const workAuthOptions = [
    'US Citizen', 'Canadian Citizen', 'Have H1 Visa', 'Need H1 Visa',
    'Green Card Holder', 'TN Permit Holder', 'Employment Auth Document', 'Prefer Not to Answer',
  ];

  it('matches a saved "U.S.Citizen" answer to the "US Citizen" option (previously fell through to the AI and guessed wrong)', () => {
    const qaList = [{ question: 'Work authorization status', answer: 'U.S.Citizen' }];
    const result = deterministicFieldMatcher('Work Authorization', workAuthOptions, qaList, null);
    expect(result).toEqual({ matched: true, option: 'US Citizen', topic: 'work_auth' });
  });

  it('still matches a cleanly-formatted "US Citizen" answer (no regression)', () => {
    const qaList = [{ question: 'Work authorization status', answer: 'US Citizen' }];
    const result = deterministicFieldMatcher('Work Authorization', workAuthOptions, qaList, null);
    expect(result).toEqual({ matched: true, option: 'US Citizen', topic: 'work_auth' });
  });

  it('falls back to the profile.workAuthorization field when no Q&A entry matches', () => {
    const result = deterministicFieldMatcher('Work Authorization', workAuthOptions, [], { workAuthorization: 'Green Card Holder' });
    expect(result).toEqual({ matched: true, option: 'Green Card Holder', topic: 'work_auth' });
  });

  it('escalates to the AI (matched: false) when nothing is saved anywhere', () => {
    const result = deterministicFieldMatcher('Work Authorization', workAuthOptions, [], null);
    expect(result).toEqual({ matched: false, option: null, topic: 'work_auth' });
  });

  it('escalates to the AI rather than guessing when the saved answer matches nothing on this ATS', () => {
    const qaList = [{ question: 'Work authorization status', answer: 'Refugee/Asylee EAD' }];
    const result = deterministicFieldMatcher('Work Authorization', workAuthOptions, qaList, null);
    expect(result).toEqual({ matched: false, option: null, topic: 'work_auth' });
  });

  it('picks a LATER, usable saved answer over an EARLIER, unusable one for the same topic (the actual live bug)', () => {
    // Confirmed live: a real user had BOTH of these saved. The generic
    // "authorized to work" Yes/No question comes first in their list and
    // ALSO matches the work_auth topic's keywords, but "Yes" cannot map to
    // any of this citizenship-category dropdown's options — only the
    // second, differently-shaped saved answer can. The old code stopped
    // at the FIRST keyword match ("Yes") and never tried the second at
    // all, silently escalating to the AI (which then guessed wrong).
    const qaList = [
      { question: 'Are you legally authorized to work in the United States?', answer: 'Yes', category: 'work-auth' },
      { question: 'Work authorization status', answer: 'U.S. Citizen', category: 'work-auth' },
    ];
    const result = deterministicFieldMatcher('Work Authorization', workAuthOptions, qaList, null);
    expect(result).toEqual({ matched: true, option: 'US Citizen', topic: 'work_auth' });
  });

  it('does not let a bare "1"/"0" in ANSWER_SYNONYMS[yes/no] accidentally match an unrelated option (the actual live bug)', () => {
    // Confirmed live: with only the "Yes" entry present (no better
    // candidate to fall through to), the old synonym list ('yes' included
    // the bare digit '1') matched "Have H1 Visa" purely because "H1"
    // contains the digit "1" — nothing to do with yes/no semantics.
    const qaList = [
      { question: 'Are you legally authorized to work in the United States?', answer: 'Yes', category: 'work-auth' },
    ];
    const result = deterministicFieldMatcher('Work Authorization', workAuthOptions, qaList, null);
    expect(result).toEqual({ matched: false, option: null, topic: 'work_auth' }); // correctly gives up rather than guessing "Have H1 Visa"
  });
});

describe('deterministicFieldMatcher — demographic decline-to-answer fallback', () => {
  it('selects the decline option when no saved answer exists for a demographic topic', () => {
    const options = ['Man', 'Woman', 'Non-binary', 'Prefer not to say'];
    const result = deterministicFieldMatcher('What is your gender?', options, [], null);
    expect(result).toEqual({ matched: true, option: 'Prefer not to say', topic: 'gender' });
  });

  it('does NOT auto-decline when the saved answer just failed to match — escalates to AI instead', () => {
    const options = ['Man', 'Woman', 'Prefer not to say'];
    const qaList = [{ question: 'What is your gender?', answer: 'Some unusual custom phrasing' }];
    const result = deterministicFieldMatcher('What is your gender?', options, qaList, null);
    expect(result).toEqual({ matched: false, option: null, topic: 'gender' });
  });

  it('does not apply the decline fallback to non-demographic topics like work_auth', () => {
    const options = ['Yes', 'No']; // no decline option even offered
    const result = deterministicFieldMatcher('Are you authorized to work in the US?', options, [], null);
    expect(result).toEqual({ matched: false, option: null, topic: 'work_auth' });
  });
});
