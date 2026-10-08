// Ashby field labelled just "Location" whose description says "Country you're
// currently residing in": AutoFill typed the CITY ("Summerfield") because it
// only looked at the label. It now reads the field's description too and
// types the country (or state) when that's what is asked.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let helpers;
beforeAll(() => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const slice = (a, b) => {
    const start = src.indexOf(a);
    const end = src.indexOf(b, start);
    if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
    return src.slice(start, end);
  };
  const states = slice('  const US_STATE_NAMES = {', '  /**\n   * Types into a search-as-you-type field');
  const kind = slice('  function getFieldDescription(el) {', '  function findSavedLocationAnswer(qaList) {');
  helpers = new Function(`${states}\n${kind}\nreturn { getFieldDescription, locationKindAsked, locationPartFor };`)(); // eslint-disable-line no-new-func
});

// Verbatim (trimmed) from the live Ashby form.
const ASHBY_COUNTRY = `
  <div class="ashby-application-form-field-entry" data-field-path="6f1b584f-ba7d-47eb-a987-ae7e13a9c5d3">
    <label class="ashby-application-form-question-title" for="6f1b584f-ba7d-47eb-a987-ae7e13a9c5d3">Location</label>
    <div class="_description_1e3gg_48 ashby-application-form-question-description"><p>Country you're currently residing in</p></div>
    <div><input class="ashby-application-form-input-autocomplete" placeholder="Start typing..." role="combobox" value=""></div>
  </div>`;

const ASHBY_CITY = `
  <div class="ashby-application-form-field-entry" data-field-path="_systemfield_location">
    <label for="_systemfield_location">Location</label>
    <div><input class="ashby-application-form-input-autocomplete" placeholder="Start typing..." role="combobox" value=""></div>
  </div>`;

describe('locationKindAsked', () => {
  it('a "Location" field described as "Country you\'re currently residing in" wants the country', () => {
    document.body.innerHTML = ASHBY_COUNTRY;
    const input = document.querySelector('input');
    expect(helpers.getFieldDescription(input)).toBe("Country you're currently residing in");
    expect(helpers.locationKindAsked('Location', input)).toBe('country');
  });

  it('a plain "Location" field still wants the city', () => {
    document.body.innerHTML = ASHBY_CITY;
    expect(helpers.locationKindAsked('Location', document.querySelector('input'))).toBe('city');
  });

  it('city wins whenever it is mentioned; state/province is recognised', () => {
    document.body.innerHTML = '<input id="x">';
    const el = document.getElementById('x');
    expect(helpers.locationKindAsked('City and country of residence', el)).toBe('city');
    expect(helpers.locationKindAsked('State / Province', el)).toBe('state');
  });
});

describe('locationPartFor', () => {
  it.each([
    ['Summerfield, FL 34491', 'United States'],
    ['Summerfield, Florida', 'United States'],
    ['Denver, CO, USA', 'United States'],
    ['Toronto, Ontario, Canada', 'Canada'],
    ['Berlin, Germany', 'Germany'],
  ])('country of "%s" is "%s"', (location, country) => {
    expect(helpers.locationPartFor(location, 'country', [])).toBe(country);
  });

  it('prefers a saved Q&A answer about the country', () => {
    const qa = [{ question: 'What country do you live in?', answer: 'USA' }];
    expect(helpers.locationPartFor('Summerfield, FL', 'country', qa)).toBe('USA');
  });

  it('ignores a "country code" Q&A (phone), not a country answer', () => {
    const qa = [{ question: 'Phone country code', answer: '+1' }];
    expect(helpers.locationPartFor('Summerfield, FL', 'country', qa)).toBe('United States');
  });

  it('state spells out a US state code; city is the first part', () => {
    expect(helpers.locationPartFor('Summerfield, FL 34491', 'state', [])).toBe('Florida');
    expect(helpers.locationPartFor('Summerfield, FL 34491', 'city', [])).toBe('Summerfield');
  });
});
