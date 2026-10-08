// Ashby's Location field (jobs.ashbyhq.com, _systemfield_location) is a place
// autocomplete: type a city, and a moment later a suggestion list is added in
// a portal straight under <body> —
//   <div data-floating-ui-portal><div role="listbox"><div role="option">Summerfield, Florida, United States</div>…
// with no aria-controls tying it to the input. It stayed empty: fillInput's
// blur (added so plain text fields commit) closed the list and cleared the
// typed city before a suggestion could be picked.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let HELPERS;
beforeAll(() => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  function findBestLocationMatch(suggestions, fullLocation) {');
  const end = src.indexOf('  /**\n   * Fills a custom ARIA dropdown by', start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  HELPERS = src.slice(start, end);
});

// Verbatim (trimmed) from the live page.
const ASHBY_SUGGESTIONS = [
  'Summit, New Jersey, United States',
  'Summerville, South Carolina, United States',
  'Summerside, Prince Edward Island, Canada',
  'Summerland, British Columbia, Canada',
  'Summerfield, Florida, United States',
];

function load() {
  return new Function(` // eslint-disable-line no-new-func
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 60)));
    function dispatchFocusEvents(el, direction) {
      const [own, bubbling] = direction === 'in' ? ['focus', 'focusin'] : ['blur', 'focusout'];
      el.dispatchEvent(new FocusEvent(own, { bubbles: false }));
      el.dispatchEvent(new FocusEvent(bubbling, { bubbles: true }));
    }
    ${HELPERS}
    return { findBestLocationMatch, typeIntoAutocomplete, waitForNewSuggestionOptions };
  `)();
}

let originalRect;
beforeEach(() => {
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 });
  document.body.innerHTML = `
    <div class="ashby-application-form-field-entry" data-field-path="_systemfield_location">
      <label for="_systemfield_location">Location</label>
      <div><input class="ashby-application-form-input-autocomplete" placeholder="Start typing..." aria-autocomplete="list" aria-haspopup="listbox" role="combobox" value=""></div>
    </div>
    <ul role="listbox"><li role="option">An unrelated, already-open list</li></ul>`;
  return () => { Element.prototype.getBoundingClientRect = originalRect; };
});

/** Ashby-like: typing renders the portal ~300ms later; blurring before a pick clears the text. */
function wireAshbyLocation(input) {
  input.addEventListener('focusout', () => {
    if (!input.dataset.picked) input.value = '';
    document.querySelector('[data-floating-ui-portal]')?.remove();
  });
  input.addEventListener('input', () => setTimeout(() => {
    document.querySelector('[data-floating-ui-portal]')?.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <div id=":r2:" data-floating-ui-portal=""><div role="listbox" id=":r0:"><div class="ashby-application-form-input-autocomplete-popup">
        ${ASHBY_SUGGESTIONS.map((t, i) => `<div role="option" id=":r1${i}:" aria-selected="false">${t}</div>`).join('')}
      </div></div></div>`);
  }, 300));
}

describe('Ashby Location autocomplete', () => {
  it('types the city without leaving the field (the typed text survives)', () => {
    const input = document.querySelector('input[role="combobox"]');
    wireAshbyLocation(input);
    const events = [];
    ['focusin', 'input', 'focusout'].forEach(t => input.addEventListener(t, () => events.push(t)));

    load().typeIntoAutocomplete(input, 'Summerfield');

    expect(input.value).toBe('Summerfield');
    expect(events).toEqual(['focusin', 'input']);
  });

  it('reads only the suggestions added after typing (the body portal), not lists already on the page', async () => {
    const input = document.querySelector('input[role="combobox"]');
    wireAshbyLocation(input);
    const { typeIntoAutocomplete, waitForNewSuggestionOptions } = load();
    const before = new Set(document.querySelectorAll('[role="option"]'));

    typeIntoAutocomplete(input, 'Summerfield');
    const options = await waitForNewSuggestionOptions(before, 3000);

    expect(options.map(o => o.text)).toEqual(ASHBY_SUGGESTIONS);
  });

  it.each([
    ['Summerfield, FL 34491'],
    ['Summerfield, FL'],
    ['Summerfield, Florida, USA'],
    ['Summerfield'],
  ])('picks "Summerfield, Florida, United States" for a saved location of "%s"', (saved) => {
    const suggestions = ASHBY_SUGGESTIONS.map(text => ({ text }));
    expect(load().findBestLocationMatch(suggestions, saved).text).toBe('Summerfield, Florida, United States');
  });

  it('still matches abbreviated suggestions and prefers the state over the country', () => {
    const { findBestLocationMatch } = load();
    const s = (texts) => texts.map(text => ({ text }));
    expect(findBestLocationMatch(s(['Denver, PA, USA', 'Denver, CO, USA']), 'Denver, CO, USA').text).toBe('Denver, CO, USA');
    expect(findBestLocationMatch(s(['Denver, PA, USA', 'Denver, Colorado, United States']), 'Denver, CO').text).toBe('Denver, Colorado, United States');
  });
});

// The Location input has no id/name, and its <label for="_systemfield_location">
// points at no element — getFieldLabel() fell back to the placeholder
// "Start typing...", so the city/location handling never ran at all.
describe('getFieldLabel — Ashby Location input', () => {
  it('resolves "Location" from the field entry, not the placeholder', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('  function getFieldLabel(input) {');
    const b = src.indexOf('  /**\n   * Like getFieldLabel, but for an entire radio GROUP', a);
    const getFieldLabel = new Function('const location = { hostname: "jobs.ashbyhq.com" };' + src.slice(a, b) + '; return getFieldLabel;')(); // eslint-disable-line no-new-func
    expect(getFieldLabel(document.querySelector('input[role="combobox"]'))).toBe('Location');
  });
});
