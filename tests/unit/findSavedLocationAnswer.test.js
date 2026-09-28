// Test for findSavedLocationAnswer() — finds a saved Q&A answer for a
// location/city question (e.g. the built-in "City" Q&A entry), so the
// Location-autocomplete special case in fillCustomDropdown() can prefer
// it over the resume-parsed profile.location, per explicit request: Q&A
// is the more deliberately-curated source of truth when the user filled
// one in.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts just findSavedLocationAnswer() by source range and evals it
// directly.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = '  function findSavedLocationAnswer(qaList) {';
const END_MARKER = '\n\n  /**\n   * Picks the suggestion that best matches';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

// eslint-disable-next-line no-new-func
const findSavedLocationAnswer = new Function(`${FN_SRC}\nreturn findSavedLocationAnswer;`)();

describe('findSavedLocationAnswer', () => {
  it('finds a saved answer for the built-in "City" question', () => {
    const qaList = [
      { question: 'What is your desired salary?', answer: '120000' },
      { question: 'City', answer: 'Austin, TX, USA' },
    ];
    expect(findSavedLocationAnswer(qaList)).toBe('Austin, TX, USA');
  });

  it('matches a question containing "location" too', () => {
    const qaList = [{ question: 'Current Location', answer: 'Denver, CO' }];
    expect(findSavedLocationAnswer(qaList)).toBe('Denver, CO');
  });

  it('does NOT match a zip/postal code question (separate shortcut already handles that)', () => {
    const qaList = [{ question: 'What is your zip code?', answer: '78701' }];
    expect(findSavedLocationAnswer(qaList)).toBe('');
  });

  it('returns empty when nothing matches', () => {
    const qaList = [{ question: 'Do you need sponsorship?', answer: 'No' }];
    expect(findSavedLocationAnswer(qaList)).toBe('');
  });

  it('ignores an entry with no saved answer', () => {
    const qaList = [{ question: 'City', answer: '' }];
    expect(findSavedLocationAnswer(qaList)).toBe('');
  });

  it('handles null/non-array input without throwing', () => {
    expect(findSavedLocationAnswer(null)).toBe('');
    expect(findSavedLocationAnswer(undefined)).toBe('');
  });
});
