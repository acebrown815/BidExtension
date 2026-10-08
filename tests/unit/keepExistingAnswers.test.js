// Re-running AutoFill ("Resume Auto Mode", a later Auto-Bid pass, another
// AutoFill click) used to re-fill EVERY field, overwriting what the user had
// just typed/picked to fix a step and bringing the step's errors back. Now
// only empty fields and fields the page flags as wrong are (re)filled.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { shouldKeepExistingAnswer, hasAnswer, fieldShowsError } = require(path.join(ROOT, 'lib', 'fieldFilter.js'));

const $ = (sel) => document.querySelector(sel);

describe('shouldKeepExistingAnswer', () => {
  it('keeps a typed value; refills it when the page flags it', () => {
    document.body.innerHTML = `
      <input id="ok" value="Randolph">
      <input id="invalid" value="+1 720 310 5861" aria-invalid="true">
      <input id="described" value="abc" aria-describedby="err1"><p id="err1">Error: Enter a valid format for Phone Number.</p>
      <div data-automation-id="formField-phoneNumber"><input id="wd" value="+1 720"><p data-automation-id="inputAlert">Error: Enter a valid format for Phone Number.</p></div>
      <input id="empty" value="">`;
    expect(shouldKeepExistingAnswer($('#ok'))).toBe(true);
    expect(shouldKeepExistingAnswer($('#invalid'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#described'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#wd'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#empty'))).toBe(false);
  });

  it('native selects: a real choice is kept, a placeholder is not', () => {
    document.body.innerHTML = `
      <select id="chosen"><option value="">Select...</option><option value="us" selected>United States</option></select>
      <select id="placeholder"><option value="">Select...</option><option value="us">United States</option></select>
      <select id="dash"><option value="-1" selected>-- choose --</option><option value="1">One</option></select>`;
    expect(shouldKeepExistingAnswer($('#chosen'))).toBe(true);
    expect(shouldKeepExistingAnswer($('#placeholder'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#dash'))).toBe(false);
  });

  it('radios/checkboxes: the user\'s pick is kept, the page\'s own default is not', () => {
    document.body.innerHTML = `
      <input type="radio" name="g1" id="g1a"><input type="radio" name="g1" id="g1b">
      <input type="radio" name="g2" id="g2a" checked><input type="radio" name="g2" id="g2b">
      <input type="checkbox" id="cbUser"><input type="checkbox" id="cbDefault" checked><input type="checkbox" id="cbOff">`;
    $('#g1b').checked = true; // user picked
    $('#cbUser').checked = true; // user ticked
    expect(shouldKeepExistingAnswer($('#g1a'))).toBe(true); // any radio of an answered group
    expect(shouldKeepExistingAnswer($('#g2a'))).toBe(false); // page default only
    expect(shouldKeepExistingAnswer($('#cbUser'))).toBe(true);
    expect(shouldKeepExistingAnswer($('#cbDefault'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#cbOff'))).toBe(false);
  });

  it('a radio group flagged as wrong is refilled', () => {
    document.body.innerHTML = '<fieldset aria-invalid="true"><input type="radio" name="g" id="a"><input type="radio" name="g" id="b"></fieldset>';
    $('#b').checked = true;
    expect(hasAnswer($('#a'))).toBe(true);
    expect(fieldShowsError($('#a'))).toBe(true);
    expect(shouldKeepExistingAnswer($('#a'))).toBe(false);
  });

  it('dropdown triggers: Workday value, Radix placeholder, Rippling "Select...", react-select value', () => {
    document.body.innerHTML = `
      <button id="wdSet" aria-haspopup="listbox" value="bc33aa31">United States of America</button>
      <button id="wdEmpty" aria-haspopup="listbox" value="">Select One</button>
      <button id="radixEmpty" role="combobox"><span data-placeholder="">Select hours</span></button>
      <button id="radixSet" role="combobox"><span>Full-time</span></button>
      <div id="ripplingEmpty" role="combobox"><p>Select...</p></div>
      <div class="select__control"><div class="select__single-value">Yes</div><input id="reactSelect" value=""></div>`;
    expect(shouldKeepExistingAnswer($('#wdSet'))).toBe(true);
    expect(shouldKeepExistingAnswer($('#wdEmpty'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#radixEmpty'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#radixSet'))).toBe(true);
    expect(shouldKeepExistingAnswer($('#ripplingEmpty'))).toBe(false);
    expect(shouldKeepExistingAnswer($('#reactSelect'))).toBe(true);
  });
});

describe('detectFormFields pass 2 — only empty or flagged text fields are sent to be filled', () => {
  let runPass2;
  beforeAll(() => {
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('// ── 2. Text inputs, textareas');
    const end = src.indexOf('// ── 2b. Rippling', start);
    const pass2 = src.slice(start, end);
    runPass2 = new Function('ff', ` // eslint-disable-line no-new-func
      const shouldKeepExistingAnswer = ff.shouldKeepExistingAnswer;
      const fieldShowsError = ff.fieldShowsError;
      const isWorkdaySelectCompanionInput = () => false;
      const isWorkdayPromptInput = () => false;
      const getFieldLabel = (el) => el.getAttribute('aria-label') || '';
      const isFieldEligible = () => true;
      const isCustomDropdown = () => false;
      const readCustomOptions = () => [];
      const buildSelectOptions = () => ({ optMap: {}, optTexts: [] });
      const seen = new Set();
      const questions = [];
      const _fieldMap = {};
      let qIndex = 0;
      ${pass2}
      return questions.map(q => q.question_id);
    `);
  });

  it('skips what the user filled, keeps empty and error-flagged fields', () => {
    document.body.innerHTML = `
      <input id="firstName" aria-label="First Name" value="Randolph">
      <input id="phone" aria-label="Phone Number" value="+1 720 310 5861" aria-invalid="true">
      <input id="city" aria-label="City" value="">
      <textarea id="why" aria-label="Why us?">Because I love the mission.</textarea>`;
    expect(runPass2({ shouldKeepExistingAnswer, fieldShowsError }).sort()).toEqual(['city', 'phone']);
  });
});
