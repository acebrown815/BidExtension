// Test for findBestLocationMatch() — picks the suggestion that best
// matches the user's FULL saved location (city + state/country) rather
// than always trusting whichever suggestion a live-search widget renders
// first. Matters because only the bare city name (the part before the
// first comma) gets typed to trigger the search, and several places can
// share the same city name in different states — e.g. typing "Denver"
// could suggest both "Denver, CO, USA" and "Denver, PA, USA".
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts just findBestLocationMatch() by source range and evals it
// directly.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = '  function findBestLocationMatch(suggestions, fullLocation) {';
const END_MARKER = '\n\n  /**\n   * Fills a custom ARIA dropdown by';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

// eslint-disable-next-line no-new-func
const findBestLocationMatch = new Function(`${FN_SRC}\nreturn findBestLocationMatch;`)();

function suggestion(text) {
  return { text, el: { dataset: { text } } };
}

describe('findBestLocationMatch — disambiguates same-named cities in different states', () => {
  it('picks the suggestion matching city AND state over the first result', () => {
    const suggestions = [suggestion('Denver, PA, USA'), suggestion('Denver, CO, USA')];
    const best = findBestLocationMatch(suggestions, 'Denver, CO, USA');
    expect(best.text).toBe('Denver, CO, USA');
  });

  it('falls back to matching just the state/province when no full match exists', () => {
    const suggestions = [suggestion('Denver, PA, USA'), suggestion('Denver Metro Area, CO')];
    const best = findBestLocationMatch(suggestions, 'Denver, CO, USA');
    expect(best.text).toBe('Denver Metro Area, CO');
  });

  it('falls back to the first suggestion when nothing matches the state either', () => {
    const suggestions = [suggestion('Denver, TX, USA'), suggestion('Denver, WA, USA')];
    const best = findBestLocationMatch(suggestions, 'Denver, CO, USA');
    expect(best).toBe(suggestions[0]);
  });

  it('falls back to the first suggestion when the saved location has no state/country part', () => {
    const suggestions = [suggestion('Denver, CO, USA'), suggestion('Denver, PA, USA')];
    const best = findBestLocationMatch(suggestions, 'Denver');
    expect(best).toBe(suggestions[0]);
  });

  it('is case-insensitive', () => {
    const suggestions = [suggestion('DENVER, PA, USA'), suggestion('denver, co, usa')];
    const best = findBestLocationMatch(suggestions, 'Denver, CO, USA');
    expect(best.text).toBe('denver, co, usa');
  });
});
