// Feature test for filling Google-Places-backed location-autocomplete
// fields via a saved ZIP/postal code, instead of trying to drive the live
// autocomplete widget. Confirmed needed on Dice's application wizard: its
// "What is your current city of residence?" field is a role="combobox"
// input whose suggestions only render after typing (a real network
// round-trip to Google) — findVisibleOptions() has no way to wait for
// that meaningfully, so the field was always left blank and its own
// validation ("Location is required") blocked the wizard from advancing.
//
// The field's own placeholder spells out that a raw postal code is an
// acceptable alternative to picking a city suggestion: "Enter your city
// or postal code (e.g., Denver, CO or 80202)". fillCustomDropdown() now
// checks for that hint and, if the user has a saved Q&A answer about
// their zip/postal code, types it — which DOES trigger Google Places to
// render a matching suggestion — and then clicks that suggestion, the
// same as a human would, since the field's own validation isn't satisfied
// by typed text alone.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts findSavedZipCodeAnswer() and fillCustomDropdown() by source
// range and evals them with small stand-ins for their dependencies.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let findSavedZipCodeAnswer;
let buildFillCustomDropdown;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = 'function findSavedZipCodeAnswer(qaList) {';
  const endMarker = '\n  async function waitForVisibleOptions(triggerEl';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);

  // eslint-disable-next-line no-eval
  findSavedZipCodeAnswer = (0, eval)(`(function () { ${extracted} return findSavedZipCodeAnswer; })`)();

  // fillCustomDropdown() needs sendMessage/fillInput/clickElement/
  // findVisibleOptions/waitForVisibleOptions in scope — build a fresh
  // instance per test via a factory so each test can supply its own
  // GET_QA_LIST response and observe what fillInput was called with.
  buildFillCustomDropdown = ({ qaList, dropdownOptionTexts = [] }) => {
    const calls = { fillInput: null, sendMessage: [], clickElement: 0, clickedText: null };
    const factory = new Function( // eslint-disable-line no-new-func
      'qaList', 'dropdownOptionTexts', 'calls',
      `
      async function sendMessage(msg) {
        calls.sendMessage.push(msg);
        if (msg.type === 'GET_QA_LIST') return qaList;
        return null;
      }
      function fillInput(input, value) { calls.fillInput = { input, value }; }
      function clickElement(el) { calls.clickElement++; calls.clickedText = el.dataset.text || null; }
      async function waitForVisibleOptions() {
        return dropdownOptionTexts.map(text => {
          const el = document.createElement('div');
          el.dataset.text = text;
          return { text, el };
        });
      }
      ${extracted}
      return fillCustomDropdown;
      `,
    );
    return { fillCustomDropdown: factory(qaList, dropdownOptionTexts, calls), calls };
  };
});

describe('findSavedZipCodeAnswer', () => {
  it('finds a saved answer whose QUESTION mentions zip code', () => {
    const qaList = [
      { question: 'What is your desired salary?', answer: '120000' },
      { question: 'What is your zip code?', answer: '78701' },
    ];
    expect(findSavedZipCodeAnswer(qaList)).toBe('78701');
  });

  it('matches "postal code" wording too', () => {
    const qaList = [{ question: 'Postal Code', answer: '90210' }];
    expect(findSavedZipCodeAnswer(qaList)).toBe('90210');
  });

  it('returns empty when nothing matches', () => {
    const qaList = [{ question: 'Do you need sponsorship?', answer: 'No' }];
    expect(findSavedZipCodeAnswer(qaList)).toBe('');
  });

  it('handles null/non-array input without throwing', () => {
    expect(findSavedZipCodeAnswer(null)).toBe('');
    expect(findSavedZipCodeAnswer(undefined)).toBe('');
  });
});

describe('fillCustomDropdown — zip/postal code placeholder shortcut', () => {
  it('types the saved zip code, then clicks the resulting Google Places suggestion (the Dice case)', async () => {
    document.body.innerHTML = `<input placeholder="Enter your city or postal code (e.g., Denver, CO or 80202)">`;
    const input = document.querySelector('input');
    const { fillCustomDropdown, calls } = buildFillCustomDropdown({
      qaList: [{ question: 'What is your zip code?', answer: '78701' }],
      dropdownOptionTexts: ['Austin, TX 78701, USA'],
    });

    const result = await fillCustomDropdown(input, 'What is your current city of residence?');

    expect(result).toBe(true);
    expect(calls.fillInput).toEqual({ input, value: '78701' });
    expect(calls.clickElement).toBe(1);
    expect(calls.clickedText).toBe('Austin, TX 78701, USA'); // clicked the FIRST (best-match) suggestion
  });

  it('types the zip and still succeeds even if no suggestion ever renders', async () => {
    // Some sites might accept the typed value alone, or the network
    // round-trip simply hasn't resolved — either way, leaving the typed
    // zip in place is strictly better than leaving the field empty.
    document.body.innerHTML = `<input placeholder="Enter your city or postal code (e.g., Denver, CO or 80202)">`;
    const input = document.querySelector('input');
    const { fillCustomDropdown, calls } = buildFillCustomDropdown({
      qaList: [{ question: 'What is your zip code?', answer: '78701' }],
      dropdownOptionTexts: [],
    });

    const result = await fillCustomDropdown(input, 'What is your current city of residence?');

    expect(result).toBe(true);
    expect(calls.fillInput).toEqual({ input, value: '78701' });
    expect(calls.clickElement).toBe(0); // nothing to click
  });

  it('falls through to the normal dropdown flow when no saved zip answer exists', async () => {
    document.body.innerHTML = `<input placeholder="Enter your city or postal code (e.g., Denver, CO or 80202)">`;
    const input = document.querySelector('input');
    const { fillCustomDropdown, calls } = buildFillCustomDropdown({
      qaList: [{ question: 'Do you need sponsorship?', answer: 'No' }],
      dropdownOptionTexts: [], // simulates Google Places never rendering suggestions
    });

    const result = await fillCustomDropdown(input, 'What is your current city of residence?');

    expect(result).toBe(false); // no options ever appeared, nothing to select
    expect(calls.fillInput).toBeNull();
    expect(calls.clickElement).toBeGreaterThan(0); // did attempt to open it
  });

  it('does not take the zip shortcut when the placeholder has no zip/postal hint', async () => {
    document.body.innerHTML = `<input placeholder="Select a country">`;
    const input = document.querySelector('input');
    const { fillCustomDropdown, calls } = buildFillCustomDropdown({
      qaList: [{ question: 'What is your zip code?', answer: '78701' }],
      dropdownOptionTexts: [],
    });

    await fillCustomDropdown(input, 'Country');

    expect(calls.fillInput).toBeNull();
    expect(calls.sendMessage.some(m => m.type === 'GET_QA_LIST')).toBe(false);
  });
});
