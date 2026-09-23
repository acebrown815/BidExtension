// Regression test for a real bug found live on a Greenhouse application
// form: the "Location (City)" field (a Google-Places-backed autocomplete,
// like the existing zip/postal special case below it in the same function)
// always failed with "no options ever rendered". Root cause: unlike the zip
// case, there was no special handling for a plain city/location field at
// all — fillCustomDropdown just clicked to "open" it and waited for options
// that only ever render after something is actually typed, so it timed out
// every time even though the field itself was detected and clicked fine.
//
// Fix: mirror the existing zip/postal special case — detect a city/location
// question by its label text, type the profile's saved city into the field
// first, THEN wait for suggestions and click the first one (falling back to
// leaving the typed text in place if no suggestion ever renders).
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts just the new special-case block by source range and wraps it in
// a stand-in async function with small hand-written stubs for its
// dependencies (sendMessage, fillInput, waitForVisibleOptions, clickElement).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = '// Same story as the zip/postal case above, for a plain city/location';
const END_MARKER = '// Step 1: Click to open the dropdown.';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER, START);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const BLOCK_SRC = SRC.slice(START, END);

function buildHarness({ profileLocation, suggestionTexts = [] } = {}) {
  const filledValues = [];
  const clickedTexts = [];
  const suggestionEls = suggestionTexts.map(t => ({ text: t, el: { click: () => clickedTexts.push(t) } }));

  const factory = new Function( // eslint-disable-line no-new-func
    'sendMessage', 'fillInput', 'waitForVisibleOptions', 'clickElement', '_activeResumeId',
    `
    return async function run(input, questionText) {
      ${BLOCK_SRC}
      return 'FELL_THROUGH';
    };
    `,
  );

  const sendMessage = async (msg) => {
    if (msg.type === 'GET_PROFILE') return { location: profileLocation };
    return {};
  };
  const fillInput = (input, value) => { filledValues.push(value); };
  const waitForVisibleOptions = async () => suggestionEls;
  const clickElement = (el) => { if (el && el.click) el.click(); };

  const run = factory(sendMessage, fillInput, waitForVisibleOptions, clickElement, 'resume-1');
  return { run, filledValues, clickedTexts };
}

describe('fillCustomDropdown — city/location special case (the actual bug)', () => {
  it('types the saved city and clicks the first suggestion when one renders', async () => {
    const { run, filledValues, clickedTexts } = buildHarness({
      profileLocation: 'Summerfield, FL, USA',
      suggestionTexts: ['Summerfield, FL, USA', 'Summerfield, TX, USA'],
    });
    const result = await run({}, 'Location (City)');
    expect(result).toBe(true);
    expect(filledValues).toEqual(['Summerfield']);
    expect(clickedTexts).toEqual(['Summerfield, FL, USA']);
  });

  it('leaves the typed city in place when no suggestion ever renders', async () => {
    const { run, filledValues, clickedTexts } = buildHarness({
      profileLocation: 'Summerfield, FL, USA',
      suggestionTexts: [],
    });
    const result = await run({}, 'Location (City)');
    expect(result).toBe(true);
    expect(filledValues).toEqual(['Summerfield']);
    expect(clickedTexts).toEqual([]);
  });

  it('falls through without acting when there is no saved location', async () => {
    const { run, filledValues } = buildHarness({ profileLocation: '' });
    const result = await run({}, 'Location (City)');
    expect(result).toBe('FELL_THROUGH');
    expect(filledValues).toEqual([]);
  });

  it('does not trigger for an unrelated question (e.g. zip/postal, or a non-location field)', async () => {
    const { run: runZip, filledValues: filledZip } = buildHarness({ profileLocation: 'Summerfield, FL, USA' });
    expect(await runZip({}, 'Zip/postal code')).toBe('FELL_THROUGH');
    expect(filledZip).toEqual([]);

    const { run: runOther, filledValues: filledOther } = buildHarness({ profileLocation: 'Summerfield, FL, USA' });
    expect(await runOther({}, 'What is your gender?')).toBe('FELL_THROUGH');
    expect(filledOther).toEqual([]);
  });
});
